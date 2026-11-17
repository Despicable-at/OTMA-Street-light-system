import { preflight } from "../_shared/cors.ts";
import { cleanText, errorMessage, json } from "../_shared/http.ts";
import { createAdminClient, createAuthenticatedClient, getActiveStaffProfile } from "../_shared/supabase.ts";

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

    const body = await req.json();
    const reference = cleanText(body?.reference, 50).toUpperCase();
    const kind = cleanText(body?.kind, 20);
    if (!/^OTMA-RPT-(?:20[0-9]{2}-[A-HJ-NP-Z2-9]{8}|[0-9]{5})$/.test(reference) || !["report", "repair"].includes(kind)) {
      return json(req, { error: "Provide a valid report reference and photo type." }, 400);
    }

    const { data: report, error } = await admin.from("fault_reports")
      .select("reference,assigned_to,photo_path,after_photo_path")
      .eq("reference", reference).maybeSingle();
    if (error) throw error;
    if (!report) return json(req, { error: "The report could not be found." }, 404);

    const isOversight = ["administrator", "assembly_officer", "auditor"].includes(profile.role);
    const isAssigned = profile.role === "technician" && report.assigned_to === authData.user.id;
    if (!isOversight && !isAssigned) return json(req, { error: "You do not have access to this report's photos." }, 403);

    const bucket = kind === "report" ? "report-photos" : "repair-photos";
    const path = kind === "report" ? report.photo_path : report.after_photo_path;
    if (!path) return json(req, { error: "No photo is attached to this report." }, 404);

    const { data: signed, error: signedError } = await admin.storage.from(bucket).createSignedUrl(path, 300);
    if (signedError) throw signedError;
    return json(req, { ok: true, signed_url: signed.signedUrl, expires_in_seconds: 300 });
  } catch (error) {
    console.error("photo-url failed", errorMessage(error));
    return json(req, { error: "The requested photo could not be opened." }, 500);
  }
});
