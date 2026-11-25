/* Thin wrapper around the Supabase JS client. Real backend: Postgres (accounts, fleets,
   units, inspections) + Storage (video/photos), replacing the old IndexedDB/localStorage demo. */

const SUPABASE_READY = Boolean(
  window.SUPABASE_CONFIG &&
  /^https?:\/\//.test(window.SUPABASE_CONFIG.url) &&
  window.SUPABASE_CONFIG.anonKey &&
  window.SUPABASE_CONFIG.anonKey !== 'YOUR_SUPABASE_ANON_KEY'
);

const sb = SUPABASE_READY
  ? window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey, {
      auth: {
        persistSession: true,
        storage: window.localStorage,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

function requireSb() {
  if (!sb) throw new Error('Supabase is not configured yet — fill in js/supabase-config.js with your project URL and anon key.');
  return sb;
}

/* ---------------- auth ---------------- */

async function sbSignUp(email, password, metadata, emailRedirectTo) {
  // metadata (name/phone/role/fleet_code) lands in auth.users.raw_user_meta_data, which
  // the handle_new_user() DB trigger reads to create the profile (and fleet, if manager)
  // server-side — see supabase/schema.sql. The client never inserts these rows directly.
  // emailRedirectTo must also be added under Authentication -> URL Configuration ->
  // Redirect URLs in the Supabase dashboard, or Supabase will silently ignore it.
  return requireSb().auth.signUp({ email, password, options: { data: metadata, emailRedirectTo } });
}

async function sbSignIn(email, password) {
  return requireSb().auth.signInWithPassword({ email, password });
}

async function sbSignOut() {
  return requireSb().auth.signOut();
}

async function sbGetSessionUser() {
  const { data } = await requireSb().auth.getSession();
  return data.session ? data.session.user : null;
}

async function sbSendPasswordReset(email, redirectTo) {
  return requireSb().auth.resetPasswordForEmail(email, { redirectTo });
}

async function sbVerifyOtp(email, token, type) {
  // type is 'signup' for the confirm-account code, 'recovery' for the reset-password code.
  // On success this establishes a real session — for 'recovery' that's what then lets
  // updateUser({password}) immediately after actually go through.
  return requireSb().auth.verifyOtp({ email, token, type });
}

async function sbUpdatePassword(newPassword) {
  return requireSb().auth.updateUser({ password: newPassword });
}

function sbOnAuthEvent(callback) {
  requireSb().auth.onAuthStateChange((event, session) => callback(event, session));
}

/* ---------------- profiles ---------------- */

async function sbGetProfile(userId) {
  const { data, error } = await requireSb().from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

async function sbGetFleetDrivers(fleetCode) {
  const { data, error } = await requireSb()
    .from('profiles')
    .select('*')
    .eq('fleet_code', fleetCode)
    .eq('role', 'driver')
    .order('name');
  if (error) throw error;
  return data;
}

async function sbGetFleetManagers(fleetCode) {
  const { data, error } = await requireSb()
    .from('profiles')
    .select('*')
    .eq('fleet_code', fleetCode)
    .eq('role', 'manager')
    .order('name');
  if (error) throw error;
  return data;
}

// Manager security code (see supabase/manager_security_code.sql)
async function sbCheckManagerCode(fleetCode, managerCode) {
  const { data, error } = await requireSb().rpc('check_manager_code', { p_fleet: fleetCode, p_code: managerCode });
  if (error) throw error;
  return data === true;
}
async function sbGetManagerCode() {
  const { data, error } = await requireSb().rpc('get_manager_code');
  if (error) throw error;
  return data;
}
async function sbRegenerateManagerCode() {
  const { data, error } = await requireSb().rpc('regenerate_manager_code');
  if (error) throw error;
  return data;
}

// Removes the driver's profile AND their login (their past inspections stay as company records).
async function sbRemoveDriver(userId) {
  const r = await requireSb().rpc('manager_remove_driver', { p_driver_id: userId });
  if (!r.error) return r;
  if (!/manager_remove_driver|schema cache|does not exist/i.test(r.error.message || '')) return r;
  return requireSb().from('profiles').delete().eq('id', userId); // database update not installed yet
}

// Name, login (email), password and assigned unit in one go (blank login/password = unchanged).
async function sbManagerUpdateDriver(userId, { name, email, password, unit }) {
  const { error } = await requireSb().rpc('manager_update_driver', {
    p_driver_id: userId, p_name: name, p_email: email || '', p_password: password || '', p_unit: unit || '',
  });
  if (error) throw error;
}

async function sbManagerUpdateManager(userId, { name, email, password }) {
  const { error } = await requireSb().rpc('manager_update_manager', {
    p_manager_id: userId, p_name: name, p_email: email || '', p_password: password || '',
  });
  if (error) throw error;
}

async function sbRemoveManager(userId) {
  const { error } = await requireSb().rpc('manager_remove_manager', { p_manager_id: userId });
  if (error) throw error;
}

async function sbUpdateDriver(userId, fields) {
  return requireSb().from('profiles').update(fields).eq('id', userId);
}

/* ---------------- fleets ---------------- */

// Yes/no lookup (the database no longer lets strangers list every fleet code).
async function sbFindFleetByCode(code) {
  const { data, error } = await requireSb().rpc('find_fleet', { p_code: String(code || '') });
  if (!error) return data ? { code: data } : null;
  if (!/find_fleet|schema cache|does not exist/i.test(error.message || '')) throw error;
  // database update not installed yet: old behaviour
  const r = await requireSb().from('fleets').select('code').ilike('code', code).maybeSingle();
  if (r.error) throw r.error;
  return r.data;
}

/* ---------------- units ---------------- */

async function sbGetUnits(fleetCode) {
  const { data, error } = await requireSb().from('units').select('*').eq('fleet_code', fleetCode).order('unit');
  if (error) throw error;
  return data;
}

async function sbInsertUnit(unit) {
  return requireSb().from('units').insert(unit);
}

async function sbDeleteUnit(id) {
  return requireSb().from('units').delete().eq('id', id);
}

/* ---------------- inspections ---------------- */

// Supabase returns at most 1000 rows per request, so this reads page after page (newest first).
// opts: { since: ISO date (only newer), driverId: only that driver's, max: safety cap }
async function sbGetInspections(fleetCode, opts) {
  const o = opts || {};
  const PAGE = 1000;
  const cap = o.max || 20000;
  let out = [];
  for (let from = 0; from < cap; from += PAGE) {
    let q = requireSb().from('inspections').select('*').eq('fleet_code', fleetCode);
    q = o.type ? q.eq('type', o.type) : q.neq('type', 'BASELINE'); // assigned truck videos only when asked for
    if (o.since) q = q.gte('created_at', o.since);
    if (o.driverId) q = q.eq('driver_id', o.driverId);
    const { data, error } = await q.order('created_at', { ascending: false }).range(from, from + PAGE - 1);
    if (error) throw error;
    out = out.concat(data || []);
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function sbCountInspections(fleetCode) {
  const { count, error } = await requireSb().from('inspections').select('id', { count: 'exact', head: true }).eq('fleet_code', fleetCode).neq('type', 'BASELINE');
  if (error) throw error;
  return count || 0;
}

// Oldest inspections past the retention date (used by the automatic clean-up).
async function sbGetExpiredInspections(fleetCode, cutoffIso, limit) {
  const { data, error } = await requireSb()
    .from('inspections')
    .select('id,video_path,defects,created_at')
    .eq('fleet_code', fleetCode)
    .neq('type', 'BASELINE') // assigned truck videos are never auto-deleted
    .lt('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .limit(limit || 40);
  if (error) throw error;
  return data || [];
}

async function sbGetRecentInspections(fleetCode, sinceIso) {
  const { data, error } = await requireSb()
    .from('inspections')
    .select('driver_id,driver_name,type,unit,created_at')
    .eq('fleet_code', fleetCode)
    .neq('type', 'BASELINE')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function sbInsertInspection(record) {
  return requireSb().from('inspections').insert(record);
}

async function sbDeleteInspection(id) {
  return requireSb().from('inspections').delete().eq('id', id);
}

/* ---------------- storage ---------------- */

async function sbDeleteStorageObjects(paths) {
  const clean = (paths || []).filter(Boolean);
  if (clean.length === 0) return;
  const { error } = await requireSb().storage.from('inspection-media').remove(clean);
  if (error) throw error;
}

async function sbUploadBlob(path, blob) {
  const { error } = await requireSb().storage.from('inspection-media').upload(path, blob, {
    contentType: String(blob.type || 'application/octet-stream').split(';')[0],
    upsert: false,
  });
  if (error) throw error;
  return path;
}

// The vendored supabase-js storage client has no upload-progress callback, so real
// byte-level progress (for the uploading screen) needs a direct XHR call to the same
// REST endpoint the SDK uses under the hood.
async function sbUploadBlobWithProgress(path, blob, onProgress, bucket) {
  const { data: sessionData } = await requireSb().auth.getSession();
  const token = sessionData.session ? sessionData.session.access_token : null;
  if (!token) throw new Error('Your session expired — log back in and try again.');

  const url = `${window.SUPABASE_CONFIG.url}/storage/v1/object/${bucket || 'inspection-media'}/${path}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', window.SUPABASE_CONFIG.anonKey);
    xhr.setRequestHeader('Content-Type', String(blob.type || 'application/octet-stream').split(';')[0]);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onProgress) onProgress(blob.size);
        resolve(path);
      } else {
        reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText || 'unknown error'}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload — check your connection and try again.'));
    xhr.send(blob);
  });
}

// ---- Fast + resumable upload (TUS protocol, Supabase Storage) -------------------------------
// Sends the file in 6 MB pieces straight to Supabase's storage server. If the connection drops, only
// the current piece is retried and the upload carries on from where it stopped (even after the app is
// closed and reopened), instead of starting the whole video again. Falls back to the old single-request
// upload if the resumable route is not available.
const TUS_CHUNK = 6 * 1024 * 1024; // Supabase requires exactly 6 MB pieces
const TUS_KEY_PREFIX = 'pti_tus_';

function tusEndpoint() {
  const base = String(window.SUPABASE_CONFIG.url || '');
  const ref = (base.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i) || [])[1];
  // The direct storage address skips the general API gateway, which is much faster for big files.
  return ref ? `https://${ref}.storage.supabase.co/storage/v1/upload/resumable` : `${base}/storage/v1/upload/resumable`;
}

function tusB64(s) {
  return btoa(unescape(encodeURIComponent(String(s))));
}

async function tusToken() {
  const { data } = await requireSb().auth.getSession();
  const token = data && data.session ? data.session.access_token : null;
  if (!token) throw new Error('Your session expired — log back in and try again.');
  return token;
}

function tusRequest(method, url, headers, body, onUploadProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    Object.keys(headers || {}).forEach((k) => xhr.setRequestHeader(k, headers[k]));
    if (onUploadProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onUploadProgress(e.loaded); };
    xhr.onload = () => resolve({ status: xhr.status, getHeader: (n) => xhr.getResponseHeader(n), text: xhr.responseText });
    xhr.onerror = () => reject(new Error('network'));
    xhr.ontimeout = () => reject(new Error('network'));
    xhr.timeout = 120000;
    xhr.send(body || null);
  });
}

function tusSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function sbUploadResumable(path, blob, onProgress, resumeId, bucket) {
  const total = blob.size;
  const keyName = TUS_KEY_PREFIX + (resumeId || path);
  const endpoint = tusEndpoint();
  const baseHeaders = async () => ({ Authorization: `Bearer ${await tusToken()}`, apikey: window.SUPABASE_CONFIG.anonKey, 'Tus-Resumable': '1.0.0' });

  // 1) find (or create) the upload
  let uploadUrl = null;
  try { uploadUrl = localStorage.getItem(keyName); } catch (e) { /* storage unavailable */ }
  let offset = 0;
  if (uploadUrl) {
    try {
      const h = await tusRequest('HEAD', uploadUrl, await baseHeaders());
      if (h.status === 200 && Number(h.getHeader('Upload-Offset')) >= 0) offset = Number(h.getHeader('Upload-Offset'));
      else uploadUrl = null;
    } catch (e) { uploadUrl = null; }
  }
  if (!uploadUrl) {
    const meta = [
      'bucketName ' + tusB64(bucket || 'inspection-media'),
      'objectName ' + tusB64(path),
      'contentType ' + tusB64(String(blob.type || 'application/octet-stream').split(';')[0]),
      'cacheControl ' + tusB64('3600'),
    ].join(',');
    const c = await tusRequest('POST', endpoint, Object.assign(await baseHeaders(), {
      'Upload-Length': String(total), 'Upload-Metadata': meta, 'x-upsert': bucket ? 'false' : 'true',
    }));
    if (c.status !== 201 || !c.getHeader('Location')) throw new Error(`resumable-start-failed (${c.status}) ${String(c.text || '').slice(0, 160)}`);
    uploadUrl = new URL(c.getHeader('Location'), endpoint).toString();
    try { localStorage.setItem(keyName, uploadUrl); } catch (e) { /* storage unavailable */ }
    offset = 0;
  }
  if (onProgress) onProgress(offset);

  // 2) send the pieces, retrying a piece if the connection hiccups
  let failures = 0;
  while (offset < total) {
    const end = Math.min(offset + TUS_CHUNK, total);
    try {
      const r = await tusRequest('PATCH', uploadUrl, Object.assign(await baseHeaders(), {
        'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream',
      }), blob.slice(offset, end), (loaded) => { if (onProgress) onProgress(offset + loaded); });
      if (r.status === 204 || r.status === 200) {
        const next = Number(r.getHeader('Upload-Offset'));
        offset = Number.isFinite(next) && next > 0 ? next : end;
        failures = 0;
        if (onProgress) onProgress(offset);
        continue;
      }
      if (r.status === 409 || r.status === 460) { // out of sync: ask the server where we are
        const h = await tusRequest('HEAD', uploadUrl, await baseHeaders());
        offset = Number(h.getHeader('Upload-Offset')) || 0;
        continue;
      }
      if (r.status === 401 || r.status === 403) throw new Error(`Upload not allowed (${r.status}): ${String(r.text || '').slice(0, 160)}`);
      throw new Error('network');
    } catch (e) {
      if (e && e.message && e.message !== 'network') throw e;
      failures += 1;
      if (failures > 12) throw new Error('The connection kept dropping — your recording is saved on this phone, try again with better signal.');
      await tusSleep(Math.min(15000, 800 * failures * failures));
      try { // where did the server get to?
        const h = await tusRequest('HEAD', uploadUrl, await baseHeaders());
        if (h.status === 200) offset = Number(h.getHeader('Upload-Offset')) || offset;
      } catch (e2) { /* still offline: loop and retry */ }
    }
  }
  try { localStorage.removeItem(keyName); } catch (e) { /* ignore */ }
  if (onProgress) onProgress(total);
  return path;
}

// Resumable first; if that route is not available at all, use the old single-request upload.
async function sbUploadFast(path, blob, onProgress, resumeId, bucket) {
  try {
    return await sbUploadResumable(path, blob, onProgress, resumeId, bucket);
  } catch (err) {
    if (err && /resumable-start-failed/.test(err.message || '')) {
      console.warn('Resumable upload not available, using plain upload:', err.message);
      return sbUploadBlobWithProgress(path, blob, onProgress, bucket);
    }
    throw err;
  }
}

async function sbUploadDataUrl(path, dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return sbUploadBlob(path, blob);
}

async function sbSignedUrl(path, expiresSec = 3600, bucket) {
  if (!path) return null;
  const { data, error } = await requireSb().storage.from(bucket || 'inspection-media').createSignedUrl(path, expiresSec);
  if (error) {
    console.warn('Signed URL failed for', path, error);
    return null;
  }
  return data.signedUrl;
}


/* ---------------- assigned truck videos (type 'BASELINE' inspections; permanent) ---------------- */

// All of the fleet's assigned truck videos, newest first (paged).
async function sbGetAssignedVideos(fleetCode) {
  return sbGetInspections(fleetCode, { type: 'BASELINE' });
}

// The one permanent video for a unit, or null.
async function sbFindAssignedVideo(fleetCode, unit) {
  const { data, error } = await requireSb().from('inspections').select('*')
    .eq('fleet_code', fleetCode).eq('type', 'BASELINE').ilike('unit', String(unit).replace(/[%_]/g, (m) => '\\' + m)).limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

// Inspections done per driver, by kind: { [driverId]: { PTI, DROP, HOOK, total } }
async function sbGetDriverCounts(fleetCode) {
  const out = {};
  const add = (id, type, n) => {
    const c = out[id] || (out[id] = { PTI: 0, DROP: 0, HOOK: 0, total: 0 });
    if (type in c) c[type] += n;
    c.total += n;
  };
  const r = await requireSb().rpc('fleet_driver_counts');
  if (!r.error) { (r.data || []).forEach((x) => add(x.driver_id, x.type, Number(x.n))); return out; }
  if (!/fleet_driver_counts|schema cache|does not exist/i.test(r.error.message || '')) throw r.error;
  // database update not installed yet: count by reading the (small) columns
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await requireSb().from('inspections').select('driver_id,type').eq('fleet_code', fleetCode)
      .neq('type', 'BASELINE').range(from, from + 999);
    if (error) throw error;
    (data || []).forEach((x) => add(x.driver_id, x.type, 1));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/* ---------------- manager password ---------------- */

// Confirms the current password, then sets the new one. The manager stays signed in.
async function sbChangeOwnPassword(email, currentPassword, newPassword) {
  const sb = requireSb();
  const check = await sb.auth.signInWithPassword({ email, password: currentPassword });
  if (check.error) return { error: { message: 'Your current password is not right.' } };
  const r = await sb.auth.updateUser({ password: newPassword });
  return r;
}
