import { preflight } from "../_shared/cors.ts";
import { cleanText, errorMessage, json } from "../_shared/http.ts";
import { createAdminClient, createAuthenticatedClient, getActiveStaffProfile } from "../_shared/supabase.ts";

const ALLOWED_ROLES = new Set(["administrator", "assembly_officer", "technician", "auditor"]);

Deno.serve(async (req: Request) => {
  const blocked = preflight(req);
  if (blocked) return blocked;
  if (req.method !== "POST") return json(req, { error: "Method not allowed." }, 405);
  try {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json(req, { error: "Staff authentication is required." }, 401);

    const caller = createAuthenticatedClient(token);
    const { data: userData, error: userError } = await caller.auth.getUser();
    if (userError || !userData.user) return json(req, { error: "Staff session is invalid." }, 401);

    const admin = createAdminClient();
    const profile = await getActiveStaffProfile(admin, userData.user.id);
    if (!profile || profile.role !== "administrator") {
      return json(req, { error: "Only an active administrator can invite staff." }, 403);
    }

    const body = await req.json();
    const email = cleanText(body?.email, 254).toLowerCase();
    const fullName = cleanText(body?.full_name, 120);
    const role = cleanText(body?.role, 40);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || fullName.length < 2 || !ALLOWED_ROLES.has(role)) {
      return json(req, { error: "Provide a valid email, full name and permitted staff role." }, 400);
    }

    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName }
    });
    if (inviteError) throw inviteError;
    if (!invited.user) throw new Error("Auth invitation did not return a user.");

    const { error: updateError } = await admin.from("profiles").upsert({
      id: invited.user.id, email, full_name: fullName, role, is_active: true
    });
    if (updateError) throw updateError;

    const { error: auditError } = await admin.from("audit_logs").insert({
      actor_id: userData.user.id, action: "staff_invited", entity_type: "profile",
      entity_id: invited.user.id, metadata: { role }
    });
    if (auditError) console.error("admin-invite audit insert failed", auditError.message);

    return json(req, {
      ok: true, user_id: invited.user.id, email, role,
      message: "Invitation created. The user must accept the invitation and set a password."
    }, 201);
  } catch (error) {
    console.error("admin-invite failed", errorMessage(error));
    return json(req, { error: "The staff invitation could not be created." }, 500);
  }
});
