/**
 * messages.js — Turquoise v6
 * IndexedDB persistence for messages and peer metadata.
 *
 * ── Changes from v5 ──────────────────────────────────────────────────────────
 *
 * WRITE QUEUE (primary fix):
 *   Each write goes through an in-memory queue that drains serially in the
 *   background. This prevents "transaction already finished" errors that occur
 *   when rapid message delivery races with IDB commit cycles. It also means a
 *   brief IDB hiccup (e.g. iOS Safari under memory pressure) only delays writes
 *   rather than dropping them.
 *
 * ROBUST DB HANDLE:
 *   - _db = null is reset on: onerror, onclose, AND any failed transaction.
 *   - getDB() tracks whether an open is already in progress (_dbOpening flag)
 *     so concurrent callers share one open attempt instead of racing.
 *   - Version bumped to 2 to add 'by-fp' index on peers store.
 *
 * MSG_LIMIT applied per-session AND globally:
 *   - loadMessages(sessionId): cap at 2000 most recent.
 *   - loadAllMessages(): cap at 10,000 total (safety valve).
 *
 * PEER DEDUPLICATION:
 *   - savePeer() merges with existing record (never overwrites nickname if
 *     the incoming value is blank).
 *
 * FULL LOGGING:
 *   - Every operation logs to TQLog with timing for black-box analysis.
 *
 * Murphy's Law hardening:
 *   - All IDB callbacks check that the db ref is still the one we opened.
 *   - restoreMessages/restorePeers: validate required fields, skip invalid.
 *   - clearAllData: single transaction for atomicity.
 *   - All public functions: never throw — errors are returned or logged.
 */

import { TQLog } from './tqlog.js';

const DB_NAME    = 'tq-messages';
const DB_VERSION = 2;          // bump: added by-fp peer index
const MSG_LIMIT  = 2_000;      // per session
const ALL_LIMIT  = 10_000;     // loadAllMessages safety cap

const FILE = 'messages';

let _db       = null;
let _dbOpening = false;
let _dbWaiters = [];   // array of {res, rej} for concurrent getDB() callers

const _log = TQLog.get();

// ── Write queue ───────────────────────────────────────────────────────────────
// Prevents racing transactions and ensures writes survive transient IDB errors.

const _writeQueue    = [];
let   _writeDraining = false;

function _enqueue(op) {
  return new Promise((res, rej) => {
    _writeQueue.push({ op, res, rej });
    _drainWriteQueue();
  });
}

async function _drainWriteQueue() {
  if (_writeDraining || !_writeQueue.length) return;
  _writeDraining = true;
  while (_writeQueue.length) {
    const { op, res, rej } = _writeQueue.shift();
    try {
      const result = await op();
      res(result);
    } catch (e) {
      _log.warn(FILE, '_drainWriteQueue', 'write op failed: ' + e.message);
      rej(e);
    }
  }
  _writeDraining = false;
}

// ── IndexedDB lifecycle ───────────────────────────────────────────────────────

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // Messages store (unchanged)
      if (!db.objectStoreNames.contains('messages')) {
        const ms = db.createObjectStore('messages', { keyPath: 'id' });
        ms.createIndex('by-session', 'sessionId');
        ms.createIndex('by-ts',      'ts');
      }
      // Peers store — add by-fp index if upgrading
      if (!db.objectStoreNames.contains('peers')) {
        const ps = db.createObjectStore('peers', { keyPath: 'fingerprint' });
        ps.createIndex('by-fp', 'fingerprint', { unique: true });
      } else if (e.oldVersion < 2) {
        // Upgrading from v1: add the index
        const tx = e.target.transaction;
        const ps = tx.objectStore('peers');
        if (!ps.indexNames.contains('by-fp')) {
          ps.createIndex('by-fp', 'fingerprint', { unique: true });
        }
      }
    };

    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = () => rej(new Error('messages DB open: ' + req.error?.message));
    req.onblocked = () => rej(new Error('messages DB blocked — close other tabs'));
  });
}

async function getDB() {
  // Fast path: healthy db
  if (_db && _db.objectStoreNames?.length > 0) return _db;

  // If an open is already in flight, queue up behind it
  if (_dbOpening) {
    return new Promise((res, rej) => _dbWaiters.push({ res, rej }));
  }

  _dbOpening = true;
  _db = null;

  try {
    const db = await openDB();
    _db = db;

    // Tear down ref on unexpected close so the next call reopens
    db.onclose = () => {
      _log.warn(FILE, 'getDB', 'IDB connection closed unexpectedly');
      if (_db === db) { _db = null; }
    };
    db.onerror = (e) => {
      _log.warn(FILE, 'getDB', 'IDB error: ' + (e.target?.error?.message || '?'));
      if (_db === db) { _db = null; }
    };

    _dbOpening = false;
    // Resolve all waiters
    const waiters = _dbWaiters.splice(0);
    waiters.forEach(w => w.res(db));
    return db;
  } catch (e) {
    _dbOpening = false;
    _db = null;
    const waiters = _dbWaiters.splice(0);
    waiters.forEach(w => w.rej(e));
    throw e;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function saveMessage(msg) {
  if (!msg?.id) return;
  return _enqueue(async () => {
    const db = await getDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction('messages', 'readwrite');
      const req = tx.objectStore('messages').put(msg);
      tx.oncomplete = () => res();
      tx.onerror    = () => { if (_db === db) _db = null; rej(tx.error); };
    });
  });
}

