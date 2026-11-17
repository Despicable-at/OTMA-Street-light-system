# OTMA Streetlight Portal — data cleanup

This package removes packaged example operational data and placeholder copy while retaining the approved page styling and the real application schema/API.

## Removed from the package

- The frontend `data/streetlights.json` inventory fixture.
- The backend `fixtures/streetlights.json` inventory fixture.
- The previous SQL seed inserts for streetlights, reports, maintenance jobs, spare parts and opening stock. Both seed files are now intentionally empty.
- Local demo users/reports/inventory defaults from the admin workspace. The old browser storage key is cleared on load.
- Hard-coded homepage and dashboard counts, fake recent activity, illustrative repair cards, sample news/community cards, placeholder evidence images and explanatory sample-data notices.

## Database cleanup

A new migration, `202611170001_remove_demo_records.sql`, removes the old seeded records if they were previously loaded into Supabase:

- streetlights and fault reports flagged `is_demo = true`;
- maintenance jobs linked to those records or labelled as old development jobs;
- the old development spare-part SKUs and their opening stock movements;
- dependent report notes, events and confirmations.

It also resets the generated streetlight ID sequence to the next available ID. The migration does not delete authenticated staff accounts. No staff accounts were created by the SQL seed; old browser-only demo users are cleared by the frontend.

## Apply to Supabase

From `otma-streetlight-backend`, after linking the correct Supabase project, run:

```powershell
npx supabase db push --dry-run --remote
npx supabase db push --remote
```

Review the dry-run before applying. Back up the database first if it contains any records you need to preserve. The cleanup migration deletes only records marked non-operational or matching the explicit old development stock identifiers.

## Validation

- Frontend JavaScript syntax checks pass.
- Backend project checks pass.
- Backend unit tests pass.
- No live Supabase database migration was run from this environment.
