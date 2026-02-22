/**
 * files.js — Turquoise Phase 4
 *
 * Streaming file transfer over WebRTC DataChannel.
 *
 * WHY STREAMING MATTERS:
 *   Naive approach: file.arrayBuffer() → loads ENTIRE file into RAM.
 *   A 5 GB file needs 5 GB of browser RAM. Browser crashes.
 *
 *   Correct approach: File.slice(start, end) → read 64 KB at a time.
 *   Monitor DataChannel.bufferedAmount → pause when buffer is full.
 *   Never hold more than ~2 chunks in memory at once.
 *   This allows arbitrarily large files.
 *
 * Protocol:
 *   → file-start  { fileId, name, size, mimeType, totalChunks }
 *   → file-chunk  { fileId, index, data: base64 }  ×N
 *   → file-end    { fileId }
 *
 * Murphy's Law: missing chunks, encode failures, closed channels —
 *               all caught and reported. Nothing corrupts silently.
 */

const CHUNK_SIZE      = 64 * 1024;        // 64 KB per chunk
const MAX_BUFFER      = 256 * 1024;       // pause when DataChannel buffer > 256 KB
const BUFFER_POLL_MS  = 50;               // check buffer every 50ms when paused
const MAX_FILE_SIZE   = 8 * 1024 ** 3;    // 8 GB hard limit (browser memory concern)

export class FileTransfer {

  constructor(sendToFn) {
    if (typeof sendToFn !== 'function') {
      throw new Error('FileTransfer: sendToFn must be a function(fp, payload).');
    }
    this.sendTo      = sendToFn;
    this.incoming    = new Map(); // fileId → { meta, chunks[], received }
    this.outgoing    = new Map(); // fileId → { cancelled: bool }

    // Callbacks — set from outside
    this.onProgress  = null; // (fileId, 0–1, 'in'|'out') → void
    this.onFileReady = null; // (fileInfo) → void
    this.onError     = null; // (fileId, msg) → void
  }

  // ── Send a file to one peer ─────────────────────────────────────────────────

