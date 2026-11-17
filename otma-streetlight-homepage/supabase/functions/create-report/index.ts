import { createClient } from "npm:@supabase/supabase-js@2";
import { preflight } from "../_shared/cors.ts";
import { cleanText, errorMessage, json, requiredEnv } from "../_shared/http.ts";
import { generateReportReference, getPriority, getSlaDueAt, validateReportPayload } from "../_shared/domain.mjs";

const PHOTO_LIMIT = 5 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  const blocked = preflight(req);
  if (blocked) return blocked;
  if (req.method !== "POST") return json(req, { error: "Method not allowed." }, 405);

  let uploadedPath: string | null = null;
  try {
    const form = await req.formData();
    const rawPayload = form.get("report");
    const payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : null;
    const validation = validateReportPayload(payload);
    if (!validation.valid) return json(req, { error: "Please correct the report details.", details: validation.errors }, 400);
    const clean = validation.normalized;
    const photo = form.get("photo");
    if (photo && !(photo instanceof File)) return json(req, { error: "Invalid photo upload." }, 400);
    if (photo instanceof File && photo.size > PHOTO_LIMIT) return json(req, { error: "Photo must be 5 MB or smaller." }, 413);
    if (photo instanceof File && !PHOTO_TYPES.has(photo.type)) return json(req, { error: "Photo must be JPG, PNG or WebP." }, 415);

    const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // Basic short-window abuse control. IPs are irreversibly hashed before storage.
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("x-real-ip") || "";
    if (forwarded) {
      const ipHash = await sha256(`${Deno.env.get("RATE_LIMIT_SALT") ?? "otma-rate-limit"}:${forwarded}`);
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count, error: countError } = await supabase.from("request_rate_limits")
        .select("id", { count: "exact", head: true })
        .eq("ip_hash", ipHash).eq("action", "create-report").gte("created_at", since);
      if (countError) console.error("Rate-limit lookup failed", countError.message);
      if ((count ?? 0) >= 5) return json(req, { error: "Too many reports from this connection. Please try again later." }, 429);
      await supabase.from("request_rate_limits").insert({ ip_hash: ipHash, action: "create-report" });
    }

    let light = null;
    if (clean.light_id) {
      const { data, error } = await supabase.from("streetlights")
        .select("id,community_id,street,status").eq("id", clean.light_id).maybeSingle();
      if (error) throw error;
      if (!data) return json(req, { error: "The selected streetlight could not be found. Refresh the map and try again." }, 400);
      light = data;
    }

    const priority = getPriority(clean.fault);
    const reference = generateReportReference(new Date());
    const issueLabels: Record<string, string> = {
      not_working: "Not working", flickering: "Flickering", pole_damage: "Pole damage",
      exposed_wiring: "Exposed electrical wiring", fallen_pole: "Fallen or leaning pole",
      physical_damage: "Physical damage", other: "Other fault"
    };

    if (photo instanceof File && photo.size > 0) {
      const extension = photo.type === "image/jpeg" ? "jpg" : photo.type === "image/png" ? "png" : "webp";
      uploadedPath = `${reference}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from("report-photos").upload(uploadedPath, photo, {
        contentType: photo.type, upsert: false
      });
      if (uploadError) throw uploadError;
    }

    const row = {
      reference,
      streetlight_id: light?.id ?? null,
      community_id: light?.community_id ?? null,
      street: light?.street ?? cleanText(clean.landmark, 250) ?? null,
      latitude: clean.latitude,
      longitude: clean.longitude,
      issue_type: issueLabels[clean.fault],
      description: clean.description,
      priority,
      status: "received",
      reporter_name: cleanText(clean.name, 120) || null,
      reporter_phone: clean.phone,
      nearby_landmark: clean.landmark || null,
      photo_path: uploadedPath,
      sla_due_at: getSlaDueAt(priority),
      is_demo: false
    };

    const { data: created, error: insertError } = await supabase.from("fault_reports")
      .insert(row).select("reference,status,reported_at,sla_due_at").single();
    if (insertError) throw insertError;

    return json(req, {
      ok: true,
      reference: created.reference,
      status: created.status,
      reported_at: created.reported_at,
      message: "Your report has been received. Keep the reference number to track its progress."
    }, 201);
  } catch (error) {
    console.error("create-report failed", errorMessage(error));
    if (uploadedPath) {
      try {
        const cleanup = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
        await cleanup.storage.from("report-photos").remove([uploadedPath]);
      } catch (cleanupError) { console.error("Photo cleanup failed", errorMessage(cleanupError)); }
    }
    return json(req, { error: "The report could not be submitted. Please try again or contact the Assembly." }, 500);
  }
});
