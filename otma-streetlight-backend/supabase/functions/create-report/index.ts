import { preflight } from "../_shared/cors.ts";
import { cleanText, errorMessage, json } from "../_shared/http.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import { isRateLimited } from "../_shared/rate-limit.ts";
import { generateReportReference, getPriority, getSlaDueAt, haversineMeters, validateReportPayload } from "../_shared/domain.mjs";

const PHOTO_LIMIT = 5 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ISSUE_LABELS: Record<string, string> = {
  not_working: "Not working", flickering: "Flickering", pole_damage: "Pole damage",
  exposed_wiring: "Exposed electrical wiring", fallen_pole: "Fallen or leaning pole",
  physical_damage: "Physical damage", other: "Other fault"
};

Deno.serve(async (req: Request) => {
  const blocked = preflight(req);
  if (blocked) return blocked;
  if (req.method !== "POST") return json(req, { error: "Method not allowed." }, 405);

  let uploadedPath: string | null = null;
  try {
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > PHOTO_LIMIT + 128 * 1024) {
      return json(req, { error: "The report and photo upload is too large." }, 413);
    }
    const form = await req.formData();
    const rawPayload = form.get("report");
    let payload: unknown = null;
    try { payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : null; }
    catch { return json(req, { error: "Report details must be valid JSON." }, 400); }

    const validation = validateReportPayload(payload);
    if (!validation.valid) return json(req, { error: "Please correct the report details.", details: validation.errors }, 400);
    const clean = validation.normalized;
    const photo = form.get("photo");
    if (photo && !(photo instanceof File)) return json(req, { error: "Invalid photo upload." }, 400);
    if (photo instanceof File && photo.size > PHOTO_LIMIT) return json(req, { error: "Photo must be 5 MB or smaller." }, 413);
    if (photo instanceof File && photo.size > 0 && !PHOTO_TYPES.has(photo.type)) return json(req, { error: "Photo must be JPG, PNG or WebP." }, 415);

    const supabase = createAdminClient();
    if (await isRateLimited(req, "create-report", 5, 3600)) {
      return json(req, { error: "Too many reports from this connection. Please try again later." }, 429);
    }

    let light: { id: string; community_id: string | null; street: string; latitude: number; longitude: number } | null = null;
    let latitude = clean.latitude;
    let longitude = clean.longitude;

    if (clean.light_id) {
      const { data, error } = await supabase.from("streetlights")
        .select("id,community_id,street,latitude,longitude")
        .eq("id", clean.light_id).eq("is_demo", false).maybeSingle();
      if (error) throw error;
      if (!data) return json(req, { error: "The selected streetlight could not be found. Refresh the map and try again." }, 400);
      light = data;
      const distance = haversineMeters(
        { latitude: clean.latitude, longitude: clean.longitude },
        { latitude: Number(data.latitude), longitude: Number(data.longitude) }
      );
      if (distance > 200) return json(req, { error: "The selected coordinates do not match this streetlight. Please select it again on the map." }, 400);
      latitude = Number(data.latitude);
      longitude = Number(data.longitude);
    }

    const priority = getPriority(clean.fault);
    const reference = generateReportReference(new Date());

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
      street: light?.street ?? (cleanText(clean.landmark, 250) || null),
      latitude,
      longitude,
      issue_type: ISSUE_LABELS[clean.fault],
      description: cleanText(clean.description, 1000),
      priority,
      status: "received",
      reporter_name: cleanText(clean.name, 120) || null,
      reporter_phone: clean.phone,
      nearby_landmark: cleanText(clean.landmark, 250) || null,
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
      sla_due_at: created.sla_due_at,
      message: "Your report has been received. Keep the reference number to track its progress."
    }, 201);
  } catch (error) {
    console.error("create-report failed", errorMessage(error));
    if (uploadedPath) {
      try {
        const cleanup = createAdminClient();
        await cleanup.storage.from("report-photos").remove([uploadedPath]);
      } catch (cleanupError) { console.error("Photo cleanup failed", errorMessage(cleanupError)); }
    }
    return json(req, { error: "The report could not be submitted. Please try again or contact the Assembly." }, 500);
  }
});
