# OTMA frontend live API configuration

The approved visual design is unchanged. The public site now reads the live streetlight view, submits reports with optional photos, looks up report references, loads aggregate statistics, and sends contact enquiries when live mode is enabled. The admin sign-in uses Supabase Auth and its data adapter loads/saves supported workspace records.

## Configure

1. Deploy the SQL migrations and Edge Functions from `../otma-streetlight-backend` to your Supabase project.
2. Edit `js/config.js` in this folder. Set `SUPABASE_URL` to `https://PROJECT_REF.supabase.co`, `SUPABASE_ANON_KEY` to the Supabase publishable/anon key, and `DEMO_MODE` to `false`.
3. Add the exact Vercel deployment origin to the Edge Function `ALLOWED_ORIGINS` secret. Include localhost during local testing.
4. Redeploy the static frontend to Vercel.
5. Create the first staff user in Supabase Auth and run the first-admin bootstrap SQL as described in the backend setup guide.

Only the publishable/anon key belongs in `js/config.js`. Never put a service-role key, database password, or JWT secret in frontend files.

## Live-connected public features

- `index.html` and `map.html`: public streetlight inventory from `streetlights_public` when live mode is enabled; no local inventory fallback is used.
- `report.html`: sends `multipart/form-data` to `create-report`; displays the official generated reference only after a successful API response.
- `track.html`: queries `track-report` and renders the returned public timeline.
- `statistics.html`: uses `public-stats` for monthly reported/resolved series where available.
- `contact.html`: sends enquiries to `contact-message`.
- `/admin`: staff login uses Supabase Auth; admin workspace attempts to load and persist supported records through the Supabase adapter.

## Test status and limitations

Local JavaScript syntax checks and the backend's 13 unit tests / 10 project checks pass. A live end-to-end test cannot be completed until the Supabase project is deployed and its URL/key are configured. Database pgTAP tests still need to be run against the deployed database (or a local Supabase stack).

Some admin controls in the staff interface are still browser-only workflows; user invitations, full CSV import transaction, advanced stock movements, and all admin action flows require final API-specific wiring and permission tests before production use.
