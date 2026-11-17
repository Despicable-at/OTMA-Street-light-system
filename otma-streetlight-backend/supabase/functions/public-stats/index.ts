import { preflight } from "../_shared/cors.ts";
import { errorMessage, json } from "../_shared/http.ts";
import { createAdminClient } from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  const blocked = preflight(req);
  if (blocked) return blocked;
  if (req.method !== "GET") return json(req, { error: "Method not allowed." }, 405);
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("public_statistics_summary");
    if (error) throw error;
    return json(req, data ?? { data_status: "No verified live records loaded" });
  } catch (error) {
    console.error("public-stats failed", errorMessage(error));
    return json(req, { error: "Public statistics are temporarily unavailable." }, 500);
  }
});
