/**
 * files.js — Turquoise
 * High-throughput file transfer over WebRTC DataChannel.
 *
 * Flow control:
 *   LOW_WATER  = 64KB  (bufferedAmountLowThreshold, set in webrtc.js)
 *   HIGH_WATER = 1MB   — pause sending above this, resume on low-water event
 *   CHUNK      = 256KB — lazy disk reads, never loads whole file into RAM
 *
 * Race condition fix:
 *   ctrl channel and data channel are separate ordered streams.
 *   file-end (on ctrl) can arrive before the last binary chunk (on data).
 *   Fix: track both `ended` flag AND bytes received.
 *   Finalize only when BOTH: file-end received AND bytes >= expected size.
 */

const CHUNK      = 256 * 1024;
const HIGH_WATER =   1 * 1024 * 1024;

export class FileTransfer {
  constructor(sendCtrlFn, sendBinaryFn, waitBufferFn) {
    this._sendCtrl   = sendCtrlFn;
    this._sendBinary = sendBinaryFn;
    this._waitBuf    = waitBufferFn || (() => Promise.resolve());
    this._recv    = new Map(); // fp → recv state
    this._queue   = new Map(); // fp → [{file, fileId}]
    this._sending = new Set();
    this.onProgress  = null;
    this.onFileReady = null;
    this.onError     = null;
  }

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
      const { file, fileId } = q[0];
      try { await this._sendOne(file, fp, fileId); }
      catch (e) {
        this.onError?.(fileId, e.message, fp);
        try { this._sendCtrl(fp, { type: 'file-abort', fileId }); } catch {}
      }
      q.shift();
    }
    this._sending.delete(fp);
  }

  async _sendOne(file, fp, fileId) {
    if (file.size === 0) {
      this._sendCtrl(fp, { type: 'file-meta', fileId, name: file.name, size: 0, mimeType: file.type || 'application/octet-stream', totalChunks: 0 });
      this._sendCtrl(fp, { type: 'file-end', fileId, totalChunks: 0 });
      this.onProgress?.(fileId, 1, 'send', fp);
      return;
    }

    const totalChunks = Math.ceil(file.size / CHUNK);
    const ok = this._sendCtrl(fp, {
      type: 'file-meta', fileId,
      name: file.name, size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
    });
    if (!ok) throw new Error('Peer not connected');

    let offset = 0, chunkIdx = 0, lastPct = -1;

    while (offset < file.size) {
      await this._waitBuf(fp); // event-driven backpressure — never polls
      const end = Math.min(offset + CHUNK, file.size);
      let buf;
      try { buf = await file.slice(offset, end).arrayBuffer(); }
      catch (e) { throw new Error('File read error: ' + e.message); }
      if (!this._sendBinary(fp, buf)) throw new Error('DataChannel closed during transfer');
      offset += buf.byteLength;
      chunkIdx++;
      const pct = Math.floor(offset / file.size * 100);
      if (pct !== lastPct) { this.onProgress?.(fileId, offset / file.size, 'send', fp); lastPct = pct; }
    }

    this._sendCtrl(fp, { type: 'file-end', fileId, totalChunks: chunkIdx });
  }

  handleCtrl(fp, msg) {
    const { type, fileId } = msg;
    if (!fileId) return;

    if (type === 'file-meta') {
      this._recv.set(fp, {
        fileId, from: fp,
        name: msg.name || 'file',
        size: msg.size || 0,
        mimeType: msg.mimeType || 'application/octet-stream',
        total: msg.totalChunks || 0,
        chunks: [], bytes: 0,
        ended: false,   // file-end received
        lastPct: -1,
      });
    } else if (type === 'file-end') {
      const s = this._recv.get(fp);
      if (s && s.fileId === fileId) {
        s.ended = true;
        // If all bytes already arrived, finalize now.
        // If not (ctrl ahead of data), _tryFinalize in handleBinary will catch it.
        this._tryFinalize(fp, fileId);
      }
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
    const pct = s.size > 0 ? Math.min(s.bytes / s.size, 0.99) : 0;
    const pctInt = Math.floor(pct * 100);
    if (pctInt !== s.lastPct) { this.onProgress?.(s.fileId, pct, 'recv', fp); s.lastPct = pctInt; }
    // Try finalize — will succeed when both file-end received AND all bytes arrived
    if (s.ended) this._tryFinalize(fp, s.fileId);
  }

  _tryFinalize(fp, fileId) {
    const s = this._recv.get(fp);
    if (!s || s.fileId !== fileId) return;
    if (!s.ended) return; // still waiting for file-end on ctrl channel
    if (s.size > 0 && s.bytes < s.size) return; // still waiting for binary chunks
    this._recv.delete(fp);
    try {
      const blob = new Blob(s.chunks, { type: s.mimeType });
      const url  = URL.createObjectURL(blob);
      this.onProgress?.(fileId, 1, 'recv', fp);
      this.onFileReady?.({ fileId, url, name: s.name, size: blob.size, mimeType: s.mimeType, from: fp });
    } catch (e) {
      this.onError?.(fileId, 'Assembly failed: ' + e.message, fp);
    }
  }
}
