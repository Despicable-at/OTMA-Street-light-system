-- OTMA Streetlight Portal: initial PostgreSQL schema

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.communities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null,
  phone text,
  role text not null default 'pending' check (role in ('administrator','assembly_officer','technician','auditor','pending')),
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists public.streetlights (
  id text primary key check (id ~ '^OTMA-SL-[0-9]{5}$'),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  community_id uuid references public.communities(id) on delete set null,
  street text not null,
  lamp_type text not null,
  status text not null default 'working' check (status in ('working','faulty','under_repair','out_of_service')),
  last_repaired_date date,
  pole_height_m numeric(5,2),
  wattage integer,
  pole_material text,
  pole_condition text,
  installation_date date,
  asset_note text,
  is_demo boolean not null default false,
  qr_code_value text generated always as ('OTMA-ASSET:' || id) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null
);

create index if not exists streetlights_community_idx on public.streetlights(community_id);
create index if not exists streetlights_status_idx on public.streetlights(status);
create index if not exists streetlights_location_idx on public.streetlights(latitude, longitude);

create table if not exists public.fault_reports (
  reference text primary key,
  streetlight_id text references public.streetlights(id) on delete set null,
  community_id uuid references public.communities(id) on delete set null,
  street text,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  issue_type text not null,
  description text not null check (char_length(description) between 10 and 1000),
  priority text not null default 'normal' check (priority in ('low','normal','medium','high','critical')),
  status text not null default 'received' check (status in ('received','verified','assigned','in_progress','awaiting_parts','resolved','closed')),
  reporter_name text,
  reporter_phone text not null,
  is_demo boolean not null default false,
  nearby_landmark text,
  photo_path text,
  after_photo_path text,
  confirmation_count integer not null default 0 check (confirmation_count >= 0),
  assigned_to uuid references public.profiles(id) on delete set null,
  sla_due_at timestamptz not null,
  resolution_action text,
  parts_used text,
  resolved_at timestamptz,
  closed_at timestamptz,
  reported_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists fault_reports_status_idx on public.fault_reports(status);
create index if not exists fault_reports_reported_at_idx on public.fault_reports(reported_at desc);
create index if not exists fault_reports_sla_idx on public.fault_reports(sla_due_at) where status not in ('resolved','closed');
create index if not exists fault_reports_community_idx on public.fault_reports(community_id);
create index if not exists fault_reports_assigned_idx on public.fault_reports(assigned_to);

create table if not exists public.report_events (
  id uuid primary key default gen_random_uuid(),
  report_reference text not null references public.fault_reports(reference) on delete cascade,
  event_type text not null,
  from_status text,
  to_status text,
  public_message text not null default 'Your report has been updated.',
  internal_note text,
  actor_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists report_events_reference_idx on public.report_events(report_reference, created_at);

create table if not exists public.report_notes (
  id uuid primary key default gen_random_uuid(),
  report_reference text not null references public.fault_reports(reference) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  note text not null check (char_length(note) between 1 and 3000),
  created_at timestamptz not null default now()
);
create index if not exists report_notes_reference_idx on public.report_notes(report_reference, created_at desc);

create table if not exists public.report_confirmations (
  id uuid primary key default gen_random_uuid(),
  report_reference text not null references public.fault_reports(reference) on delete cascade,
  phone_hash text not null,
  created_at timestamptz not null default now(),
  unique(report_reference, phone_hash)
);

create table if not exists public.maintenance_jobs (
  id uuid primary key default gen_random_uuid(),
  streetlight_id text references public.streetlights(id) on delete set null,
  report_reference text references public.fault_reports(reference) on delete set null,
  asset_label text not null,
  task text not null,
  scheduled_for date not null,
  assigned_to uuid references public.profiles(id) on delete set null,
  status text not null default 'scheduled' check (status in ('scheduled','in_progress','completed','cancelled')),
  notes text,
  completed_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists maintenance_jobs_date_idx on public.maintenance_jobs(scheduled_for);

create table if not exists public.spare_parts (
  sku text primary key,
  name text not null,
  quantity integer not null default 0 check (quantity >= 0),
  reorder_level integer not null default 0 check (reorder_level >= 0),
  unit text not null default 'pcs',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  sku text not null references public.spare_parts(sku) on delete restrict,
  quantity_delta integer not null check (quantity_delta <> 0),
  reason text not null,
  report_reference text references public.fault_reports(reference) on delete set null,
  actor_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  subject text not null,
  message text not null,
  status text not null default 'new' check (status in ('new','reviewing','responded','closed')),
  created_at timestamptz not null default now(),
  handled_by uuid references public.profiles(id) on delete set null,
  handled_at timestamptz
);

create table if not exists public.app_settings (
  setting_key text primary key,
  setting_value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on public.audit_logs(created_at desc);

create table if not exists public.request_rate_limits (
  id bigserial primary key,
  ip_hash text not null,
  action text not null,
  created_at timestamptz not null default now()
);
create index if not exists request_rate_limits_lookup_idx on public.request_rate_limits(ip_hash, action, created_at desc);

-- Authentication profile bootstrap: newly invited accounts are inactive and pending
-- until an administrator assigns a role through the protected invite function.
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public, auth as $$
begin
  insert into public.profiles(id, email, full_name, role, is_active)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email, 'OTMA user'), '@', 1)),
    'pending',
    false
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_auth_user();

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger streetlights_set_updated_at before update on public.streetlights
for each row execute function public.set_updated_at();
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger maintenance_jobs_set_updated_at before update on public.maintenance_jobs
for each row execute function public.set_updated_at();
create trigger spare_parts_set_updated_at before update on public.spare_parts
for each row execute function public.set_updated_at();
create trigger app_settings_set_updated_at before update on public.app_settings
for each row execute function public.set_updated_at();

create or replace function public.current_staff_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and is_active = true limit 1;
$$;

create or replace function public.has_staff_role(allowed_roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_staff_role() = any(allowed_roles), false);
$$;

create or replace function public.is_active_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_staff_role() in ('administrator','assembly_officer','technician','auditor');
$$;

revoke all on function public.current_staff_role() from public;
revoke all on function public.has_staff_role(text[]) from public;
revoke all on function public.is_active_staff() from public;
grant execute on function public.current_staff_role() to authenticated;
grant execute on function public.has_staff_role(text[]) to authenticated;
grant execute on function public.is_active_staff() to authenticated;

-- Status events become an append-only public-safe timeline.
create or replace function public.record_report_status_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_message text;
begin
  if tg_op = 'INSERT' then
    -- Seed fixtures supply their own historical timeline rows. Avoid adding a
    -- duplicate event creation or unintended changes to operational asset status.
    if not new.is_demo then
      insert into public.report_events(report_reference,event_type,from_status,to_status,public_message,actor_id)
      values (new.reference,'status_change',null,new.status,'Your fault report has been received by the Assembly.',new.created_by);
      if new.streetlight_id is not null then
        update public.streetlights
        set status = 'faulty'
        where id = new.streetlight_id and status in ('working','faulty');
      end if;
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
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
    insert into public.report_events(report_reference,event_type,from_status,to_status,public_message,actor_id)
    values (new.reference,'status_change',old.status,new.status,v_message,coalesce(new.updated_by,auth.uid()));
    if not new.is_demo and new.streetlight_id is not null then
      if new.status in ('resolved','closed') then
        if not exists (
          select 1 from public.fault_reports other
          where other.streetlight_id = new.streetlight_id
            and other.reference <> new.reference
            and other.status not in ('resolved','closed')
            and other.is_demo = false
        ) then
          update public.streetlights set status = 'working', last_repaired_date = current_date
          where id = new.streetlight_id and status in ('faulty','under_repair');
        end if;
      elsif new.status in ('in_progress','awaiting_parts') then
        update public.streetlights set status = 'under_repair'
        where id = new.streetlight_id and status = 'faulty';
      else
        update public.streetlights set status = 'faulty'
        where id = new.streetlight_id and status = 'working';
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger fault_reports_status_event after insert or update of status on public.fault_reports
for each row execute function public.record_report_status_change();

-- Public streetlight view intentionally omits private operational/audit columns.
create or replace view public.streetlights_public with (security_barrier = true) as
select s.id, s.latitude, s.longitude, c.name as community, s.street, s.lamp_type as "lampType",
       s.status, s.last_repaired_date as "lastRepairedDate", s.pole_height_m as "poleHeightM",
       s.wattage, s.pole_material as "poleMaterial", s.pole_condition as "poleCondition",
       s.installation_date as "installationDate"
from public.streetlights s left join public.communities c on c.id = s.community_id
where s.is_demo = false;

-- The public API only receives aggregate values and safe workflow events from Edge Functions.

-- RLS is enabled on every application table, including those not exposed to anon.
alter table public.communities enable row level security;
alter table public.profiles enable row level security;
alter table public.streetlights enable row level security;
alter table public.fault_reports enable row level security;
alter table public.report_events enable row level security;
alter table public.report_notes enable row level security;
alter table public.report_confirmations enable row level security;
alter table public.maintenance_jobs enable row level security;
alter table public.spare_parts enable row level security;
alter table public.stock_movements enable row level security;
alter table public.contact_messages enable row level security;
alter table public.app_settings enable row level security;
alter table public.audit_logs enable row level security;
alter table public.request_rate_limits enable row level security;

-- Explicit privileges: anon sees only the safe streetlight view. All writes to public
-- report/contact endpoints go through Edge Functions using the server-only service key.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.streetlights_public to anon, authenticated;
grant select on public.communities to anon, authenticated;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.communities to authenticated;
grant select, insert, update, delete on public.streetlights to authenticated;
grant select, insert, update on public.fault_reports to authenticated;
grant select on public.report_events to authenticated;
grant select, insert, delete on public.report_notes to authenticated;
grant select on public.report_confirmations to authenticated;
grant select, insert, update, delete on public.maintenance_jobs to authenticated;
grant select, insert, update, delete on public.spare_parts to authenticated;
grant select, insert on public.stock_movements to authenticated;
grant select, update on public.contact_messages to authenticated;
grant select, insert, update on public.app_settings to authenticated;
grant select on public.audit_logs to authenticated;

grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Communities: public read, officers/admin manage.
create policy communities_public_read on public.communities for select to anon, authenticated using (is_active = true or public.is_active_staff());
create policy communities_staff_manage on public.communities for all to authenticated
  using (public.has_staff_role(array['administrator','assembly_officer']))
  with check (public.has_staff_role(array['administrator','assembly_officer']));

-- Profiles: users can read their own profile; admins manage the staff directory.
create policy profiles_read_self_or_admin on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_staff_role(array['administrator']));
create policy profiles_admin_manage on public.profiles for all to authenticated
  using (public.has_staff_role(array['administrator']))
  with check (public.has_staff_role(array['administrator']));

