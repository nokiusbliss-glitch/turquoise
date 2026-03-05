/**
 * messages.js — Turquoise
 * IndexedDB persistence for messages and peer metadata.
 */

const DB_NAME    = 'tq-messages';
const DB_VERSION = 1;
let   _db        = null;

function getDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('messages')) {
        const ms = db.createObjectStore('messages', { keyPath: 'id' });
        ms.createIndex('by-session', 'sessionId');
        ms.createIndex('by-ts', 'ts');
      }
      if (!db.objectStoreNames.contains('peers')) {
        db.createObjectStore('peers', { keyPath: 'fingerprint' });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; res(_db); };
    req.onerror   = () => rej(new Error('messages DB: ' + req.error?.message));
    req.onblocked = () => rej(new Error('messages DB blocked'));
  });
}

export async function saveMessage(msg) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('messages', 'readwrite');
    const req = tx.objectStore('messages').put(msg);
    req.onsuccess = () => res(); req.onerror = () => rej(req.error);
  });
}

export async function loadMessages(sessionId) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('messages', 'readonly');
    const req = tx.objectStore('messages').index('by-session').getAll(IDBKeyRange.only(sessionId));
    req.onsuccess = () => res((req.result || []).sort((a, b) => a.ts - b.ts));
    req.onerror   = () => rej(req.error);
  });
}

// Load ALL messages for state export
export async function loadAllMessages() {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('messages', 'readonly');
    const req = tx.objectStore('messages').getAll();
    req.onsuccess = () => res((req.result || []).sort((a, b) => a.ts - b.ts));
    req.onerror   = () => rej(req.error);
  });
}

export async function clearMessages(sessionId) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('messages', 'readwrite');
    const req = tx.objectStore('messages').index('by-session').openCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = (e) => { const c=e.target.result; if(c){c.delete();c.continue();}else res(); };
    req.onerror   = () => rej(req.error);
  });
}

export async function clearAllData() {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(['messages','peers'], 'readwrite');
    tx.objectStore('messages').clear();
    tx.objectStore('peers').clear();
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

export async function savePeer(peer) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('peers', 'readwrite');
    const req = tx.objectStore('peers').put({ ...peer, lastSeen: Date.now() });
    req.onsuccess = () => res(); req.onerror = () => rej(req.error);
  });
}

export async function loadPeers() {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('peers', 'readonly');
    const req = tx.objectStore('peers').getAll();
    req.onsuccess = () => res(req.result || []); req.onerror = () => rej(req.error);
  });
}

// Restore all messages from export bundle
export async function restoreMessages(msgs) {
  if (!msgs?.length) return;
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('messages', 'readwrite');
    const store = tx.objectStore('messages');
    msgs.forEach(m => { try { store.put(m); } catch {} });
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

export async function restorePeers(peers) {
  if (!peers?.length) return;
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx    = db.transaction('peers', 'readwrite');
    const store = tx.objectStore('peers');
    peers.forEach(p => { try { store.put(p); } catch {} });
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
