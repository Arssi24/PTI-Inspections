/* Thin wrapper around the Supabase JS client. Real backend: Postgres (accounts, fleets,
   units, inspections) + Storage (video/photos), replacing the old IndexedDB/localStorage demo. */

const SUPABASE_READY = Boolean(
  window.SUPABASE_CONFIG &&
  /^https?:\/\//.test(window.SUPABASE_CONFIG.url) &&
  window.SUPABASE_CONFIG.anonKey &&
  window.SUPABASE_CONFIG.anonKey !== 'YOUR_SUPABASE_ANON_KEY'
);

const sb = SUPABASE_READY
  ? window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey)
  : null;

function requireSb() {
  if (!sb) throw new Error('Supabase is not configured yet — fill in js/supabase-config.js with your project URL and anon key.');
  return sb;
}

/* ---------------- auth ---------------- */

async function sbSignUp(email, password, metadata) {
  // metadata (name/phone/role/fleet_code) lands in auth.users.raw_user_meta_data, which
  // the handle_new_user() DB trigger reads to create the profile (and fleet, if manager)
  // server-side — see supabase/schema.sql. The client never inserts these rows directly.
  return requireSb().auth.signUp({ email, password, options: { data: metadata } });
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
