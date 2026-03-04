/**
 * webrtc.js — Turquoise
 * Signaling + P2P transport + media renegotiation + peer telemetry.
 */

const LOW_WATER = 64 * 1024;
const HIGH_WATER = 1024 * 1024;
const FP_RE = /^[a-f0-9]{64}$/i;

export class TurquoiseNetwork {
  constructor(identity) {
    if (!identity?.fingerprint) throw new Error('identity.fingerprint required');

    this.id = identity;
    this.peers = new Map();
    this.ws = null;
    this._wsURL = null;
    this._retry = 0;
    this._timer = null;
    this._ping = null;
    this._dead = false;
    this._streamRefs = new WeakMap();

    this.onPeerConnected = null;
    this.onPeerDisconnected = null;
    this.onMessage = null;
    this.onBinaryChunk = null;
    this.onLog = null;
    this.onSignalingConnected = null;
    this.onSignalingDisconnected = null;
  }

  connect(url) {
    this._wsURL = url;
    this._dead = false;
    this._retry = 0;
    clearTimeout(this._timer);
    try { this.ws?.close(); } catch {}
    this._openWS();
  }

  disconnect() {
    this.destroy();
  }

  _openWS() {
    if (this._dead) return;

    this._log('connecting to signaling...');
    let ws;
    try {
      ws = new WebSocket(this._wsURL);
    } catch (e) {
      this._log('WS create failed: ' + (e?.message || e), true);
      this._scheduleWS();
      return;
    }

    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws) return;

      this._retry = 0;
      this._log('signaling connected');
      try {
        ws.send(JSON.stringify({
          type: 'announce',
          from: this.id.fingerprint,
          nick: this.id.nickname,
        }));
      } catch {}

      this.onSignalingConnected?.();

