# Systemd Templates (Dedicated Linux)

These unit files are templates for running Value Steward on a dedicated Linux box.
They assume the repo lives at `/home/lukes/value-steward` and that Node/npm are installed.

Files:
- `value-steward-gpio.service`: GPIO bridge daemon (continuous).
- `value-steward-tick.service` + `value-steward-tick.timer`: local tick every 15 minutes during market hours.
- `value-steward-world.service` + `value-steward-world.timer`: scheduled world context runner.
- `value-steward-eod.service` + `value-steward-eod.timer`: scheduled EOD run (guarded).

Install steps:
1. Copy the unit files to `/etc/systemd/system/` (or use a user unit in `~/.config/systemd/user/`).
2. Update the `User=` and `WorkingDirectory=` lines if your paths differ.
3. Reload systemd:
   - `sudo systemctl daemon-reload`
4. Enable and start:
   - `sudo systemctl enable --now value-steward-gpio.service`
   - `sudo systemctl enable --now value-steward-tick.timer`
   - `sudo systemctl enable --now value-steward-world.timer`
   - `sudo systemctl enable --now value-steward-eod.timer`

Notes:
- Timers use `Timezone=America/New_York` so they fire on market time.
- The world/eod services call the scheduled wrappers:
  - `npm run world:run:scheduled`
  - `npm run eod:run:scheduled`
  These scripts guard against off-window execution and duplicate runs.
- If you want to disable LED output from the GPIO daemon, set `VS_GPIO_LED_ENABLED=false`.