-- Asset inventory: staff access; changes only by administrator/officer.
create policy streetlights_staff_read on public.streetlights for select to authenticated using (public.is_active_staff());
create policy streetlights_staff_manage on public.streetlights for all to authenticated
  using (public.has_staff_role(array['administrator','assembly_officer']))
  with check (public.has_staff_role(array['administrator','assembly_officer']));

-- Reports: officers/admin manage; auditors read; technicians see reports assigned to them.
create policy reports_staff_read on public.fault_reports for select to authenticated
  using (
    public.has_staff_role(array['administrator','assembly_officer','auditor'])
    or (public.current_staff_role() = 'technician' and assigned_to = auth.uid())
  );
create policy reports_officer_insert on public.fault_reports for insert to authenticated
  with check (public.has_staff_role(array['administrator','assembly_officer']));
create policy reports_officer_update on public.fault_reports for update to authenticated
  using (public.has_staff_role(array['administrator','assembly_officer']))
  with check (public.has_staff_role(array['administrator','assembly_officer']));

create policy report_events_staff_read on public.report_events for select to authenticated using (public.is_active_staff());
create policy report_notes_staff_read on public.report_notes for select to authenticated using (public.is_active_staff());
create policy report_notes_staff_insert on public.report_notes for insert to authenticated
  with check (
    public.has_staff_role(array['administrator','assembly_officer'])
    or (public.current_staff_role() = 'technician' and exists (
      select 1 from public.fault_reports r where r.reference = report_reference and r.assigned_to = auth.uid()
    ))
  );
