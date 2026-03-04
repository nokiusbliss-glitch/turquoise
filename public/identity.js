/**
 * identity.js — Turquoise
 * Cryptographic device identity + editable nickname
 * Persistent across sessions via IndexedDB
 */

const DB_NAME = 'tq-identity';
const DB_VERSION = 2;
const STORE_KEY = 'tq-keys';
const STORE_NICK = 'tq-prefs';

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_KEY)) db.createObjectStore(STORE_KEY);
      if (!db.objectStoreNames.contains(STORE_NICK)) db.createObjectStore(STORE_NICK);
    };

    req.onsuccess = (e) => {
      _db = e.target.result;
      _db.onversionchange = () => {
        try { _db.close(); } catch {}
        _db = null;
      };
      resolve(_db);
    };

    req.onerror = () => reject(new Error('IndexedDB open failed: ' + (req.error?.message || 'unknown')));
    req.onblocked = () => reject(new Error('IndexedDB blocked - close other tabs'));
  });
}

function dbGet(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(db, store, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify']
  );
}

async function fingerprintOf(publicKey) {
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;

  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function encodePayload(data) {
  const text = typeof data === 'string' ? data : stableStringify(data);
  return new TextEncoder().encode(text);
}

function normalizeNickname(raw, fallback) {
  const clean = String(raw || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 32);

  return clean || fallback;
}

export async function getIdentity() {
  if (!window.crypto?.subtle) throw new Error('crypto.subtle unavailable - requires HTTPS');
  if (!window.indexedDB) throw new Error('IndexedDB unavailable');

  const db = await openDB();

  let keys = await dbGet(db, STORE_KEY, 'keypair');
  if (!keys) {
    keys = await generateKeyPair();
    await dbPut(db, STORE_KEY, 'keypair', keys);
  }

  const fingerprint = await fingerprintOf(keys.publicKey);
  const shortId = fingerprint.slice(0, 8);

  const savedNick = await dbGet(db, STORE_NICK, 'nickname');
  const hasNick = typeof savedNick === 'string' && savedNick.trim().length > 0;
  const nickname = normalizeNickname(savedNick, shortId);
  const isNewUser = !hasNick;

  async function sign(data) {
    const encoded = encodePayload(data);
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encoded);
    return Array.from(new Uint8Array(sig));
  }

  async function verify(data, sigArray, pubKey) {
    try {
      const encoded = encodePayload(data);
      const sigBuf = new Uint8Array(sigArray).buffer;
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, sigBuf, encoded);
    } catch {
      return false;
    }
  }

  async function saveNickname(nick) {
    const normalized = normalizeNickname(nick, shortId);
    await dbPut(db, STORE_NICK, 'nickname', normalized);
    return normalized;
  }

  return {
    fingerprint,
    shortId,
    nickname,
    isNewUser,
    sign,
    verify,
    saveNickname,
  };
}

export async function resetIdentity() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_KEY, STORE_NICK], 'readwrite');
    tx.objectStore(STORE_KEY).delete('keypair');
    tx.objectStore(STORE_NICK).delete('nickname');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
