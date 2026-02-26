/**
 * messages.js — Turquoise
 * Persistent chat history and peer registry in IndexedDB.
 */

const DB_NAME    = 'turquoise_messages';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB not supported.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains('messages')) {
        const ms = db.createObjectStore('messages', { keyPath: 'id' });
        ms.createIndex('bySession', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('peers')) {
        db.createObjectStore('peers', { keyPath: 'fingerprint' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(new Error('Messages DB: ' + req.error?.message));
  });
}

export async function saveMessage(msg) {
  if (!msg?.id || !msg?.sessionId) throw new Error('saveMessage: id + sessionId required.');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').put(msg);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(new Error('saveMessage: ' + tx.error?.message));
  });
}

export async function loadMessages(sessionId) {
  if (!sessionId) throw new Error('loadMessages: sessionId required.');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const idx = db.transaction('messages', 'readonly')
                  .objectStore('messages').index('bySession');
    const req = idx.getAll(IDBKeyRange.only(sessionId));
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.ts - b.ts));
    req.onerror   = () => reject(new Error('loadMessages: ' + req.error?.message));
  });
}

export async function savePeer(peer) {
  if (!peer?.fingerprint) throw new Error('savePeer: fingerprint required.');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('peers', 'readwrite');
    tx.objectStore('peers').put({
      fingerprint: peer.fingerprint,
      shortId:     peer.shortId || peer.fingerprint.slice(0, 8),
      nickname:    peer.nickname || null,
      lastSeen:    Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(new Error('savePeer: ' + tx.error?.message));
  });
}

export async function loadPeers() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('peers', 'readonly').objectStore('peers').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(new Error('loadPeers: ' + req.error?.message));
  });
}

export async function updatePeerNickname(fingerprint, nickname) {
  if (!fingerprint) return;
  const db    = await openDB();
  const store = db.transaction('peers', 'readwrite').objectStore('peers');
  return new Promise((resolve) => {
    const req = store.get(fingerprint);
    req.onsuccess = () => {
      const r = req.result;
      if (!r) { resolve(); return; }
      r.nickname = nickname;
      store.put(r);
      resolve();
    };
    req.onerror = () => resolve();
  });
}
