# Verification report — 17 November 2026

This report records checks performed on the cleaned project package.

## Passed

| Check | Result |
|---|---|
| Frontend JavaScript syntax | PASS — all frontend `.js` files passed `node --check` |
| Backend project checks | PASS — 9 checks passed with `npm run check` |
| Backend unit tests | PASS — 13 tests passed, 0 failed with `npm test` |
| Static HTTP smoke test | PASS — public pages, admin pages, API adapter and empty seed file returned HTTP 200 |
| Packaged operational fixtures | PASS — frontend inventory fixture and backend fixture file are absent; both SQL seed files contain no operational inserts |
| Cleanup migration present | PASS — `202611170001_remove_demo_records.sql` is included |

## Not run

The PostgreSQL pgTAP integration suite (`supabase/tests/database.test.sql`) was not executed in this environment. It requires a running PostgreSQL/Supabase test database.

The cleanup migration was not applied to a live Supabase project from this environment. Apply it through `npx supabase db push --remote` after reviewing the dry run and backing up any records that must be retained.

## Production checks still required

Before accepting real citizen or staff records, run pgTAP, apply and verify the migrations in the intended Supabase project, exercise public and staff APIs with authorized test accounts, verify RLS and signed-photo access, configure SMTP and backup/export routines, and obtain OTMA approval for inventory, coordinates, contact details, retention rules and operating responsibilities.
