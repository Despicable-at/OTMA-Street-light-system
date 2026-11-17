import { createAdminClient } from "./supabase.ts";
import { requiredEnv } from "./http.ts";

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Uses the platform proxy IP when supplied. No raw IP is written to the database. */
export async function isRateLimited(req: Request, action: string, limit: number, windowSeconds: number) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("cf-connecting-ip")
    || req.headers.get("x-real-ip");
  if (!ip) return false;

  const ipHash = await sha256(`${requiredEnv("RATE_LIMIT_SALT")}:${ip}`);
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("consume_request_rate_limit", {
    p_ip_hash: ipHash,
    p_action: action,
    p_limit: limit,
    p_window_seconds: windowSeconds
  });
  if (error) throw error;
  return data !== true;
}
