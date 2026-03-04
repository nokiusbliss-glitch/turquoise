/**
 * messages.js — Turquoise
 * IndexedDB persistence for messages and peer metadata.
 */

const DB_NAME = 'tq-messages';
const DB_VERSION = 2;
let _db = null;

function getDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('messages')) {
        const ms = db.createObjectStore('messages', { keyPath: 'id' });
        ms.createIndex('by-session', 'sessionId');
        ms.createIndex('by-session-ts', ['sessionId', 'ts']);
      } else {
        const ms = req.transaction.objectStore('messages');
        if (!ms.indexNames.contains('by-session')) ms.createIndex('by-session', 'sessionId');
        if (!ms.indexNames.contains('by-session-ts')) ms.createIndex('by-session-ts', ['sessionId', 'ts']);
      }

      if (!db.objectStoreNames.contains('peers')) {
        const ps = db.createObjectStore('peers', { keyPath: 'fingerprint' });
        ps.createIndex('by-lastSeen', 'lastSeen');
      } else {
        const ps = req.transaction.objectStore('peers');
        if (!ps.indexNames.contains('by-lastSeen')) ps.createIndex('by-lastSeen', 'lastSeen');
      }
    };

    req.onsuccess = () => {
      _db = req.result;
      _db.onversionchange = () => {
        _db.close();
        _db = null;
      };
      resolve(_db);
    };

    req.onerror = () => reject(new Error(`messages DB failed: ${req.error?.message || 'unknown'}`));
    req.onblocked = () => reject(new Error('messages DB blocked by another tab'));
  });
}

function validMessage(msg) {
  return (
    msg &&
    typeof msg === 'object' &&
    typeof msg.id === 'string' &&
    msg.id.length > 0 &&
    typeof msg.sessionId === 'string' &&
    msg.sessionId.length > 0
  );
}

export async function saveMessage(msg) {
  if (!validMessage(msg)) throw new Error('Invalid message payload');
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    const req = tx.objectStore('messages').put(msg);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function loadMessages(sessionId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readonly');
    const store = tx.objectStore('messages');

    let req;
    if (store.indexNames.contains('by-session-ts')) {
      const idx = store.index('by-session-ts');
      req = idx.getAll(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]));
    } else {
      const idx = store.index('by-session');
      req = idx.getAll(IDBKeyRange.only(sessionId));
    }

    req.onsuccess = () => {
      const msgs = (req.result || []).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      resolve(msgs);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearMessages(sessionId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    const idx = tx.objectStore('messages').index('by-session');
    const req = idx.openCursor(IDBKeyRange.only(sessionId));

    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };

    req.onerror = () => reject(req.error);
  });
}

export async function clearAllData() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['messages', 'peers'], 'readwrite');
    tx.objectStore('messages').clear();
    tx.objectStore('peers').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function savePeer(peer) {
  if (!peer || typeof peer.fingerprint !== 'string') throw new Error('Invalid peer payload');
  const db = await getDB();

  const payload = {
    fingerprint: peer.fingerprint,
    shortId: peer.shortId || peer.fingerprint.slice(0, 8),
    nickname: peer.nickname || peer.shortId || peer.fingerprint.slice(0, 8),
    lastSeen: Date.now(),
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction('peers', 'readwrite');
    const req = tx.objectStore('peers').put(payload);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function loadPeers() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('peers', 'readonly');
    const req = tx.objectStore('peers').getAll();
    req.onsuccess = () => {
      const peers = (req.result || []).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      resolve(peers);
    };
    req.onerror = () => reject(req.error);
  });
}
