import { preflight } from "../_shared/cors.ts";
import { cleanText, errorMessage, json } from "../_shared/http.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import { isRateLimited } from "../_shared/rate-limit.ts";
import { REPORT_REFERENCE_PATTERN } from "../_shared/domain.mjs";

const labels: Record<string, string> = {
  received: "Received", verified: "Verified", assigned: "Assigned", in_progress: "In Progress",
  awaiting_parts: "Awaiting Parts", resolved: "Resolved", closed: "Closed"
};

Deno.serve(async (req: Request) => {
  const blocked = preflight(req);
  if (blocked) return blocked;
  if (req.method !== "POST") return json(req, { error: "Method not allowed." }, 405);
  try {
    const body = await req.json();
    const reference = cleanText(body?.reference, 50).toUpperCase();
    if (!REPORT_REFERENCE_PATTERN.test(reference)) return json(req, { error: "Enter a valid report reference." }, 400);

    const supabase = createAdminClient();
    if (await isRateLimited(req, "track-report", 30, 600)) {
      return json(req, { error: "Too many lookups. Please wait a few minutes and try again." }, 429);
    }

    const { data: report, error } = await supabase.from("fault_reports")
      .select("reference,status,issue_type,street,reported_at,resolved_at,community_id,communities(name)")
      .eq("reference", reference).maybeSingle();
    if (error) throw error;
    if (!report) return json(req, { error: "No report was found. Check the reference number and try again." }, 404);

    const { data: events, error: eventError } = await supabase.from("report_events")
      .select("to_status,public_message,created_at")
      .eq("report_reference", reference)
      .order("created_at", { ascending: true });
    if (eventError) throw eventError;

    return json(req, {
      ok: true,
      report: {
        reference: report.reference,
        status: labels[report.status] ?? report.status,
        community: report.communities?.name ?? "Location pending verification",
        street: report.street ?? "Map-selected location",
        issue: report.issue_type,
        reported_at: report.reported_at,
        resolved_at: report.resolved_at,
        timeline: (events ?? []).map((event) => ({
          stage: labels[event.to_status] ?? "Updated",
          message: event.public_message,
          created_at: event.created_at
        }))
      }
    });
  } catch (error) {
    console.error("track-report failed", errorMessage(error));
    return json(req, { error: "Report tracking is temporarily unavailable." }, 500);
  }
});
