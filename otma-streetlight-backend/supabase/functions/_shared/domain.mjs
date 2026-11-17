export const REPORT_STATUSES = Object.freeze([
  "received", "verified", "assigned", "in_progress", "awaiting_parts", "resolved", "closed"
]);

export const FAULT_TYPES = Object.freeze([
  "not_working", "flickering", "pole_damage", "exposed_wiring",
  "fallen_pole", "physical_damage", "other"
]);

export const GHANA_PHONE_PATTERN = /^(?:\+233|0)[0-9]{9}$/;
export const REPORT_REFERENCE_PATTERN = /^OTMA-RPT-(?:20[0-9]{2}-[A-HJ-NP-Z2-9]{8}|[0-9]{5})$/;

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

  return {
    valid: errors.length === 0,
    errors,
    normalized: { ...payload, latitude, longitude, phone, name, description, landmark }
  };
}

export function validateContactPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, errors: ["Contact payload must be an object."] };
  }

  const name = String(payload.name ?? "").trim();
  const email = String(payload.email ?? "").trim().toLowerCase();
  const subject = String(payload.subject ?? "").trim();
  const message = String(payload.message ?? "").trim();
  const phone = normalizePhone(payload.phone);

  if (name.length < 2 || name.length > 120) errors.push("Enter a name between 2 and 120 characters.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) errors.push("Enter a valid email address.");
  if (subject.length < 3 || subject.length > 160) errors.push("Subject must contain 3 to 160 characters.");
  if (message.length < 10 || message.length > 3000) errors.push("Message must contain 10 to 3,000 characters.");
  if (phone && !GHANA_PHONE_PATTERN.test(phone)) errors.push("Enter a valid Ghanaian phone number or leave it blank.");

  return { valid: errors.length === 0, errors, normalized: { name, email, phone, subject, message } };
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
  const v = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(v));
}

export function findAreaOutages(reports, {
  radiusMeters = 300, windowHours = 24, now = new Date(), minimum = 3
} = {}) {
  const nowMs = new Date(now).getTime();
  const cutoff = nowMs - windowHours * 3600000;
  const open = reports.filter((report) => {
    const date = new Date(report.reported_at ?? report.reportedAt).getTime();
    return REPORT_STATUSES.slice(0, 5).includes(report.status)
      && Number.isFinite(date) && date >= cutoff && date <= nowMs
      && Number.isFinite(Number(report.latitude)) && Number.isFinite(Number(report.longitude));
  });

  // A cluster must be demonstrably centred on a 300 m neighbourhood. Returning
  // an entire connected component can overstate the affected area for long chains.
  const unique = new Map();
  for (const anchor of open) {
    // Put the anchor first so every returned group visibly fits within the
    // advertised radius around its first (centroid-like) reference point.
    const cluster = [anchor, ...open.filter((candidate) =>
      candidate.reference !== anchor.reference && haversineMeters(anchor, candidate) <= radiusMeters
    )];
    if (cluster.length < minimum) continue;
    const key = cluster.map((item) => item.reference).sort().join('|');
    if (!unique.has(key)) unique.set(key, cluster);
  }

  return [...unique.values()].sort((a, b) => b.length - a.length);
}
