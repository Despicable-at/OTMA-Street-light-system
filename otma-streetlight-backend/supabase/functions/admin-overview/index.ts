import { preflight } from "../_shared/cors.ts";
import { errorMessage, json } from "../_shared/http.ts";
import { createAdminClient, createAuthenticatedClient, getActiveStaffProfile } from "../_shared/supabase.ts";
import { findAreaOutages } from "../_shared/domain.mjs";

const OPEN_STATUSES = ["received", "verified", "assigned", "in_progress", "awaiting_parts"];
const HAZARD_ISSUES = new Set(["Exposed electrical wiring", "Fallen or leaning pole"]);
const MAX_REPORT_SCAN = 1000;

Deno.serve(async (req: Request) => {
  const blocked = preflight(req);
  if (blocked) return blocked;
  if (req.method !== "GET") return json(req, { error: "Method not allowed." }, 405);

  try {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json(req, { error: "Staff authentication is required." }, 401);

    const caller = createAuthenticatedClient(token);
    const { data: authData, error: authError } = await caller.auth.getUser();
    if (authError || !authData.user) return json(req, { error: "Staff session is invalid." }, 401);

    const admin = createAdminClient();
    const profile = await getActiveStaffProfile(admin, authData.user.id);
    if (!profile) return json(req, { error: "An active staff account is required." }, 403);

    const technicianOnly = profile.role === "technician";
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setUTCHours(0, 0, 0, 0);
    weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
    const weekStartIso = weekStart.toISOString();

    let reportQuery = admin.from("fault_reports")
      .select("reference,streetlight_id,community_id,communities(name),street,latitude,longitude,issue_type,priority,status,reported_at,sla_due_at,resolved_at,assigned_to", { count: "exact" })
      .eq("is_demo", false)
      .order("reported_at", { ascending: false })
      .limit(MAX_REPORT_SCAN);
    if (technicianOnly) reportQuery = reportQuery.eq("assigned_to", authData.user.id);

    const [reportResult, statisticsResult] = await Promise.all([
      reportQuery,
      admin.rpc("public_statistics_summary")
    ]);

    if (reportResult.error) throw reportResult.error;
    if (statisticsResult.error) throw statisticsResult.error;

    const reports = reportResult.data ?? [];
    const reportCount = reportResult.count ?? reports.length;
    const reportRefs = reports.map((report: { reference: string }) => report.reference);
    const liveOpenReports = reports.filter((report: { status: string }) => OPEN_STATUSES.includes(report.status));

    const countQuery = async (configure: (query: any) => any) => {
      let query = admin.from("fault_reports").select("reference", { count: "exact", head: true }).eq("is_demo", false);
      if (technicianOnly) query = query.eq("assigned_to", authData.user.id);
      query = configure(query);
      const result = await query;
      if (result.error) throw result.error;
      return result.count ?? 0;
    };

    const [newReports, overdueReports, underRepair, resolvedThisWeek] = await Promise.all([
      countQuery((query) => query.eq("status", "received")),
      countQuery((query) => query.lt("sla_due_at", now.toISOString()).not("status", "in", "(resolved,closed)")),
      countQuery((query) => query.in("status", ["in_progress", "awaiting_parts"])),
      countQuery((query) => query.gte("resolved_at", weekStartIso))
    ]);

    let activity: Array<Record<string, unknown>> = [];
    if (!technicianOnly || reportRefs.length > 0) {
      let activityQuery = admin.from("report_events")
        .select("report_reference,event_type,from_status,to_status,public_message,created_at")
        .order("created_at", { ascending: false }).limit(20);
      if (technicianOnly) activityQuery = activityQuery.in("report_reference", reportRefs);
      const activityResult = await activityQuery;
      if (activityResult.error) throw activityResult.error;
      activity = activityResult.data ?? [];
    }

    const ninetyDaysAgo = now.getTime() - 90 * 24 * 60 * 60 * 1000;
    const openRecent = reports.filter((report: { reported_at: string }) =>
      new Date(report.reported_at).getTime() >= ninetyDaysAgo
    );

    const chronicMap = new Map<string, { streetlight_id: string; community: string; street: string; count: number; latest_reported_at: string }>();
    for (const report of openRecent) {
      if (!report.streetlight_id) continue;
      const existing = chronicMap.get(report.streetlight_id);
      if (existing) {
        existing.count += 1;
        if (report.reported_at > existing.latest_reported_at) existing.latest_reported_at = report.reported_at;
      } else {
        chronicMap.set(report.streetlight_id, {
          streetlight_id: report.streetlight_id,
          community: report.communities?.name ?? "Community pending verification",
          street: report.street ?? "Location pending verification",
          count: 1,
          latest_reported_at: report.reported_at
        });
      }
    }

    const chronicFailureLights = [...chronicMap.values()]
      .filter((item) => item.count >= 3)
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const hazards = liveOpenReports
      .filter((report: { priority: string; issue_type: string }) =>
        report.priority === "critical" || HAZARD_ISSUES.has(report.issue_type)
      )
      .slice(0, 30)
      .map((report: any) => ({
        reference: report.reference,
        priority: report.priority,
        issue: report.issue_type,
        community: report.communities?.name ?? "Community pending verification",
        street: report.street ?? "Location pending verification",
        latitude: report.latitude,
        longitude: report.longitude,
        status: report.status,
        reported_at: report.reported_at
      }));

    const overdueList = liveOpenReports
      .filter((report: { sla_due_at: string }) => new Date(report.sla_due_at).getTime() < now.getTime())
      .sort((a: { sla_due_at: string }, b: { sla_due_at: string }) => a.sla_due_at.localeCompare(b.sla_due_at))
      .slice(0, 30)
      .map((report: any) => ({
        reference: report.reference,
        issue: report.issue_type,
        community: report.communities?.name ?? "Community pending verification",
        street: report.street ?? "Location pending verification",
        status: report.status,
        sla_due_at: report.sla_due_at,
        reported_at: report.reported_at
      }));

    const outages = findAreaOutages(liveOpenReports, {
      radiusMeters: 300,
      windowHours: 24,
      now,
      minimum: 3
    }).map((cluster) => ({
      count: cluster.length,
      anchor: { latitude: Number(cluster[0].latitude), longitude: Number(cluster[0].longitude) },
      community: cluster[0].communities?.name ?? "Community pending verification",
      references: cluster.map((report: { reference: string }) => report.reference)
    }));

    const metrics = statisticsResult.data ?? {};
    return json(req, {
      ok: true,
      refreshed_at: now.toISOString(),
      role: profile.role,
      data_scope: technicianOnly ? "assigned_reports_only" : "all_live_reports",
      metrics: {
        total_lights: metrics.total_lights ?? 0,
        working_percentage: metrics.working_percentage ?? null,
        open_faults: technicianOnly ? liveOpenReports.length : metrics.open_faults ?? 0,
        new_reports: newReports,
        overdue_past_sla: overdueReports,
        under_repair: underRepair,
        resolved_this_week: resolvedThisWeek,
        average_repair_hours: metrics.average_repair_hours ?? null,
        status_breakdown: metrics.status_breakdown ?? {}
      },
      report_scan: {
        returned: reports.length,
        matching_total: reportCount,
        truncated: reportCount > reports.length
      },
      fault_map: liveOpenReports.map((report: any) => ({
        reference: report.reference,
        latitude: report.latitude,
        longitude: report.longitude,
        community: report.communities?.name ?? "Community pending verification",
        street: report.street,
        issue: report.issue_type,
        priority: report.priority,
        status: report.status,
        sla_due_at: report.sla_due_at
      })),
      needs_attention: {
        hazards,
        overdue_reports: overdueList,
        chronic_failure_lights: chronicFailureLights
      },
      area_outages: outages,
      activity
    });
  } catch (error) {
    console.error("admin-overview failed", errorMessage(error));
    return json(req, { error: "The dashboard overview could not be loaded. Refresh and try again." }, 500);
  }
});
