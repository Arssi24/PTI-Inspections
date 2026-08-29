/* Offline upload queue — lets a driver record a PTI/HOOK/DROP with zero signal (e.g. way
   out on a route), and not lose it. The video/photos/metadata get written to IndexedDB the
   moment "Save & Upload" is tapped, BEFORE the network attempt — so even if the app is fully
   closed while offline, the recording survives and retries next time the app opens with a
   connection. Nothing here talks to Supabase directly; app.js still owns the actual upload,
   this file only persists/retrieves the payload around that attempt. */

const OFFLINE_DB_NAME = 'pti-offline-queue';
const OFFLINE_DB_VERSION = 1;
const OFFLINE_STORE = 'pending_uploads';

function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
        db.createObjectStore(OFFLINE_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueSavePendingUpload(record) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, 'readwrite');
    tx.objectStore(OFFLINE_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function queueRemovePendingUpload(id) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, 'readwrite');
    tx.objectStore(OFFLINE_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function queueGetAllPendingUploads() {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, 'readonly');
    const req = tx.objectStore(OFFLINE_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
