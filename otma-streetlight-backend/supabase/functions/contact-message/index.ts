import { preflight } from "../_shared/cors.ts";
import { cleanText, errorMessage, json } from "../_shared/http.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import { isRateLimited } from "../_shared/rate-limit.ts";
import { validateContactPayload } from "../_shared/domain.mjs";

Deno.serve(async (req: Request) => {
  const blocked = preflight(req);
  if (blocked) return blocked;
  if (req.method !== "POST") return json(req, { error: "Method not allowed." }, 405);
  try {
    const validation = validateContactPayload(await req.json());
    if (!validation.valid) return json(req, { error: "Please check your message.", details: validation.errors }, 400);
    const payload = validation.normalized;

    const supabase = createAdminClient();
    if (await isRateLimited(req, "contact-message", 5, 3600)) {
      return json(req, { error: "Too many messages from this connection. Please try again later." }, 429);
    }

    const { data, error } = await supabase.from("contact_messages").insert({
      name: cleanText(payload.name, 120),
      email: cleanText(payload.email, 254).toLowerCase(),
      phone: cleanText(payload.phone, 30) || null,
      subject: cleanText(payload.subject, 160),
      message: cleanText(payload.message, 3000)
    }).select("id,created_at").single();
    if (error) throw error;
    return json(req, {
      ok: true, message_id: data.id, received_at: data.created_at,
      message: "Your message has been received."
    }, 201);
  } catch (error) {
    console.error("contact-message failed", errorMessage(error));
    return json(req, { error: "Your message could not be sent. Please try again later." }, 500);
  }
});
