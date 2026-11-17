import { createClient } from "npm:@supabase/supabase-js@2";
import { requiredEnv } from "./http.ts";

function keyFromJsonEnv(name: string): string | null {
  const raw = Deno.env.get(name);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed.default ?? Object.values(parsed)[0] ?? null;
  } catch {
    return null;
  }
}

export function getPublishableKey(): string {
  return Deno.env.get("SUPABASE_ANON_KEY")
    ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")
    ?? keyFromJsonEnv("SUPABASE_PUBLISHABLE_KEYS")
    ?? requiredEnv("SUPABASE_ANON_KEY");
}

export function getSecretKey(): string {
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    ?? Deno.env.get("SUPABASE_SECRET_KEY")
    ?? keyFromJsonEnv("SUPABASE_SECRET_KEYS")
    ?? requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
}

export function createAdminClient() {
  return createClient(requiredEnv("SUPABASE_URL"), getSecretKey(), {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export function createAuthenticatedClient(accessToken: string) {
  return createClient(requiredEnv("SUPABASE_URL"), getPublishableKey(), {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export async function getActiveStaffProfile(admin: ReturnType<typeof createAdminClient>, userId: string) {
  const { data, error } = await admin.from("profiles")
    .select("id,email,full_name,role,is_active")
    .eq("id", userId).maybeSingle();
  if (error) throw error;
  if (!data || !data.is_active || data.role === "pending") return null;
  return data;
}
