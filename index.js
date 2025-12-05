import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import fs from "fs";

const rules = JSON.parse(fs.readFileSync("./rules.json", "utf8"));

const app = express();
const PORT = process.env.PORT || 8080;

const SHOP = process.env.SHOPIFY_SHOP;               // e.g. "rpztwp-r0"
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const ALLOWED_LOCATION_ID = process.env.ALLOWED_LOCATION_ID; // e.g. "84886585560"
const API_VERSION = "2025-10";

// Set this to false if you want to go back to dry-run mode
const WRITE_MODE = true;

if (!SHOP || !ADMIN_TOKEN) {
	console.error("Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_API_TOKEN env vars");
	process.exit(1);
}

app.use(bodyParser.json());

// Maps built at startup
const inventoryItemIdToSku = new Map();   // inventory_item_id -> sku
const skuToInventoryItemIds = new Map();  // sku -> [inventory_item_id]

// Cache for recent inventory level reads to reduce rate-limit pressure
// key = `${inventoryItemId}:${locationId}` -> { available, fetchedAt }
const inventoryLevelCache = new Map();

// Cache for recent webhooks to suppress duplicates
// key = `${inventoryItemId}:${locationId}` -> { available, ts }
const recentEvents = new Map();

// Simple sleep helper for pacing writes
function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch all products/variants and build maps
async function fetchAllVariants() {
	let url = `https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/products.json?limit=250`;
	let more = true;

	while (more && url) {
		const resp = await fetch(url, {
			headers: {
				"X-Shopify-Access-Token": ADMIN_TOKEN,
				"Content-Type": "application/json"
			}
		});

		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`Error fetching products: ${resp.status} ${text}`);
		}

		const data = await resp.json();
		const products = data.products || [];
		if (products.length === 0) break;

		for (const product of products) {
			for (const variant of product.variants) {
				const sku = (variant.sku || "").trim();
				const invId = variant.inventory_item_id;

				if (!sku || !invId) continue;

				inventoryItemIdToSku.set(invId, sku);

				if (!skuToInventoryItemIds.has(sku)) {
					skuToInventoryItemIds.set(sku, []);
				}
				skuToInventoryItemIds.get(sku).push(invId);
			}
		}

		const linkHeader = resp.headers.get("link");
		const nextMatch =
			linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);

		if (nextMatch) {
			url = nextMatch[1];
		} else {
			more = false;
		}
	}

	console.log(
		`Loaded ${inventoryItemIdToSku.size} inventory items across ${skuToInventoryItemIds.size} SKUs`
	);
}

app.get("/health", (req, res) => {
	res.status(200).send("ok");
});

// Helper: fetch available for a specific inventory item at a location
async function fetchAvailableForInventoryItem(inventoryItemId, locationId) {
	const key = `${inventoryItemId}:${locationId}`;
	const cached = inventoryLevelCache.get(key);
	const now = Date.now();

	// If we read this within the last 1s, reuse it
	if (cached && now - cached.fetchedAt < 1000) {
		return cached.available;
	}

	const resp = await fetch(
		`https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${locationId}`,
		{
			method: "GET",
			headers: {
				"X-Shopify-Access-Token": ADMIN_TOKEN,
				"Content-Type": "application/json"
			}
		}
	);

	if (!resp.ok) {
		const text = await resp.text();
		console.log(
			`Error fetching inventory level for item ${inventoryItemId}: ${resp.status} ${text}`
		);
		return null;
	}

	const data = await resp.json();
	const levels = data.inventory_levels || [];
	if (levels.length === 0) return null;

	const available = levels[0].available;
	inventoryLevelCache.set(key, { available, fetchedAt: now });
	return available;
}

// Helper: actually set inventory level
async function setInventoryLevel(inventoryItemId, locationId, available) {
	console.log(
		`Setting inventory_item_id ${inventoryItemId} at location ${locationId} to available=${available}`
	);

	if (!WRITE_MODE) {
		console.log("WRITE_MODE is false, skipping API call");
		return;
	}

	const resp = await fetch(
		`https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/inventory_levels/set.json`,
		{
			method: "POST",
			headers: {
				"X-Shopify-Access-Token": ADMIN_TOKEN,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				location_id: locationId,
				inventory_item_id: inventoryItemId,
				available: available
			})
		}
	);

	if (!resp.ok) {
		const text = await resp.text();
		console.log(
			`Error setting inventory level for item ${inventoryItemId}: ${resp.status} ${text}`
		);
		return;
	}

	// Update cache with the new known value
	const key = `${inventoryItemId}:${locationId}`;
	inventoryLevelCache.set(key, { available, fetchedAt: Date.now() });

	console.log(`Successfully set inventory level for item ${inventoryItemId}`);
}

// Sync all SKUs in an alias group to a specific available value
async function syncAliasGroup(groupName, locationId, targetAvailable) {
	const groupSkus = rules.aliasGroups[groupName] || [];
	if (groupSkus.length === 0) {
		console.log(`Alias group ${groupName} has no SKUs`);
		return;
	}

	console.log(
		`Alias group ${groupName}: syncing available=${targetAvailable} at location ${locationId} for SKUs [${groupSkus.join(
			", "
		)}]`
	);

	const seenInvIds = new Set();

	for (const sku of groupSkus) {
		const invIds = skuToInventoryItemIds.get(sku) || [];
		for (const invId of invIds) {
			if (seenInvIds.has(invId)) continue;
			seenInvIds.add(invId);

			const current = await fetchAvailableForInventoryItem(invId, locationId);
			if (current == null) {
				console.log(
					`Alias group ${groupName}: no current inventory level for item ${invId}`
				);
				continue;
			}

			if (current === targetAvailable) {
				console.log(
					`Alias group ${groupName}: item ${invId} already at ${targetAvailable}, skipping`
				);
				continue;
			}

			// Pace writes slightly to stay under Shopify's per-second limits
			if (WRITE_MODE) {
				await sleep(300);
			}

			await setInventoryLevel(invId, locationId, targetAvailable);
		}
	}
}