      clearInterval(this._ping);
      this._ping = setInterval(() => {
        if (ws.readyState === 1) {
          try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
        }
      }, 25_000);
    };

    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      try {
        const msg = JSON.parse(e.data);
        this._onSignal(msg);
      } catch {}
    };

    ws.onerror = () => {};

    ws.onclose = (e) => {
      if (ws !== this.ws) return;
      clearInterval(this._ping);
      if (this._dead) return;

      this._log(`signaling lost (code ${e.code}) - retrying`, true);
      this.onSignalingDisconnected?.();
      this._scheduleWS();
    };
  }

  _scheduleWS() {
    clearTimeout(this._timer);
    const ms = Math.min(30_000, 1000 * Math.pow(1.618, Math.min(this._retry++, 8)));
    this._timer = setTimeout(() => this._openWS(), ms);
  }

  _sig(obj) {
    if (this.ws?.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  _onSignal(msg) {
    if (!msg?.type) return;

    if (msg.type === 'peer') {
      const fp = String(msg.fingerprint || '').toLowerCase();
      if (FP_RE.test(fp) && fp !== this.id.fingerprint && !this.peers.has(fp)) {
        setTimeout(() => {
          if (!this.peers.has(fp)) this._initiate(fp);
        }, Math.random() * 150);
      }
      return;
    }

    if (msg.to && msg.to !== this.id.fingerprint) return;

    const from = String(msg.from || '').toLowerCase();
    if (!FP_RE.test(from)) return;

    if (msg.type === 'offer') { this._onOffer(from, msg.sdp, msg.nick); return; }
    if (msg.type === 'answer') { this._onAnswer(from, msg.sdp); return; }
    if (msg.type === 'ice') { this._onICE(from, msg.candidate); return; }
  }

  _newPeerState(fp, pc, nick = null) {
    return {
      pc,
      ctrl: null,
      data: null,
      ready: false,
      nick,
      remoteStream: null,
      localStream: null,
      onRemoteStream: null,
      _closing: false,
      _makingOffer: false,
      _mediaLock: false,
      _isPolite: this.id.fingerprint < fp,
      _pendingIce: [],
      _statsPrev: new Map(),
    };
  }

  _makePC(fp) {
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch (e) {
      this._log('RTCPeerConnection failed: ' + (e?.message || e), true);
      return null;
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this._sig({
          type: 'ice',
          from: this.id.fingerprint,
          to: fp,
          candidate,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce(); } catch {}
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        this._log(`P2P connected: ${fp.slice(0, 8)}`);
      }

      if (s === 'failed' || s === 'closed') {
        const ps = this.peers.get(fp);
        const wasReady = !!ps?.ready;
        const name = ps?.nick || fp.slice(0, 8);
        this._closePeer(fp);

        if (wasReady) this.onPeerDisconnected?.(fp);
        this._log(`peer disconnected: ${name}`, true);

        if (!this._dead) {
          setTimeout(() => {
            if (!this.peers.has(fp)) this._initiate(fp);
          }, 3000);
        }
      }
    };

    pc.ontrack = (e) => {
      const ps = this.peers.get(fp);
      if (!ps) return;

      if (!ps.remoteStream) ps.remoteStream = new MediaStream();

      const track = e.track;
      if (!ps.remoteStream.getTracks().includes(track)) {
        ps.remoteStream.addTrack(track);
      }

      ps.onRemoteStream?.(ps.remoteStream);
      track.onunmute = () => ps.onRemoteStream?.(ps.remoteStream);
    };

    return pc;
  }

  _wireCtrl(fp, ch) {
    const ps = this.peers.get(fp);
    if (ps) ps.ctrl = ch;

    let closed = false;

    ch.onopen = () => {
      this._log(`ctrl open: ${fp.slice(0, 8)}`);
      try {
        ch.send(JSON.stringify({
          type: 'hello',
          fingerprint: this.id.fingerprint,
          nick: this.id.nickname,
        }));
      } catch {}
      this._checkReady(fp);
    };

    ch.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._onPeerMsg(fp, msg);
    };

    ch.onerror = () => {
      if (closed) return;
      const p = this.peers.get(fp);
      if (!p || p._closing) return;

      const s = p.pc?.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') return;

      this._log(`ctrl channel error: ${fp.slice(0, 8)}`, true);
    };

    ch.onclose = () => {
      closed = true;
    };
  }

  _wireData(fp, ch) {
    const ps = this.peers.get(fp);
    if (ps) ps.data = ch;

    let closed = false;

    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = LOW_WATER;

    ch.onopen = () => {
      this._log(`data open: ${fp.slice(0, 8)}`);
      this._checkReady(fp);
    };

    ch.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.onBinaryChunk?.(fp, e.data);
    };

    ch.onerror = () => {
      if (closed) return;
      const p = this.peers.get(fp);
      if (!p || p._closing) return;

      const s = p.pc?.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') return;

      this._log(`data channel error: ${fp.slice(0, 8)}`, true);
    };

    ch.onclose = () => {
      closed = true;
    };
  }

  _checkReady(fp) {
    const ps = this.peers.get(fp);
    if (!ps || ps.ready) return;

    if (ps.ctrl?.readyState === 'open' && ps.data?.readyState === 'open') {
      ps.ready = true;
      this._log(`peer ready: ${ps.nick || fp.slice(0, 8)}`);
      this.onPeerConnected?.(fp, ps.nick);
    }
  }

  async _initiate(fp) {
    if (this.peers.has(fp)) return;

    this._log(`initiating: ${fp.slice(0, 8)}`);

    const pc = this._makePC(fp);
    if (!pc) return;

    const ps = this._newPeerState(fp, pc, null);
    this.peers.set(fp, ps);

    const ctrl = pc.createDataChannel('ctrl', { ordered: true });
    const data = pc.createDataChannel('data', { ordered: true });

    this._wireCtrl(fp, ctrl);
    this._wireData(fp, data);

    pc.onnegotiationneeded = async () => {
      if (ps._mediaLock) return;
      try {
        ps._makingOffer = true;
        await pc.setLocalDescription();
        this._sig({
          type: 'offer',
          from: this.id.fingerprint,
          to: fp,
          sdp: pc.localDescription,
          nick: this.id.nickname,
        });
      } catch (e) {
        this._log('offer error: ' + (e?.message || e), true);
      } finally {
        ps._makingOffer = false;
      }
    };
  }

  async _onOffer(fp, sdp, nick) {
    if (!sdp) return;

    let ps = this.peers.get(fp);
    if (!ps) {
      const pc = this._makePC(fp);
      if (!pc) return;

      ps = this._newPeerState(fp, pc, nick || null);
      this.peers.set(fp, ps);

      pc.ondatachannel = (e) => {
        if (e.channel.label === 'ctrl') this._wireCtrl(fp, e.channel);
        if (e.channel.label === 'data') this._wireData(fp, e.channel);
      };
    } else if (nick) {
      ps.nick = nick;
    }

    const collision = ps._makingOffer || ps.pc.signalingState !== 'stable';
    if (collision) {
      if (!ps._isPolite) return;
      try {
        await ps.pc.setLocalDescription({ type: 'rollback' });
      } catch {
        this._closePeer(fp);
        if (!this._dead) setTimeout(() => this._initiate(fp), 200);
        return;
      }
    }

    try {
      await ps.pc.setRemoteDescription(sdp);
      await this._flushPendingIce(ps);
      await ps.pc.setLocalDescription();
      this._sig({
        type: 'answer',
        from: this.id.fingerprint,
        to: fp,
        sdp: ps.pc.localDescription,
      });
    } catch (e) {
      this._log('answer error: ' + (e?.message || e), true);
      this._closePeer(fp);
    }
  }

  async _onAnswer(fp, sdp) {
    const ps = this.peers.get(fp);
    if (!ps || !sdp) return;

    try {
      await ps.pc.setRemoteDescription(sdp);
      await this._flushPendingIce(ps);
    } catch (e) {
      this._log('setRemoteDescription error: ' + (e?.message || e), true);
    }
  }

  async _onICE(fp, candidate) {
    const ps = this.peers.get(fp);
    if (!ps || !candidate) return;

    if (!ps.pc.remoteDescription) {
      ps._pendingIce.push(candidate);
      return;
    }

    try {
      await ps.pc.addIceCandidate(candidate);
    } catch (e) {
      const msg = String(e);
      if (!msg.includes('701') && !msg.includes('closed')) {
        this._log('ICE error: ' + (e?.message || e), true);
      }
    }
  }

  async _flushPendingIce(ps) {
    if (!ps?.pc?.remoteDescription || !ps._pendingIce?.length) return;
    const pending = ps._pendingIce.splice(0);
    for (const c of pending) {
      try {
        await ps.pc.addIceCandidate(c);
      } catch (e) {
        const msg = String(e);
        if (!msg.includes('701') && !msg.includes('closed')) {
          this._log('ICE flush error: ' + (e?.message || e), true);
        }
      }
    }
  }

  _onPeerMsg(fp, msg) {
    if (!msg?.type) return;

    if (msg.type === 'hello') {
      const ps = this.peers.get(fp);
      if (ps && msg.nick) ps.nick = msg.nick;
    }

    if (msg.type === 'answer-reneg') {
      this._applyRenegAnswer(fp, msg.sdp);
      return;
    }

    this.onMessage?.(fp, msg);
  }

  async _applyRenegAnswer(fp, sdp) {
    const ps = this.peers.get(fp);
    if (!ps || !sdp) return;
    try {
      await ps.pc.setRemoteDescription(sdp);
      await this._flushPendingIce(ps);
    } catch (e) {
      this._log('reneg answer error: ' + (e?.message || e), true);
    }
  }

  sendCtrl(fp, msg) {
    const ps = this.peers.get(fp);
    if (ps?.ctrl?.readyState !== 'open') return false;
    try {
      ps.ctrl.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  sendBinary(fp, buf) {
    const ps = this.peers.get(fp);
    if (ps?.data?.readyState !== 'open') return false;
    try {
      ps.data.send(buf);
      return true;
    } catch {
      return false;
    }
  }

  waitForBuffer(fp) {
    return new Promise((resolve) => {
      const ps = this.peers.get(fp);
      const ch = ps?.data;
      if (!ch || ch.readyState !== 'open' || ch.bufferedAmount < HIGH_WATER) {
        resolve();
        return;
      }

      let done = false;
      const prev = ch.onbufferedamountlow;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ch.onbufferedamountlow = prev || null;
        resolve();
      };

      const timer = setTimeout(finish, 5000);
      ch.onbufferedamountlow = (ev) => {
        try { prev?.call(ch, ev); } catch {}
        finish();
      };
    });
  }

  isReady(fp) {
    const ps = this.peers.get(fp);
    return !!(ps?.ready && ps.ctrl?.readyState === 'open' && ps.data?.readyState === 'open');
  }

  getConnectedPeers() {
    return [...this.peers.entries()]
      .filter(([, ps]) => ps.ready)
      .map(([fp]) => fp);
  }

  getPeerNick(fp) {
    return this.peers.get(fp)?.nick || fp?.slice(0, 8) || '?';
  }

  async getLocalStream(video = false) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: video
          ? {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 },
            }
          : false,
      });
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        throw new Error('permission-denied:' + (video ? 'camera/mic' : 'microphone'));
      }
      if (e.name === 'NotFoundError') {
        throw new Error('no-device:' + (video ? 'camera/mic' : 'microphone'));
      }
      throw e;
    }
  }

  async offerWithStream(fp, stream, extra = {}) {
    const ps = this.peers.get(fp);
    if (!ps) throw new Error('Peer not connected');

    this._releaseStream(ps.localStream);
    ps.pc.getSenders().forEach((s) => { try { ps.pc.removeTrack(s); } catch {} });

    ps.localStream = stream;
    this._retainStream(stream);

    ps._mediaLock = true;
    try {
      stream.getTracks().forEach((t) => ps.pc.addTrack(t, stream));
      const offer = await ps.pc.createOffer();
      await ps.pc.setLocalDescription(offer);

      this.sendCtrl(fp, {
        type: 'offer-reneg',
        sdp: ps.pc.localDescription,
        callType: stream.getVideoTracks().length > 0 ? 'stream' : 'walkie',
        ...extra,
      });
    } finally {
      ps._mediaLock = false;
    }
  }

  async answerWithStream(fp, remoteSdp, stream, extra = {}) {
    const ps = this.peers.get(fp);
    if (!ps) throw new Error('Peer not connected');

    this._releaseStream(ps.localStream);
    ps.pc.getSenders().forEach((s) => { try { ps.pc.removeTrack(s); } catch {} });

    ps.localStream = stream;
    this._retainStream(stream);

    ps._mediaLock = true;
    try {
      stream.getTracks().forEach((t) => ps.pc.addTrack(t, stream));
      await ps.pc.setRemoteDescription(remoteSdp);
      await this._flushPendingIce(ps);

      const answer = await ps.pc.createAnswer();
      await ps.pc.setLocalDescription(answer);

      this.sendCtrl(fp, {
        type: 'answer-reneg',
        sdp: ps.pc.localDescription,
        ...extra,
      });
    } finally {
      ps._mediaLock = false;
    }
  }

  async stopMedia(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return;

    this._releaseStream(ps.localStream);
    ps.localStream = null;

    ps.pc.getSenders().forEach((s) => {
      try { ps.pc.removeTrack(s); } catch {}
    });

    this.sendCtrl(fp, { type: 'call-end' });
  }

  setRemoteStreamHandler(fp, fn) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    ps.onRemoteStream = fn;
    if (ps.remoteStream) fn(ps.remoteStream);
  }

  _retainStream(stream) {
    if (!stream) return;
    const refs = this._streamRefs.get(stream) || 0;
    this._streamRefs.set(stream, refs + 1);
  }

  _releaseStream(stream) {
    if (!stream) return;
    const refs = this._streamRefs.get(stream) || 0;
    if (refs <= 1) {
      this._streamRefs.delete(stream);
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this._streamRefs.set(stream, refs - 1);
  }

  async getPeerStats(fp) {
    const ps = this.peers.get(fp);
    if (!ps?.pc) return null;

    const report = await ps.pc.getStats();
    const now = Date.now();

    const out = {
      connection: { rttMs: null, local: null, remote: null },
      audio: { inKbps: 0, outKbps: 0, jitterMs: null, lost: 0 },
      video: { inKbps: 0, outKbps: 0, width: null, height: null, fps: null, lost: 0 },
    };

    const rateKbps = (stat, bytesKey) => {
      const cur = typeof stat[bytesKey] === 'number' ? stat[bytesKey] : null;
      const prev = ps._statsPrev.get(stat.id);

      ps._statsPrev.set(stat.id, { t: now, b: cur });

      if (!prev || cur === null || prev.b === null) return 0;
      const dt = (now - prev.t) / 1000;
      if (dt <= 0) return 0;
      return Math.max(0, ((cur - prev.b) * 8) / 1000 / dt);
    };

    let selectedPair = null;

    report.forEach((s) => {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
        selectedPair = s;
      }

      if (s.type === 'inbound-rtp' && !s.isRemote) {
        const kind = s.kind || 'audio';
        const kbps = rateKbps(s, 'bytesReceived');

        if (kind === 'audio') {
          out.audio.inKbps += kbps;
          if (typeof s.jitter === 'number') out.audio.jitterMs = s.jitter * 1000;
          out.audio.lost += Number(s.packetsLost || 0);
        }

        if (kind === 'video') {
          out.video.inKbps += kbps;
          out.video.lost += Number(s.packetsLost || 0);
          if (s.frameWidth) out.video.width = s.frameWidth;
          if (s.frameHeight) out.video.height = s.frameHeight;
          if (s.framesPerSecond) out.video.fps = s.framesPerSecond;
        }
      }

      if (s.type === 'outbound-rtp' && !s.isRemote) {
        const kind = s.kind || 'audio';
        const kbps = rateKbps(s, 'bytesSent');
        if (kind === 'audio') out.audio.outKbps += kbps;
        if (kind === 'video') out.video.outKbps += kbps;
      }
    });

    if (selectedPair) {
      if (typeof selectedPair.currentRoundTripTime === 'number') {
        out.connection.rttMs = selectedPair.currentRoundTripTime * 1000;
      }
      const local = report.get(selectedPair.localCandidateId);
      const remote = report.get(selectedPair.remoteCandidateId);
      out.connection.local = local ? `${local.candidateType}/${local.protocol}` : null;
      out.connection.remote = remote ? `${remote.candidateType}/${remote.protocol}` : null;
    }

    return out;
  }

  _closePeer(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return;

    ps._closing = true;
    this._releaseStream(ps.localStream);

    try { ps.ctrl?.close(); } catch {}
    try { ps.data?.close(); } catch {}
    try { ps.pc.close(); } catch {}

    this.peers.delete(fp);
  }

  destroy() {
    this._dead = true;
    clearTimeout(this._timer);
    clearInterval(this._ping);

    try { this.ws?.close(); } catch {}
    this.ws = null;

    for (const fp of [...this.peers.keys()]) {
      this._closePeer(fp);
    }
  }

  _log(text, isErr = false) {
    this.onLog?.(text, isErr);
    (isErr ? console.warn : console.log)('[TQ]', text);
  }
}