create policy report_notes_admin_delete on public.report_notes for delete to authenticated
  using (public.has_staff_role(array['administrator']));
create policy confirmations_staff_read on public.report_confirmations for select to authenticated using (public.is_active_staff());

create policy maintenance_staff_read on public.maintenance_jobs for select to authenticated
  using (public.has_staff_role(array['administrator','assembly_officer','auditor']) or assigned_to = auth.uid());
create policy maintenance_officer_manage on public.maintenance_jobs for all to authenticated
  using (public.has_staff_role(array['administrator','assembly_officer']))
  with check (public.has_staff_role(array['administrator','assembly_officer']));

create policy parts_staff_read on public.spare_parts for select to authenticated using (public.is_active_staff());
create policy parts_officer_manage on public.spare_parts for all to authenticated
  using (public.has_staff_role(array['administrator','assembly_officer']))
  with check (public.has_staff_role(array['administrator','assembly_officer']));
create policy stock_movements_staff_read on public.stock_movements for select to authenticated using (public.is_active_staff());
create policy stock_movements_officer_insert on public.stock_movements for insert to authenticated
  with check (public.has_staff_role(array['administrator','assembly_officer']));

create policy contact_messages_staff_read on public.contact_messages for select to authenticated
  using (public.has_staff_role(array['administrator','assembly_officer']));
