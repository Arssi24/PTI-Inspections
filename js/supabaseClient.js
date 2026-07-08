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

async function sbRemoveDriver(userId) {
  return requireSb().from('profiles').delete().eq('id', userId);
}

async function sbUpdateDriver(userId, fields) {
  return requireSb().from('profiles').update(fields).eq('id', userId);
}

/* ---------------- fleets ---------------- */

async function sbFindFleetByCode(code) {
  const { data, error } = await requireSb().from('fleets').select('*').ilike('code', code).maybeSingle();
  if (error) throw error;
  return data;
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

async function sbGetInspections(fleetCode) {
  const { data, error } = await requireSb()
    .from('inspections')
    .select('*')
    .eq('fleet_code', fleetCode)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function sbInsertInspection(record) {
  return requireSb().from('inspections').insert(record);
}

/* ---------------- storage ---------------- */

async function sbUploadBlob(path, blob) {
  const { error } = await requireSb().storage.from('inspection-media').upload(path, blob, {
    contentType: blob.type,
    upsert: false,
  });
  if (error) throw error;
  return path;
}

// The vendored supabase-js storage client has no upload-progress callback, so real
// byte-level progress (for the uploading screen) needs a direct XHR call to the same
// REST endpoint the SDK uses under the hood.
async function sbUploadBlobWithProgress(path, blob, onProgress) {
  const { data: sessionData } = await requireSb().auth.getSession();
  const token = sessionData.session ? sessionData.session.access_token : null;
  if (!token) throw new Error('Your session expired — log back in and try again.');

  const url = `${window.SUPABASE_CONFIG.url}/storage/v1/object/inspection-media/${path}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', window.SUPABASE_CONFIG.anonKey);
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
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

async function sbUploadDataUrl(path, dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return sbUploadBlob(path, blob);
}

async function sbSignedUrl(path, expiresSec = 3600) {
  if (!path) return null;
  const { data, error } = await requireSb().storage.from('inspection-media').createSignedUrl(path, expiresSec);
  if (error) {
    console.warn('Signed URL failed for', path, error);
    return null;
  }
  return data.signedUrl;
}