// Helper: get available quantity for one alias group at a location
// Uses the webhook value for the group that actually changed when possible
async function fetchAvailableForGroup(groupName, locationId, webhookContext) {
	if (webhookContext && webhookContext.groupsForSku.includes(groupName)) {
		return webhookContext.available;
	}

	const groupSkus = rules.aliasGroups[groupName];
	if (!groupSkus || groupSkus.length === 0) {
		console.log(`Group ${groupName} has no SKUs defined`);
		return null;
	}

	const repSku = groupSkus[0];
	const invIds = skuToInventoryItemIds.get(repSku) || [];
	if (invIds.length === 0) {
		console.log(
			`No inventory_item_id found for representative SKU ${repSku} (group ${groupName})`
		);
		return null;
	}

	const repInvId = invIds[0];
	return await fetchAvailableForInventoryItem(repInvId, locationId);
}

app.post("/webhooks/inventory", async (req, res) => {
	const body = req.body;

	console.log("Inventory webhook received:");
	console.log(JSON.stringify(body, null, 2));

	const invId = body.inventory_item_id;
	const locationId = body.location_id;
	const available = body.available;

	// 1) Location guard: only act on your main location
	if (ALLOWED_LOCATION_ID && String(locationId) !== String(ALLOWED_LOCATION_ID)) {
		console.log(
			`Ignoring webhook for location ${locationId} (allowed location is ${ALLOWED_LOCATION_ID})`
		);
		res.status(200).send("ok");
		return;
	}

	// 2) Seed cache with the value from the webhook (we know it's current)
	const cacheKey = `${invId}:${locationId}`;
	inventoryLevelCache.set(cacheKey, {
		available,
		fetchedAt: Date.now()
	});

	// 3) Duplicate webhook suppression: same item, same qty, within 2 seconds
	const last = recentEvents.get(cacheKey);
	if (last && last.available === available && Date.now() - last.ts < 2000) {
		console.log(
			`Duplicate webhook for item ${invId} at location ${locationId} with available=${available}, ignoring`
		);
		res.status(200).send("ok");
		return;
	}
	recentEvents.set(cacheKey, { available, ts: Date.now() });

	const sku = inventoryItemIdToSku.get(invId);
	if (!sku) {
		console.log(`Unknown inventory_item_id ${invId}, ignoring`);
		res.status(200).send("ok");
		return;
	}

	console.log(
		`Webhook for SKU ${sku} at location ${locationId}, available=${available}`
	);

	// Find alias groups this SKU belongs to
	const groupsForSku = [];
	for (const [groupName, skus] of Object.entries(rules.aliasGroups)) {
		if (skus.includes(sku)) {
			groupsForSku.push(groupName);
		}
	}

	if (groupsForSku.length === 0) {
		console.log("No alias groups configured for this SKU. Nothing to do.");
		res.status(200).send("ok");
		return;
	}

	console.log(
		`SKU ${sku} belongs to alias groups: ${groupsForSku.join(", ")}`
	);

	try {
		// 1) Sync alias groups (driver/passenger groups)
		for (const groupName of groupsForSku) {
			await syncAliasGroup(groupName, locationId, available);
		}

		// 2) Handle any sets that use one of these groups as a component
		const affectedSets = rules.sets.filter((set) =>
			set.components.some((c) => groupsForSku.includes(c))
		);

		if (affectedSets.length === 0) {
			console.log("No set rules affected by this change.");
			res.status(200).send("ok");
			return;
		}

		const webhookContext = { groupsForSku, available };

		for (const set of affectedSets) {
			const componentQtys = [];

			for (const compGroup of set.components) {
				const qty = await fetchAvailableForGroup(
					compGroup,
					locationId,
					webhookContext
				);
				if (qty == null) {
					console.log(
						`Missing quantity for component group ${compGroup} in set ${set.setGroup}`
					);
					continue;
				}
				componentQtys.push(qty);
			}

			if (componentQtys.length !== set.components.length) {
				console.log(
					`Skipping set ${set.setGroup}: not all component quantities available`
				);
				continue;
			}

			const setQty = Math.min(...componentQtys);
			const setSkus = rules.aliasGroups[set.setGroup];

			console.log(
				`Set rule ${set.setGroup}: component groups ${
					set.components
				} have quantities [${componentQtys.join(
					", "
				)}]; syncing all set SKUs [${setSkus.join(
					", "
				)}] to available=${setQty} at location ${locationId}`
			);

			await syncAliasGroup(set.setGroup, locationId, setQty);
		}

		res.status(200).send("ok");
	} catch (err) {
		console.log("Error handling webhook:", err);
		res.status(500).send("error");
	}
});

// Start: build maps, then listen
(async () => {
	try {
		await fetchAllVariants();
		app.listen(PORT, () => {
			console.log(`Server listening on port ${PORT}`);
		});
	} catch (err) {
		console.error("Startup error:", err);
		process.exit(1);
	}
})();
