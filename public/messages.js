/**
 * messages.js — Turquoise
 * IndexedDB persistence for messages and peer metadata.
 *
 * Fixes:
 *   - _db was a module-level singleton that was never cleared on error.
 *     If the IDB connection was lost after initial open, all subsequent
 *     calls would use a closed/stale DB and throw cryptic errors.
 *     Fix: reset _db = null in getDB() error path so the next call retries.
 *   - Added MSG_LIMIT to cap per-session queries and prevent huge memory usage
 *     in long-running sessions.
 *   - restoreMessages/restorePeers now return counts for feedback.
 */

const DB_NAME    = 'tq-messages';
const DB_VERSION = 1;
const MSG_LIMIT  = 2000;   // max messages returned per session query

let _db = null;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('messages')) {
        const ms = db.createObjectStore('messages', { keyPath: 'id' });
        ms.createIndex('by-session', 'sessionId');
        ms.createIndex('by-ts',      'ts');
      }
      if (!db.objectStoreNames.contains('peers')) {
        db.createObjectStore('peers', { keyPath: 'fingerprint' });
      }
    };
    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = () => rej(new Error('messages DB open: ' + req.error?.message));
    req.onblocked = () => rej(new Error('messages DB blocked — close other tabs'));
  });
}

async function getDB() {
  if (_db) {
    // Sanity-check the connection is still alive
    if (_db.objectStoreNames.length > 0) return _db;
    _db = null; // stale reference — fall through to reopen
  }
  try {
    _db = await openDB();
    // Clear reference on unexpected close so the next call reopens
    _db.onclose = () => { _db = null; };
    _db.onerror = () => { _db = null; };
    return _db;
  } catch (e) {
    _db = null;
    throw e;
  }
}

export async function saveMessage(msg) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('messages', 'readwrite');
    const req = tx.objectStore('messages').put(msg);
    req.onsuccess = () => res();
    req.onerror   = () => { _db = null; rej(req.error); };
  });
}

export async function loadMessages(sessionId) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('messages', 'readonly');
    // Get all for session then sort; IDBKeyRange returns in insertion order
    const req = tx.objectStore('messages')
      .index('by-session')
      .getAll(IDBKeyRange.only(sessionId));
    req.onsuccess = () => {
      const all = (req.result || []).sort((a, b) => a.ts - b.ts);
      // Return only the most recent MSG_LIMIT messages
      res(all.length > MSG_LIMIT ? all.slice(-MSG_LIMIT) : all);
    };
    req.onerror = () => { _db = null; rej(req.error); };
  });
}

export async function loadAllMessages() {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('messages', 'readonly');
    const req = tx.objectStore('messages').getAll();
    req.onsuccess = () => res((req.result || []).sort((a, b) => a.ts - b.ts));
    req.onerror   = () => { _db = null; rej(req.error); };
  });
}

export async function clearMessages(sessionId) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('messages', 'readwrite');
    let count = 0;
    const req = tx.objectStore('messages')
      .index('by-session')
      .openCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); count++; cursor.continue(); }
      else res(count);
    };
    req.onerror = () => { _db = null; rej(req.error); };
  });
}

export async function clearAllData() {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(['messages', 'peers'], 'readwrite');
    tx.objectStore('messages').clear();
    tx.objectStore('peers').clear();
    tx.oncomplete = () => res();
    tx.onerror    = () => { _db = null; rej(tx.error); };
  });
}

export async function savePeer(peer) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('peers', 'readwrite');
    const req = tx.objectStore('peers').put({ ...peer, lastSeen: Date.now() });
    req.onsuccess = () => res();
    req.onerror   = () => { _db = null; rej(req.error); };
  });
}

export async function loadPeers() {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('peers', 'readonly');
    const req = tx.objectStore('peers').getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => { _db = null; rej(req.error); };
  });
}

export async function restoreMessages(msgs) {
  if (!msgs?.length) return 0;
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx    = db.transaction('messages', 'readwrite');
    const store = tx.objectStore('messages');
    let count   = 0;
    msgs.forEach(m => {
      if (!m?.id) return;
      try { store.put(m); count++; } catch {}
    });
    tx.oncomplete = () => res(count);
    tx.onerror    = () => { _db = null; rej(tx.error); };
  });
}

export async function restorePeers(peers) {
  if (!peers?.length) return 0;
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx    = db.transaction('peers', 'readwrite');
    const store = tx.objectStore('peers');
    let count   = 0;
    peers.forEach(p => {
      if (!p?.fingerprint) return;
      try { store.put(p); count++; } catch {}
    });
    tx.oncomplete = () => res(count);
    tx.onerror    = () => { _db = null; rej(tx.error); };
  });
}
