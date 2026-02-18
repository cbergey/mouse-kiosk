require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());
const path = require("path");
app.use(express.static(path.join(__dirname, "public")));

// ----------------------
// Database Setup
// ----------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // needed on Render
});

// Helper to get settings row
async function getSettings() {
  const res = await pool.query("SELECT * FROM settings WHERE id = 1");
  return res.rows[0];
}

// ----------------------
// Stripe Initialization (deferred)
// ----------------------

let stripe; // will initialize only if key exists

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripe) stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

// ----------------------
// Public Routes
// ----------------------

// Fetch donation config (1–2 options)
app.get("/api/config", async (req, res) => {
  try {
    const settings = await getSettings();
    const options =
      settings.mode === "single"
        ? [settings.option1]
        : [settings.option1, settings.option2].filter(Boolean);
    res.json({ mode: settings.mode, options });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch config." });
  }
});

// Create PaymentIntent
app.post("/api/create-payment-intent", async (req, res) => {
  const { amount } = req.body;
  const settings = await getSettings();
  const allowedAmounts =
    settings.mode === "single"
      ? [settings.option1]
      : [settings.option1, settings.option2].filter(Boolean);

  if (!allowedAmounts.includes(amount)) {
    return res.status(400).json({ error: "Invalid donation amount." });
  }

  const stripeInstance = getStripe();
  if (!stripeInstance) {
    // Placeholder for testing without Stripe key
    return res.json({
      clientSecret: "sk_test_placeholder",
      note: "Stripe key missing. This is a placeholder for testing."
    });
  }

  try {
    const paymentIntent = await stripeInstance.paymentIntents.create(
      {
        amount,
        currency: "usd",
        payment_method_types: ["card_present"],
        capture_method: "automatic"
      },
      { idempotencyKey: uuidv4() }
    );

    // Optional: log donation locally
    await pool.query(
      "INSERT INTO donations (amount, payment_intent_id, status) VALUES ($1, $2, $3)",
      [amount, paymentIntent.id, "created"]
    );

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PaymentIntent creation failed." });
  }
});

// Connection token for Stripe Terminal
app.post("/api/connection-token", async (req, res) => {
  const stripeInstance = getStripe();
  if (!stripeInstance) {
    return res.json({ secret: "placeholder_connection_token" });
  }

  try {
    const token = await stripeInstance.terminal.connectionTokens.create();
    res.json({ secret: token.secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create connection token." });
  }
});

// ----------------------
// Admin Routes
// ----------------------

app.post("/api/admin/update-config", async (req, res) => {
  const { mode, option1, option2, adminKey } = req.body;

  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    await pool.query(
      `UPDATE settings
       SET mode = $1, option1 = $2, option2 = $3, updated_at = NOW()
       WHERE id = 1`,
      [mode, option1, option2 || null]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update config." });
  }
});

// ----------------------

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
