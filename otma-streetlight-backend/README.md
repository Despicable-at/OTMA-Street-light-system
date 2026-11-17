# OTMA Streetlight Portal — Backend & Database

Backend package for the Old Tafo Municipal Assembly Streetlight Portal. It is designed to sit beside `otma-streetlight-homepage` in the project folder:

```text
OTMA-Streetlight-Portal/
├── otma-streetlight-homepage/   # approved static frontend
└── otma-streetlight-backend/    # this package
```

## Technology

- **Supabase** — managed PostgreSQL, Auth, private Storage and Edge Functions.
- **PostgreSQL 17** — relational data, constraints, workflow triggers, RLS and aggregate views/functions.
- **Deno + TypeScript** — server-side Supabase Edge Functions.
- **Node.js 20+** — local domain tests and project checks.
- **OpenAPI 3.1 + Swagger UI 5** — interactive API reference in `docs/`.
- **Vercel** — can host the static Swagger UI separately now, and the frontend plus `/api-docs` after the integration phase.

## Included functionality

### Public endpoints

- `POST /functions/v1/create-report` — create a fault report, optionally upload one JPG/PNG/WebP image (up to 5 MB), and return an `OTMA-RPT-YYYY-XXXXXXXX` reference.
- `POST /functions/v1/track-report` — look up a report reference and return the public-safe workflow timeline only.
- `GET /functions/v1/public-stats` — aggregate statistics, excluding non-operational rows and all personal information.
- `POST /functions/v1/contact-message` — validate and store a public enquiry.

### Protected staff endpoints

- `GET /functions/v1/admin-overview` — staff dashboard KPIs, fault-map points, overdue/hazard/chronic-failure attention lists, activity and 3-in-300-metre/24-hour area-outage clusters; technicians receive assigned-report scope only. No reporter contact fields are returned.
- `POST /functions/v1/admin-invite` — administrator-only invitation using Supabase Auth.
- `POST /functions/v1/report-action` — verify, assign, start, await parts, resume, resolve (with work description, parts-used entry and after-photo) or close a report; add an internal note.
- `POST /functions/v1/photo-url` — create a five-minute signed URL for a report/repair photo after checking the caller's staff role and assignment.
- `POST /functions/v1/maintenance-action` — create, assign, reschedule, cancel, start, complete or annotate a maintenance job with role and assignment checks.

### Database and storage

- 14 RLS-protected application tables.
- Private `report-photos` and `repair-photos` buckets.
- Public-safe `streetlights_public` view (returns operational assets only).
- Safe `staff_directory` view; administrator-only `staff_admin_directory` view.
- Database-enforced report status transitions and resolution evidence.
- Rate-limit records use salted SHA-256 IP hashes, not raw IP addresses.
- Append-only workflow history, internal notes, audit metadata and a movement-first spare-parts stock ledger. All on-hand quantity changes are posted through `stock_movements`; a database trigger applies each delta atomically and rejects negative stock.
- No operational records or staff accounts are seeded. Import only an approved OTMA inventory and invite authorized staff.

## Before deployment

1. Read `docs/SETUP-SUPABASE.md`.
2. Read `docs/SCHEMA-REFERENCE.md` and `docs/FRONTEND-INTEGRATION.md`.
3. Set up a Supabase project and apply the migrations.
4. Bootstrap the first administrator using `scripts/bootstrap-first-admin.sql`.
5. Review `docs/TEST-RESULTS.md` for the checks completed and the database tests still requiring Docker.
5. Set server secrets and deploy the Edge Functions.
6. Open `docs/index.html` locally or deploy the `docs/` Swagger UI as a static Vercel project.

The seed file is intentionally empty. For live use, apply migrations, then import an approved OTMA streetlight register with surveyed coordinates and invite authorized staff through Supabase Auth.

## Run checks

From this folder:

```bash
npm run test:all
```

This runs source/config/schema-contract checks and the Node domain unit tests. The PostgreSQL integration suite is in `supabase/tests/database.test.sql` (27 pgTAP assertions) and is run with:

```bash
npm run test:database
```

The database suite requires the Supabase local stack and a Docker-compatible runtime. Start it with `npx --yes supabase start`, then run `npx --yes supabase db reset` followed by `npx --yes supabase test db`. It is not the same as the database-independent Node tests.

## Local Supabase stack (optional)

Install Docker Desktop, then:

```bash
npx --yes supabase start
npx --yes supabase db reset
npx --yes supabase functions serve --env-file supabase/functions/.env
```

Create `supabase/functions/.env` from `supabase/functions/.env.example` first. The local stack starts with an empty operational database. The CLI prints local API keys; keep the service-role key private.

## Deployment boundary

This package contains deployable source, migrations and deployment instructions. It has **not** been deployed to a live Supabase project because no project reference, account access or secrets were supplied. The Swagger UI is included and ready for static hosting; it has not been published to a public URL. The existing frontend has not been connected to this backend yet—that is the next, separate integration stage.

## Security reminders

- Never put `SUPABASE_SERVICE_ROLE_KEY`, a Supabase secret key, database password or JWT signing secret in the browser frontend, Git, Swagger UI or Vercel client-side environment variables.
- Only the Supabase publishable/legacy anon key belongs in the static frontend, and only after RLS has been tested.
- Public report tracking never returns reporter name, phone, private photo paths or internal notes.
- Configure a real SMTP provider before sending invitations to staff outside the project team.
- Supabase Free currently includes 500 MB database, 1 GB file storage, 5 GB egress, 50,000 monthly active users and 500,000 Edge Function invocations. Check the live pricing page before setup because quotas can change. Free projects can pause after a week of low activity and do not include automatic database backups. This is suitable for development/testing, not a dependable production service without an approved operational/backup plan.
- Vercel Hobby is restricted to personal/non-commercial use. Confirm an appropriate hosting arrangement for an official municipal public service before launch.
