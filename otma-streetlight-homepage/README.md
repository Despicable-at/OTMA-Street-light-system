# OTMA Streetlight Portal — Frontend

The approved public portal and staff workspace for the Old Tafo Municipal Assembly. Operational streetlights, reports, staff profiles, maintenance jobs and stock records are loaded from the configured Supabase project. The project package does not contain seeded operational records or staff accounts.

## Project files

- `index.html` — public portal homepage.
- `map.html` — live streetlight map.
- `report.html` — public fault reporting form.
- `track.html` — report reference lookup.
- `statistics.html` — public aggregate statistics.
- `admin/` — staff sign-in and protected operations pages.
- `js/config.js` — browser-safe Supabase URL and publishable key configuration.
- `js/live-api.js` — public API requests.
- `js/backend.js` — staff authentication and data access.

## Configure

Set `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `DEMO_MODE: false` in `js/config.js`. Use only the Supabase publishable/anon key in browser code. Never place a service-role key or database password in the frontend.

Apply the backend migrations, deploy the Edge Functions and import only an approved OTMA inventory. Invite staff through the protected staff invitation flow.
