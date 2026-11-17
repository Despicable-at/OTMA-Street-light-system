import { preflight } from "../_shared/cors.ts";
import { cleanText, errorMessage, json } from "../_shared/http.ts";
import { createAdminClient, createAuthenticatedClient, getActiveStaffProfile } from "../_shared/supabase.ts";

const PHOTO_LIMIT = 5 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const OFFICER_ROLES = new Set(["administrator", "assembly_officer"]);
const TECHNICIAN_ROLES = new Set(["administrator", "assembly_officer", "technician"]);

Deno.serve(async (req: Request) => {
  const blocked = preflight(req);
  if (blocked) return blocked;
  if (req.method !== "POST") return json(req, { error: "Method not allowed." }, 405);

  let uploadedPath: string | null = null;
  try {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json(req, { error: "Staff authentication is required." }, 401);
    const caller = createAuthenticatedClient(token);
    const { data: authData, error: authError } = await caller.auth.getUser();
    if (authError || !authData.user) return json(req, { error: "Staff session is invalid." }, 401);

    const admin = createAdminClient();
    const profile = await getActiveStaffProfile(admin, authData.user.id);
    if (!profile) return json(req, { error: "Your OTMA staff account is inactive." }, 403);

    const isMultipart = req.headers.get("content-type")?.includes("multipart/form-data") ?? false;
    let body: Record<string, unknown>;
    let afterPhoto: File | null = null;
    if (isMultipart) {
      const form = await req.formData();
      body = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string")) as Record<string, unknown>;
      const file = form.get("after_photo");
      afterPhoto = file instanceof File ? file : null;
    } else {
      body = await req.json();
    }

    const reference = cleanText(body.reference, 50).toUpperCase();
    const action = cleanText(body.action, 30);
    if (!/^OTMA-RPT-(?:20[0-9]{2}-[A-HJ-NP-Z2-9]{8}|[0-9]{5})$/.test(reference)) {
      return json(req, { error: "A valid report reference is required." }, 400);
    }

    const { data: report, error: reportError } = await admin.from("fault_reports")
      .select("reference,status,assigned_to,is_demo")
      .eq("reference", reference).maybeSingle();
    if (reportError) throw reportError;
    if (!report) return json(req, { error: "The report could not be found." }, 404);

    const isOfficer = OFFICER_ROLES.has(profile.role);
    const isAssignedTechnician = profile.role === "technician" && report.assigned_to === authData.user.id;
    if (profile.role === "auditor" || profile.role === "pending") {
      return json(req, { error: "Your role does not permit report changes." }, 403);
    }

    const requiredCurrentStatus: Record<string, string> = {
      verify: "received",
      start: "assigned",
      awaiting_parts: "in_progress",
      resume: "awaiting_parts",
      resolve: "in_progress",
      close: "resolved"
    };
    if (requiredCurrentStatus[action] && report.status !== requiredCurrentStatus[action]) {
      return json(req, {
        error: `This action requires the report to be in the ${requiredCurrentStatus[action].replaceAll("_", " ")} stage.`
      }, 409);
    }

    if (action === "add_note") {
      if (!isOfficer && !isAssignedTechnician) return json(req, { error: "Only the assigned technician or an authorised officer can add internal notes." }, 403);
      const note = cleanText(body.note, 3000);
      if (!note) return json(req, { error: "Enter a note before saving." }, 400);
      const { data, error } = await admin.from("report_notes").insert({
        report_reference: reference, author_id: authData.user.id, note
      }).select("id,created_at").single();
      if (error) throw error;
      return json(req, { ok: true, note_id: data.id, created_at: data.created_at }, 201);
    }

    if (action === "assign") {
      if (!isOfficer) return json(req, { error: "Only an Assembly officer or administrator can assign work." }, 403);
      if (!["verified", "assigned", "in_progress", "awaiting_parts"].includes(report.status)) {
        return json(req, { error: "Verify the report before assigning a technician." }, 409);
      }
      const technicianId = cleanText(body.assigned_to, 80);
      if (!/^[0-9a-f-]{36}$/i.test(technicianId)) return json(req, { error: "Select a valid technician account." }, 400);
      const { data: technician, error: technicianError } = await admin.from("profiles")
        .select("id,role,is_active").eq("id", technicianId).maybeSingle();
      if (technicianError) throw technicianError;
      if (!technician || !technician.is_active || technician.role !== "technician") {
        return json(req, { error: "The selected account is not an active technician." }, 400);
      }
      const nextStatus = report.status === "verified" ? "assigned" : report.status;
      const { data, error } = await admin.from("fault_reports").update({
        assigned_to: technicianId, status: nextStatus, updated_by: authData.user.id
      }).eq("reference", reference).eq("status", report.status)
        .select("reference,status,assigned_to,updated_at").maybeSingle();
      if (error) throw error;
      if (!data) return json(req, { error: "The report changed before assignment. Refresh and try again." }, 409);
      if (report.status !== "verified") {
        const { error: eventError } = await admin.from("report_events").insert({
          report_reference: reference,
          event_type: "assignment",
          from_status: report.status,
          to_status: report.status,
          public_message: "The report assignment was updated by the Assembly.",
          actor_id: authData.user.id
        });
        if (eventError) throw eventError;
      }
      return json(req, { ok: true, report: data });
    }

    if (action === "resolve") {
      if (!TECHNICIAN_ROLES.has(profile.role) || (!isOfficer && !isAssignedTechnician)) {
        return json(req, { error: "Only the assigned technician or an authorised officer can resolve this report." }, 403);
      }
      const resolutionAction = cleanText(body.resolution_action, 2000);
      const partsUsed = cleanText(body.parts_used, 1000);
      if (resolutionAction.length < 10) return json(req, { error: "Describe the work completed using at least 10 characters." }, 400);
      if (partsUsed.length < 1) return json(req, { error: "Record the parts used, or enter None." }, 400);
      if (!afterPhoto || afterPhoto.size < 1) return json(req, { error: "An after-repair photo is required." }, 400);
      if (afterPhoto.size > PHOTO_LIMIT) return json(req, { error: "The after-repair photo must be 5 MB or smaller." }, 413);
      if (!PHOTO_TYPES.has(afterPhoto.type)) return json(req, { error: "The after-repair photo must be JPG, PNG or WebP." }, 415);

      const extension = afterPhoto.type === "image/jpeg" ? "jpg" : afterPhoto.type === "image/png" ? "png" : "webp";
      uploadedPath = `${reference}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await admin.storage.from("repair-photos").upload(uploadedPath, afterPhoto, {
        contentType: afterPhoto.type, upsert: false
      });
      if (uploadError) throw uploadError;

      const { data, error } = await admin.from("fault_reports").update({
        status: "resolved", resolution_action: resolutionAction, parts_used: partsUsed,
        after_photo_path: uploadedPath, resolved_at: new Date().toISOString(), updated_by: authData.user.id
      }).eq("reference", reference).eq("status", report.status)
        .select("reference,status,resolved_at,after_photo_path").maybeSingle();
      if (error) throw error;
      if (!data) {
        await admin.storage.from("repair-photos").remove([uploadedPath]);
        uploadedPath = null;
        return json(req, { error: "The report changed before resolution. Refresh and try again." }, 409);
      }
      uploadedPath = null;
      return json(req, { ok: true, report: data });
    }

    const nextStatus: Record<string, string> = {
      verify: "verified", start: "in_progress", awaiting_parts: "awaiting_parts",
      resume: "in_progress", close: "closed"
    };
    const target = nextStatus[action];
    if (!target) return json(req, { error: "Unsupported report action." }, 400);

    if (action === "verify" || action === "close") {
      if (!isOfficer) return json(req, { error: "Only an authorised officer can perform this action." }, 403);
    } else if (!isOfficer && !isAssignedTechnician) {
      return json(req, { error: "Only the assigned technician or an authorised officer can update this work." }, 403);
    }

    const { data, error } = await admin.from("fault_reports").update({
      status: target, updated_by: authData.user.id
    }).eq("reference", reference).eq("status", report.status)
      .select("reference,status,updated_at").maybeSingle();
    if (error) throw error;
    if (!data) return json(req, { error: "The report changed before this action. Refresh and try again." }, 409);
    return json(req, { ok: true, report: data });
  } catch (error) {
    console.error("report-action failed", errorMessage(error));
    if (uploadedPath) {
      try {
        const cleanup = createAdminClient();
        await cleanup.storage.from("repair-photos").remove([uploadedPath]);
      } catch (cleanupError) { console.error("After-photo cleanup failed", errorMessage(cleanupError)); }
    }
    return json(req, { error: "The report action could not be completed. Refresh and try again." }, 500);
  }
});
