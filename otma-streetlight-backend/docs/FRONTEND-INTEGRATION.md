# Frontend integration contract (for the next phase)

This document defines how the already-approved static frontend should connect to the backend. It does not change the frontend in this backend-delivery phase.

## Public configuration

The browser needs only:

```js
window.OTMA_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_PUBLISHABLE_KEY",
  DEMO_MODE: false
};
```

`SUPABASE_ANON_KEY` is retained as a frontend variable name for compatibility with the current adapter. A new Supabase publishable key may be supplied there. Never include a secret/service-role key, database password, rate-limit salt or JWT signing secret in this object.

The existing homepage has `js/backend.js` and `js/config.js`. Its current adapter is a starting point only: it must be reconciled against this API contract before setting `DEMO_MODE: false`.

## Function endpoints

Base URL: `https://YOUR_PROJECT_REF.supabase.co/functions/v1`

| Frontend feature | Method / path | Request | Response / notes |
|---|---|---|---|
| Submit citizen fault | `POST /create-report` | `multipart/form-data`: `report` JSON string and optional `photo` | Returns `reference`, status, reported time and SLA due time. |
| Track reference | `POST /track-report` | JSON `{ "reference": "OTMA-RPT-2026-ABCDEFGH" }` | Public-safe report summary and timeline; no personal data or private paths. |
| Public stats | `GET /public-stats` | No body | Aggregate-only stats, excluding `is_demo=true`. |
| Contact form | `POST /contact-message` | JSON `{ name, email, phone?, subject, message }` | Returns message ID and received time. |
| Admin dashboard overview | `GET /admin-overview` | Bearer token required | Returns live KPIs, open fault map, needs-attention lists, recent activity and area-outage clusters. Technicians receive assigned-report scope; no reporter PII is returned. |
| Invite staff | `POST /admin-invite` | JSON `{ email, full_name, role }` | Bearer token required; administrator only. |
| Report action | `POST /report-action` | JSON for verify/assign/start/awaiting_parts/resume/close/add_note; multipart for resolve | Bearer token required; role, assignment and status checks enforced. |
| Read photo | `POST /photo-url` | JSON `{ reference, kind: "report" | "repair" }` | Bearer token required; signed URL expires after 300 seconds. |
| Maintenance actions | `POST /maintenance-action` | JSON actions `create`, `assign`, `reschedule`, `cancel`, `start`, `complete`, `note` | Bearer token required; officers manage schedules and assignments, assigned technicians update their jobs. |

### Create-report multipart body

`report` is a JSON string containing:

```json
{
  "light_id": "OTMA-SL-00001",
  "latitude": 6.735463,
  "longitude": -1.613031,
  "name": "Optional name",
  "phone": "0241234567",
  "fault": "not_working",
  "description": "The light has not turned on for three evenings.",
  "nearby_landmark": "Near the junction"
}
```

Supported `fault` values: `not_working`, `flickering`, `pole_damage`, `exposed_wiring`, `fallen_pole`, `physical_damage`, `other`.

If `light_id` is supplied, the function loads its authoritative coordinates and rejects a supplied point more than 200 metres from that asset. For a map-selected unlisted pole, omit `light_id` and provide the coordinates/landmark.

### Report action body examples

Verify:

```json
{ "reference": "OTMA-RPT-2026-ABCDEFGH", "action": "verify" }
```

Assign:

```json
{ "reference": "OTMA-RPT-2026-ABCDEFGH", "action": "assign", "assigned_to": "TECHNICIAN_AUTH_USER_UUID" }
```

Resolve uses multipart fields `reference`, `action=resolve`, `resolution_action`, `parts_used` (enter `None` when no parts were used), and `after_photo` (required image).

The permitted live status progression is:

```text
received → verified → assigned → in_progress
                              ↘ awaiting_parts → in_progress
in_progress → resolved → closed
```

Reassignment is permitted after a report has been verified; it does not move the report backwards in the workflow. Invalid direct jumps are rejected by the database trigger.

## Direct Supabase REST resources

Base URL: `https://YOUR_PROJECT_REF.supabase.co/rest/v1`

| Resource | Public or staff | Notes |
|---|---|---|
| `streetlights_public` | Public read | Only verified/live (`is_demo=false`) asset records and safe display fields. |
| `communities` | Public read | Active community names. |
| `streetlights` | Staff | Full inventory; administrator/officer writes. |
| `fault_reports` | Staff | Officers/auditors read all; technicians read only assigned reports. For workflow writes use `report-action`. |
| `report_events` | Staff | Workflow event history; technician access limited to assigned jobs. |
| `report_notes` | Staff | Internal notes; never use in public tracking. |
| `maintenance_jobs` | Staff | Officers manage; technicians see assigned jobs. Use `maintenance-action` for validated job actions. |
| `spare_parts` | Staff | On-hand `quantity` is not directly updateable by authenticated users. |
| `stock_movements` | Staff | Insert a signed `quantity_delta`; a database trigger atomically updates the `spare_parts.quantity` balance. |
| `staff_directory` | Staff | Safe names/roles for assignment pickers. |
| `staff_admin_directory` | Administrator | Email/phone fields, administrator only. |
| `app_settings` | Administrator | Admin-managed settings. |
| `audit_logs` | Administrator/auditor | Metadata contains changed field names, not old/new personal values. |

Every authenticated REST call uses the publishable key as `apikey` and the user's Supabase Auth access token as `Authorization: Bearer ...`. Supabase RLS determines which rows and operations are available.

## Role mapping

| Database role | Frontend label | Main permissions |
|---|---|---|
| `administrator` | Administrator | Staff invitations, settings, inventory, reports, maintenance, stock, audit. |
| `assembly_officer` | Assembly Officer | Reports, asset inventory, assignments, repairs oversight, maintenance and spare parts. |
| `technician` | Technician | Assigned jobs/reports, internal notes, repair actions and repair photo upload. |
| `auditor` | Auditor | Read-only report/inventory/audit oversight. |
| `pending` | Pending | No operational access until an administrator activates the profile. |

## Integration cautions

- The current frontend adapter queries `profiles` for the whole staff directory. That only works for administrators under these policies. Replace it with `staff_directory` for safe assignment lists, and query `staff_admin_directory` only for administrators. Do not loosen `profiles` RLS to make a broad profile query work.
- The current UI report statuses and the database statuses need a deliberate mapping: `New` ↔ `received`, `Verified` ↔ `verified`, `Assigned` ↔ `assigned`, `In Progress` ↔ `in_progress`, `Awaiting Parts` ↔ `awaiting_parts`, `Resolved` ↔ `resolved`, `Closed` ↔ `closed`.
- The existing adapter uses broad `upsert` loops. Do not turn those loops on unchanged: replace report status changes with `report-action`, and maintenance mutations with `maintenance-action`. Handle `409` conflicts by refreshing the record.
- For photos, save only storage object paths in database rows. Ask `photo-url` for a five-minute signed URL; do not store public bucket URLs.
- The current demo adapter upserts `spare_parts.quantity`. Replace that with `stock_movements` inserts for every issue/restock; `spare_parts.quantity` is not directly writable by authenticated users. Create a new part with zero quantity, then post its opening balance as a stock movement.
- Only records approved for operational use are returned by public views and statistics.
- Real contacts, reporter data, coordinates and staff details require OTMA approval and an approved privacy/retention procedure before production use.
