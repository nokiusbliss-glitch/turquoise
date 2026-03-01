/**
 * messages.js — Turquoise
 * IndexedDB persistence for messages and peer metadata
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
    req.onerror   = () => rej(new Error('messages DB failed: ' + req.error?.message));
    req.onblocked = () => rej(new Error('messages DB blocked'));
  });
}

export async function saveMessage(msg) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('messages', 'readwrite');
    const req = tx.objectStore('messages').put(msg);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

export async function loadMessages(sessionId) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx   = db.transaction('messages', 'readonly');
    const idx  = tx.objectStore('messages').index('by-session');
    const req  = idx.getAll(IDBKeyRange.only(sessionId));
    req.onsuccess = () => {
      const msgs = (req.result || []).sort((a, b) => a.ts - b.ts);
      res(msgs);
    };
    req.onerror = () => rej(req.error);
  });
}

export async function savePeer(peer) {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('peers', 'readwrite');
    const req = tx.objectStore('peers').put({ ...peer, lastSeen: Date.now() });
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

export async function loadPeers() {
  const db = await getDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('peers', 'readonly');
    const req = tx.objectStore('peers').getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => rej(req.error);
  });
}
