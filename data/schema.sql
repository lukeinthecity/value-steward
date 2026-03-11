-- data/schema.sql
-- Value Steward Institutional Database Schema

-- 1. World Context: Captures the state of the world at a specific time
CREATE TABLE IF NOT EXISTS world_context (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    slot TEXT NOT NULL,
    generated_at TIMESTAMP NOT NULL,
    macro_score REAL,
    macro_label TEXT,
    scout_score REAL,
    scout_label TEXT,
    scout_thesis TEXT,
    raw_json TEXT NOT NULL
);

-- 2. Signals: The mathematical attractiveness of assets
CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    symbol TEXT NOT NULL,
    momentum_rank REAL,
    vol_rank REAL,
    drawdown_rank REAL,
    score REAL,
    volatility REAL,
    last_close REAL,
    world_context_id TEXT,
    FOREIGN KEY (world_context_id) REFERENCES world_context(id)
);

-- 3. Intents: The deliberate decisions made by the bot
CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY,
    timestamp TIMESTAMP NOT NULL,
    mode TEXT NOT NULL,
    action_type TEXT NOT NULL,
    symbol TEXT,
    size_pct REAL,
    expected_price REAL,
    reason_code TEXT,
    explanation TEXT,
    pre_risk_exposure_pct REAL,
    post_risk_exposure_pct REAL,
    world_context_id TEXT,
    FOREIGN KEY (world_context_id) REFERENCES world_context(id)
);

-- 4. Executions: Actual orders sent to Alpaca (linked to the intent)
CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    notional REAL NOT NULL,
    fill_price REAL,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (intent_id) REFERENCES intents(id)
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_intents_symbol ON intents(symbol);
CREATE INDEX IF NOT EXISTS idx_intents_timestamp ON intents(timestamp);
CREATE INDEX IF NOT EXISTS idx_world_date ON world_context(date);
