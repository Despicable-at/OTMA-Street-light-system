import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));
const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}

check("Supabase project configuration and database version", () => {
  const config = read("supabase/config.toml");
  assert.match(config, /project_id\s*=\s*"otma-streetlight-portal"/);
  assert.match(config, /major_version\s*=\s*17/);
  assert.match(config, /enable_signup\s*=\s*false/, "public staff self-signup must remain disabled");
  for (const name of ["create-report", "track-report", "public-stats", "contact-message", "admin-invite", "report-action", "photo-url", "maintenance-action", "admin-overview"]) {
    assert.match(config, new RegExp(`\\[functions\\.${name}\\]`));
  }
});

check("no demo streetlight, report, or user fixtures are packaged", () => {
  assert.equal(exists("fixtures/streetlights.json"), false);
  const seed = read("supabase/seed.sql");
  assert.doesNotMatch(seed, /insert\s+into\s+public\.(streetlights|fault_reports|profiles)/i);
  assert.doesNotMatch(seed, /OTMA-SL-|OTMA-RPT-/);
  assert.equal(read("../otma-streetlight-homepage/js/main.js").includes("data/streetlights.json"), false);
  assert.ok(exists("supabase/migrations/202611170001_remove_demo_records.sql"));
  assert.match(read("supabase/migrations/202611170001_remove_demo_records.sql"), /delete from public\.streetlights where is_demo = true/i);
});

check("live report trigger maintains operational asset status", () => {
  const sql = read("supabase/migrations/202611140001_initial_schema.sql");
  assert.match(sql, /if not new\.is_demo then[\s\S]*?Your fault report has been received/);
  assert.match(sql, /if not new\.is_demo and new\.streetlight_id is not null then/);
  assert.match(sql, /set status = 'under_repair'/);
});

check("all application tables in initial migration enable RLS", () => {
  const sql = read("supabase/migrations/202611140001_initial_schema.sql");
  const tables = ["communities", "profiles", "streetlights", "fault_reports", "report_events", "report_notes", "report_confirmations", "maintenance_jobs", "spare_parts", "stock_movements", "contact_messages", "app_settings", "audit_logs", "request_rate_limits"];
  for (const table of tables) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"), `RLS missing: ${table}`);
  }
});

check("hardening migration includes workflow guardrails and private views", () => {
  const sql = read("supabase/migrations/202611140002_workflow_security_and_api.sql");
  for (const token of ["validate_fault_report_update", "staff_directory", "staff_admin_directory", "consume_request_rate_limit", "public_statistics_summary", "audit_row_change", "apply_stock_movement", "after-repair photograph is required"]) {
    assert.ok(sql.toLowerCase().includes(token.toLowerCase()), `missing migration capability: ${token}`);
  }
  assert.match(sql, /report_photos_staff_read/);
  assert.match(sql, /repair_photos_staff_read/);
  assert.match(sql, /report_photos_staff_read[\s\S]*?assigned_to/);
  assert.match(sql, /repair_photos_staff_read[\s\S]*?assigned_to/);
  assert.match(sql, /stock_movements_apply_balance/);
  assert.match(sql, /revoke insert, update on public\.spare_parts from authenticated/i);
  assert.doesNotMatch(sql, /create trigger spare_parts_stock_ledger/i, "stock ledger must not recurse into itself");
  const baseSchema = read("supabase/migrations/202611140001_initial_schema.sql");
  assert.match(baseSchema, /streetlights_public[\s\S]*?where s\.is_demo = false/i, "public inventory must hide non-operational rows");
  assert.match(sql, /prevent_client_demo_flag_changes/);
  assert.match(sql, /if not new\.is_demo and new\.streetlight_id is not null then/);
  assert.match(sql, /streetlight_id_seq/);
  assert.match(sql, /grant usage, select on sequence public\.streetlight_id_seq to authenticated/i);
});

check("every Edge Function has CORS handling and no frontend service-role key", () => {
  const functions = ["create-report", "track-report", "public-stats", "contact-message", "admin-invite", "report-action", "photo-url", "maintenance-action", "admin-overview"];
  for (const name of functions) {
    const source = read(`supabase/functions/${name}/index.ts`);
    assert.match(source, /preflight\(req\)/, `${name} is missing origin validation`);
    assert.match(source, /Deno\.serve/, `${name} is missing Deno.serve`);
  }
  const helper = read("supabase/functions/_shared/cors.ts");
  assert.match(helper, /allowedOrigins\.includes\(origin\)/);
  assert.doesNotMatch(helper, /allowedOrigins\.includes\(["']\*["']\)/, "wildcard CORS must not be accepted");
  assert.doesNotMatch(read(".env.production.example"), /sb_secret_[A-Za-z0-9]+/);
  assert.match(read("supabase/functions/create-report/index.ts"), /eq\("is_demo", false\)/, "public reports must not bind to demo-only inventory records");
  const overview = read("supabase/functions/admin-overview/index.ts");
  assert.match(overview, /findAreaOutages/);
  assert.match(overview, /radiusMeters:\s*300[\s\S]*?windowHours:\s*24[\s\S]*?minimum:\s*3/);
  assert.doesNotMatch(overview, /reporter_phone|reporter_name|description/);
});

check("OpenAPI contract and Swagger UI page are packaged", () => {
  const spec = read("openapi/openapi.yaml");
  assert.match(spec, /openapi:\s*3\.1\.0/);
  for (const route of ["/create-report", "/track-report", "/public-stats", "/contact-message", "/admin-invite", "/report-action", "/photo-url", "/maintenance-action", "/admin-overview"]) {
    assert.ok(spec.includes(route), `OpenAPI route missing: ${route}`);
  }
  assert.ok(exists("docs/index.html"));
  assert.match(read("docs/index.html"), /SwaggerUIBundle/);
  assert.equal(read("docs/openapi.yaml"), spec);
});


check("database pgTAP suite is complete and seed data is empty", () => {
  const dbTests = read("supabase/tests/database.test.sql");
  const plan = Number(dbTests.match(/select plan\((\d+)\);/i)?.[1]);
  const assertions = (dbTests.match(/^select (?!plan\(|\* from finish\()(?=has_|ok\()/gim) ?? []).length;
  assert.equal(assertions, plan, `pgTAP plan says ${plan}; found ${assertions} assertions`);
  const seed = read("supabase/seed.sql");
  assert.doesNotMatch(seed, /insert\s+into\s+public\.(streetlights|fault_reports|profiles|spare_parts|stock_movements)/i);
});

check("database schema documentation and first-admin bootstrap exist", () => {
  assert.ok(exists("docs/SCHEMA-REFERENCE.md"));
  assert.ok(exists("scripts/bootstrap-first-admin.sql"));
  assert.match(read("docs/SCHEMA-REFERENCE.md"), /reporter.*personal|personal.*reporter/i);
  assert.match(read("docs/SCHEMA-REFERENCE.md"), /## Column reference/);
  assert.ok(exists("deployment-templates/deploy-swagger-pages.yml"));
});

console.log(`\n${checks.length} project checks passed.`);
