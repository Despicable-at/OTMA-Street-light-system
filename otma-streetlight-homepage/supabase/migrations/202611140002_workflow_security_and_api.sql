-- OTMA Streetlight Portal — workflow, least-privilege access and API support.
-- Requires 202611140001_initial_schema.sql.

-- Protect the demo/live boundary. Browser-authenticated users cannot create or
-- reclassify rows as demo data to bypass workflow rules or hide real assets from
-- public inventory/statistics. Trusted seed/admin operations use postgres/service_role.
create or replace function public.prevent_client_demo_flag_changes()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if current_user in ('anon','authenticated') then
    if tg_op = 'INSERT' and new.is_demo then
      raise exception 'Client sessions cannot create demo-flagged records.' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.is_demo is distinct from old.is_demo then
      raise exception 'Client sessions cannot change the demo-data flag.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists streetlights_protect_demo_flag on public.streetlights;
create trigger streetlights_protect_demo_flag
before insert or update on public.streetlights
for each row execute function public.prevent_client_demo_flag_changes();

drop trigger if exists reports_protect_demo_flag on public.fault_reports;
create trigger reports_protect_demo_flag
before insert or update on public.fault_reports
for each row execute function public.prevent_client_demo_flag_changes();

-- Assign the next sequential asset ID when staff create an inventory record
-- without supplying one. Seed data advances this sequence after its 60 fixtures.
create sequence if not exists public.streetlight_id_seq start with 1;
alter table public.streetlights alter column id set default
  ('OTMA-SL-' || lpad(nextval('public.streetlight_id_seq')::text, 5, '0'));
-- The default nextval() call needs sequence USAGE for authorised inventory writers.
grant usage, select on sequence public.streetlight_id_seq to authenticated;

-- The browser dashboard uses a restricted directory view for assignment pickers.
-- Do not expose profile phone numbers or authentication metadata to other staff.
create or replace view public.staff_directory
with (security_barrier = true)
as
select p.id, p.full_name, p.role, p.is_active, p.last_seen_at, p.created_at
from public.profiles p
where p.is_active = true and public.is_active_staff();

grant select on public.staff_directory to authenticated;

create or replace view public.staff_admin_directory
with (security_barrier = true)
as
select p.id, p.email, p.full_name, p.phone, p.role, p.is_active, p.last_seen_at, p.created_at
from public.profiles p
where public.has_staff_role(array['administrator']);

grant select on public.staff_admin_directory to authenticated;

-- Correct overly broad initial read policies: technicians see only assigned report
-- activity; internal notes stay within the assigned job / authorised oversight team.
drop policy if exists report_events_staff_read on public.report_events;
create policy report_events_staff_read on public.report_events for select to authenticated
using (
  public.has_staff_role(array['administrator','assembly_officer','auditor'])
  or exists (
    select 1 from public.fault_reports r
    where r.reference = report_reference and r.assigned_to = auth.uid()
  )
);

drop policy if exists report_notes_staff_read on public.report_notes;
create policy report_notes_staff_read on public.report_notes for select to authenticated
using (
  public.has_staff_role(array['administrator','assembly_officer','auditor'])
  or exists (
    select 1 from public.fault_reports r
    where r.reference = report_reference and r.assigned_to = auth.uid()
  )
);

-- Profiles are private. Use staff_directory for assignment pickers and the
-- administrator-only staff_admin_directory for account management.
drop policy if exists profiles_read_self_or_admin on public.profiles;
create policy profiles_read_self_or_admin on public.profiles for select to authenticated
using (id = auth.uid() or public.has_staff_role(array['administrator']));

