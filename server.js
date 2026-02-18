require("dotenv").config();
const express = require("express");
const Stripe = require("stripe");
const { Pool } = require("pg");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());

// ----------------------
// Database Setup
// ----------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // needed for Render
});

// Helper: get settings row
async function getSettings() {
  const res = await pool.query("SELECT * FROM settings WHERE id = 1");
  return res.rows[0];
}

// ----------------------
// Public Routes
// ----------------------

app.get("/api/config", async (req, res) => {
  const settings = await getSettings();
  const options =
    settings.mode === "single"
      ? [settings.option1]
      : [settings.option1, settings.option2].filter(Boolean);
  res.json({ mode: settings.mode, options });
});

app.post("/api/create-payment-intent", async (req, res) => {
  try {
    const { amount } = req.body;

    const settings = await getSettings();
    const allowedAmounts =
      settings.mode === "single"
        ? [settings.option1]
        : [settings.option1, settings.option2].filter(Boolean);

    if (!allowedAmounts.includes(amount)) {
      return res.status(400).json({ error: "Invalid donation amount." });
    }

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount,
        currency: "usd",
        payment_method_types: ["card_present"],
        capture_method: "automatic"
      },
      { idempotencyKey: uuidv4() }
    );

    // Optional: log in donations table
    await pool.query(
      "INSERT INTO donations (amount, payment_intent_id, status) VALUES ($1, $2, $3)",
      [amount, paymentIntent.id, "created"]
    );

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Payment intent failed." });
  }
});

app.post("/api/connection-token", async (req, res) => {
  const token = await stripe.terminal.connectionTokens.create();
  res.json({ secret: token.secret });
});

// ----------------------
// Admin Route
// ----------------------

app.post("/api/admin/update-config", async (req, res) => {
  const { mode, option1, option2, adminKey } = req.body;

  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  await pool.query(
    `UPDATE settings
     SET mode = $1, option1 = $2, option2 = $3, updated_at = NOW()
     WHERE id = 1`,
    [mode, option1, option2 || null]
  );

  res.json({ success: true });
});

// ----------------------

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
