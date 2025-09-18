# Thrive on Thrift — Sterlington (v3)

### New in this build
- Footer on every page with **Address, Phone, Facebook**.
- **Admin blackout days**: turn off random dates (closed). Calendar shows them and scheduling is blocked.
- Admin Calendar + Availability list; CSV export; Central Time w/ 12‑hour display.
- Donor form has no cost/time estimates; admin controls costs and mileage.
- Admin secret default **password** (change in `.env`).

### Run
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
npm install
Copy-Item .env.example .env
notepad .env   # paste your GOOGLE_MAPS_API_KEY, optionally change ADMIN_SECRET
npm run init-db
npm start
```
Admin: http://localhost:3000/admin

**Origin for mileage**: 10010 US-165, Sterlington, LA 71280