-- Database-enforced workflow transitions and resolution evidence.
create or replace function public.validate_fault_report_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transition_allowed boolean := false;
begin
  if new.status is distinct from old.status then
    -- Demo fixtures are intentionally flexible so that the admin UI can be tested.
    -- Real reports must follow the state machine below.
    if not new.is_demo then
      v_transition_allowed := case old.status
        when 'received' then new.status = 'verified'
        when 'verified' then new.status = 'assigned'
        when 'assigned' then new.status = 'in_progress'
        when 'in_progress' then new.status in ('awaiting_parts','resolved')
        when 'awaiting_parts' then new.status = 'in_progress'
        when 'resolved' then new.status = 'closed'
        else false
      end;

      if not v_transition_allowed then
        raise exception 'Invalid report status transition: % -> %', old.status, new.status
          using errcode = '23514';
      end if;

      if new.status in ('assigned','in_progress','awaiting_parts') and new.assigned_to is null then
        raise exception 'A technician must be assigned before this status is used.'
          using errcode = '23514';
      end if;

      if new.status = 'resolved' then
        if char_length(trim(coalesce(new.resolution_action, ''))) < 10 then
          raise exception 'Resolution action must contain at least 10 characters.'
            using errcode = '23514';
        end if;
        if char_length(trim(coalesce(new.parts_used, ''))) < 1 then
          raise exception 'Record parts used, or enter None.'
            using errcode = '23514';
        end if;
        if nullif(trim(coalesce(new.after_photo_path, '')), '') is null then
          raise exception 'An after-repair photograph is required before resolution.'
            using errcode = '23514';
        end if;
        new.resolved_at := coalesce(new.resolved_at, now());
      end if;

      if new.status = 'closed' then
        if old.status <> 'resolved' then
          raise exception 'A report must be resolved before it can be closed.'
            using errcode = '23514';
        end if;
        new.closed_at := coalesce(new.closed_at, now());
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists fault_reports_validate_update on public.fault_reports;
create trigger fault_reports_validate_update
before update of status on public.fault_reports
for each row execute function public.validate_fault_report_update();

-- Replace the starter trigger so demo fixtures do not mutate asset status, and active
-- concurrent live reports determine the linked asset's operational status.
create or replace function public.record_report_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message text;
  v_has_open boolean := false;
  v_has_repair boolean := false;
begin
  if tg_op = 'INSERT' then
    -- Demo fixtures already carry a curated historical timeline in seed.sql.
    -- Do not add a duplicate current-time event during database reset.
    if not new.is_demo then
      insert into public.report_events(
        report_reference, event_type, from_status, to_status, public_message, actor_id
      ) values (
        new.reference, 'status_change', null, new.status,
        'Your fault report has been received by the Assembly.', new.created_by
      );
    end if;
  elsif new.status is distinct from old.status then
    v_message := case new.status
      when 'received' then 'Your fault report has been received.'
      when 'verified' then 'The Assembly has verified the reported fault.'
      when 'assigned' then 'The report has been assigned to a maintenance team.'
      when 'in_progress' then 'Work on the reported fault is in progress.'
      when 'awaiting_parts' then 'The repair is awaiting required replacement parts.'
      when 'resolved' then 'The reported fault has been repaired and recorded as resolved.'
      when 'closed' then 'The work order has been closed.'
      else 'Your report has been updated.'
    end;
    insert into public.report_events(
      report_reference, event_type, from_status, to_status, public_message, actor_id
    ) values (
      new.reference, 'status_change', old.status, new.status, v_message,
      coalesce(new.updated_by, auth.uid())
    );
  end if;

  if not new.is_demo and new.streetlight_id is not null then
    select
      count(*) > 0,
      coalesce(bool_or(status in ('in_progress','awaiting_parts')), false)
    into v_has_open, v_has_repair
    from public.fault_reports
    where streetlight_id = new.streetlight_id
      and reference <> new.reference
      and is_demo = false
      and status not in ('resolved','closed');

    if new.status not in ('resolved','closed') then
      update public.streetlights
      set status = case
        when new.status in ('in_progress','awaiting_parts') or v_has_repair then 'under_repair'
        else 'faulty'
      end
      where id = new.streetlight_id and status <> 'out_of_service';
    elsif not v_has_open then
      update public.streetlights
      set status = 'working', last_repaired_date = current_date
      where id = new.streetlight_id and status <> 'out_of_service';
    else
      update public.streetlights
      set status = case when v_has_repair then 'under_repair' else 'faulty' end
      where id = new.streetlight_id and status <> 'out_of_service';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists fault_reports_status_event on public.fault_reports;
