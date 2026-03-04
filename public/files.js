/**
 * files.js — Turquoise
 * P2P file transfer over RTCDataChannel with telemetry.
 */

const CHUNK = 256 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const RECV_STALL_MS = 30_000;

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function calcProgress(bytes, total, startedAt) {
  const pct = total > 0 ? Math.max(0, Math.min(1, bytes / total)) : 0;
  const elapsed = Math.max(0.001, (nowMs() - startedAt) / 1000);
  const bps = bytes / elapsed;
  const etaSec = total > bytes ? (total - bytes) / Math.max(1, bps) : 0;
  return { pct, bytes, totalBytes: total, bps, etaSec };
}

export class FileTransfer {
  constructor(sendCtrlFn, sendBinaryFn, waitBufferFn) {
    this._sendCtrl = sendCtrlFn;
    this._sendBinary = sendBinaryFn;
    this._waitBuf = waitBufferFn || (() => Promise.resolve());

    // fp -> active receive state (one at a time per peer)
    this._recv = new Map();
    // fp -> [{ file, fileId, meta }]
    this._queue = new Map();
    this._sending = new Set();

    this.onProgress = null;
    this.onFileReady = null;
    this.onError = null;
  }

  send(file, fp, fileId, meta = {}) {
    if (!file || !fp || !fileId) return;
    if (!this._queue.has(fp)) this._queue.set(fp, []);
    this._queue.get(fp).push({ file, fileId, meta });
    if (!this._sending.has(fp)) this._drain(fp).catch(() => {});
  }

  async _drain(fp) {
    this._sending.add(fp);
    const q = this._queue.get(fp) || [];

    while (q.length) {
      const { file, fileId, meta } = q[0];
      try {
        await this._sendOne(file, fp, fileId, meta);
      } catch (e) {
        this.onError?.(fileId, e?.message || 'transfer failed', fp);
        try { this._sendCtrl(fp, { type: 'file-abort', fileId }); } catch {}
      }
      q.shift();
    }

    this._sending.delete(fp);
  }

  async _sendOne(file, fp, fileId, meta) {
    if (file.size > MAX_FILE_BYTES) throw new Error('file too large');

    const startedAt = nowMs();

    if (file.size === 0) {
      const okMeta = this._sendCtrl(fp, {
        type: 'file-meta',
        fileId,
        name: file.name,
        size: 0,
        mimeType: file.type || 'application/octet-stream',
        totalChunks: 0,
        ...meta,
      });
      if (!okMeta) throw new Error('peer not connected');

      this._sendCtrl(fp, { type: 'file-end', fileId, totalChunks: 0, ...meta });
      this.onProgress?.(fileId, { dir: 'send', fp, pct: 1, bytes: 0, totalBytes: 0, bps: 0, etaSec: 0 }, 'send', fp);
      return;
    }

    const totalChunks = Math.ceil(file.size / CHUNK);
    const ok = this._sendCtrl(fp, {
      type: 'file-meta',
      fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
      ...meta,
    });
    if (!ok) throw new Error('peer not connected');

    let offset = 0;
    let chunkIdx = 0;
    let lastPctInt = -1;

    while (offset < file.size) {
      await this._waitBuf(fp);

      const end = Math.min(offset + CHUNK, file.size);
      const buf = await file.slice(offset, end).arrayBuffer();

      if (!this._sendBinary(fp, buf)) {
        throw new Error('data channel closed during transfer');
      }

      offset += buf.byteLength;
      chunkIdx++;

      const stats = calcProgress(offset, file.size, startedAt);
      const pctInt = Math.floor(stats.pct * 100);
      if (pctInt !== lastPctInt) {
        this.onProgress?.(fileId, { dir: 'send', fp, ...stats, chunks: chunkIdx }, 'send', fp);
        lastPctInt = pctInt;
      }
    }

    const okEnd = this._sendCtrl(fp, { type: 'file-end', fileId, totalChunks: chunkIdx, ...meta });
    if (!okEnd) throw new Error('control channel closed before file-end');
  }

