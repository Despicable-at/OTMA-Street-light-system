export function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const allowAll = configured.length === 0 || configured.includes("*");
  const allowed = allowAll || configured.includes(origin);
  return {
    allowed,
    headers: {
      "Access-Control-Allow-Origin": allowAll ? "*" : (allowed ? origin : "null"),
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    }
  };
}

export function preflight(req: Request) {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: cors.headers });
  if (!cors.allowed) return new Response(JSON.stringify({ error: "Origin not allowed." }), {
    status: 403,
    headers: { ...cors.headers, "Content-Type": "application/json" }
  });
  return null;
}
