/**
 * files.js — Turquoise Phase 4
 *
 * File transfer over WebRTC DataChannel.
 *
 * Protocol:
 *   Sender → file-start  { fileId, name, size, mimeType, totalChunks }
 *   Sender → file-chunk  { fileId, index, data: base64 }  ×N
 *   Sender → file-end    { fileId, checksum }
 *
 * Receiver assembles chunks in order and verifies count before building Blob.
 *
 * Murphy's Law:
 *   - File too large → clear error, no send
 *   - Missing chunks on reassembly → clear error, no corrupt download
 *   - DataChannel not open → clear error
 *   - ArrayBuffer encoding failures → caught and reported
 *   - Each chunk validated before adding to assembly
 */

const CHUNK_SIZE    = 64 * 1024;          // 64 KB per chunk
const MAX_FILE_SIZE = 512 * 1024 * 1024;  // 512 MB hard limit

export class FileTransfer {

  /**
   * @param {function} sendToFn  (fingerprint, payload) → boolean
   */
  constructor(sendToFn) {
    if (typeof sendToFn !== 'function') {
      throw new Error('FileTransfer: sendToFn must be a function.');
    }

    this.sendTo     = sendToFn;
    this.incoming   = new Map(); // fileId → { meta, chunks[], received }
    this.outgoing   = new Map(); // fileId → { name, size, to }

    // Callbacks — set from outside
    this.onProgress  = null; // (fileId, 0–1, direction) → void
    this.onFileReady = null; // (fileInfo) → void
    this.onError     = null; // (fileId, message) → void
  }

  // ── Send a file to one peer ─────────────────────────────────────────────────

  async sendFile(file, toPeerFp, fileId) {
    if (!file)       throw new Error('sendFile: no file provided.');
    if (!toPeerFp)   throw new Error('sendFile: no peer fingerprint.');
    if (!fileId)     fileId = this._genId();

    if (file.size === 0) {
      throw new Error('sendFile: file is empty.');
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(
        `sendFile: file too large (${this._fmtSize(file.size)} — max ${this._fmtSize(MAX_FILE_SIZE)}).`
      );
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // 1. Send metadata header
    const ok = this.sendTo(toPeerFp, {
      type:        'file-start',
      fileId,
      name:        file.name || 'untitled',
      size:        file.size,
      mimeType:    file.type || 'application/octet-stream',
      totalChunks,
      ts:          Date.now(),
    });

    if (!ok) throw new Error('sendFile: peer channel not open.');

    this.outgoing.set(fileId, { name: file.name, size: file.size, to: toPeerFp });

    // 2. Read file into ArrayBuffer
    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (e) {
      throw new Error('sendFile: could not read file: ' + e.message);
    }

    // 3. Send chunks
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end   = Math.min(start + CHUNK_SIZE, file.size);

      let data;
      try {
        data = this._bufToBase64(buffer.slice(start, end));
      } catch (e) {
        throw new Error(`sendFile: chunk ${i} encode failed: ${e.message}`);
      }

      const sent = this.sendTo(toPeerFp, {
        type:   'file-chunk',
        fileId,
        index:  i,
        data,
      });

      if (!sent) {
        throw new Error(`sendFile: channel closed at chunk ${i}/${totalChunks}.`);
      }

      // Report progress
      if (typeof this.onProgress === 'function') {
        this.onProgress(fileId, (i + 1) / totalChunks, 'out');
      }

      // Yield every 20 chunks to avoid blocking the event loop
      if (i % 20 === 19) await this._sleep(0);
    }

    // 4. Send end marker
    this.sendTo(toPeerFp, { type: 'file-end', fileId });
    this.outgoing.delete(fileId);

    return fileId;
  }

  // ── Handle incoming file messages ───────────────────────────────────────────

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    const { type, fileId } = msg;
    if (!fileId) return;

    if (type === 'file-start') {
      this._handleStart(msg);
    } else if (type === 'file-chunk') {
      this._handleChunk(msg);
    } else if (type === 'file-end') {
      this._handleEnd(msg);
    }
  }

  _handleStart(msg) {
    if (!msg.name || !msg.totalChunks || msg.totalChunks < 1) {
      this._err(msg.fileId, 'file-start: invalid metadata.');
      return;
    }

    this.incoming.set(msg.fileId, {
      meta:     msg,
      chunks:   new Array(msg.totalChunks).fill(null),
      received: 0,
    });
  }

  _handleChunk(msg) {
    const transfer = this.incoming.get(msg.fileId);
    if (!transfer) {
      // Could arrive slightly out of order — silently ignore
      return;
    }

    const { totalChunks } = transfer.meta;

    if (typeof msg.index !== 'number' || msg.index < 0 || msg.index >= totalChunks) {
      this._err(msg.fileId, `chunk index ${msg.index} out of range (0–${totalChunks - 1}).`);
      return;
    }
    if (!msg.data) {
      this._err(msg.fileId, `chunk ${msg.index} has no data.`);
      return;
    }

    if (transfer.chunks[msg.index] === null) {
      transfer.chunks[msg.index] = msg.data;
      transfer.received++;
    }

    if (typeof this.onProgress === 'function') {
      this.onProgress(msg.fileId, transfer.received / totalChunks, 'in');
    }
  }

  _handleEnd(msg) {
    const transfer = this.incoming.get(msg.fileId);
    if (!transfer) {
      this._err(msg.fileId, 'file-end received but no transfer found.');
      return;
    }

    this.incoming.delete(msg.fileId);

    const { meta, chunks, received } = transfer;

    // Verify no missing chunks
    const missing = chunks.reduce((n, c, i) => c === null ? n.concat(i) : n, []);
    if (missing.length > 0) {
      this._err(msg.fileId, `${missing.length} chunk(s) missing — file corrupt.`);
      return;
    }

    // Reassemble
    let blob;
    try {
      const parts = chunks.map((b64, i) => {
        try {
          return new Uint8Array(this._base64ToBuf(b64));
        } catch (e) {
          throw new Error(`chunk ${i} decode failed: ${e.message}`);
        }
      });

      blob = new Blob(parts, { type: meta.mimeType || 'application/octet-stream' });
    } catch (e) {
      this._err(msg.fileId, 'Reassembly failed: ' + e.message);
      return;
    }

    let url;
    try {
      url = URL.createObjectURL(blob);
    } catch (e) {
      this._err(msg.fileId, 'createObjectURL failed: ' + e.message);
      return;
    }

    if (typeof this.onFileReady === 'function') {
      this.onFileReady({
        fileId:   msg.fileId,
        name:     meta.name,
        size:     meta.size,
        mimeType: meta.mimeType,
        blob,
        url,
      });
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _bufToBase64(buffer) {
    const bytes  = new Uint8Array(buffer);
    let   binary = '';
    // Chunk the conversion to avoid call stack overflow on large buffers
    const step   = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  _base64ToBuf(base64) {
    if (typeof base64 !== 'string') throw new Error('base64 must be a string.');
    const binary = atob(base64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  _genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  _fmtSize(bytes) {
    if (bytes < 1024)        return bytes + ' B';
    if (bytes < 1024 ** 2)   return (bytes / 1024).toFixed(1)      + ' KB';
    if (bytes < 1024 ** 3)   return (bytes / 1024 ** 2).toFixed(1) + ' MB';
    return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  }

  _err(fileId, msg) {
    console.error('[FileTransfer]', fileId, msg);
    if (typeof this.onError === 'function') this.onError(fileId, msg);
  }
}
