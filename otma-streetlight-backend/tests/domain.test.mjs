import test from "node:test";
import assert from "node:assert/strict";
import {
  REPORT_STATUSES,
  FAULT_TYPES,
  normalizePhone,
  validateReportPayload,
  validateContactPayload,
  generateReportReference,
  getPriority,
  getSlaDueAt,
  haversineMeters,
  findAreaOutages
} from "../supabase/functions/_shared/domain.mjs";

test("report and fault status enumerations remain explicit", () => {
  assert.deepEqual(REPORT_STATUSES, ["received", "verified", "assigned", "in_progress", "awaiting_parts", "resolved", "closed"]);
  assert.deepEqual(FAULT_TYPES, ["not_working", "flickering", "pole_damage", "exposed_wiring", "fallen_pole", "physical_damage", "other"]);
});

test("Ghana phone normalisation removes common visual separators", () => {
  assert.equal(normalizePhone("024 123-4567"), "0241234567");
  assert.equal(normalizePhone("+233 (24) 123 4567"), "+233241234567");
});

test("valid citizen fault report is accepted and normalized", () => {
  const result = validateReportPayload({
    light_id: "OTMA-SL-00001",
    latitude: "6.735463",
    longitude: "-1.613031",
    phone: "024 123 4567",
    fault: "not_working",
    description: "The light has not turned on for three evenings.",
    name: "Test Reporter",
    nearby_landmark: "Near the junction"
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.latitude, 6.735463);
  assert.equal(result.normalized.longitude, -1.613031);
  assert.equal(result.normalized.phone, "0241234567");
});

test("report validation rejects invalid IDs, coordinates, phone and short descriptions", () => {
  const result = validateReportPayload({
    light_id: "NOT-A-LIGHT", latitude: 220, longitude: -200,
    phone: "123", fault: "wrong_type", description: "bad"
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 5);
});

test("report reference format is valid and deterministic with supplied random bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const ref = generateReportReference(new Date("2026-11-14T12:00:00Z"), bytes);
  assert.match(ref, /^OTMA-RPT-2026-[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(ref, generateReportReference(new Date("2026-11-14T12:00:00Z"), bytes));
});

test("priority rules elevate electrical hazards", () => {
  assert.equal(getPriority("exposed_wiring"), "critical");
  assert.equal(getPriority("fallen_pole"), "critical");
  assert.equal(getPriority("pole_damage"), "high");
  assert.equal(getPriority("not_working"), "normal");
});

test("SLA due dates use 4, 24 and 72-hour defaults", () => {
  const from = new Date("2026-11-14T10:00:00Z");
  assert.equal(getSlaDueAt("critical", from), "2026-11-14T14:00:00.000Z");
  assert.equal(getSlaDueAt("high", from), "2026-11-15T10:00:00.000Z");
  assert.equal(getSlaDueAt("normal", from), "2026-11-17T10:00:00.000Z");
});

test("haversine distance is near zero for same point and correct for local offsets", () => {
  const point = { latitude: 6.7342, longitude: -1.6127 };
  assert.equal(haversineMeters(point, point), 0);
  const nearby = { latitude: 6.7351, longitude: -1.6127 };
  const distance = haversineMeters(point, nearby);
  assert.ok(distance > 95 && distance < 105, `expected about 100m, got ${distance}`);
});

test("area outage detector requires three open reports clustered inside 300m and 24h", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  const base = { latitude: 6.7342, longitude: -1.6127 };
  const reports = [
    { reference: "A", status: "received", reported_at: "2026-11-14T11:30:00Z", ...base },
    { reference: "B", status: "in_progress", reported_at: "2026-11-14T11:35:00Z", latitude: 6.7348, longitude: -1.6127 },
    { reference: "C", status: "verified", reported_at: "2026-11-14T11:40:00Z", latitude: 6.7342, longitude: -1.6135 },
    { reference: "OLD", status: "received", reported_at: "2026-11-13T10:00:00Z", latitude: 6.7343, longitude: -1.6128 },
    { reference: "DONE", status: "resolved", reported_at: "2026-11-14T11:50:00Z", ...base }
  ];
  const clusters = findAreaOutages(reports, { now, radiusMeters: 300, windowHours: 24, minimum: 3 });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].map((x) => x.reference).sort(), ["A", "B", "C"]);
});

test("area outage detector excludes widely separated reports", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  const reports = [
    { reference: "A", status: "received", reported_at: now.toISOString(), latitude: 6.73, longitude: -1.61 },
    { reference: "B", status: "received", reported_at: now.toISOString(), latitude: 6.75, longitude: -1.61 },
    { reference: "C", status: "received", reported_at: now.toISOString(), latitude: 6.77, longitude: -1.61 }
  ];
  assert.equal(findAreaOutages(reports, { now }).length, 0);
});

test("contact form validation accepts optional blank phone and normalizes email", () => {
  const result = validateContactPayload({
    name: "Test Contact Owusu", email: "AKOSUA@example.com", phone: "",
    subject: "Streetlight enquiry", message: "Please provide an update on a reported fault."
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.email, "akosua@example.com");
  assert.equal(result.normalized.phone, "");
});

test("contact form rejects invalid email and malformed optional phone", () => {
  const result = validateContactPayload({
    name: "A", email: "not-an-email", phone: "123",
    subject: "Hi", message: "Too short"
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((x) => x.includes("email")));
  assert.ok(result.errors.some((x) => x.includes("phone")));
});

test("area outage groups are radius-centred instead of returning a long connected chain", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  const lat = 6.7342;
  // 0, 240, 480 and 720 metres east: the largest valid 300m-centred group
  // contains three faults, not all four connected reports.
  const points = [0, 240, 480, 720].map((meters, i) => ({
    reference: `CHAIN-${i}`,
    status: "received",
    reported_at: now.toISOString(),
    latitude: lat,
    longitude: -1.6127 + meters / (111320 * Math.cos(lat * Math.PI / 180))
  }));
  const clusters = findAreaOutages(points, { now, radiusMeters: 300, minimum: 3 });
  assert.ok(clusters.length >= 1);
  assert.ok(clusters.every((cluster) => cluster.length <= 3));
  for (const cluster of clusters) {
    const anchor = cluster[0];
    assert.ok(cluster.every((candidate) => haversineMeters(anchor, candidate) <= 300));
  }
});