  handleCtrl(fp, msg) {
    const { type, fileId } = msg || {};
    if (!fileId) return;

    if (type === 'file-meta') {
      const size = Number(msg.size || 0);
      if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) {
        this.onError?.(fileId, 'invalid file metadata', fp);
        try { this._sendCtrl(fp, { type: 'file-abort', fileId }); } catch {}
        return;
      }

      const existing = this._recv.get(fp);
      if (existing && existing.fileId !== fileId) {
        this._abortRecv(fp, existing.fileId, 'new transfer started before previous finished');
      }

      const startedAt = nowMs();
      const state = {
        fileId,
        from: fp,
        sessionId: msg.mesh ? 'mesh' : fp,
        mesh: !!msg.mesh,
        name: msg.name || 'file',
        size,
        mimeType: msg.mimeType || 'application/octet-stream',
        totalChunks: Number(msg.totalChunks || 0),
        chunks: [],
        bytes: 0,
        ended: false,
        startedAt,
        lastPctInt: -1,
        stallTimer: null,
      };

      this._recv.set(fp, state);
      this._touchRecv(fp);
      return;
    }

    if (type === 'file-end') {
      const state = this._recv.get(fp);
      if (!state || state.fileId !== fileId) return;
      state.ended = true;
      this._touchRecv(fp);
      this._tryFinalize(fp, fileId);
      return;
    }

    if (type === 'file-abort') {
      const state = this._recv.get(fp);
      if (!state || state.fileId !== fileId) return;
      this._clearRecvTimer(state);
      this._recv.delete(fp);
      this.onError?.(fileId, 'transfer aborted by sender', fp);
    }
  }

  handleBinary(fp, buf) {
    const state = this._recv.get(fp);
    if (!state) return;
    if (!(buf instanceof ArrayBuffer)) return;

    if (state.size > 0 && (state.bytes + buf.byteLength) > state.size + CHUNK) {
      this._abortRecv(fp, state.fileId, 'received more data than declared');
      return;
    }

    state.chunks.push(buf);
    state.bytes += buf.byteLength;
    this._touchRecv(fp);

    const stats = calcProgress(Math.min(state.bytes, state.size), state.size, state.startedAt);
    const pctInt = Math.floor(stats.pct * 100);
    if (pctInt !== state.lastPctInt) {
      state.lastPctInt = pctInt;
      this.onProgress?.(
        state.fileId,
        { dir: 'recv', fp, ...stats, chunks: state.chunks.length },
        'recv',
        fp
      );
    }

    if (state.ended) this._tryFinalize(fp, state.fileId);
  }

  _touchRecv(fp) {
    const state = this._recv.get(fp);
    if (!state) return;
    this._clearRecvTimer(state);
    state.stallTimer = setTimeout(() => {
      this._abortRecv(fp, state.fileId, 'transfer stalled');
    }, RECV_STALL_MS);
  }

  _clearRecvTimer(state) {
    if (!state?.stallTimer) return;
    clearTimeout(state.stallTimer);
    state.stallTimer = null;
  }

  _abortRecv(fp, fileId, reason) {
    const state = this._recv.get(fp);
    if (state && state.fileId === fileId) {
      this._clearRecvTimer(state);
      this._recv.delete(fp);
    }
    this.onError?.(fileId, reason, fp);
    try { this._sendCtrl(fp, { type: 'file-abort', fileId }); } catch {}
  }

  _tryFinalize(fp, fileId) {
    const state = this._recv.get(fp);
    if (!state || state.fileId !== fileId) return;
    if (!state.ended) return;
    if (state.size > 0 && state.bytes < state.size) return;

    this._clearRecvTimer(state);
    this._recv.delete(fp);

    try {
      const blob = new Blob(state.chunks, { type: state.mimeType });
      const url = URL.createObjectURL(blob);

      this.onProgress?.(
        fileId,
        {
          dir: 'recv',
          fp,
          pct: 1,
          bytes: blob.size,
          totalBytes: state.size,
          bps: 0,
          etaSec: 0,
          chunks: state.chunks.length,
        },
        'recv',
        fp
      );

      this.onFileReady?.({
        fileId,
        url,
        name: state.name,
        size: blob.size,
        mimeType: state.mimeType,
        from: fp,
        sessionId: state.sessionId,
        mesh: state.mesh,
      });
    } catch (e) {
      this.onError?.(fileId, 'assembly failed: ' + (e?.message || e), fp);
    }
  }
}
