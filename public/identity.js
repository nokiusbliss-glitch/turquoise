/**
 * identity.js — Turquoise
 * Cryptographic device identity + editable nickname
 * Persistent across sessions via IndexedDB
 */

const DB_NAME    = 'tq-identity';
const DB_VERSION = 2;
const STORE_KEY  = 'tq-keys';
const STORE_NICK = 'tq-prefs';

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_KEY))  db.createObjectStore(STORE_KEY);
      if (!db.objectStoreNames.contains(STORE_NICK)) db.createObjectStore(STORE_NICK);
    };
    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = () => rej(new Error('IndexedDB open failed: ' + req.error?.message));
    req.onblocked = () => rej(new Error('IndexedDB blocked — close other tabs'));
  });
}

function dbGet(db, store, key) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbPut(db, store, key, value) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value, key);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
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
  const raw  = await crypto.subtle.exportKey('raw', publicKey);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function getIdentity() {
  if (!window.crypto?.subtle) throw new Error('crypto.subtle unavailable — requires HTTPS');
  if (!window.indexedDB)      throw new Error('IndexedDB unavailable');

  const db = await openDB();

  let keys = await dbGet(db, STORE_KEY, 'keypair');
  if (!keys) {
    keys = await generateKeyPair();
    await dbPut(db, STORE_KEY, 'keypair', keys);
  }

  const fingerprint = await fingerprintOf(keys.publicKey);
  const shortId     = fingerprint.slice(0, 8);

  const savedNick = await dbGet(db, STORE_NICK, 'nickname');
  const nickname  = (typeof savedNick === 'string' && savedNick.trim()) ? savedNick.trim() : shortId;
  const isNewUser = !savedNick; // true if nickname was never set

  async function sign(data) {
    const encoded = new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data));
    const sigBuf  = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encoded);
    return Array.from(new Uint8Array(sigBuf));
  }

  async function verify(data, sigArray, pubKey) {
    try {
      const encoded = new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data));
      const sigBuf  = new Uint8Array(sigArray).buffer;
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, sigBuf, encoded);
    } catch { return false; }
  }

  async function saveNickname(nick) {
    const trimmed = (nick || '').trim().slice(0, 32);
    await dbPut(db, STORE_NICK, 'nickname', trimmed || shortId);
    return trimmed || shortId;
  }

  return { fingerprint, shortId, nickname, isNewUser, sign, verify, saveNickname };
}

// Clears the cryptographic identity — next load generates a fresh one
export async function resetIdentity() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction([STORE_KEY, STORE_NICK], 'readwrite');
    tx.objectStore(STORE_KEY).delete('keypair');
    tx.objectStore(STORE_NICK).delete('nickname');
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}
