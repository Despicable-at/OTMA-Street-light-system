import { createClient } from "npm:@supabase/supabase-js@2";
import { preflight } from "../_shared/cors.ts";
import { cleanText, errorMessage, json, requiredEnv } from "../_shared/http.ts";
import { validateContactPayload } from "../_shared/domain.mjs";

Deno.serve(async (req: Request) => {
  const blocked = preflight(req);
  if (blocked) return blocked;
  if (req.method !== "POST") return json(req, { error: "Method not allowed." }, 405);
  try {
    const validation = validateContactPayload(await req.json());
    if (!validation.valid) return json(req, { error: "Please check your message.", details: validation.errors }, 400);
    const payload = validation.normalized;
    const phone = cleanText(payload.phone ?? "", 30) || null;
    const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
    const { data, error } = await supabase.from("contact_messages").insert({
      name: payload.name, email: payload.email, phone, subject: payload.subject, message: payload.message
    }).select("id,created_at").single();
    if (error) throw error;
    return json(req, { ok: true, message_id: data.id, received_at: data.created_at, message: "Your message has been received." }, 201);
  } catch (error) {
    console.error("contact-message failed", errorMessage(error));
    return json(req, { error: "Your message could not be sent. Please try again later." }, 500);
  }
});
