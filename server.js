require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

const app = express();

// ----------------------
// Middleware
// ----------------------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ----------------------
// Simple in-process rate limiter (no extra deps)
// ----------------------
function makeRateLimiter(windowMs, max) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || "unknown";
    const count = (hits.get(key) || 0) + 1;
    hits.set(key, count);
    if (count > max) {
      return res.status(429).json({ error: "Too many requests. Please slow down." });
    }
    next();
  };
}

const paymentLimiter = makeRateLimiter(60 * 1000, 20);
const adminLimiter   = makeRateLimiter(15 * 60 * 1000, 10);

// ----------------------
// Config & Validation
// ----------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const REQUIRED_ENV = ["DATABASE_URL", "ADMIN_PASSWORD", "ADMIN_KEY"];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.warn(`⚠️  Warning: Missing environment variable: ${key}`);
  }
}

// ----------------------
// Database Setup
// ----------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on("error", (err) => {
  console.error("Unexpected DB pool error:", err);
});

async function getSettings() {
  const res = await pool.query("SELECT * FROM settings WHERE id = 1");
  if (!res.rows.length) throw new Error("Settings row not found.");
  return res.rows[0];
}

// Ensure DB schema exists on startup
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        mode VARCHAR(10) DEFAULT 'dual',
        option1 INTEGER DEFAULT 500,
        option2 INTEGER,
        option3 INTEGER,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      ALTER TABLE settings ADD COLUMN IF NOT EXISTS option3 INTEGER;

      INSERT INTO settings (id, mode, option1, option2, option3)
      VALUES (1, 'dual', 500, 1000, NULL)
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS donations (
        id SERIAL PRIMARY KEY,
        amount INTEGER NOT NULL,
        payment_intent_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'created',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ Database initialized.");
  } catch (err) {
    console.error("❌ DB init failed:", err.message);
  }
}

// ----------------------
// Stripe Initialization
// ----------------------
let stripe;

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripe) stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

// Validate that amount is an integer number of cents, reasonable range ($1–$10,000)
function isValidAmount(amount) {
  return (
    Number.isInteger(amount) &&
    amount >= 100 &&
    amount <= 1_000_000
  );
}

// ----------------------
// Public Routes
// ----------------------

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Fetch donation config
app.get("/api/config", async (req, res) => {
  try {
    const settings = await getSettings();
    const options = [settings.option1, settings.option2, settings.option3].filter(Boolean);
    res.json({ mode: settings.mode, options });
  } catch (err) {
    console.error("config error:", err);
    res.status(500).json({ error: "Failed to fetch config." });
  }
});

// Create PaymentIntent
app.post("/api/create-payment-intent", paymentLimiter, async (req, res) => {
  const { amount } = req.body;

  if (!isValidAmount(amount)) {
    return res.status(400).json({ error: "Invalid donation amount." });
  }

  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    return res.status(500).json({ error: "Could not load settings." });
  }

  const allowedAmounts = [settings.option1, settings.option2, settings.option3].filter(Boolean);
  if (!allowedAmounts.includes(amount)) {
    return res.status(400).json({ error: "Amount not in allowed options." });
  }

  const stripeInstance = getStripe();
  if (!stripeInstance) {
    // Dev/test mode — return placeholder
    return res.json({
      clientSecret: "sk_test_placeholder",
      note: "Stripe key missing — placeholder response."
    });
  }

  try {
    const idempotencyKey = uuidv4();

    const paymentIntent = await stripeInstance.paymentIntents.create(
      {
        amount,
        currency: "usd",
        payment_method_types: ["card_present"],
        capture_method: "automatic",
        metadata: { source: "donation_kiosk" }
      },
      { idempotencyKey }
    );

    await pool.query(
      "INSERT INTO donations (amount, payment_intent_id, status) VALUES ($1, $2, $3)",
      [amount, paymentIntent.id, "created"]
    ).catch(err => console.error("Failed to log donation:", err)); // non-fatal

    res.json({ clientSecret: paymentIntent.client_secret, intentId: paymentIntent.id });
  } catch (err) {
    console.error("PaymentIntent error:", err);
    const message = err.raw?.message || "Payment setup failed. Please try again.";
    res.status(500).json({ error: message });
  }
});

// Connection token for Stripe Terminal
app.post("/api/connection-token", paymentLimiter, async (req, res) => {
  const stripeInstance = getStripe();
  if (!stripeInstance) {
    return res.json({ secret: "placeholder_connection_token" });
  }

  try {
    const token = await stripeInstance.terminal.connectionTokens.create();
    res.json({ secret: token.secret });
  } catch (err) {
    console.error("Connection token error:", err);
    res.status(500).json({ error: "Failed to create connection token." });
  }
});

