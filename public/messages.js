/**
 * messages.js — Turquoise v7
 * Persistent storage for chat messages and known peers.
 * sessionId = peer fingerprint for 1:1, 'group' for broadcast.
 */

const DB_NAME = 'tq_messages_v3';

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = ev => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains('messages')) {
        const ms = db.createObjectStore('messages', { keyPath: 'id' });
        ms.createIndex('bySess', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('peers')) {
        db.createObjectStore('peers', { keyPath: 'fingerprint' });
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(new Error('Messages DB: ' + r.error?.message));
    r.onblocked = () => rej(new Error('Messages DB blocked.'));
  });
}

export async function saveMessage(msg) {
  if (!msg?.id || !msg?.sessionId) throw new Error('saveMessage: id and sessionId required.');
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').put(msg);
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(new Error('saveMessage: ' + tx.error?.message));
  });
}

export async function loadMessages(sessionId) {
  if (!sessionId) throw new Error('loadMessages: sessionId required.');
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction('messages', 'readonly')
                .objectStore('messages')
                .index('bySess')
                .getAll(IDBKeyRange.only(sessionId));
    r.onsuccess = () => res((r.result || []).sort((a, b) => a.ts - b.ts));
    r.onerror   = () => rej(new Error('loadMessages: ' + r.error?.message));
  });
}

export async function savePeer(peer) {
  if (!peer?.fingerprint) throw new Error('savePeer: fingerprint required.');
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('peers', 'readwrite');
    tx.objectStore('peers').put({
      fingerprint: peer.fingerprint,
      shortId:     peer.shortId || peer.fingerprint.slice(0, 8),
      nickname:    peer.nickname || null,
      lastSeen:    Date.now(),
    });
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(new Error('savePeer: ' + tx.error?.message));
  });
}

export async function loadPeers() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction('peers', 'readonly').objectStore('peers').getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror   = () => rej(new Error('loadPeers: ' + r.error?.message));
  });
}

export async function updatePeerNickname(fp, nick) {
  if (!fp) return;
  const db = await openDB();
  return new Promise(res => {
    const st = db.transaction('peers', 'readwrite').objectStore('peers');
    const r  = st.get(fp);
    r.onsuccess = () => {
      if (!r.result) { res(); return; }
      r.result.nickname = nick;
      st.put(r.result);
      res();
    };
    r.onerror = () => res();
  });
}
