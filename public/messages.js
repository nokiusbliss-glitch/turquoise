/**
 * messages.js — Turquoise Phase 3
 *
 * Persistent storage for:
 *   - Chat messages (indexed by session/peer fingerprint)
 *   - Known peers (fingerprint → shortId, last seen)
 *
 * Append-only for messages — nothing is ever deleted unless the user clears.
 * Murphy's Law: every DB operation has explicit error handling.
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
      try {
        // messages store: indexed by sessionId for fast session loading
        if (!db.objectStoreNames.contains('messages')) {
          const ms = db.createObjectStore('messages', { keyPath: 'id' });
          ms.createIndex('bySession', 'sessionId', { unique: false });
          ms.createIndex('byTs',      'ts',        { unique: false });
        }
        // peers store: keyed by fingerprint
        if (!db.objectStoreNames.contains('peers')) {
          db.createObjectStore('peers', { keyPath: 'fingerprint' });
        }
      } catch (e) {
        reject(new Error('DB upgrade failed: ' + e.message));
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(new Error('Messages DB failed: ' + req.error?.message));
    req.onblocked = () => reject(new Error('Messages DB blocked — close other tabs.'));
  });
}

// ── Messages ──────────────────────────────────────────────────────────────────

/**
 * Save one message record.
 * @param {object} msg  Must have: id, sessionId, from, fromShort, text, ts, type, own
 */
export async function saveMessage(msg) {
  if (!msg?.id)        throw new Error('saveMessage: msg.id required.');
  if (!msg?.sessionId) throw new Error('saveMessage: msg.sessionId required.');
  if (!msg?.ts)        throw new Error('saveMessage: msg.ts required.');

  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').put(msg);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(new Error('saveMessage failed: ' + tx.error?.message));
    } catch (e) {
      reject(new Error('saveMessage tx error: ' + e.message));
    }
  });
}

/**
 * Load all messages for a session (peer fingerprint), sorted by timestamp.
 * Returns [] if none found — never throws for empty result.
 */
export async function loadMessages(sessionId) {
  if (!sessionId) throw new Error('loadMessages: sessionId required.');

  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx    = db.transaction('messages', 'readonly');
      const idx   = tx.objectStore('messages').index('bySession');
      const req   = idx.getAll(IDBKeyRange.only(sessionId));

      req.onsuccess = () => {
        const msgs = (req.result || []).sort((a, b) => a.ts - b.ts);
        resolve(msgs);
      };
      req.onerror = () => reject(new Error('loadMessages failed: ' + req.error?.message));
    } catch (e) {
      reject(new Error('loadMessages tx error: ' + e.message));
    }
  });
}

// ── Peers ─────────────────────────────────────────────────────────────────────

/**
 * Save or update a known peer.
 * @param {object} peer  Must have: fingerprint, shortId
 */
export async function savePeer(peer) {
  if (!peer?.fingerprint) throw new Error('savePeer: fingerprint required.');
  if (!peer?.shortId)     throw new Error('savePeer: shortId required.');

  const record = {
    fingerprint: peer.fingerprint,
    shortId:     peer.shortId,
    name:        peer.name || peer.shortId,
    lastSeen:    Date.now(),
  };

  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('peers', 'readwrite');
      tx.objectStore('peers').put(record);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(new Error('savePeer failed: ' + tx.error?.message));
    } catch (e) {
      reject(new Error('savePeer tx error: ' + e.message));
    }
  });
}

/**
 * Load all known peers.
 * Returns [] if none — never throws for empty result.
 */
export async function loadPeers() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const req = db.transaction('peers', 'readonly').objectStore('peers').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(new Error('loadPeers failed: ' + req.error?.message));
    } catch (e) {
      reject(new Error('loadPeers tx error: ' + e.message));
    }
  });
}