// Capture payment after successful card read
app.post("/api/capture-payment", paymentLimiter, async (req, res) => {
  const { intentId } = req.body;
  if (!intentId || typeof intentId !== "string") {
    return res.status(400).json({ error: "Missing intentId." });
  }

  const stripeInstance = getStripe();
  if (!stripeInstance) {
    return res.json({ success: true, note: "Stripe key missing — simulated capture." });
  }

  try {
    const intent = await stripeInstance.paymentIntents.capture(intentId);

    await pool.query(
      "UPDATE donations SET status = $1 WHERE payment_intent_id = $2",
      ["captured", intentId]
    ).catch(err => console.error("Failed to update donation status:", err));

    res.json({ success: true, status: intent.status });
  } catch (err) {
    console.error("Capture error:", err);
    const message = err.raw?.message || "Failed to capture payment.";
    res.status(500).json({ error: message });
  }
});

// Cancel a payment intent (for when user backs out or timeout occurs)
app.post("/api/cancel-payment", paymentLimiter, async (req, res) => {
  const { intentId } = req.body;
  if (!intentId || typeof intentId !== "string") {
    return res.status(400).json({ error: "Missing intentId." });
  }

  const stripeInstance = getStripe();
  if (!stripeInstance) {
    return res.json({ success: true, note: "Simulated cancel." });
  }

  try {
    await stripeInstance.paymentIntents.cancel(intentId);
    await pool.query(
      "UPDATE donations SET status = $1 WHERE payment_intent_id = $2",
      ["cancelled", intentId]
    ).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    // If already captured/cancelled, that's fine
    if (err.code === "payment_intent_unexpected_state") {
      return res.json({ success: true, note: "Already in terminal state." });
    }
    console.error("Cancel error:", err);
    res.status(500).json({ error: "Failed to cancel payment." });
  }
});

// Stripe webhook for async payment status updates
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const stripeInstance = getStripe();
  if (!stripeInstance || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.sendStatus(200);
  }

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripeInstance.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await pool.query(
          "UPDATE donations SET status = 'succeeded' WHERE payment_intent_id = $1",
          [event.data.object.id]
        );
        break;
      case "payment_intent.payment_failed":
        await pool.query(
          "UPDATE donations SET status = 'failed' WHERE payment_intent_id = $1",
          [event.data.object.id]
        );
        break;
    }
  } catch (err) {
    console.error("Webhook handler error:", err);
  }

  res.sendStatus(200);
});

// ----------------------
// Admin Routes
// ----------------------

app.post("/api/check-admin", adminLimiter, (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: "Admin password not configured." });
  }
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: "Incorrect password" });
  }
});

app.post("/api/admin/update-config", adminLimiter, async (req, res) => {
  const { mode, option1, option2, option3, adminPassword } = req.body;

  if (!adminPassword || adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!["single", "dual", "triple"].includes(mode)) {
    return res.status(400).json({ error: "Invalid mode." });
  }

  if (!isValidAmount(option1)) {
    return res.status(400).json({ error: "option1 must be a valid amount in cents." });
  }

  if ((mode === "dual" || mode === "triple") && !isValidAmount(option2)) {
    return res.status(400).json({ error: "option2 must be a valid amount in cents." });
  }

  if (mode === "triple" && !isValidAmount(option3)) {
    return res.status(400).json({ error: "option3 must be a valid amount in cents for triple mode." });
  }

  try {
    await pool.query(
      `UPDATE settings
       SET mode = $1, option1 = $2, option2 = $3, option3 = $4, updated_at = NOW()
       WHERE id = 1`,
      [
        mode,
        option1,
        (mode === "dual" || mode === "triple") ? option2 : null,
        mode === "triple" ? option3 : null
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("update-config error:", err);
    res.status(500).json({ error: "Failed to update config." });
  }
});

// Simple donations summary for admin
app.get("/api/admin/summary", adminLimiter, async (req, res) => {
  const { adminPassword } = req.query;
  if (!adminPassword || adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'succeeded') AS successful_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0) AS total_cents,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS today_count
      FROM donations
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("summary error:", err);
    res.status(500).json({ error: "Failed to fetch summary." });
  }
});

// ----------------------
// Start
// ----------------------
const PORT = process.env.PORT || 4242;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});