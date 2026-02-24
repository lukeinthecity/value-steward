# Value Steward Desktop Console

This is a lightweight Electron shell that renders the Value Steward state in one place:

- Policy + toggles (save back to `config/policy.json`)
- World context (latest slot, tags, macro view)
- Latest market snapshot
- Training summary
- RSS inbox ticker
- Tick countdown + tick log tail

## Run

```bash
cd desktop
npm install
npm start
```

## Notes

- The app reads local files; it does not call external APIs directly.
- The policy editor writes to `config/policy.json`.
- Data refreshes every 30 seconds.
