import { createClient } from "npm:@supabase/supabase-js@2";
import { preflight } from "../_shared/cors.ts";
import { errorMessage, json, requiredEnv } from "../_shared/http.ts";

const monthKey = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

Deno.serve(async (req: Request) => {
  const blocked = preflight(req);
  if (blocked) return blocked;
  if (req.method !== "GET" && req.method !== "POST") return json(req, { error: "Method not allowed." }, 405);
  try {
    const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
    const [{ data: lights, error: lightError }, { data: reports, error: reportError }] = await Promise.all([
      supabase.from("streetlights").select("status,is_demo,community_id,communities(name)"),
      supabase.from("fault_reports").select("status,reported_at,resolved_at,community_id,communities(name),is_demo")
    ]);
    if (lightError) throw lightError;
    if (reportError) throw reportError;
    const liveLights = (lights ?? []).filter((x) => !x.is_demo);
    const liveReports = (reports ?? []).filter((x) => !x.is_demo);
    const statuses = ["working", "faulty", "under_repair", "out_of_service"];
    const statusBreakdown = Object.fromEntries(statuses.map((status) => [status, liveLights.filter((x) => x.status === status).length]));
    const totalLights = liveLights.length;
    const working = statusBreakdown.working ?? 0;
    const openFaults = liveReports.filter((x) => !["resolved", "closed"].includes(x.status)).length;
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0,0,0,0);
    const repairedThisMonth = liveReports.filter((x) => x.resolved_at && new Date(x.resolved_at) >= monthStart).length;
    const completed = liveReports.filter((x) => x.resolved_at && x.reported_at);
    const averageRepairHours = completed.length
      ? completed.reduce((sum, x) => sum + (new Date(x.resolved_at).getTime() - new Date(x.reported_at).getTime()) / 3600000, 0) / completed.length
      : null;
    const months = [];
    for (let offset = 5; offset >= 0; offset--) {
      const date = new Date(); date.setUTCDate(1); date.setUTCHours(0,0,0,0); date.setUTCMonth(date.getUTCMonth() - offset);
      const key = monthKey(date);
      const monthReports = liveReports.filter((x) => monthKey(new Date(x.reported_at)) === key);
      const monthResolved = liveReports.filter((x) => x.resolved_at && monthKey(new Date(x.resolved_at)) === key);
      months.push({ month: key, reported: monthReports.length, resolved: monthResolved.length });
    }
    const byCommunity = new Map();
    for (const report of liveReports) {
      const name = report.communities?.name ?? "Unassigned community";
      byCommunity.set(name, (byCommunity.get(name) ?? 0) + 1);
    }
    return json(req, {
      data_status: totalLights === 0 && liveReports.length === 0 ? "No verified live records loaded" : "Live records",
      total_lights: totalLights,
      working_percentage: totalLights ? Math.round((working / totalLights) * 1000) / 10 : null,
      open_faults: openFaults,
      repaired_this_month: repairedThisMonth,
      average_repair_hours: averageRepairHours === null ? null : Math.round(averageRepairHours * 10) / 10,
      status_breakdown: statusBreakdown,
      monthly: months,
      faults_by_community: [...byCommunity.entries()].map(([community, count]) => ({ community, count })).sort((a,b) => b.count - a.count)
    });
  } catch (error) {
    console.error("public-stats failed", errorMessage(error));
    return json(req, { error: "Public statistics are temporarily unavailable." }, 500);
  }
});
