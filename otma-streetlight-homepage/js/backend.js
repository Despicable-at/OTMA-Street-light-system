/* OTMA Supabase adapter. This file is safe to ship in a static frontend.
 * The publishable/anon key is public; database security comes from RLS.
 * NEVER add SUPABASE_SERVICE_ROLE_KEY or a database password here.
 */
const config = window.OTMA_CONFIG ?? {};
const configured = Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY && !config.DEMO_MODE);
let clientPromise;
let baseline = { lights: new Map(), reports: new Map(), parts: new Map(), maintenance: new Map(), notes: new Set() };
let loadedProfile = null;

export function isBackendConfigured() { return configured; }

async function getClient() {
  if (!configured) throw new Error("Supabase is not configured.");
  if (!clientPromise) {
    clientPromise = import("https://esm.sh/@supabase/supabase-js@2.95.0").then(({ createClient }) => createClient(
      config.SUPABASE_URL,
      config.SUPABASE_ANON_KEY,
      { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "otma-supabase-auth" } }
    ));
  }
  return clientPromise;
}

async function invokePublic(name, body, options = {}) {
  const url = `${String(config.SUPABASE_URL).replace(/\/$/, "")}/functions/v1/${name}`;
  const headers = { apikey: config.SUPABASE_ANON_KEY, ...(options.headers ?? {}) };
  const response = await fetch(url, { method: options.method ?? "POST", headers, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The ${name} service returned ${response.status}.`);
  return data;
}

export async function getPublicLights() {
  if (!configured) return null;
  const client = await getClient();
  const { data, error } = await client.from("streetlights_public").select("*").order("id");
  if (error) throw error;
  return {
    meta: { title: "OTMA streetlight inventory", recordType: "Live inventory", mapCentre: { latitude: 6.7342, longitude: -1.6127 } },
    lights: (data ?? []).map((x) => ({
      id: x.id, latitude: x.latitude, longitude: x.longitude, community: x.community,
      street: x.street, lampType: x.lampType, status: x.status,
      lastRepairedDate: x.lastRepairedDate, poleHeightM: x.poleHeightM,
      wattage: x.wattage, poleMaterial: x.poleMaterial,
      poleCondition: x.poleCondition, installationDate: x.installationDate
    })),
    communities: [...new Set((data ?? []).map((x) => x.community).filter(Boolean))]
  };
}

export async function createPublicReport(payload, photo = null) {
  if (!configured) throw new Error("Backend is not configured.");
  const form = new FormData();
  form.set("report", JSON.stringify(payload));
  if (photo) form.set("photo", photo, photo.name);
  return invokePublic("create-report", form);
}

export async function trackPublicReport(reference) {
  if (!configured) return null;
  return invokePublic("track-report", JSON.stringify({ reference }), {
    headers: { "Content-Type": "application/json" }
  });
}

export async function getPublicStatistics() {
  if (!configured) return null;
  return invokePublic("public-stats", undefined, { method: "GET" });
}

export async function sendContactMessage(payload) {
  if (!configured) throw new Error("Backend is not configured.");
  return invokePublic("contact-message", JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" }
  });
}

export async function signInStaff(email, password) {
  const client = await getClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const { data: profile, error: profileError } = await client.from("profiles")
    .select("id,email,full_name,role,is_active").eq("id", data.user.id).single();
  if (profileError) {
    await client.auth.signOut();
    throw profileError;
  }
  if (!profile.is_active || profile.role === "pending") {
    await client.auth.signOut();
    throw new Error("Your account is not active. Contact the OTMA system administrator.");
  }
  loadedProfile = profile;
  return profileToSession(profile);
}

function profileToSession(profile) {
  const roles = { administrator: "Administrator", assembly_officer: "Assembly Officer", technician: "Technician", auditor: "Auditor" };
  return { id: profile.id, name: profile.full_name, email: profile.email, role: roles[profile.role] ?? profile.role, backend: true };
}

export async function restoreStaffSession() {
  const client = await getClient();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) return null;
  const { data, error } = await client.from("profiles")
    .select("id,email,full_name,role,is_active").eq("id", userData.user.id).single();
  if (error || !data?.is_active || data.role === "pending") {
    await client.auth.signOut();
    return null;
  }
  loadedProfile = data;
  return profileToSession(data);
}

export async function signOutStaff() {
  const client = await getClient();
  loadedProfile = null;
  return client.auth.signOut();
}

const toUiStatus = (status) => ({ received: "New", verified: "Verified", assigned: "Assigned", in_progress: "In Progress", awaiting_parts: "Awaiting Parts", resolved: "Resolved", closed: "Closed" }[status] ?? status);
const toDbStatus = (status) => ({ New: "received", Verified: "verified", Assigned: "assigned", "In Progress": "in_progress", "Awaiting Parts": "awaiting_parts", Resolved: "resolved", Closed: "closed" }[status] ?? status);
const uiRole = (role) => ({ administrator: "Administrator", assembly_officer: "Assembly Officer", technician: "Technician", auditor: "Auditor" }[role] ?? role);
const dbRole = (role) => ({ Administrator: "administrator", "Assembly Officer": "assembly_officer", Technician: "technician", Auditor: "auditor" }[role] ?? role);
const stable = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort());

export async function loadAdminWorkspace() {
  const client = await getClient();
  const [lightsRes, reportsRes, eventsRes, notesRes, usersRes, partsRes, jobsRes, communitiesRes] = await Promise.all([
    client.from("streetlights").select("*,communities(name)").order("id"),
    client.from("fault_reports").select("*").order("reported_at", { ascending: false }),
    client.from("report_events").select("*").order("created_at", { ascending: true }),
    client.from("report_notes").select("*").order("created_at", { ascending: false }),
    client.from("profiles").select("id,email,full_name,role,is_active,last_seen_at,created_at").order("full_name"),
    client.from("spare_parts").select("*").order("name"),
    client.from("maintenance_jobs").select("*").order("scheduled_for"),
    client.from("communities").select("id,name")
  ]);
  for (const result of [lightsRes,reportsRes,eventsRes,notesRes,usersRes,partsRes,jobsRes,communitiesRes]) {
    if (result.error) throw result.error;
  }
  const communityName = new Map((communitiesRes.data ?? []).map((x) => [x.id, x.name]));
  const profileById = new Map((usersRes.data ?? []).map((x) => [x.id, x]));
  const timelineByRef = new Map();
  for (const event of eventsRes.data ?? []) {
    if (!timelineByRef.has(event.report_reference)) timelineByRef.set(event.report_reference, []);
    timelineByRef.get(event.report_reference).push([toUiStatus(event.to_status), event.created_at, event.public_message]);
  }
  const notesByRef = new Map();
  for (const note of notesRes.data ?? []) {
    if (!notesByRef.has(note.report_reference)) notesByRef.set(note.report_reference, []);
    notesByRef.get(note.report_reference).push({ id: note.id, author: profileById.get(note.author_id)?.full_name ?? "OTMA staff", date: note.created_at, text: note.note, authorId: note.author_id });
  }

  const lights = (lightsRes.data ?? []).map((x) => ({
    id: x.id, latitude: x.latitude, longitude: x.longitude, community: x.communities?.name ?? communityName.get(x.community_id) ?? "Unassigned",
    street: x.street, lampType: x.lamp_type, status: x.status, lastRepairedDate: x.last_repaired_date,
    poleHeightM: x.pole_height_m, wattage: x.wattage, poleMaterial: x.pole_material,
    poleCondition: x.pole_condition, installationDate: x.installation_date, assetNote: x.asset_note,
    isDemo: x.is_demo
  }));
  const reports = (reportsRes.data ?? []).map((x) => ({
    reference: x.reference, lightId: x.streetlight_id, community: communityName.get(x.community_id) ?? "Unassigned",
    street: x.street ?? "Map-selected location", issue: x.issue_type, description: x.description,
    priority: x.priority[0].toUpperCase() + x.priority.slice(1), status: toUiStatus(x.status),
    reportedAt: x.reported_at, dueAt: x.sla_due_at, latitude: x.latitude, longitude: x.longitude,
    confirmationCount: x.confirmation_count, assignedTo: profileById.get(x.assigned_to)?.full_name ?? "",
    assignedToId: x.assigned_to, notes: notesByRef.get(x.reference) ?? [],
    timeline: timelineByRef.get(x.reference) ?? [], reporterName: x.reporter_name,
    reporterPhone: x.reporter_phone, nearbyLandmark: x.nearby_landmark,
    photoPath: x.photo_path, afterPhotoPath: x.after_photo_path,
    resolutionAction: x.resolution_action, partsUsed: x.parts_used,
    resolvedAt: x.resolved_at, isDemo: x.is_demo
  }));
  const users = (usersRes.data ?? []).map((x) => ({
    id: x.id, name: x.full_name, email: x.email, role: uiRole(x.role),
    status: x.is_active ? "Active" : "Invited", lastActive: x.last_seen_at ? new Date(x.last_seen_at).toLocaleDateString("en-GH") : "—"
  }));
  const parts = (partsRes.data ?? []).map((x) => ({ name: x.name, sku: x.sku, qty: x.quantity, reorder: x.reorder_level, unit: x.unit, updated: new Date(x.updated_at).toLocaleDateString("en-GH") }));
  const maintenance = (jobsRes.data ?? []).map((x) => ({ id: x.id, asset: x.asset_label, task: x.task, date: x.scheduled_for, team: profileById.get(x.assigned_to)?.full_name ?? "Unassigned", status: x.status }));

  baseline = {
    lights: new Map(lights.map((x) => [x.id, stable(x)])),
    reports: new Map(reports.map((x) => [x.reference, stable(x)])),
    parts: new Map(parts.map((x) => [x.sku, stable(x)])),
    maintenance: new Map(maintenance.map((x) => [x.id, stable(x)])),
    notes: new Set((notesRes.data ?? []).map((x) => x.id))
  };
  return { lights, reports, users, parts, maintenance };
}

export async function saveStreetlightRecord(light) {
  const client = await getClient();
  const { data: community, error: communityError } = await client
    .from("communities")
    .select("id")
    .eq("name", light.community)
    .maybeSingle();
  if (communityError) throw communityError;

  const row = {
    id: light.id,
    latitude: Number(light.latitude),
    longitude: Number(light.longitude),
    community_id: community?.id ?? null,
    street: light.street,
    lamp_type: light.lampType,
    status: light.status,
    last_repaired_date: light.lastRepairedDate || null,
    pole_height_m: light.poleHeightM ?? null,
    wattage: light.wattage ?? null,
    pole_material: light.poleMaterial ?? null,
    pole_condition: light.poleCondition ?? null,
    installation_date: light.installationDate || null,
    asset_note: light.assetNote ?? null,
    is_demo: false
  };

  // This operation writes only the selected streetlight. It deliberately does
  // not persist reports, users, maintenance jobs, or spare-parts data.
  const { data, error } = await client
    .from("streetlights")
    .upsert(row, { onConflict: "id" })
    .select("id")
    .single();
  if (error) throw error;

  baseline.lights.set(light.id, stable(light));
  return data;
}

export async function persistAdminWorkspace(state) {
  const client = await getClient();
  const [{ data: communities, error: communityError }, { data: profiles, error: profileError }, userResult] = await Promise.all([
    client.from("communities").select("id,name"),
    client.from("profiles").select("id,full_name,role"),
    client.auth.getUser()
  ]);
  if (communityError) throw communityError;
  if (profileError) throw profileError;
  if (userResult.error || !userResult.data.user) throw new Error("Staff session expired. Sign in again.");
  const communityId = new Map((communities ?? []).map((x) => [x.name, x.id]));
  const profileId = new Map((profiles ?? []).map((x) => [x.full_name, x.id]));
  const actor = userResult.data.user.id;

  for (const x of state.lights) {
    const row = {
      id: x.id, latitude: Number(x.latitude), longitude: Number(x.longitude), community_id: communityId.get(x.community) ?? null,
      street: x.street, lamp_type: x.lampType, status: x.status, last_repaired_date: x.lastRepairedDate || null,
      pole_height_m: x.poleHeightM ?? null, wattage: x.wattage ?? null, pole_material: x.poleMaterial ?? null,
      pole_condition: x.poleCondition ?? null, installation_date: x.installationDate || null,
      asset_note: x.assetNote ?? null, is_demo: Boolean(x.isDemo), updated_by: actor
    };
    if (baseline.lights.get(x.id) !== stable({ ...x })) {
      const { error } = await client.from("streetlights").upsert(row, { onConflict: "id" });
      if (error) throw error;
    }
  }

  for (const x of state.reports) {
    const dbStatus = toDbStatus(x.status);
    const row = {
      reference: x.reference, streetlight_id: x.lightId || null, community_id: communityId.get(x.community) ?? null,
      street: x.street ?? null, latitude: Number(x.latitude), longitude: Number(x.longitude), issue_type: x.issue,
      description: x.description, priority: String(x.priority).toLowerCase(), status: dbStatus,
      reporter_name: x.reporterName || null, reporter_phone: x.reporterPhone || "0000000000",
      nearby_landmark: x.nearbyLandmark || null, photo_path: x.photoPath || null,
      after_photo_path: x.afterPhotoPath || null, confirmation_count: Number(x.confirmationCount ?? 0),
      assigned_to: profileId.get(x.assignedTo) ?? x.assignedToId ?? null,
      sla_due_at: x.dueAt || new Date(Date.now() + 72 * 3600000).toISOString(),
      resolution_action: x.resolutionAction || null, parts_used: x.partsUsed || null,
      resolved_at: x.resolvedAt || (dbStatus === "resolved" || dbStatus === "closed" ? x.reportedAt : null),
      is_demo: Boolean(x.isDemo), updated_by: actor
    };
    const previous = baseline.reports.get(x.reference);
    if (previous !== stable(x)) {
      const { error } = await client.from("fault_reports").upsert(row, { onConflict: "reference" });
      if (error) throw error;
    }
    for (const note of (x.notes ?? [])) {
      if (note.id && baseline.notes.has(note.id)) continue;
      if (!note.id && note.__saved) continue;
      const { data, error } = await client.from("report_notes").insert({
        report_reference: x.reference,
        author_id: note.authorId ?? profileId.get(note.author) ?? actor,
        note: note.text
      }).select("id").single();
      if (error) throw error;
      note.id = data.id;
      note.__saved = true;
      baseline.notes.add(data.id);
    }
  }

  for (const x of state.parts) {
    const row = { sku: x.sku, name: x.name, quantity: Number(x.qty), reorder_level: Number(x.reorder), unit: x.unit ?? "pcs", updated_by: actor };
    if (baseline.parts.get(x.sku) !== stable(x)) {
      const { error } = await client.from("spare_parts").upsert(row, { onConflict: "sku" });
      if (error) throw error;
    }
  }

  for (const x of state.maintenance) {
    if (!x.id) x.id = crypto.randomUUID();
    const row = {
      id: x.id, asset_label: x.asset, task: x.task, scheduled_for: x.date,
      assigned_to: profileId.get(x.team) ?? null, status: x.status ?? "scheduled", created_by: actor
    };
    if (baseline.maintenance.get(x.id) !== stable(x)) {
      const { error } = await client.from("maintenance_jobs").upsert(row, { onConflict: "id" });
      if (error) throw error;
    }
  }

  // Refresh adapter snapshots after a successful save, preventing stale local diffs.
  baseline = {
    lights: new Map(state.lights.map((x) => [x.id, stable(x)])),
    reports: new Map(state.reports.map((x) => [x.reference, stable(x)])),
    parts: new Map(state.parts.map((x) => [x.sku, stable(x)])),
    maintenance: new Map(state.maintenance.map((x) => [x.id, stable(x)])),
    notes: baseline.notes
  };
  return true;
}

export async function inviteStaff(email, fullName, role) {
  const client = await getClient();
  const { data: sessionData } = await client.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("Sign in before inviting staff.");
  const url = `${String(config.SUPABASE_URL).replace(/\/$/, "")}/functions/v1/admin-invite`;
  const response = await fetch(url, {
    method: "POST", headers: { apikey: config.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, full_name: fullName, role: dbRole(role) })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not invite staff.");
  return data;
}

export async function setStaffActive(userId, isActive) {
  const client = await getClient();
  const { error } = await client.from("profiles").update({ is_active: isActive }).eq("id", userId);
  if (error) throw error;
}

export async function saveWorkspaceSettings(value) {
  const client = await getClient();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) throw new Error("Staff session expired.");
  const { error } = await client.from("app_settings").upsert({ setting_key: "workspace", setting_value: value, updated_by: userData.user.id });
  if (error) throw error;
}

export async function loadWorkspaceSettings() {
  const client = await getClient();
  const { data, error } = await client.from("app_settings").select("setting_value").eq("setting_key", "workspace").maybeSingle();
  if (error) throw error;
  return data?.setting_value ?? null;
}
