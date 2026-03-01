/**
 * files.js — Turquoise
 * Simple reliable file transfer over WebRTC DataChannel.
 *
 * Design:
 *   - ctrl channel: file-meta → file-end | file-abort (JSON)
 *   - data channel: raw ArrayBuffer chunks, no header needed
 *   - one active transfer per peer at a time (queued)
 *   - receiver knows active file from last file-meta on ctrl
 *   - chunks arrive in order (ordered:true DataChannel guarantee)
 *   - reassemble as Blob — works for any size the WiFi allows
 *
 * All data is P2P. Nothing touches Render after connection.
 */

const CHUNK = 65536; // 64 KB per chunk

export class FileTransfer {
  constructor(sendCtrlFn, sendBinaryFn, waitBufferFn) {
    this._sendCtrl   = sendCtrlFn;
    this._sendBinary = sendBinaryFn;
    this._waitBuf    = waitBufferFn || (() => Promise.resolve());

    this._recv    = new Map(); // fp → recv state
    this._queue   = new Map(); // fp → [{file, fileId}]
    this._sending = new Set(); // fps currently sending

    this.onProgress  = null;
    this.onFileReady = null;
    this.onError     = null;
  }

  // ── Send API ──────────────────────────────────────────────────────────────────
  send(file, fp, fileId) {
    if (!file || !fp || !fileId) return;
    if (!this._queue.has(fp)) this._queue.set(fp, []);
    this._queue.get(fp).push({ file, fileId });
    if (!this._sending.has(fp)) this._drain(fp);
  }

  async _drain(fp) {
    this._sending.add(fp);
    const q = this._queue.get(fp) || [];
    while (q.length) {
      const item = q[0];
      try {
        await this._sendOne(item.file, fp, item.fileId);
      } catch (e) {
        this.onError?.(item.fileId, e.message, fp);
        this._sendCtrl(fp, { type: 'file-abort', fileId: item.fileId });
      }
      q.shift();
    }
    this._sending.delete(fp);
  }

  async _sendOne(file, fp, fileId) {
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK));

    const ok = this._sendCtrl(fp, {
      type: 'file-meta', fileId,
      name: file.name, size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
    });
    if (!ok) throw new Error('Peer not connected');

    let offset = 0;
    let idx    = 0;

    while (offset < file.size) {
      await this._waitBuf(fp);
      const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
      if (!this._sendBinary(fp, buf)) throw new Error('DataChannel closed during transfer');
      offset += buf.byteLength;
      idx++;
      this.onProgress?.(fileId, offset / file.size, 'send', fp);
    }

    this._sendCtrl(fp, { type: 'file-end', fileId, totalChunks: idx });
  }

  // ── Receive API ───────────────────────────────────────────────────────────────
  handleCtrl(fp, msg) {
    const { type, fileId } = msg;
    if (!fileId) return;

    if (type === 'file-meta') {
      this._recv.set(fp, {
        fileId,
        name:     msg.name     || 'file',
        size:     msg.size     || 0,
        mimeType: msg.mimeType || 'application/octet-stream',
        total:    msg.totalChunks || 0,
        chunks:   [],
        bytes:    0,
      });
    } else if (type === 'file-end') {
      this._finalize(fp, fileId);
    } else if (type === 'file-abort') {
      this._recv.delete(fp);
      this.onError?.(fileId, 'Transfer aborted by sender', fp);
    }
  }

  handleBinary(fp, buf) {
    const s = this._recv.get(fp);
    if (!s) return;
    s.chunks.push(buf);
    s.bytes += buf.byteLength;
    const pct = s.size > 0 ? Math.min(s.bytes / s.size, 0.99) : (s.total > 0 ? s.chunks.length / s.total : 0);
    this.onProgress?.(s.fileId, pct, 'recv', fp);
  }

  _finalize(fp, fileId) {
    const s = this._recv.get(fp);
    if (!s || s.fileId !== fileId) return;
    this._recv.delete(fp);
    try {
      const blob = new Blob(s.chunks, { type: s.mimeType });
      const url  = URL.createObjectURL(blob);
      this.onFileReady?.({ fileId, url, name: s.name, size: blob.size, mimeType: s.mimeType, from: fp });
    } catch (e) {
      this.onError?.(fileId, 'Assembly failed: ' + e.message, fp);
    }
  }
}
