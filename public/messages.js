/**
 * messages.js — Turquoise
 *
 * Persistent storage for chat messages and known peers.
 * Append-only message log. Peer registry updated on connect.
 *
 * Murphy's Law: every operation has explicit error paths.
 *               Empty results return [] — never throw for missing data.
 */

const DB_NAME    = 'turquoise_messages';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB not supported.')); return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains('messages')) {
        const ms = db.createObjectStore('messages', { keyPath: 'id' });
        ms.createIndex('bySession', 'sessionId', { unique: false });
        ms.createIndex('byTs',      'ts',        { unique: false });
      }
      if (!db.objectStoreNames.contains('peers')) {
        db.createObjectStore('peers', { keyPath: 'fingerprint' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(new Error('Messages DB failed: ' + req.error?.message));
    req.onblocked = () => reject(new Error('Messages DB blocked.'));
  });
}

// ── Messages ──────────────────────────────────────────────────────────────────

export async function saveMessage(msg) {
  if (!msg?.id)        throw new Error('saveMessage: msg.id required.');
  if (!msg?.sessionId) throw new Error('saveMessage: msg.sessionId required.');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').put(msg);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(new Error('saveMessage failed: ' + tx.error?.message));
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
    req.onerror   = () => reject(new Error('loadMessages failed: ' + req.error?.message));
  });
}

// ── Peers ─────────────────────────────────────────────────────────────────────

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
    tx.onerror    = () => reject(new Error('savePeer failed: ' + tx.error?.message));
  });
}

export async function loadPeers() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('peers', 'readonly').objectStore('peers').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(new Error('loadPeers failed: ' + req.error?.message));
  });
}

export async function updatePeerNickname(fingerprint, nickname) {
  if (!fingerprint) return;
  const db    = await openDB();
  const store = db.transaction('peers', 'readwrite').objectStore('peers');
  return new Promise((resolve) => {
    const req = store.get(fingerprint);
    req.onsuccess = () => {
      const record = req.result;
      if (!record) { resolve(); return; }
      record.nickname = nickname;
      store.put(record);
      resolve();
    };
    req.onerror = () => resolve(); // non-fatal
  });
}
