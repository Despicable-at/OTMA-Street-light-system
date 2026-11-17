/** Fail-closed CORS. Set ALLOWED_ORIGINS to the exact Vercel origin(s). */
export function corsHeaders(req: Request) {
  const origin = req.headers.get("origin");
  const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",").map((value) => value.trim()).filter((value) => value && value !== "*");
  const allowed = !origin || allowedOrigins.includes(origin);

  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (origin && allowed) headers["Access-Control-Allow-Origin"] = origin;
  return { allowed, headers };
}

export function preflight(req: Request) {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: cors.allowed ? 200 : 403, headers: cors.headers });
  }
  if (!cors.allowed) {
    return new Response(JSON.stringify({ error: "Origin not allowed. Check the backend ALLOWED_ORIGINS setting." }), {
      status: 403,
      headers: { ...cors.headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
  return null;
}
