/**
 * identity.js — Turquoise
 *
 * ECDSA P-256 device identity. Keys stored in IndexedDB.
 * Fingerprint = SHA-256 of raw public key bytes.
 * Nickname stored in localStorage.
 *
 * Murphy's Law: every step validated, every failure surfaced clearly.
 */

const DB_NAME = 'turquoise_identity';
const STORE   = 'keys';

function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB not supported. Use a modern browser.')); return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      try { req.result.createObjectStore(STORE); } catch (e) { reject(e); }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(new Error('Identity DB failed: ' + req.error?.message));
    req.onblocked = () => reject(new Error('Identity DB blocked — close other tabs.'));
  });
}

function dbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(new Error('dbGet: ' + req.error?.message));
  });
}

function dbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(new Error('dbPut: ' + tx.error?.message));
  });
}

export async function getIdentity() {
  if (!window.crypto?.subtle) {
    throw new Error(
      'crypto.subtle unavailable — page must be served over HTTPS or localhost.'
    );
  }

  const db = await openDB();
  let kp = await dbGet(db, 'keypair');

  if (!kp) {
    kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,         // non-exportable private key
      ['sign', 'verify']
    );
    await dbPut(db, 'keypair', kp);
  }

  if (!kp?.publicKey || !kp?.privateKey) {
    throw new Error(
      'Keypair malformed. Clear site data in browser settings and reload.'
    );
  }

  const rawPub     = await crypto.subtle.exportKey('raw', kp.publicKey);
  const hashBuf    = await crypto.subtle.digest('SHA-256', rawPub);
  const fingerprint = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const nickname = localStorage.getItem('tq_nickname') || null;

  return {
    publicKey:   kp.publicKey,
    privateKey:  kp.privateKey,
    fingerprint,
    shortId:     fingerprint.slice(0, 8),
    nickname,
  };
}

export function saveNickname(nickname) {
  if (typeof nickname === 'string' && nickname.trim()) {
    localStorage.setItem('tq_nickname', nickname.trim().slice(0, 32));
  }
}
