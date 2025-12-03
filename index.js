import express from "express";
import bodyParser from "body-parser";

const app = express();
const PORT = process.env.PORT || 3000;

// parse JSON bodies
app.use(bodyParser.json());

// simple health check
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// inventory webhook (read-only for now)
app.post("/webhooks/inventory", (req, res) => {
  console.log("Inventory webhook received:");
  console.log(JSON.stringify(req.body, null, 2));
  res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
