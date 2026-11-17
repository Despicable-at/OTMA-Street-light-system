export const REPORT_STATUSES = Object.freeze([
  "received", "verified", "assigned", "in_progress", "awaiting_parts", "resolved", "closed"
]);

export const FAULT_TYPES = Object.freeze([
  "not_working", "flickering", "pole_damage", "exposed_wiring",
  "fallen_pole", "physical_damage", "other"
]);

export const GHANA_PHONE_PATTERN = /^(?:\+233|0)[0-9]{9}$/;

export function normalizePhone(value) {
  return String(value ?? "").replace(/[\s()-]/g, "");
}

export function validateReportPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, errors: ["Report payload must be an object."] };
  }
  const latitude = Number(payload.latitude);
  const longitude = Number(payload.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) errors.push("A valid latitude is required.");
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) errors.push("A valid longitude is required.");
  if (payload.light_id != null && !/^OTMA-SL-[0-9]{5}$/.test(String(payload.light_id))) errors.push("The streetlight ID is invalid.");
  if (!FAULT_TYPES.includes(String(payload.fault ?? ""))) errors.push("Select a supported fault type.");
  const description = String(payload.description ?? "").trim();
  if (description.length < 10 || description.length > 1000) errors.push("Description must contain 10 to 1,000 characters.");
  const phone = normalizePhone(payload.phone);
  if (!GHANA_PHONE_PATTERN.test(phone)) errors.push("Enter a valid Ghanaian phone number.");
  const name = String(payload.name ?? "").trim();
  if (name.length > 120) errors.push("Name must be 120 characters or fewer.");
  const landmark = String(payload.nearby_landmark ?? payload.landmark ?? "").trim();
  if (landmark.length > 250) errors.push("Landmark must be 250 characters or fewer.");
  return { valid: errors.length === 0, errors, normalized: { ...payload, latitude, longitude, phone, name, description, landmark } };
}

export function validateContactPayload(payload) {
  const errors = [];
  const name = String(payload?.name ?? "").trim();
  const email = String(payload?.email ?? "").trim();
  const subject = String(payload?.subject ?? "").trim();
  const message = String(payload?.message ?? "").trim();
  if (name.length < 2 || name.length > 120) errors.push("Enter a name between 2 and 120 characters.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) errors.push("Enter a valid email address.");
  if (subject.length < 3 || subject.length > 160) errors.push("Subject must contain 3 to 160 characters.");
  if (message.length < 10 || message.length > 3000) errors.push("Message must contain 10 to 3,000 characters.");
  return { valid: errors.length === 0, errors, normalized: { name, email, subject, message } };
}

export function generateReportReference(date = new Date(), randomBytes = crypto.getRandomValues(new Uint8Array(8))) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let token = "";
  for (const byte of randomBytes) token += alphabet[byte % alphabet.length];
  return `OTMA-RPT-${date.getUTCFullYear()}-${token}`;
}

export function getPriority(faultType) {
  if (["exposed_wiring", "fallen_pole"].includes(faultType)) return "critical";
  if (["pole_damage", "physical_damage"].includes(faultType)) return "high";
  return "normal";
}

export function getSlaDueAt(priority, from = new Date()) {
  const hours = priority === "critical" ? 4 : priority === "high" ? 24 : 72;
  return new Date(new Date(from).getTime() + hours * 60 * 60 * 1000).toISOString();
}

export function haversineMeters(a, b) {
  const rad = (value) => value * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const v = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(v));
}

export function findAreaOutages(reports, { radiusMeters = 300, windowHours = 24, now = new Date(), minimum = 3 } = {}) {
  const cutoff = new Date(now).getTime() - windowHours * 3600000;
  const open = reports.filter((report) => {
    const date = new Date(report.reported_at ?? report.reportedAt).getTime();
    const status = report.status;
    return REPORT_STATUSES.slice(0, 5).includes(status) && date >= cutoff && date <= new Date(now).getTime()
      && Number.isFinite(Number(report.latitude)) && Number.isFinite(Number(report.longitude));
  });
  const clusters = [];
  const used = new Set();
  for (const report of open) {
    if (used.has(report.reference)) continue;
    const nearby = open.filter((candidate) => haversineMeters(
      { latitude: Number(report.latitude), longitude: Number(report.longitude) },
      { latitude: Number(candidate.latitude), longitude: Number(candidate.longitude) }
    ) <= radiusMeters);
    if (nearby.length >= minimum) {
      nearby.forEach((item) => used.add(item.reference));
      clusters.push(nearby);
    }
  }
  return clusters;
}
