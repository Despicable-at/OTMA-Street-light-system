-- Remove the development fixtures that may have been loaded by an earlier seed.
-- The project now starts with an empty operational dataset.
begin;

-- Remove maintenance jobs created only for the old development inventory.
delete from public.maintenance_jobs
where notes ilike 'DEMO JOB%'
   or streetlight_id in (select id from public.streetlights where is_demo = true)
   or report_reference in (select reference from public.fault_reports where is_demo = true);

-- Remove dependent report history and reports marked non-operational.
delete from public.report_notes
where report_reference in (select reference from public.fault_reports where is_demo = true);

delete from public.report_events
where report_reference in (select reference from public.fault_reports where is_demo = true);

delete from public.report_confirmations
where report_reference in (select reference from public.fault_reports where is_demo = true);

delete from public.fault_reports where is_demo = true;
delete from public.streetlights where is_demo = true;

-- Remove the five SKUs and opening stock movements from the old development seed.
delete from public.stock_movements
where reason = 'Demonstration opening balance'
   or sku in ('DEMO-LAMP-LED-60W','DEMO-PHOTO-CELL','DEMO-FUSE-10A','DEMO-CABLE-2C','DEMO-TERMINAL');

delete from public.spare_parts
where sku in ('DEMO-LAMP-LED-60W','DEMO-PHOTO-CELL','DEMO-FUSE-10A','DEMO-CABLE-2C','DEMO-TERMINAL');

-- Rewind generated asset IDs so the next registered pole receives the next free ID.
select setval(
  'public.streetlight_id_seq',
  greatest(coalesce((select max(substring(id from 9)::bigint) from public.streetlights where id ~ '^OTMA-SL-[0-9]{5}$'), 0) + 1, 1),
  false
);

commit;
