import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import fs from "fs";

const rules = JSON.parse(fs.readFileSync("./rules.json", "utf8"));

const app = express();
const PORT = process.env.PORT || 8080;

const SHOP = process.env.SHOPIFY_SHOP; // e.g. "van44-overlanding-gear"
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = "2025-10";

if (!SHOP || !ADMIN_TOKEN) {
  console.error("Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_API_TOKEN env vars");
  process.exit(1);
}

app.use(bodyParser.json());

// Maps built at startup
const inventoryItemIdToSku = new Map();   // inventory_item_id -> sku
const skuToInventoryItemIds = new Map();  // sku -> [inventory_item_id]

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

    // Handle pagination using Link header if present
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

// Helper: get available quantity for one alias group at a location
async function fetchAvailableForGroup(groupName, locationId, webhookContext) {
  // If this group is the one from the webhook, we already know its quantity
  if (
    webhookContext &&
    webhookContext.groupsForSku.includes(groupName)
  ) {
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

  const resp = await fetch(
    `https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/inventory_levels.json?inventory_item_ids=${repInvId}&location_ids=${locationId}`,
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
      `Error fetching inventory level for group ${groupName}: ${resp.status} ${text}`
    );
    return null;
  }

  const data = await resp.json();
  const levels = data.inventory_levels || [];
  if (levels.length === 0) {
    console.log(`No inventory level found for group ${groupName}`);
    return null;
  }

  return levels[0].available;
}

app.post("/webhooks/inventory", async (req, res) => {
  const body = req.body;

  console.log("Inventory webhook received:");
  console.log(JSON.stringify(body, null, 2));

  const invId = body.inventory_item_id;
  const locationId = body.location_id;
  const available = body.available;

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

  // Dry-run: show what we'd sync within each alias group
  for (const groupName of groupsForSku) {
    const groupSkus = rules.aliasGroups[groupName];
    console.log(
      `Alias group ${groupName}: would sync available=${available} to SKUs [${groupSkus.join(
        ", "
      )}] at location ${locationId}`
    );
  }

  // Now handle any sets that use one of these groups as a component
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
      )}]; would set all set SKUs [${setSkus.join(
        ", "
      )}] to available=${setQty} at location ${locationId}`
    );
  }

  res.status(200).send("ok");
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
