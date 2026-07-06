# Value Steward: SQL Intelligence Guide

Your trading bot now maintains a professional SQLite database at `data/steward.db`. 
This allows you to perform "Quantitative Audits" that are impossible with simple text files.

## 1. How to Access the Database

### Option A: Command Line (Fastest)
Run this in your terminal:
```bash
sqlite3 data/steward.db
```
Once inside, you can type your queries. Type `.quit` to exit.

### Option B: DB Browser for SQLite (Recommended)
Download "DB Browser for SQLite" (open source) on your Windows machine. 
Point it to the `data/steward.db` file to see your data in a spreadsheet-like view.

---

## 2. The Schema (The Map)

- **world_context**: Global risk scores (Guardian vs. Scout) and news summaries.
- **intents**: Every decision the bot made (BUY, SELL, HOLD) and the reason why.
- **signals**: The mathematical scores for every stock during every tick.
- **executions**: Actual orders submitted to Alpaca (linked to intents).

---

## 3. Practice Queries (Institutional Level)

Copy and paste these into your SQL terminal to see what the bot is thinking.

### QUERY 1: The "Intelligence Gap"
See exactly where the AI (Scout) and the Rules (Guardian) disagree on risk.
```sql
SELECT date, slot, 
       macro_score as guardian_score, 
       scout_score as ai_score, 
       (scout_score - macro_score) as bull_bear_gap
FROM world_context 
WHERE scout_score IS NOT NULL 
ORDER BY generated_at DESC 
LIMIT 10;
```

### QUERY 2: The "Panic Audit"
Find every time the system triggered an emergency Vol-Stop (Panic Exit).
```sql
SELECT timestamp, symbol, explanation 
FROM intents 
WHERE reason_code = 'VOL_STOP'
ORDER BY timestamp DESC;
```

### QUERY 3: Effectiveness per Regime
Do we trade more often when the world is 'calm' or 'watchful'?
```sql
SELECT w.macro_label, i.action_type, count(*) as frequency
FROM intents i
JOIN world_context w ON i.world_context_id = w.id
GROUP BY w.macro_label, i.action_type
ORDER BY frequency DESC;
```

### QUERY 4: Slippage Audit
Calculate the average difference between our "Fishing" price and the actual market close.
```sql
-- Note: Requires scorecard data to be synced
SELECT symbol, 
       avg(abs(expected_price - entry_close) / expected_price) * 100 as avg_slippage_pct
FROM intents
WHERE expected_price IS NOT NULL
GROUP BY symbol;
```

### QUERY 5: The "Hold" Defender
How many times did the "Strategic Hold" logic save us from selling a winner?
```sql
SELECT count(*) as winner_holds
FROM intents
WHERE reason_code = 'SELL_BLOCKED' 
  AND explanation LIKE '%hold_winner%';
```

---

## 4. Tips for Learning
- Always end your SQL commands with a semicolon `;`.
- Use `LIMIT 10` when exploring a new table so you don't overwhelm your screen.
- Use `JOIN` to connect the "Brain" (intents) to the "World" (world_context).
