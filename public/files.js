/**
 * files.js — Turquoise v8
 * Resumable file transfer with chunk acknowledgements.
 *
 * Wire protocol:
 *   Sender   -> Receiver: { type:'file-meta', fileId, name, size, mimeType, totalChunks }
 *   Receiver -> Sender:   { type:'file-ack', fileId, receivedChunks, receivedBytes }
 *   Sender   -> Receiver: binary chunks over data channel
 *   Sender   -> Receiver: { type:'file-end', fileId, totalChunks }
 *   Receiver -> Sender:   { type:'file-complete', fileId, size, totalChunks }
 *
 * Resume model:
 *   - Sender only treats bytes as "done" after receiver ACKs them.
 *   - On reconnect, sender re-sends file-meta.
 *   - Receiver answers with the last confirmed chunk index.
 *   - Sender continues from that checkpoint and re-sends file-end if needed.
 */

const CHUNK              = 256 * 1024;
const STALL_MS           = 30_000;
const RESUME_MS          = 5 * 60_000;
const RETRY_MS           = 350;
const ACK_WAIT_MS        = 6_000;
const MAX_INFLIGHT       = 4;
const COMPLETE_CACHE_MAX = 256;

const smooth = (cur, inst) => cur === 0 ? inst : 0.35 * inst + 0.65 * cur;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export class FileTransfer {
  constructor(sendCtrlFn, sendBinaryFn, waitBufFn, isBinaryReadyFn) {
    this._ctrl        = sendCtrlFn;
    this._binary      = sendBinaryFn;
    this._waitBuf     = waitBufFn || (() => Promise.resolve());
    this._binaryReady = isBinaryReadyFn || (() => true);

    this._recv        = new Map(); // fp -> RecvState
    this._queue       = new Map(); // fp -> [sendKey]
    this._send        = new Map(); // sendKey -> SendState
    this._pumping     = new Set(); // fps currently pumping
    this._retryTimers = new Map(); // fp -> timeout id
    this._completed   = new Map(); // "fp:fileId" -> { at, ...meta }

    this.onProgress  = null; // (fileId, pct, dir, fp, stats) => void
    this.onFileReady = null; // ({ fileId, url, blob, name, size, mimeType, from }) => void
    this.onError     = null; // (fileId, msg, fp) => void
    this.onSent      = null; // (fileId, fp, stats) => void
  }

  // -- Public API -------------------------------------------------------------

  send(file, fp, fileId) {
    if (!file || !fp || !fileId) return false;
    const key = this._sendKey(fp, fileId);
    if (this._send.has(key)) {
      const state = this._send.get(key);
      if (state?.done) return false;
      state.file = file;
      this._kick(fp);
      return true;
    }

    const totalChunks = Math.ceil((file.size || 0) / CHUNK);
    const state = {
      key,
      fp,
      fileId,
      file,
      name: file.name || 'file',
      size: file.size || 0,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
      metaSent: false,
      resumeRequested: true,
      waitingAck: false,
      endSent: false,
      remoteDone: false,
      done: false,
      cancelled: false,
      sentChunks: 0,
      ackedChunks: 0,
      ackedBytes: 0,
      speed: 0,
      t0: Date.now(),
      lastAckAt: Date.now(),
      lastPct: -1,
      _resume: null,
      _await: null,
    };

    if (!this._queue.has(fp)) this._queue.set(fp, []);
    this._queue.get(fp).push(key);
    this._send.set(key, state);
    this._kick(fp);
    return true;
  }

  cancelSend(fileId, fp) {
    if (!fileId) return;
    if (fp) {
      const state = this._send.get(this._sendKey(fp, fileId));
      if (state) this._finishSendError(state, 'Cancelled', true);
      return;
    }
    for (const state of this._send.values()) {
      if (state.fileId === fileId) this._finishSendError(state, 'Cancelled', true);
    }
  }

  cancelRecv(fp, fileId) {
    const state = this._recv.get(fp);
    if (!state || state.fileId !== fileId) return;
    this._failRecv(fp, state, 'Cancelled', true);
  }

  onPeerDisconnected(fp) {
    let active = 0;

    const recv = this._recv.get(fp);
    if (recv) {
      active++;
      this._pauseRecv(fp, recv);
    }

    const q = this._queue.get(fp) || [];
    for (const key of q) {
      const state = this._send.get(key);
      if (!state || state.done) continue;
      active++;
      this._markResumeNeeded(state);
      this._armSendResume(state);
    }

    this._clearRetry(fp);
    return active;
  }

  onPeerConnected(fp) {
    let active = 0;

    const recv = this._recv.get(fp);
    if (recv) {
      active++;
      this._clearRecvResume(recv);
      this._resetStall(fp);
    }

    const q = this._queue.get(fp) || [];
    for (const key of q) {
      const state = this._send.get(key);
      if (!state || state.done) continue;
      active++;
      this._clearSendResume(state);
      this._markResumeNeeded(state);
    }

    if (active) this._kick(fp);
    return active;
  }

  handleCtrl(fp, msg) {
    const { type, fileId } = msg || {};
    if (!type || !fileId) return;

    if (type === 'file-meta') {
      this._handleMeta(fp, msg);
      return;
    }
    if (type === 'file-ack') {
      this._handleAck(fp, msg);
      return;
    }
    if (type === 'file-end') {
      this._handleEnd(fp, msg);
      return;
    }
    if (type === 'file-complete') {
      this._handleComplete(fp, msg);
      return;
    }
    if (type === 'file-abort') {
      this._handleAbort(fp, msg);
    }
  }

  handleBinary(fp, buf) {
    const state = this._recv.get(fp);
    if (!state) {
      console.warn('[TQ files] binary before meta from', fp?.slice(0, 8));
      return;
    }
    if (state.done) return;

    this._clearRecvResume(state);
    this._resetStall(fp);

    if (state.totalChunks > 0 && state.receivedChunks >= state.totalChunks) {
      this._sendAck(fp, state);
      return;
    }

    state.chunks.push(buf);
    state.receivedChunks++;
    state.bytes += buf.byteLength;
    state.wBytes += buf.byteLength;

    const now = Date.now();
    const elapsed = (now - state.t0) / 1000;
    const wAge = (now - state.wStart) / 1000;
    if (wAge >= 0.4) {
      state.speed = smooth(state.speed, wAge > 0 ? state.wBytes / wAge : 0);
      state.wStart = now;
      state.wBytes = 0;
    }

    const pct = state.size > 0 ? Math.min(state.bytes / state.size, state.endReceived ? 1 : 0.999) : 0;
    const pctInt = Math.floor(pct * 100);
    if (pctInt !== state.lastPct) {
      this.onProgress?.(state.fileId, pct, 'recv', fp, {
        bytesTransferred: state.bytes,
        totalBytes: state.size,
        speedBps: state.speed,
        etaSec: state.speed > 0 ? (state.size - state.bytes) / state.speed : 0,
        elapsedSec: elapsed,
        confirmedBytes: state.bytes,
        confirmedChunks: state.receivedChunks,
        totalChunks: state.totalChunks,
      });
      state.lastPct = pctInt;
    }

    this._sendAck(fp, state);
    if (state.endReceived && state.receivedChunks >= state.totalChunks) this._finalize(fp, state.fileId);
  }

  // -- Receiver side ----------------------------------------------------------

  _handleMeta(fp, msg) {
    const { fileId } = msg;
    const completed = this._completed.get(this._recvKey(fp, fileId));
    if (completed) {
      this._ctrl(fp, { type:'file-complete', fileId, size:completed.size, totalChunks:completed.totalChunks });
      return;
    }

    const totalChunks = Number.isFinite(msg.totalChunks)
      ? Math.max(0, msg.totalChunks | 0)
      : Math.ceil((msg.size || 0) / CHUNK);

    let state = this._recv.get(fp);
    if (state && state.fileId !== fileId) {
      this._failRecv(fp, state, 'Transfer replaced by a new file', false);
      state = null;
    }

    if (!state) {
      state = {
        fileId,
        name: msg.name || 'file',
        size: msg.size || 0,
        mimeType: msg.mimeType || 'application/octet-stream',
        totalChunks,
        chunks: [],
        receivedChunks: 0,
        bytes: 0,
        from: fp,
        t0: Date.now(),
        wStart: Date.now(),
        wBytes: 0,
        speed: 0,
        lastPct: -1,
        endReceived: false,
        done: false,
        _stall: null,
        _resume: null,
      };
      this._recv.set(fp, state);
    } else {
      state.name = msg.name || state.name;
      state.size = msg.size || state.size;
      state.mimeType = msg.mimeType || state.mimeType;
      state.totalChunks = totalChunks;
    }

    this._clearRecvResume(state);
    this._resetStall(fp);
    this._sendAck(fp, state);
    if (state.endReceived && state.receivedChunks >= state.totalChunks) this._finalize(fp, fileId);
  }

  _handleEnd(fp, msg) {
    const state = this._recv.get(fp);
    if (!state || state.fileId !== msg.fileId) {
      const completed = this._completed.get(this._recvKey(fp, msg.fileId));
      if (completed) this._ctrl(fp, { type:'file-complete', fileId:msg.fileId, size:completed.size, totalChunks:completed.totalChunks });
      return;
    }

    state.endReceived = true;
    if (Number.isFinite(msg.totalChunks)) state.totalChunks = Math.max(state.totalChunks, msg.totalChunks | 0);
    this._clearRecvResume(state);

    if (state.receivedChunks >= state.totalChunks) this._finalize(fp, msg.fileId);
    else {
      this._sendAck(fp, state);
      this._resetStall(fp);
    }
  }

  _handleAbort(fp, msg) {
    const sendState = this._send.get(this._sendKey(fp, msg.fileId));
    if (sendState) {
      this._finishSendError(sendState, 'Cancelled by receiver', false);
      return;
    }

    const recvState = this._recv.get(fp);
    if (recvState?.fileId === msg.fileId) this._failRecv(fp, recvState, 'Transfer aborted by sender', false);
  }

  _sendAck(fp, state) {
    this._ctrl(fp, {
      type: 'file-ack',
      fileId: state.fileId,
      receivedChunks: state.receivedChunks,
      receivedBytes: state.bytes,
      totalChunks: state.totalChunks,
    });
  }

  _finalize(fp, fileId) {
    const state = this._recv.get(fp);
    if (!state || state.fileId !== fileId || state.done) return;

    state.done = true;
    this._clearStall(fp);
    this._clearRecvResume(state);
    this._recv.delete(fp);

    const elapsed = (Date.now() - state.t0) / 1000;
    try {
      const blob = new Blob(state.chunks, { type: state.mimeType });
      const url = URL.createObjectURL(blob);
      this._rememberComplete(fp, fileId, {
        name: state.name,
        size: blob.size,
        mimeType: state.mimeType,
        totalChunks: state.totalChunks,
      });
      this._ctrl(fp, { type:'file-complete', fileId, size:blob.size, totalChunks:state.totalChunks });
      this.onProgress?.(fileId, 1, 'recv', fp, {
        bytesTransferred: blob.size,
        totalBytes: state.size,
        speedBps: elapsed > 0 ? blob.size / elapsed : 0,
        etaSec: 0,
        elapsedSec: elapsed,
        confirmedBytes: blob.size,
        confirmedChunks: state.totalChunks,
        totalChunks: state.totalChunks,
        done: true,
      });
      this.onFileReady?.({ fileId, url, blob, name: state.name, size: blob.size, mimeType: state.mimeType, from: fp });
    } catch (e) {
      this.onError?.(fileId, 'Assembly failed: ' + e.message, fp);
    }
  }

  _failRecv(fp, state, msg, notifySender) {
    if (!state || state.done) return;
    state.done = true;
    this._clearStall(fp);
    this._clearRecvResume(state);
    if (this._recv.get(fp)?.fileId === state.fileId) this._recv.delete(fp);
    if (notifySender) {
      try { this._ctrl(fp, { type:'file-abort', fileId:state.fileId }); } catch {}
    }
    this.onError?.(state.fileId, msg, fp);
  }

  _pauseRecv(fp, state) {
    if (!state || state.done) return;
    this._clearStall(fp);
    this._clearRecvResume(state);
    state._resume = setTimeout(() => {
      const cur = this._recv.get(fp);
      if (!cur || cur.fileId !== state.fileId || cur.done) return;
      this._failRecv(fp, cur, 'Peer did not reconnect', false);
    }, RESUME_MS);
  }

  // -- Sender side ------------------------------------------------------------

  _handleAck(fp, msg) {
    const state = this._send.get(this._sendKey(fp, msg.fileId));
    if (!state || state.done) return;

    const receivedChunks = clamp(Number(msg.receivedChunks) || 0, 0, state.totalChunks);
    const fallbackBytes = receivedChunks >= state.totalChunks
      ? state.size
      : Math.min(state.size, receivedChunks * CHUNK);
    const receivedBytes = clamp(Number.isFinite(msg.receivedBytes) ? msg.receivedBytes : fallbackBytes, 0, state.size);

    if (receivedChunks < state.ackedChunks || receivedBytes < state.ackedBytes) return;

    const now = Date.now();
    const deltaBytes = receivedBytes - state.ackedBytes;
    const deltaSec = Math.max((now - state.lastAckAt) / 1000, 0.001);
    if (deltaBytes > 0) state.speed = smooth(state.speed, deltaBytes / deltaSec);

    state.ackedChunks = receivedChunks;
    state.ackedBytes = receivedBytes;
    state.sentChunks = Math.max(state.sentChunks, state.ackedChunks);
    state.waitingAck = false;
    state.lastAckAt = now;

    this._clearAwait(state);
    if (!state.remoteDone) {
      if (state.sentChunks > state.ackedChunks || state.ackedChunks < state.totalChunks) this._armAwait(state, 'ack');
    }

    this._emitSendProgress(state, state.ackedChunks >= state.totalChunks && state.size > 0);
    this._kick(fp);
  }

  _handleComplete(fp, msg) {
    const state = this._send.get(this._sendKey(fp, msg.fileId));
    if (!state || state.done) return;
    state.remoteDone = true;
    state.ackedChunks = state.totalChunks;
    state.ackedBytes = state.size;
    this._completeSend(state);
  }

  async _pump(fp) {
    if (this._pumping.has(fp)) return;
    this._pumping.add(fp);
    this._clearRetry(fp);

    try {
      while (true) {
        const state = this._head(fp);
        if (!state) break;
        if (state.done) {
          this._removeSendState(state);
          continue;
        }

        if (state.resumeRequested || !state.metaSent) {
          const ok = this._ctrl(fp, {
            type: 'file-meta',
            fileId: state.fileId,
            name: state.name,
            size: state.size,
            mimeType: state.mimeType,
            totalChunks: state.totalChunks,
          });
          if (!ok) {
            this._scheduleRetry(fp);
            break;
          }
          state.metaSent = true;
          state.resumeRequested = false;
          state.waitingAck = true;
          this._armAwait(state, 'ack');
          break;
        }

        if (state.waitingAck) break;

        if (state.remoteDone) {
          this._completeSend(state);
          continue;
        }

        if (state.sentChunks < state.ackedChunks) state.sentChunks = state.ackedChunks;

        if (state.sentChunks >= state.totalChunks) {
          if (!state.endSent) {
            const ok = this._ctrl(fp, { type:'file-end', fileId:state.fileId, totalChunks:state.totalChunks });
            if (!ok) {
              this._markResumeNeeded(state);
              this._scheduleRetry(fp);
              break;
            }
            state.endSent = true;
            this._armAwait(state, 'complete');
          }
          break;
        }

        if (!this._binaryReady(fp)) {
          this._scheduleRetry(fp);
          break;
        }

        if (state.sentChunks >= Math.min(state.totalChunks, state.ackedChunks + MAX_INFLIGHT)) {
          this._armAwait(state, 'ack');
          break;
        }

        const result = await this._sendChunk(state);
        if (result === 'cancelled') continue;
        if (result === 'retry') {
          this._markResumeNeeded(state);
          this._scheduleRetry(fp);
          break;
        }
      }
    } finally {
      this._pumping.delete(fp);
    }
  }

  async _sendChunk(state) {
    if (state.done || state.cancelled) return 'cancelled';

    try {
      await this._waitBuf(state.fp);
    } catch {
      return 'retry';
    }

    if (state.done || state.cancelled) return 'cancelled';
    if (!this._binaryReady(state.fp)) return 'retry';

    const chunkIdx = state.sentChunks;
    const start = chunkIdx * CHUNK;
    const end = Math.min(start + CHUNK, state.size);
    let buf;

    try {
      buf = await state.file.slice(start, end).arrayBuffer();
    } catch (e) {
      this._finishSendError(state, 'File read error: ' + e.message, true);
      return 'cancelled';
    }

    if (state.done || state.cancelled) return 'cancelled';
    if (!this._binary(state.fp, buf)) return 'retry';

    state.sentChunks = chunkIdx + 1;
    this._armAwait(state, 'ack');
    return 'sent';
  }

  _completeSend(state) {
    if (!state || state.done) return;
    state.done = true;
    state.remoteDone = true;
    state.ackedChunks = state.totalChunks;
    state.ackedBytes = state.size;
    this._emitSendProgress(state, true);
    this._clearAwait(state);
    this._clearSendResume(state);
    this._removeSendState(state);

    const elapsed = (Date.now() - state.t0) / 1000;
    this.onSent?.(state.fileId, state.fp, {
      bytesTransferred: state.size,
      totalBytes: state.size,
      speedBps: elapsed > 0 ? state.size / elapsed : 0,
      etaSec: 0,
      elapsedSec: elapsed,
      confirmedBytes: state.size,
      confirmedChunks: state.totalChunks,
      totalChunks: state.totalChunks,
      done: true,
    });
    this._kick(state.fp);
  }

  _finishSendError(state, msg, notifyPeer) {
    if (!state || state.done) return;
    state.done = true;
    state.cancelled = msg === 'Cancelled';
    this._clearAwait(state);
    this._clearSendResume(state);
    this._removeSendState(state);
    if (notifyPeer) {
      try { this._ctrl(state.fp, { type:'file-abort', fileId:state.fileId }); } catch {}
    }
    this.onError?.(state.fileId, msg, state.fp);
    this._kick(state.fp);
  }

  _emitSendProgress(state, force = false) {
    const pct = state.size > 0
      ? Math.min(state.ackedBytes / state.size, state.remoteDone ? 1 : 0.999)
      : (state.remoteDone ? 1 : 0);
    const pctInt = Math.floor(pct * 100);
    if (!force && pctInt === state.lastPct) return;
    state.lastPct = pctInt;

    const elapsed = (Date.now() - state.t0) / 1000;
    this.onProgress?.(state.fileId, pct, 'send', state.fp, {
      bytesTransferred: state.ackedBytes,
      totalBytes: state.size,
      speedBps: state.speed,
      etaSec: state.speed > 0 ? Math.max(0, (state.size - state.ackedBytes) / state.speed) : 0,
      elapsedSec: elapsed,
      confirmedBytes: state.ackedBytes,
      confirmedChunks: state.ackedChunks,
      totalChunks: state.totalChunks,
    });
  }

  // -- Timers / bookkeeping ---------------------------------------------------

  _armAwait(state, mode) {
    this._clearAwait(state);
    state._await = setTimeout(() => {
      if (state.done) return;
      if (mode === 'complete') {
        if (!state.remoteDone) {
          state.sentChunks = state.totalChunks;
          this._markResumeNeeded(state);
          this._kick(state.fp);
        }
        return;
      }

      if (state.waitingAck || state.sentChunks > state.ackedChunks) {
        this._markResumeNeeded(state);
        this._kick(state.fp);
      }
    }, ACK_WAIT_MS);
  }

  _clearAwait(state) {
    if (state?._await) {
      clearTimeout(state._await);
      state._await = null;
    }
  }

  _armSendResume(state) {
    this._clearSendResume(state);
    state._resume = setTimeout(() => {
      const cur = this._send.get(state.key);
      if (!cur || cur.done) return;
      this._finishSendError(cur, 'Peer did not reconnect', false);
    }, RESUME_MS);
  }

  _clearSendResume(state) {
    if (state?._resume) {
      clearTimeout(state._resume);
      state._resume = null;
    }
  }

  _clearRecvResume(state) {
    if (state?._resume) {
      clearTimeout(state._resume);
      state._resume = null;
    }
  }

  _markResumeNeeded(state) {
    if (!state || state.done) return;
    state.resumeRequested = true;
    state.waitingAck = false;
    state.endSent = false;
    state.sentChunks = clamp(state.ackedChunks, 0, state.totalChunks);
    this._clearAwait(state);
  }

  _scheduleRetry(fp, ms = RETRY_MS) {
    if (this._retryTimers.has(fp)) return;
    const t = setTimeout(() => {
      this._retryTimers.delete(fp);
      this._kick(fp);
    }, ms);
    this._retryTimers.set(fp, t);
  }

  _clearRetry(fp) {
    const t = this._retryTimers.get(fp);
    if (t) clearTimeout(t);
    this._retryTimers.delete(fp);
  }

  _resetStall(fp) {
    const state = this._recv.get(fp);
    if (!state || state.done) return;
    this._clearStall(fp);
    state._stall = setTimeout(() => {
      const cur = this._recv.get(fp);
      if (!cur || cur.done) return;
      this._failRecv(fp, cur, `Transfer stalled (${STALL_MS / 1000}s)`, false);
    }, STALL_MS);
  }

  _clearStall(fp) {
    const state = this._recv.get(fp);
    if (state?._stall) {
      clearTimeout(state._stall);
      state._stall = null;
    }
  }

  _kick(fp) {
    queueMicrotask(() => this._pump(fp));
  }

  _head(fp) {
    const q = this._queue.get(fp);
    if (!q?.length) return null;
    while (q.length) {
      const state = this._send.get(q[0]);
      if (state && !state.done) return state;
      q.shift();
    }
    if (!q.length) this._queue.delete(fp);
    return null;
  }

  _removeSendState(state) {
    if (!state) return;
    this._send.delete(state.key);
    const q = this._queue.get(state.fp);
    if (q) {
      const idx = q.indexOf(state.key);
      if (idx !== -1) q.splice(idx, 1);
      if (!q.length) this._queue.delete(state.fp);
    }
    this._clearAwait(state);
    this._clearSendResume(state);
  }

  _rememberComplete(fp, fileId, meta) {
    this._completed.set(this._recvKey(fp, fileId), { ...meta, at: Date.now() });
    while (this._completed.size > COMPLETE_CACHE_MAX) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, info] of this._completed) {
        if ((info?.at || 0) < oldestAt) {
          oldestAt = info.at || 0;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this._completed.delete(oldestKey);
    }
  }

  _sendKey(fp, fileId) {
    return `${fp}:${fileId}`;
  }

  _recvKey(fp, fileId) {
    return `${fp}:${fileId}`;
  }
}
