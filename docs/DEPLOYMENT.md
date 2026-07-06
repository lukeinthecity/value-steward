Value Steward - Dedicated Device Instantiation Checklist

Purpose
Prepare a dedicated Linux device to run Value Steward 24/7 with GPIO toggles and systemd scheduling.

Assumptions
- Target device is a Linux box (not WSL).
- Repo will live at /home/lukes/value-steward (adjust if different).
- This device will use LIVE trading credentials (paper is only for phased validation).

1) Base OS setup
1. Install a current Ubuntu LTS (or similar).
2. Set system timezone to America/New_York:
   sudo timedatectl set-timezone America/New_York
3. Update packages:
   sudo apt update && sudo apt upgrade -y

2) System dependencies
1. Install Node.js + npm (LTS) and Python 3.12:
   sudo apt install -y nodejs npm python3 python3-venv python3-pip git
2. Verify versions:
   node -v
   npm -v
   python3 --version

3) Repo + virtualenv
1. Clone repo:
   git clone https://github.com/lukeinthecity/value-steward.git
   cd value-steward
2. Python venv:
   python3 -m venv .venv
   . .venv/bin/activate
   pip install -r requirements.txt
   pip install -e .
3. Node deps:
   npm install

4) Environment configuration
1. Copy .env example:
   cp .env.example .env
2. Fill Alpaca LIVE keys + base URL:
   ALPACA_API_KEY_ID=...
   ALPACA_SECRET_KEY=...
   ALPACA_BASE_URL=https://api.alpaca.markets
   (Keep paper keys in a separate .env if you want a quick revert.)
3. Email config (optional):
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=you@gmail.com
   SMTP_PASS=app_password
   VS_EMAIL_POLICY_UPDATES=true
4. Market time alignment:
   VS_MARKET_TIMEZONE=America/New_York
   VS_USE_ALPACA_CLOCK=false

5) Control + GPIO wiring
1. GPIO input file:
   data/gpio-state.json
   fields: trading_enabled, force_no_trade, reason, updated_at
2. LED output file:
   data/led-status.json
   fields: health_ok, market_open, trading_enabled, force_no_trade, can_trade
3. Test GPIO simulation:
   npm run gpio:sim enable
   npm run gpio:once

6) Systemd scheduling (dedicated device)
1. Copy unit files:
   sudo cp docs/systemd/*.service /etc/systemd/system/
   sudo cp docs/systemd/*.timer /etc/systemd/system/
2. Edit units for correct user/path:
   sudo nano /etc/systemd/system/value-steward-*.service
   Update User= and WorkingDirectory=
3. Reload + enable:
   sudo systemctl daemon-reload
   sudo systemctl enable --now value-steward-gpio.service
   sudo systemctl enable --now value-steward-tick.timer
   sudo systemctl enable --now value-steward-world.timer
   sudo systemctl enable --now value-steward-eod.timer
4. Check status:
   systemctl status value-steward-gpio.service
   systemctl list-timers | grep value-steward

7) Pre-flight verification
1. Run time check:
   npm run time:check
2. Run health snapshot:
   npm run health:check
3. World pipeline once:
   npm run world:run
4. EOD dry run (only inside window):
   npm run eod:run

8) Data retention + migration
1. Ensure data/ directory persists across reboots (default is fine).
2. If migrating from WSL, copy:
   config/policy.json
   data/*.json
   data/*.jsonl
   logs/*.jsonl

Notes
- The systemd timers call scheduled wrappers that already guard market windows.
- If you need to pause trading quickly, write to data/gpio-state.json or use:
  npm run controls:disable
  npm run controls:force-no-trade
