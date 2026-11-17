import { preflight } from "../_shared/cors.ts";
import { cleanText, errorMessage, json } from "../_shared/http.ts";
import { createAdminClient, createAuthenticatedClient, getActiveStaffProfile } from "../_shared/supabase.ts";

const OFFICER_ROLES = new Set(["administrator", "assembly_officer"]);
const REPORT_REFERENCE = /^OTMA-RPT-(?:20[0-9]{2}-[A-HJ-NP-Z2-9]{8}|[0-9]{5})$/;

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

Deno.serve(async (req: Request) => {
  const blocked = preflight(req);
  if (blocked) return blocked;
  if (req.method !== "POST") return json(req, { error: "Method not allowed." }, 405);

  try {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json(req, { error: "Staff authentication is required." }, 401);
    const caller = createAuthenticatedClient(token);
    const { data: authData, error: authError } = await caller.auth.getUser();
    if (authError || !authData.user) return json(req, { error: "Staff session is invalid." }, 401);

    const admin = createAdminClient();
    const profile = await getActiveStaffProfile(admin, authData.user.id);
    if (!profile) return json(req, { error: "Your staff account is inactive." }, 403);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json(req, { error: "Request body must be valid JSON." }, 400);
    }

    const action = cleanText(body.action, 30);
    const isOfficer = OFFICER_ROLES.has(profile.role);
    if (profile.role === "auditor" || profile.role === "pending") {
      return json(req, { error: "Your role cannot change maintenance jobs." }, 403);
    }

    if (action === "create") {
      if (!isOfficer) return json(req, { error: "Only an Assembly officer can create a maintenance job." }, 403);
      const assetLabel = cleanText(body.asset_label, 160);
      const task = cleanText(body.task, 1000);
      const scheduledFor = cleanText(body.scheduled_for, 10);
      const streetlightId = cleanText(body.streetlight_id, 32) || null;
      const reportReference = cleanText(body.report_reference, 50).toUpperCase() || null;
      const assignedTo = cleanText(body.assigned_to, 80) || null;
      if (assetLabel.length < 2 || task.length < 3 || !validDate(scheduledFor)) {
        return json(req, { error: "Provide an asset label, task description and valid scheduled date." }, 400);
      }
      if (streetlightId && !/^OTMA-SL-\d{5}$/.test(streetlightId)) {
        return json(req, { error: "The streetlight ID is invalid." }, 400);
      }
      if (reportReference && !REPORT_REFERENCE.test(reportReference)) {
        return json(req, { error: "The report reference is invalid." }, 400);
      }
      if (streetlightId) {
        const { data, error } = await admin.from("streetlights").select("id").eq("id", streetlightId).maybeSingle();
        if (error) throw error;
        if (!data) return json(req, { error: "The selected streetlight does not exist." }, 404);
      }
      if (reportReference) {
        const { data, error } = await admin.from("fault_reports").select("reference").eq("reference", reportReference).maybeSingle();
        if (error) throw error;
        if (!data) return json(req, { error: "The linked fault report does not exist." }, 404);
      }
      if (assignedTo) {
        const { data, error } = await admin.from("profiles").select("id,role,is_active").eq("id", assignedTo).maybeSingle();
        if (error) throw error;
        if (!data?.is_active || data.role !== "technician") {
          return json(req, { error: "The selected staff member is not an active technician." }, 400);
        }
      }
      const { data, error } = await admin.from("maintenance_jobs").insert({
        asset_label: assetLabel, task, scheduled_for: scheduledFor,
        streetlight_id: streetlightId, report_reference: reportReference,
        assigned_to: assignedTo, created_by: authData.user.id, updated_by: authData.user.id,
        notes: cleanText(body.notes, 2000) || null
      }).select("*").single();
      if (error) throw error;
      return json(req, { ok: true, job: data }, 201);
    }

    const id = cleanText(body.id, 64);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json(req, { error: "A valid maintenance job ID is required." }, 400);
    const { data: job, error: jobError } = await admin.from("maintenance_jobs")
      .select("id,assigned_to,status").eq("id", id).maybeSingle();
    if (jobError) throw jobError;
    if (!job) return json(req, { error: "The maintenance job could not be found." }, 404);

    const isAssignedTechnician = profile.role === "technician" && job.assigned_to === authData.user.id;
    if (!isOfficer && !isAssignedTechnician) {
      return json(req, { error: "Only the assigned technician or an authorised officer can update this job." }, 403);
    }

    let updates: Record<string, unknown> = {};
    if (action === "start") {
      if (job.status !== "scheduled") return json(req, { error: "Only a scheduled job can be started." }, 409);
      updates = { status: "in_progress" };
    } else if (action === "complete") {
      if (job.status !== "in_progress") return json(req, { error: "Only an in-progress job can be completed." }, 409);
      updates = { status: "completed", completed_at: new Date().toISOString() };
    } else if (action === "note") {
      const note = cleanText(body.notes, 2000);
      if (!note) return json(req, { error: "Enter a maintenance note." }, 400);
      updates = { notes: note };
    } else if (action === "reschedule") {
      if (!isOfficer) return json(req, { error: "Only an Assembly officer can reschedule a job." }, 403);
      const scheduledFor = cleanText(body.scheduled_for, 10);
      if (!validDate(scheduledFor)) return json(req, { error: "Enter a valid scheduled date." }, 400);
      updates = { scheduled_for: scheduledFor };
    } else if (action === "cancel") {
      if (!isOfficer) return json(req, { error: "Only an Assembly officer can cancel a job." }, 403);
      if (["completed", "cancelled"].includes(job.status)) return json(req, { error: "This job is already finished." }, 409);
      updates = { status: "cancelled", notes: cleanText(body.notes, 2000) || null };
    } else if (action === "assign") {
      if (!isOfficer) return json(req, { error: "Only an Assembly officer can assign a job." }, 403);
      const assignedTo = cleanText(body.assigned_to, 80);
      if (!/^[0-9a-f-]{36}$/i.test(assignedTo)) return json(req, { error: "Select a technician account." }, 400);
      const { data, error } = await admin.from("profiles").select("id,role,is_active").eq("id", assignedTo).maybeSingle();
      if (error) throw error;
      if (!data?.is_active || data.role !== "technician") return json(req, { error: "The selected account is not an active technician." }, 400);
      updates = { assigned_to: assignedTo };
    } else {
      return json(req, { error: "Unsupported maintenance action." }, 400);
    }

    updates.updated_by = authData.user.id;
    const { data, error } = await admin.from("maintenance_jobs").update(updates)
      .eq("id", id).eq("status", job.status).select("*").maybeSingle();
    if (error) throw error;
    if (!data) return json(req, { error: "The job changed before this action. Refresh and try again." }, 409);
    return json(req, { ok: true, job: data });
  } catch (error) {
    console.error("maintenance-action failed", errorMessage(error));
    return json(req, { error: "The maintenance action could not be completed. Refresh and try again." }, 500);
  }
});