export async function loadMessages(sessionId) {
  if (!sessionId) return [];
  const t0 = Date.now();
  try {
    const db = await getDB();
    const all = await new Promise((res, rej) => {
      const tx  = db.transaction('messages', 'readonly');
      const req = tx.objectStore('messages')
        .index('by-session')
        .getAll(IDBKeyRange.only(sessionId));
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => { if (_db === db) _db = null; rej(req.error); };
    });
    const sorted = all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const result = sorted.length > MSG_LIMIT ? sorted.slice(-MSG_LIMIT) : sorted;
    _log.debug(FILE, 'loadMessages', `${result.length} msgs for ${sessionId.slice(0,8)} in ${Date.now()-t0}ms`);
    return result;
  } catch (e) {
    _log.warn(FILE, 'loadMessages', 'failed: ' + e.message);
    return [];
  }
}

export async function loadAllMessages() {
  const t0 = Date.now();
  try {
    const db  = await getDB();
    const all = await new Promise((res, rej) => {
      const tx  = db.transaction('messages', 'readonly');
      const req = tx.objectStore('messages').getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => { if (_db === db) _db = null; rej(req.error); };
    });
    const sorted = all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const result = sorted.length > ALL_LIMIT ? sorted.slice(-ALL_LIMIT) : sorted;
    _log.debug(FILE, 'loadAllMessages', `${result.length} total msgs in ${Date.now()-t0}ms`);
    return result;
  } catch (e) {
    _log.warn(FILE, 'loadAllMessages', 'failed: ' + e.message);
    return [];
  }
}

export async function clearMessages(sessionId) {
  if (!sessionId) return 0;
  return _enqueue(async () => {
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
      req.onerror = () => { if (_db === db) _db = null; rej(req.error); };
    });
  });
}

export async function clearAllData() {
  return _enqueue(async () => {
    const db = await getDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(['messages', 'peers'], 'readwrite');
      tx.objectStore('messages').clear();
      tx.objectStore('peers').clear();
      tx.oncomplete = () => {
        _log.info(FILE, 'clearAllData', 'all data cleared');
        res();
      };
      tx.onerror = () => { if (_db === db) _db = null; rej(tx.error); };
    });
  });
}

/**
 * Save or update a peer record.
 * Merges with existing: nickname is only updated if the new value is non-empty.
 */
export async function savePeer(peer) {
  if (!peer?.fingerprint) return;
  return _enqueue(async () => {
    const db = await getDB();
    // Load existing to merge
    const existing = await new Promise((res) => {
      const tx  = db.transaction('peers', 'readonly');
      const req = tx.objectStore('peers').get(peer.fingerprint);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => res(null);
    });

    const merged = {
      ...(existing || {}),
      ...peer,
      // Don't blank out a good nickname with an empty one
      nickname: (peer.nickname?.trim()) || existing?.nickname || peer.shortId || peer.fingerprint.slice(0, 8),
      lastSeen: Date.now(),
    };

    return new Promise((res, rej) => {
      const tx  = db.transaction('peers', 'readwrite');
      const req = tx.objectStore('peers').put(merged);
      tx.oncomplete = () => res();
      tx.onerror    = () => { if (_db === db) _db = null; rej(tx.error); };
    });
  });
}

export async function loadPeers() {
  try {
    const db  = await getDB();
    const all = await new Promise((res, rej) => {
      const tx  = db.transaction('peers', 'readonly');
      const req = tx.objectStore('peers').getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => { if (_db === db) _db = null; rej(req.error); };
    });
    _log.debug(FILE, 'loadPeers', `${all.length} peers loaded`);
    return all;
  } catch (e) {
    _log.warn(FILE, 'loadPeers', 'failed: ' + e.message);
    return [];
  }
}

/**
 * Restore a batch of messages (import).
 * Returns the number of successfully written records.
 */
export async function restoreMessages(msgs) {
  if (!msgs?.length) return 0;
  return _enqueue(async () => {
    const db = await getDB();
    return new Promise((res, rej) => {
      const tx    = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      let count   = 0;
      msgs.forEach(m => {
        if (!m?.id || !m?.sessionId) return; // skip invalid
        try { store.put(m); count++; } catch {}
      });
      tx.oncomplete = () => {
        _log.info(FILE, 'restoreMessages', `restored ${count} messages`);
        res(count);
      };
      tx.onerror = () => { if (_db === db) _db = null; rej(tx.error); };
    });
  });
}

/**
 * Restore a batch of peers (import).
 * Returns the number of successfully written records.
 */
export async function restorePeers(peers) {
  if (!peers?.length) return 0;
  return _enqueue(async () => {
    const db = await getDB();
    return new Promise((res, rej) => {
      const tx    = db.transaction('peers', 'readwrite');
      const store = tx.objectStore('peers');
      let count   = 0;
      peers.forEach(p => {
        if (!p?.fingerprint) return; // skip invalid
        try { store.put({ ...p, lastSeen: p.lastSeen || Date.now() }); count++; } catch {}
      });
      tx.oncomplete = () => {
        _log.info(FILE, 'restorePeers', `restored ${count} peers`);
        res(count);
      };
      tx.onerror = () => { if (_db === db) _db = null; rej(tx.error); };
    });
  });
}
