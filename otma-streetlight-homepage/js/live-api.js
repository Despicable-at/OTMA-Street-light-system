/* OTMA public API integration. No privileged key is ever used in the browser. */
const cfg = () => window.OTMA_CONFIG || {};
export const liveEnabled = () => Boolean(cfg().SUPABASE_URL && cfg().SUPABASE_ANON_KEY && cfg().DEMO_MODE === false);
const base = () => `${String(cfg().SUPABASE_URL || '').replace(/\/$/, '')}/functions/v1`;
async function call(name, { method = 'POST', body, formData = false } = {}) {
  if (!liveEnabled()) throw new Error('Live API is not configured.');
  const headers = { apikey: cfg().SUPABASE_ANON_KEY };
  if (!formData && body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base()}/${name}`, { method, headers, body: formData ? body : body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `API request failed (${response.status}).`);
  return result;
}
export async function fetchLights() {
  if (!liveEnabled()) return null;
  const url = `${cfg().SUPABASE_URL.replace(/\/$/, '')}/rest/v1/streetlights_public?select=*&order=id.asc`;
  const response = await fetch(url, { headers: { apikey: cfg().SUPABASE_ANON_KEY, Authorization: `Bearer ${cfg().SUPABASE_ANON_KEY}` } });
  const rows = await response.json().catch(() => []);
  if (!response.ok) throw new Error(rows.message || 'Could not load the live streetlight inventory.');
  const lights = (rows || []).map(x => ({ id:x.id, latitude:Number(x.latitude), longitude:Number(x.longitude), community:x.community, street:x.street, lampType:x.lampType, status:x.status, lastRepairedDate:x.lastRepairedDate }));
  return { meta:{title:'OTMA streetlight inventory',recordType:'Live inventory',mapCentre:{latitude:6.7342,longitude:-1.6127}}, lights, communities:[...new Set(lights.map(x=>x.community).filter(Boolean))] };
}
export async function submitReport(payload, photo) {
  const fd = new FormData(); fd.set('report', JSON.stringify(payload)); if (photo) fd.set('photo', photo, photo.name);
  return call('create-report', { body:fd, formData:true });
}
export async function trackReport(reference) { return call('track-report', { body:{ reference } }); }
export async function fetchStatistics() { return call('public-stats', { method:'GET' }); }
export async function submitContact(payload) { return call('contact-message', { body:payload }); }
