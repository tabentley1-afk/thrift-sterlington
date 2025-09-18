# Thrive on Thrift — Sterlington (v3.3)
- Auto-recalculate mileage **and drive minutes** when admin opens a ticket.
- Cost = labor (drive-only) + fuel ($/mile × RT miles).
- Central Time (12‑hour), blackout days, calendar, CSV export.
- Persistent storage supported via `DATA_DIR` and `UPLOAD_DIR`.

## Run locally
```powershell
npm install
Copy-Item .env.example .env
notepad .env  # set GOOGLE_MAPS_API_KEY
npm run init-db
npm start
```