create policy contact_messages_staff_update on public.contact_messages for update to authenticated
  using (public.has_staff_role(array['administrator','assembly_officer']))
  with check (public.has_staff_role(array['administrator','assembly_officer']));

create policy settings_admin_read on public.app_settings for select to authenticated using (public.has_staff_role(array['administrator']));
create policy settings_admin_manage on public.app_settings for all to authenticated
  using (public.has_staff_role(array['administrator']))
  with check (public.has_staff_role(array['administrator']));
create policy audit_admin_auditor_read on public.audit_logs for select to authenticated using (public.has_staff_role(array['administrator','auditor']));

-- Storage is private. Uploads from the public report form are performed by the
-- Edge Function using its service-role secret; staff access is enforced here.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values
  ('report-photos','report-photos',false,5242880,array['image/jpeg','image/png','image/webp']),
  ('repair-photos','repair-photos',false,5242880,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy report_photos_staff_read on storage.objects for select to authenticated
  using (bucket_id = 'report-photos' and public.is_active_staff());
create policy repair_photos_staff_read on storage.objects for select to authenticated
  using (bucket_id = 'repair-photos' and public.is_active_staff());
create policy repair_photos_officer_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'repair-photos' and public.has_staff_role(array['administrator','assembly_officer','technician']));
create policy repair_photos_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'repair-photos' and public.has_staff_role(array['administrator','assembly_officer']));

-- Starter operational settings, not legal/service commitments.
insert into public.app_settings(setting_key,setting_value) values
 ('report_sla_hours','{"normal":72,"high":24,"critical":4}'::jsonb),
 ('portal_branding','{"assembly":"Old Tafo Municipal Assembly","portal":"Streetlight Management Portal"}'::jsonb)
on conflict (setting_key) do nothing;
