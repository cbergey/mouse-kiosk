-- Settings table (active donation options)
CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'single', -- 'single' or 'multi'
  option1 INT NOT NULL DEFAULT 500,    -- cents
  option2 INT,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Insert default row if empty
INSERT INTO settings (id, mode, option1, option2)
SELECT 1, 'single', 500, NULL
WHERE NOT EXISTS (SELECT 1 FROM settings);

-- Optional: Donation log table
CREATE TABLE IF NOT EXISTS donations (
  id SERIAL PRIMARY KEY,
  amount INT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  status TEXT
);
