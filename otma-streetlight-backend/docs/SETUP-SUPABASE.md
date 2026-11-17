# Supabase project setup and deployment (Windows-friendly)

This guide creates a Supabase project, applies the OTMA database schema, configures secrets, bootstraps the first administrator and deploys the Edge Functions.

> Use a development/test project first. The project starts without seeded operational records.

## 1. Create your Supabase project

1. Go to [https://supabase.com](https://supabase.com) and create/sign in to an account.
2. Create a new organisation if necessary.
3. Select **New project**.
4. Name it `otma-streetlight-portal-dev` (or a clear development name).
5. Choose the **Free** plan for initial development.
6. Choose the region nearest to Ghana from the regions currently offered in the dashboard. Save the database password in a password manager.
7. Wait until the project status is healthy/ready.
8. Open **Project Settings → API** (or the API Keys page in the current dashboard) and note:
   - Project URL
   - Publishable key (preferred for new projects) or legacy anon key
   - Project reference, shown in the project URL/dashboard URL

Do not put a Supabase secret/service-role key in the frontend or Swagger UI.

## 2. Install the local tools

Install:

- Node.js 20 or newer: [https://nodejs.org](https://nodejs.org)
- Git (optional but recommended): [https://git-scm.com](https://git-scm.com)
- Supabase CLI. On Windows, the supported Scoop route is:

```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

Or run the CLI through `npx` from this package (Node 20+ is required):

```powershell
npx --yes supabase --version
```

For a full local database test stack, install Docker Desktop. Remote schema/function deployment can use the CLI API deployment path and does not require running the local containers.

## 3. Open the backend folder and link it to Supabase

The folder layout should be:

```text
OTMA-Streetlight-Portal/
├── otma-streetlight-homepage/
└── otma-streetlight-backend/
```

Open PowerShell inside `otma-streetlight-backend` and run:

```powershell
npx --yes supabase login
npx --yes supabase link --project-ref YOUR_PROJECT_REF
```

Replace `YOUR_PROJECT_REF` with the project reference you copied from Supabase. The CLI may ask for the database password you created earlier.

## 4. Apply the schema migrations

For a **clean remote development project without seeded operational records**, preview and apply the numbered migrations:

```powershell
npx --yes supabase db push --dry-run --remote
npx --yes supabase db push --remote
```

The preview shows which migrations will be applied before the database changes. The migrations create the schema but do not insert operational records.

The seed file is intentionally empty; import only approved OTMA operational records.

For a local development database, start the Supabase stack. It will start without streetlight, report, staff or stock fixtures.

## 5. Create the first administrator

The schema creates a `pending`/inactive profile when an Auth user is created. This prevents a newly created account from receiving staff access automatically.

1. In the Supabase Dashboard open **Authentication → Users**.
2. Create the first trusted OTMA administrator account. For a test project you can add a user through the dashboard and set a password.
3. Open **SQL Editor**.
4. Open `scripts/bootstrap-first-admin.sql` in this project.
5. Replace both occurrences of `REPLACE_WITH_FIRST_ADMIN_EMAIL@example.com` with the exact email address of the first administrator.
6. Run the SQL and confirm that one row is returned with role `administrator` and `is_active = true`.
7. Sign in through the OTMA admin login after the frontend integration phase.

The bootstrap SQL must be run by the project owner in the Supabase SQL Editor. Do not expose it as a public endpoint. Once the first admin exists, invite further accounts using the protected `admin-invite` function.

### Email invitations

Supabase's default test SMTP service only sends to pre-authorised project team addresses. To invite real municipal staff by email, configure a trusted custom SMTP provider in **Authentication → SMTP Settings** and verify the sender domain. No email provider credentials are included in this repository.

## 6. Configure Edge Function secrets

The hosted functions receive `SUPABASE_URL` and Supabase API keys from the platform. Set only the two application secrets below.

1. Copy `.env.production.example` to `.env.production` in the backend folder.
2. Set `ALLOWED_ORIGINS` to the exact origin(s) that will call the API, comma-separated. For now use your local dev origin and the future Vercel domain, for example:

```dotenv
ALLOWED_ORIGINS=http://localhost:8000,https://YOUR-FRONTEND.vercel.app,https://YOUR-API-DOCS.vercel.app
RATE_LIMIT_SALT=REPLACE_WITH_A_RANDOM_SECRET
```

3. Generate the rate-limit salt from PowerShell with Node.js:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

4. Replace `REPLACE_WITH_A_RANDOM_SECRET` with the generated value.
5. Upload the secrets to the linked Supabase project:

```powershell
npx --yes supabase secrets set --env-file .env.production
```

The `.env.production` file is ignored by Git. Do not share it or put the salt in the frontend.

For local Edge Function development, copy `supabase/functions/.env.example` to `supabase/functions/.env`, fill the local URL and local keys printed by `supabase status`, and use:

```powershell
npx --yes supabase functions serve --env-file supabase/functions/.env
```

## 7. Deploy the Edge Functions

Deploy all configured functions:

```powershell
npx --yes supabase functions deploy --use-api
```

This package includes:

- `create-report`
- `track-report`
- `public-stats`
- `contact-message`
- `admin-invite`
- `report-action`
- `photo-url`
- `maintenance-action`
- `admin-overview`

The functions are configured with platform JWT verification disabled because each protected function validates the Bearer access token with Supabase Auth and independently checks the active profile/role. Never remove those handler checks. Public endpoints still use rate limiting and server-side input validation.

## 8. Run the database tests

After linking a local Docker/Supabase environment (or after applying migrations to a dedicated test project), run:

```powershell
npx --yes supabase test db
```

The pgTAP suite checks schema objects, RLS coverage, private photo buckets, public data isolation, the stock ledger trigger and direct privilege restrictions. Do not run test fixtures against a live municipal database.

## 9. Confirm the API

The function base URL is:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1
```

Public statistics health check:

```powershell
curl.exe https://YOUR_PROJECT_REF.supabase.co/functions/v1/public-stats `
  -H "apikey: YOUR_PUBLISHABLE_KEY"
```

An empty clean database should return zero/null live metrics and a `data_status` saying that no verified live records are loaded. This is expected: no operational records have been imported yet.

The full endpoint contract is in `openapi/openapi.yaml` and rendered by Swagger UI at `docs/index.html`.

## 10. Host Swagger UI on Vercel

The included Swagger UI is a static site. Do not try to serve the HTML from a Supabase Edge Function: Supabase Edge Functions are for API responses, not a general static website host.

For a separate documentation deployment:

1. Create a new Vercel project and import the repository containing `otma-streetlight-backend`.
2. Set **Root Directory** to `otma-streetlight-backend`.
3. Keep the included `vercel.json` configuration.
4. Deploy the project.
5. Open the Vercel URL; it redirects to the Swagger UI under `/docs/`.
6. In the Swagger server selector, replace `YOUR_PROJECT_REF` with the actual project reference.
7. Add the resulting documentation origin to `ALLOWED_ORIGINS`, then update secrets again if needed.

You can alternatively copy the contents of `docs/` into `otma-streetlight-homepage/api-docs/` during the future frontend integration. That will expose the API reference under the existing Vercel frontend domain.

Swagger UI is included in this package but has not been published to an external URL. Deployment requires your Vercel account and project selection.

## 11. Free-plan limitations and operational safety

Current published Supabase Free allowances include 500 MB PostgreSQL database, 1 GB file storage, 5 GB egress, 50,000 monthly active users and 500,000 Edge Function invocations. These are organization/project quotas as defined by Supabase; verify the live pricing page before provisioning.

- Supabase Free includes a 500 MB database size and 5 GB egress; quotas and policies can change, so review the dashboard before launch.
- Free projects may pause after a week of insufficient activity.
- Free projects do not include automatic database backups. Keep a tested manual export and restore procedure before any real records are entered.
- Supabase's default test SMTP is restricted; use custom SMTP before inviting staff outside the project team.
- Vercel Hobby is intended for personal/non-commercial use. Confirm an eligible hosting plan for the Assembly's official public service.
- Keep the project in development/test status until OTMA verifies the asset list, coordinates, communities, contact details, role assignments, privacy notice and retention policy.