create trigger fault_reports_status_event
after insert or update of status on public.fault_reports
for each row execute function public.record_report_status_change();

-- Keep fault_report updated_at consistent for all staff and API changes.
drop trigger if exists fault_reports_set_updated_at on public.fault_reports;
create trigger fault_reports_set_updated_at
before update on public.fault_reports
for each row execute function public.set_updated_at();

-- Atomic, privacy-preserving request rate limits. Only service_role may call this.
create or replace function public.consume_request_rate_limit(
  p_ip_hash text,
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_ip_hash is null or length(p_ip_hash) < 32
     or p_action is null or length(p_action) > 60
     or p_limit < 1 or p_limit > 1000
     or p_window_seconds < 1 or p_window_seconds > 604800 then
    raise exception 'Invalid rate limit parameters.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_ip_hash || ':' || p_action, 0));
  delete from public.request_rate_limits where created_at < now() - interval '48 hours';
  select count(*) into v_count
  from public.request_rate_limits
  where ip_hash = p_ip_hash
    and action = p_action
    and created_at >= now() - make_interval(secs => p_window_seconds);

  if v_count >= p_limit then
    return false;
  end if;

  insert into public.request_rate_limits(ip_hash, action) values (p_ip_hash, p_action);
  return true;
end;
$$;

revoke all on function public.consume_request_rate_limit(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_request_rate_limit(text,text,integer,integer) to service_role;

-- Aggregate-only public statistics. No names, phone numbers, emails or report text
-- are included. Demo assets/reports are excluded from every calculation.
create or replace function public.public_statistics_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with
light_statuses(status) as (
  values ('working'::text),('faulty'::text),('under_repair'::text),('out_of_service'::text)
),
light_counts as (
  select s.status, count(l.id)::integer as total
  from light_statuses s
  left join public.streetlights l on l.status = s.status and l.is_demo = false
  group by s.status
),
report_totals as (
  select
    count(*) filter (where status not in ('resolved','closed'))::integer as open_faults,
    count(*) filter (where resolved_at >= date_trunc('month', now()))::integer as repaired_this_month,
    avg(extract(epoch from (resolved_at - reported_at)) / 3600.0)
      filter (where resolved_at is not null and reported_at is not null) as average_repair_hours
  from public.fault_reports
  where is_demo = false
),
months as (
  select generate_series(
    date_trunc('month', now()) - interval '5 months',
    date_trunc('month', now()), interval '1 month'
  ) as month_start
),
monthly as (
  select
    m.month_start,
    (select count(*) from public.fault_reports r
      where r.is_demo = false and r.reported_at >= m.month_start
        and r.reported_at < m.month_start + interval '1 month')::integer as reported,
    (select count(*) from public.fault_reports r
      where r.is_demo = false and r.resolved_at >= m.month_start
        and r.resolved_at < m.month_start + interval '1 month')::integer as resolved
  from months m
),
community_counts as (
  select coalesce(c.name, 'Unassigned community') as community, count(r.reference)::integer as total
  from public.fault_reports r
  left join public.communities c on c.id = r.community_id
  where r.is_demo = false
  group by coalesce(c.name, 'Unassigned community')
),
light_totals as (
  select count(*)::integer as total from public.streetlights where is_demo = false
),
working_total as (
  select count(*)::integer as total from public.streetlights where is_demo = false and status = 'working'
)
select jsonb_build_object(
  'data_status', case when (select total from light_totals) = 0
    and (select open_faults from report_totals) = 0 then 'No verified live records loaded' else 'Live records' end,
  'total_lights', (select total from light_totals),
  'working_percentage', case when (select total from light_totals) = 0 then null
    else round((select total from working_total)::numeric * 100.0 / (select total from light_totals), 1) end,
  'open_faults', (select open_faults from report_totals),
  'repaired_this_month', (select repaired_this_month from report_totals),
  'average_repair_hours', case when (select average_repair_hours from report_totals) is null then null
    else round((select average_repair_hours from report_totals)::numeric, 1) end,
  'status_breakdown', (select jsonb_object_agg(status, total) from light_counts),
  'monthly', (select jsonb_agg(jsonb_build_object(
      'month', to_char(month_start, 'YYYY-MM'), 'reported', reported, 'resolved', resolved
    ) order by month_start) from monthly),
  'faults_by_community', coalesce((select jsonb_agg(jsonb_build_object(
      'community', community, 'count', total
    ) order by total desc, community) from community_counts), '[]'::jsonb)
);
$$;

revoke all on function public.public_statistics_summary() from public, anon, authenticated;
grant execute on function public.public_statistics_summary() to service_role;

-- Stock movements are the only authenticated route for changing on-hand quantity.
-- This trigger updates the item balance and ledger row in one transaction.
create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_quantity integer;
begin
  update public.spare_parts
  set quantity = quantity + new.quantity_delta,
      updated_by = new.actor_id
  where sku = new.sku
    and quantity + new.quantity_delta >= 0
  returning quantity into v_new_quantity;

  if not found then
    raise exception 'Insufficient stock or unknown SKU: %', new.sku
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.apply_stock_movement() from public, anon, authenticated;
drop trigger if exists stock_movements_apply_balance on public.stock_movements;
create trigger stock_movements_apply_balance
before insert on public.stock_movements
for each row execute function public.apply_stock_movement();

-- Revoke broad quantity updates. Staff can edit part descriptions/reorder levels,
-- but all quantity changes must be accompanied by a stock_movements ledger row.
revoke insert, update on public.spare_parts from authenticated;
-- New items start with zero quantity. Opening balances and later adjustments are
-- posted through stock_movements, whose trigger updates the balance atomically.
grant insert(sku, name, reorder_level, unit, updated_by) on public.spare_parts to authenticated;
grant update(name, reorder_level, unit, updated_by) on public.spare_parts to authenticated;

-- Audit log metadata records actions and changed field names only, never values or PII.
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_old jsonb;
  v_id text;
  v_actor uuid;
  v_fields text[];
begin
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
    v_old := v_row;
  elsif tg_op = 'UPDATE' then
    v_row := to_jsonb(new);
    v_old := to_jsonb(old);
  else
    v_row := to_jsonb(new);
    v_old := '{}'::jsonb;
  end if;

  v_id := coalesce(v_row->>'id', v_row->>'reference', v_row->>'sku', v_row->>'setting_key', 'unknown');
  begin
    v_actor := coalesce(auth.uid(), nullif(v_row->>'updated_by','')::uuid, nullif(v_row->>'created_by','')::uuid);
  exception when invalid_text_representation then
    v_actor := auth.uid();
  end;

  if tg_op = 'UPDATE' then
    select array_agg(k.key order by k.key) into v_fields
    from jsonb_each(v_row) k
    where k.value is distinct from v_old->k.key
      and k.key not in ('updated_at','last_seen_at');
  elsif tg_op = 'INSERT' then
    v_fields := array['created'];
  else
    v_fields := array['deleted'];
  end if;

  if coalesce(array_length(v_fields, 1), 0) > 0 then
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, metadata)
    values (v_actor, lower(tg_op), tg_table_name, v_id, jsonb_build_object('changed_fields', to_jsonb(v_fields)));
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- Audit triggers intentionally avoid capturing reporter names, phone numbers,
-- descriptions, photo URLs, staff emails, or any other field values.
drop trigger if exists audit_streetlights on public.streetlights;
create trigger audit_streetlights after insert or update or delete on public.streetlights
for each row execute function public.audit_row_change();
drop trigger if exists audit_fault_reports on public.fault_reports;
create trigger audit_fault_reports after insert or update or delete on public.fault_reports
for each row execute function public.audit_row_change();
drop trigger if exists audit_profiles on public.profiles;
create trigger audit_profiles after insert or update or delete on public.profiles
for each row execute function public.audit_row_change();
drop trigger if exists audit_maintenance_jobs on public.maintenance_jobs;
create trigger audit_maintenance_jobs after insert or update or delete on public.maintenance_jobs
for each row execute function public.audit_row_change();
drop trigger if exists audit_spare_parts on public.spare_parts;
create trigger audit_spare_parts after insert or update or delete on public.spare_parts
for each row execute function public.audit_row_change();
drop trigger if exists audit_stock_movements on public.stock_movements;
create trigger audit_stock_movements after insert on public.stock_movements
for each row execute function public.audit_row_change();

drop trigger if exists audit_report_notes on public.report_notes;
create trigger audit_report_notes after insert or update or delete on public.report_notes
for each row execute function public.audit_row_change();

-- Narrow technician report reading is enforced by the original policy. Storage
-- downloads are similarly restricted to authorised officers or the assigned team.
drop policy if exists report_photos_staff_read on storage.objects;
create policy report_photos_staff_read on storage.objects for select to authenticated
using (
  bucket_id = 'report-photos' and (
    public.has_staff_role(array['administrator','assembly_officer','auditor'])
    or exists (
      select 1 from public.fault_reports r
      where r.reference = split_part(name, '/', 1) and r.assigned_to = auth.uid()
    )
  )
);

drop policy if exists repair_photos_staff_read on storage.objects;
create policy repair_photos_staff_read on storage.objects for select to authenticated
using (
  bucket_id = 'repair-photos' and (
    public.has_staff_role(array['administrator','assembly_officer','auditor'])
    or exists (
      select 1 from public.fault_reports r
      where r.reference = split_part(name, '/', 1) and r.assigned_to = auth.uid()
    )
  )
);

drop policy if exists repair_photos_officer_upload on storage.objects;
create policy repair_photos_officer_upload on storage.objects for insert to authenticated
with check (
  bucket_id = 'repair-photos' and (
    public.has_staff_role(array['administrator','assembly_officer'])
    or exists (
      select 1 from public.fault_reports r
      where r.reference = split_part(name, '/', 1) and r.assigned_to = auth.uid()
    )
  )
);

drop policy if exists repair_photos_admin_delete on storage.objects;
create policy repair_photos_admin_delete on storage.objects for delete to authenticated
using (bucket_id = 'repair-photos' and public.has_staff_role(array['administrator','assembly_officer']));

-- Service-side API clients use these functions; direct browser users cannot.
comment on column public.streetlights.qr_code_value is 'Opaque OTMA-ASSET identifier; the frontend integration supplies the verified public asset route.';
comment on table public.fault_reports is 'Citizen/field fault reports. Reporter PII is restricted by RLS; public lookup is through Edge Functions only.';
comment on table public.report_events is 'Append-only public-safe workflow events; internal_note is never returned by the public tracking API.';
comment on table public.audit_logs is 'Audit trail. Metadata contains changed field names only; avoid storing PII or secrets.';
comment on view public.staff_directory is 'Safe active staff list for authenticated assignment pickers; excludes email and phone.';
comment on function public.public_statistics_summary() is 'Aggregate-only public statistics; excludes demo records and personal data.';
drop trigger if exists audit_contact_messages on public.contact_messages;
create trigger audit_contact_messages after update on public.contact_messages
for each row execute function public.audit_row_change();
drop trigger if exists audit_app_settings on public.app_settings;
create trigger audit_app_settings after insert or update or delete on public.app_settings
for each row execute function public.audit_row_change();


-- Record the actual staff actor for maintenance changes executed through the
-- server-side maintenance-action function (service-role JWTs do not carry auth.uid()).
alter table public.maintenance_jobs
  add column if not exists updated_by uuid references public.profiles(id) on delete set null;
