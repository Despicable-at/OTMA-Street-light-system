-- Run with: npx supabase test db
create extension if not exists pgtap with schema extensions;

begin;
select plan(27);

select has_table('public', 'communities', 'communities table exists');
select has_table('public', 'profiles', 'staff profiles table exists');
select has_table('public', 'streetlights', 'streetlight inventory table exists');
select has_table('public', 'fault_reports', 'fault reports table exists');
select has_table('public', 'report_events', 'report timeline table exists');
select has_table('public', 'report_notes', 'internal notes table exists');
select has_table('public', 'maintenance_jobs', 'maintenance jobs table exists');
select has_table('public', 'spare_parts', 'spare parts table exists');
select has_table('public', 'stock_movements', 'stock movement ledger exists');
select has_function('public', 'apply_stock_movement', array[]::text[], 'stock ledger balance trigger function exists');
select has_trigger('public', 'stock_movements', 'stock_movements_apply_balance', 'stock movement applies balance atomically');
select ok(
  has_sequence_privilege('authenticated', 'public.streetlight_id_seq', 'USAGE'),
  'authorised inventory writers can use the generated streetlight ID sequence'
);
select ok(
  not has_column_privilege('authenticated', 'public.spare_parts', 'quantity', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.spare_parts', 'quantity', 'INSERT'),
  'authenticated users cannot directly set stock quantities'
);
select has_view('public', 'streetlights_public', 'public streetlight view exists');
select has_view('public', 'staff_directory', 'safe staff directory view exists');
select has_view('public', 'staff_admin_directory', 'administrator staff directory view exists');
select has_function('public', 'public_statistics_summary', array[]::text[], 'aggregate statistics function exists');
select has_function('public', 'consume_request_rate_limit', array['text','text','integer','integer'], 'atomic rate limit function exists');
select ok(
  (select count(*) = 14 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity),
  'all 14 application tables have row level security enabled'
);
select ok(
  (select count(*) = 2 from storage.buckets where id in ('report-photos','repair-photos') and public = false),
  'both evidence photo buckets are private'
);
select ok(
  exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'report_photos_staff_read' and qual ilike '%assigned_to%')
  and exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'repair_photos_staff_read' and qual ilike '%assigned_to%'),
  'technician photo access is limited to assigned reports'
);
select ok(
  not has_function_privilege('anon', 'public.apply_stock_movement()', 'EXECUTE'),
  'stock balance trigger function is not directly executable by anonymous users'
);
select ok(
  (select count(*) = 0 from public.streetlights_public),
  'public inventory view contains no records before an approved import'
);
select ok(
  (select count(*) = 0 from public.streetlights where is_demo = true)
  and (select count(*) = 0 from public.fault_reports where is_demo = true),
  'database starts without seeded non-operational streetlights or reports'
);
select ok(
  not exists (
    select 1 from public.spare_parts p
    left join (select sku, sum(quantity_delta) as ledger_quantity from public.stock_movements group by sku) m using (sku)
    where p.quantity <> coalesce(m.ledger_quantity, 0)
  ),
  'spare-parts balances equal their stock movement ledger totals'
);
select ok(
  (select count(*) = 1 from pg_trigger where tgrelid = 'public.fault_reports'::regclass and tgname = 'fault_reports_validate_update' and not tgisinternal),
  'fault report state transitions are enforced by a database trigger'
);
select ok(
  (select count(*) = 0 from pg_trigger where tgrelid = 'public.spare_parts'::regclass and tgname = 'spare_parts_stock_ledger' and not tgisinternal),
  'there is no recursive spare-parts trigger; stock_movements is the only quantity write path'
);

select * from finish();
rollback;