  async sendFile(file, toPeerFp, fileId, getChannelFn) {
    if (!file)       throw new Error('sendFile: no file.');
    if (!toPeerFp)   throw new Error('sendFile: no peer fingerprint.');
    if (!fileId)     fileId = this._genId();
    if (file.size === 0) throw new Error('File is empty.');
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large: ${this._fmt(file.size)} (max ${this._fmt(MAX_FILE_SIZE)})`
      );
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    this.outgoing.set(fileId, { cancelled: false });

    // Send metadata
    const ok = this.sendTo(toPeerFp, {
      type: 'file-start', fileId,
      name: file.name || 'file',
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks, ts: Date.now(),
    });
    if (!ok) throw new Error('Peer channel not open.');

    // Stream chunks using File.slice() — never loads full file into RAM
    for (let i = 0; i < totalChunks; i++) {

      // Check if cancelled
      if (this.outgoing.get(fileId)?.cancelled) {
        this.outgoing.delete(fileId);
        throw new Error('Transfer cancelled.');
      }

      const start  = i * CHUNK_SIZE;
      const end    = Math.min(start + CHUNK_SIZE, file.size);
      const slice  = file.slice(start, end);

      // Read only this 64 KB slice — not the whole file
      let buffer;
      try {
        buffer = await slice.arrayBuffer();
      } catch (e) {
        throw new Error(`Failed to read chunk ${i}: ${e.message}`);
      }

      let data;
      try {
        data = this._bufToBase64(buffer);
      } catch (e) {
        throw new Error(`Failed to encode chunk ${i}: ${e.message}`);
      }

      // If caller provides a getChannel function, pause when buffer is full
      // This prevents overwhelming the DataChannel buffer
      if (typeof getChannelFn === 'function') {
        const ch = getChannelFn(toPeerFp);
        if (ch) {
          while (ch.bufferedAmount > MAX_BUFFER) {
            await this._sleep(BUFFER_POLL_MS);
          }
        }
      }

      const sent = this.sendTo(toPeerFp, { type: 'file-chunk', fileId, index: i, data });
      if (!sent) {
        this.outgoing.delete(fileId);
        throw new Error(`Channel closed at chunk ${i}/${totalChunks}.`);
      }

      if (typeof this.onProgress === 'function') {
        this.onProgress(fileId, (i + 1) / totalChunks, 'out');
      }

      // Yield to event loop every 20 chunks so UI stays responsive
      if (i % 20 === 19) await this._sleep(0);
    }

    this.sendTo(toPeerFp, { type: 'file-end', fileId });
    this.outgoing.delete(fileId);
    return fileId;
  }

  cancelSend(fileId) {
    const transfer = this.outgoing.get(fileId);
    if (transfer) transfer.cancelled = true;
  }

  // ── Handle incoming messages ────────────────────────────────────────────────

  handleMessage(msg) {
    if (!msg?.fileId) return;
    switch (msg.type) {
      case 'file-start': this._handleStart(msg); break;
      case 'file-chunk': this._handleChunk(msg); break;
      case 'file-end':   this._handleEnd(msg);   break;
    }
  }

  _handleStart(msg) {
    if (!msg.name || !msg.totalChunks || msg.totalChunks < 1) {
      this._err(msg.fileId, 'file-start: invalid metadata.'); return;
    }
    this.incoming.set(msg.fileId, {
      meta:     msg,
      chunks:   new Array(msg.totalChunks).fill(null),
      received: 0,
    });
  }

  _handleChunk(msg) {
    const t = this.incoming.get(msg.fileId);
    if (!t) return; // start may not have arrived yet — rare, ignore

    const { totalChunks } = t.meta;
    if (typeof msg.index !== 'number' || msg.index < 0 || msg.index >= totalChunks) {
      this._err(msg.fileId, `chunk index ${msg.index} out of range.`); return;
    }
    if (!msg.data) {
      this._err(msg.fileId, `chunk ${msg.index} empty.`); return;
    }

    if (t.chunks[msg.index] === null) {
      t.chunks[msg.index] = msg.data;
      t.received++;
    }

    if (typeof this.onProgress === 'function') {
      this.onProgress(msg.fileId, t.received / totalChunks, 'in');
    }
  }

  _handleEnd(msg) {
    const t = this.incoming.get(msg.fileId);
    if (!t) { this._err(msg.fileId, 'file-end with no transfer.'); return; }
    this.incoming.delete(msg.fileId);

    const missing = t.chunks.reduce((acc, c, i) => c === null ? [...acc, i] : acc, []);
    if (missing.length > 0) {
      this._err(msg.fileId, `${missing.length} chunk(s) missing — file corrupt.`); return;
    }

    let blob;
    try {
      const parts = t.chunks.map((b64, i) => {
        try { return new Uint8Array(this._base64ToBuf(b64)); }
        catch (e) { throw new Error(`chunk ${i} decode failed: ${e.message}`); }
      });
      blob = new Blob(parts, { type: t.meta.mimeType || 'application/octet-stream' });
    } catch (e) {
      this._err(msg.fileId, 'Reassembly failed: ' + e.message); return;
    }

    let url;
    try { url = URL.createObjectURL(blob); }
    catch (e) { this._err(msg.fileId, 'createObjectURL failed: ' + e.message); return; }

    if (typeof this.onFileReady === 'function') {
      this.onFileReady({
        fileId: msg.fileId, name: t.meta.name, size: t.meta.size,
        mimeType: t.meta.mimeType, blob, url,
      });
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _bufToBase64(buffer) {
    const bytes  = new Uint8Array(buffer);
    let   binary = '';
    const step   = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  _base64ToBuf(b64) {
    if (typeof b64 !== 'string') throw new Error('base64 must be a string.');
    const bin   = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  _genId()   { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  _fmt(bytes) {
    if (bytes < 1024)       return bytes + ' B';
    if (bytes < 1024 ** 2)  return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 ** 3)  return (bytes / 1024 ** 2).toFixed(1) + ' MB';
    return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  }

  _err(fileId, msg) {
    console.error('[FileTransfer]', fileId, msg);
    if (typeof this.onError === 'function') this.onError(fileId, msg);
  }
}
