import { corsHeaders } from "./cors.ts";

export function json(req: Request, body: unknown, status = 200) {
  const cors = corsHeaders(req);
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors.headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export function cleanText(value: unknown, max = 1000) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
}

export function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required server secret: ${name}`);
  return value;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected server error.";
}
