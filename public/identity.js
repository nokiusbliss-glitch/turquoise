/**
 * identity.js — Turquoise
 *
 * ECDSA P-256 device identity.
 * Keys stored as native CryptoKey objects in IndexedDB — no Base64 conversion.
 * Fingerprint = SHA-256 of the raw public key bytes.
 *
 * Murphy's Law: every step validated, every failure surfaced clearly.
 */

const DB_NAME = 'turquoise_identity';
const STORE   = 'keys';

function openIdentityDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB not supported in this browser.')); return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      try { req.result.createObjectStore(STORE); }
      catch (e) { reject(new Error('DB upgrade failed: ' + e.message)); }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(new Error('Identity DB error: ' + req.error?.message));
    req.onblocked = () => reject(new Error('Identity DB blocked — close other tabs.'));
  });
}

function dbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(new Error('dbGet failed: ' + req.error?.message));
  });
}

function dbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(new Error('dbPut failed: ' + tx.error?.message));
  });
}

export async function getIdentity() {
  if (!window.crypto?.subtle) {
    throw new Error(
      'crypto.subtle unavailable. This page must be served over HTTPS or localhost.'
    );
  }

  const db = await openIdentityDB();
  let keypair = await dbGet(db, 'keypair');

  if (!keypair) {
    keypair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // non-exportable private key
      ['sign', 'verify']
    );
    await dbPut(db, 'keypair', keypair);
  }

  if (!keypair?.publicKey || !keypair?.privateKey) {
    throw new Error(
      'Keypair in IndexedDB is malformed. ' +
      'Open DevTools → Application → IndexedDB → delete turquoise_identity and reload.'
    );
  }

  const rawPub     = await crypto.subtle.exportKey('raw', keypair.publicKey);
  const hashBuf    = await crypto.subtle.digest('SHA-256', rawPub);
  const fingerprint = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  // Load saved nickname from localStorage
  const nickname = localStorage.getItem('tq_nickname') || null;

  return {
    publicKey:   keypair.publicKey,
    privateKey:  keypair.privateKey,
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

export async function signMessage(identity, text) {
  if (!identity?.privateKey) throw new Error('signMessage: no privateKey in identity.');
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.privateKey,
    new TextEncoder().encode(text)
  );
  return new Uint8Array(sig);
}

export async function verifyMessage(identity, text, signature) {
  if (!identity?.publicKey) throw new Error('verifyMessage: no publicKey in identity.');
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.publicKey,
    signature,
    new TextEncoder().encode(text)
  );
}
