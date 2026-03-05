/**
 * webrtc.js — Turquoise
 *
 * STUN-free (local WiFi), WS ping every 25s, perfect negotiation.
 * Flow control: LOW_WATER=64KB threshold, HIGH_WATER=1MB pause.
 * offerWithStream accepts isCircle flag → sets msg.circle=true on offer-reneg.
 */

const LOW_WATER  = 64  * 1024;
const HIGH_WATER = 1024 * 1024;

export class TurquoiseNetwork {
  constructor(identity) {
    if (!identity?.fingerprint) throw new Error('identity.fingerprint required');
    this.id = identity; this.peers = new Map();
    this.ws = null; this._wsURL = null; this._retry = 0;
    this._timer = null; this._ping = null; this._dead = false;
    this.onPeerConnected = null; this.onPeerDisconnected = null;
    this.onMessage = null; this.onBinaryChunk = null; this.onLog = null;
    this.onSignalingConnected = null; this.onSignalingDisconnected = null;
  }

  connect(url) { this._wsURL = url; this._dead = false; this._retry = 0; this._openWS(); }

  _openWS() {
    if (this._dead) return;
    this._log('connecting to signaling…');
    let ws;
    try { ws = new WebSocket(this._wsURL); }
    catch (e) { this._log('WS failed: '+e.message, true); this._schedWS(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this._retry = 0; this._log('signaling connected ✓');
      ws.send(JSON.stringify({ type:'announce', from:this.id.fingerprint, nick:this.id.nickname }));
      this.onSignalingConnected?.();
      clearInterval(this._ping);
      this._ping = setInterval(() => { if (ws.readyState===1) try { ws.send(JSON.stringify({type:'ping'})); } catch {} }, 25000);
    };
    ws.onmessage = (e) => { try { this._onSignal(JSON.parse(e.data)); } catch {} };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      clearInterval(this._ping);
      if (this._dead) return;
      this._log(`signaling lost (${e.code===1006?'network dropped':'code '+e.code}) — retry…`, true);
      this.onSignalingDisconnected?.(); this._schedWS();
    };
  }

  _schedWS() {
    const ms = Math.min(30000, 1000 * Math.pow(1.618, Math.min(this._retry++, 8)));
    this._timer = setTimeout(() => this._openWS(), ms);
  }
  _sig(obj) { if (this.ws?.readyState===1) try { this.ws.send(JSON.stringify(obj)); } catch {} }

  _onSignal(msg) {
    if (!msg?.type) return;
    if (msg.type==='peer') {
      const fp = msg.fingerprint;
      if (fp && fp!==this.id.fingerprint && !this.peers.has(fp))
        setTimeout(() => { if (!this.peers.has(fp)) this._initiate(fp); }, Math.random()*150);
      return;
    }
    const from = msg.from; if (!from) return;
    if (msg.type==='offer')  { this._onOffer(from, msg.sdp, msg.nick); return; }
    if (msg.type==='answer') { this._onAnswer(from, msg.sdp); return; }
    if (msg.type==='ice')    { this._onICE(from, msg.candidate); return; }
  }

  _makePC(fp) {
    let pc; try { pc = new RTCPeerConnection({ iceServers:[] }); } catch (e) { this._log('PC:'+e.message,true); return null; }
    pc.onicecandidate = ({candidate}) => { if (candidate) this._sig({type:'ice',from:this.id.fingerprint,to:fp,candidate}); };
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState==='failed') try{pc.restartIce();}catch{} };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s==='connected') this._log(`P2P link up: ${fp.slice(0,8)}`);
      if (s==='failed'||s==='closed') {
        const ps=this.peers.get(fp), wasReady=ps?.ready, nick=ps?.nick||fp.slice(0,8);
        if (ps) ps._closing=true;
        this._closePeer(fp);
        if (wasReady) this.onPeerDisconnected?.(fp);
        this._log(`✗ ${nick} disconnected`, true);
        if (!this._dead) setTimeout(()=>{ if(!this.peers.has(fp)) this._initiate(fp); },3000);
      }
    };
    pc.ontrack = (e) => {
      const ps=this.peers.get(fp); if(!ps) return;
      if (!ps.remoteStream) ps.remoteStream = new MediaStream();
      if (!ps.remoteStream.getTracks().includes(e.track)) ps.remoteStream.addTrack(e.track);
      ps.onRemoteStream?.(ps.remoteStream);
      e.track.onunmute = () => ps.onRemoteStream?.(ps.remoteStream);
    };
    return pc;
  }

  _wireCtrl(fp, ch) {
    const ps=this.peers.get(fp); if(ps) ps.ctrl=ch;
    let closed=false;
    ch.onopen = () => {
      this._log(`ctrl ✓ ${fp.slice(0,8)}`);
      try { ch.send(JSON.stringify({type:'hello',fingerprint:this.id.fingerprint,nick:this.id.nickname})); } catch {}
      this._checkReady(fp);
    };
    ch.onmessage = (e) => {
      if (typeof e.data!=='string') return;
      let msg; try { msg=JSON.parse(e.data); } catch { return; }
      this._onPeerMsg(fp, msg);
    };
    ch.onerror  = () => { if(closed)return; const ps2=this.peers.get(fp); if(!ps2||ps2._closing)return; const s=ps2.pc?.connectionState; if(s==='failed'||s==='closed'||s==='disconnected')return; this._log(`ctrl channel error: ${fp.slice(0,8)}`,true); };
    ch.onclose  = () => { closed=true; };
  }

  _wireData(fp, ch) {
    const ps=this.peers.get(fp); if(ps) ps.data=ch;
    let closed=false;
    ch.binaryType='arraybuffer';
    ch.bufferedAmountLowThreshold = LOW_WATER;
    ch.onopen    = () => { this._log(`data ✓ ${fp.slice(0,8)}`); this._checkReady(fp); };
    ch.onmessage = (e) => { if(e.data instanceof ArrayBuffer) this.onBinaryChunk?.(fp,e.data); };
    ch.onerror   = () => { if(closed)return; const ps2=this.peers.get(fp); if(!ps2||ps2._closing)return; const s=ps2.pc?.connectionState; if(s==='failed'||s==='closed'||s==='disconnected')return; this._log(`data channel error: ${fp.slice(0,8)}`,true); };
    ch.onclose   = () => { closed=true; };
  }

  _checkReady(fp) {
    const ps=this.peers.get(fp); if(!ps||ps.ready)return;
    if (ps.ctrl?.readyState==='open' && ps.data?.readyState==='open') {
      ps.ready=true; this._log(`✓ ${ps.nick||fp.slice(0,8)} ready (P2P)`);
      this.onPeerConnected?.(fp, ps.nick);
    }
  }

  async _initiate(fp) {
    if (this.peers.has(fp)) return;
    this._log(`→ ${fp.slice(0,8)}`);
    const pc=this._makePC(fp); if(!pc) return;
    const ps = { pc, ctrl:null, data:null, ready:false, nick:null, remoteStream:null, localStream:null, onRemoteStream:null, _closing:false, _makingOffer:false, _mediaLock:false, _isPolite:this.id.fingerprint<fp };
    this.peers.set(fp, ps);
    const ctrl=pc.createDataChannel('ctrl',{ordered:true});
    const data=pc.createDataChannel('data',{ordered:true});
    this._wireCtrl(fp,ctrl); ps.ctrl=ctrl;
    this._wireData(fp,data); ps.data=data;
    pc.onnegotiationneeded = async () => {
      if (ps._mediaLock) return;
      try { ps._makingOffer=true; await pc.setLocalDescription(); this._sig({type:'offer',from:this.id.fingerprint,to:fp,sdp:pc.localDescription,nick:this.id.nickname}); }
      catch(e){ this._log('offer err:'+e.message,true); } finally { ps._makingOffer=false; }
    };
  }

  async _onOffer(fp, sdp, nick) {
    if (!sdp) return;
    let ps=this.peers.get(fp);
    if (!ps) {
      this._log(`← ${fp.slice(0,8)}`);
      const pc=this._makePC(fp); if(!pc) return;
      ps = { pc, ctrl:null, data:null, ready:false, nick:nick||null, remoteStream:null, localStream:null, onRemoteStream:null, _closing:false, _makingOffer:false, _mediaLock:false, _isPolite:this.id.fingerprint<fp };
      this.peers.set(fp, ps);
      pc.ondatachannel = (e) => { if(e.channel.label==='ctrl')this._wireCtrl(fp,e.channel); else if(e.channel.label==='data')this._wireData(fp,e.channel); };
    } else if (nick) { ps.nick=nick; }
    const collision=ps._makingOffer||ps.pc.signalingState!=='stable';
    if (collision) {
      if (!ps._isPolite) return;
      try { await ps.pc.setLocalDescription({type:'rollback'}); }
      catch { this._closePeer(fp); if(!this._dead) setTimeout(()=>this._initiate(fp),200); return; }
    }
    try {
      await ps.pc.setRemoteDescription(sdp); await ps.pc.setLocalDescription();
      this._sig({type:'answer',from:this.id.fingerprint,to:fp,sdp:ps.pc.localDescription});
    } catch(e){ this._log('answer err:'+e.message,true); this._closePeer(fp); }
  }

  async _onAnswer(fp,sdp){ const ps=this.peers.get(fp); if(!ps||!sdp)return; try{await ps.pc.setRemoteDescription(sdp);}catch(e){this._log('setRemote:'+e.message,true);} }
  async _onICE(fp,candidate){ const ps=this.peers.get(fp); if(!ps||!candidate)return; try{await ps.pc.addIceCandidate(candidate);}catch(e){if(!String(e).includes('701')&&!String(e).includes('closed'))this._log('ICE:'+e.message,true);} }

  _onPeerMsg(fp, msg) {
    if (!msg?.type) return;
    if (msg.type==='hello') { const ps=this.peers.get(fp); if(ps&&msg.nick)ps.nick=msg.nick; }
    if (msg.type==='answer-reneg') { this._applyRenegAnswer(fp,msg.sdp); return; }
    this.onMessage?.(fp, msg);
  }
  async _applyRenegAnswer(fp,sdp){ const ps=this.peers.get(fp); if(!ps||!sdp)return; try{await ps.pc.setRemoteDescription(sdp);}catch(e){this._log('reneg ans:'+e.message,true);} }

  // ── Public ─────────────────────────────────────────────────────────────────
  sendCtrl(fp,msg){ const ps=this.peers.get(fp); if(ps?.ctrl?.readyState==='open'){try{ps.ctrl.send(JSON.stringify(msg));return true;}catch{}} return false; }
  sendBinary(fp,buf){ const ps=this.peers.get(fp); if(ps?.data?.readyState==='open'){try{ps.data.send(buf);return true;}catch{}} return false; }

  waitForBuffer(fp) {
    return new Promise(res => {
      const ps=this.peers.get(fp);
      if (!ps?.data||ps.data.readyState!=='open'||ps.data.bufferedAmount<HIGH_WATER){res();return;}
      const prev=ps.data.onbufferedamountlow;
      const t=setTimeout(()=>{ps.data.onbufferedamountlow=prev;res();},5000);
      ps.data.onbufferedamountlow=()=>{clearTimeout(t);ps.data.onbufferedamountlow=prev;res();};
    });
  }

  isReady(fp){ const ps=this.peers.get(fp); return !!(ps?.ready&&ps.ctrl?.readyState==='open'&&ps.data?.readyState==='open'); }
  getConnectedPeers(){ return [...this.peers.entries()].filter(([,ps])=>ps.ready).map(([fp])=>fp); }
  getPeerNick(fp){ return this.peers.get(fp)?.nick||fp?.slice(0,8)||'?'; }

  // ── Media ──────────────────────────────────────────────────────────────────
  async getLocalStream(video=false) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},
        video:video?{width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}}:false,
      });
    } catch(e) {
      if (e.name==='NotAllowedError'||e.name==='PermissionDeniedError') throw new Error('permission-denied:'+(video?'camera/mic':'microphone'));
      if (e.name==='NotFoundError') throw new Error('no-device:'+(video?'camera/mic':'microphone'));
      throw e;
    }
  }

  // isCircle=true → receiver knows this offer-reneg is for a circle call
  async offerWithStream(fp, stream, isCircle=false) {
    const ps=this.peers.get(fp); if(!ps) throw new Error('Peer not connected');
    ps.localStream?.getTracks().forEach(t=>t.stop());
    ps.pc.getSenders().forEach(s=>{try{ps.pc.removeTrack(s);}catch{}});
    ps.localStream=stream; ps._mediaLock=true;
    try {
      stream.getTracks().forEach(t=>ps.pc.addTrack(t,stream));
      const offer=await ps.pc.createOffer(); await ps.pc.setLocalDescription(offer);
      this.sendCtrl(fp,{type:'offer-reneg',sdp:ps.pc.localDescription,callType:stream.getVideoTracks().length>0?'video':'audio',circle:isCircle});
    } finally { ps._mediaLock=false; }
  }

  async answerWithStream(fp, remoteSdp, stream) {
    const ps=this.peers.get(fp); if(!ps) throw new Error('Peer not found');
    ps.localStream?.getTracks().forEach(t=>t.stop());
    ps.pc.getSenders().forEach(s=>{try{ps.pc.removeTrack(s);}catch{}});
    ps.localStream=stream; ps._mediaLock=true;
    try {
      stream.getTracks().forEach(t=>ps.pc.addTrack(t,stream));
      await ps.pc.setRemoteDescription(remoteSdp);
      const answer=await ps.pc.createAnswer(); await ps.pc.setLocalDescription(answer);
      this.sendCtrl(fp,{type:'answer-reneg',sdp:ps.pc.localDescription});
    } finally { ps._mediaLock=false; }
  }

  async stopMedia(fp) {
    const ps=this.peers.get(fp); if(!ps)return;
    ps.localStream?.getTracks().forEach(t=>t.stop());
    ps.pc.getSenders().forEach(s=>{try{ps.pc.removeTrack(s);}catch{}});
    ps.localStream=null; this.sendCtrl(fp,{type:'call-end'});
  }

  setRemoteStreamHandler(fp,fn){ const ps=this.peers.get(fp); if(!ps)return; ps.onRemoteStream=fn; if(ps.remoteStream)fn(ps.remoteStream); }

  // Get WebRTC stats for nerdy call overlay
  async getStats(fp) {
    const ps=this.peers.get(fp); if(!ps) return null;
    try {
      const stats={}; const report=await ps.pc.getStats();
      report.forEach(r=>{
        if (r.type==='inbound-rtp'&&r.kind==='video') {
          stats.videoWidth=r.frameWidth; stats.videoHeight=r.frameHeight;
          stats.fps=Math.round(r.framesPerSecond||0);
          stats.videoKbps=Math.round((r.bytesReceived||0)*8/1000/(r.timestamp/1000||1));
        }
        if (r.type==='inbound-rtp'&&r.kind==='audio') {
          stats.audioKbps=Math.round((r.bytesReceived||0)*8/1000/(r.timestamp/1000||1));
        }
        if (r.type==='candidate-pair'&&r.nominated) {
          stats.rttMs=Math.round((r.currentRoundTripTime||0)*1000);
          stats.bytesSent=r.bytesSent||0; stats.bytesRecv=r.bytesReceived||0;
        }
      });
      return stats;
    } catch { return null; }
  }

  _closePeer(fp) {
    const ps=this.peers.get(fp); if(!ps)return;
    ps._closing=true; ps.localStream?.getTracks().forEach(t=>t.stop());
    try{ps.ctrl?.close();}catch{} try{ps.data?.close();}catch{} try{ps.pc.close();}catch{}
    this.peers.delete(fp);
  }
  destroy() {
    this._dead=true; clearTimeout(this._timer); clearInterval(this._ping);
    try{this.ws?.close();}catch{}
    for (const fp of [...this.peers.keys()]) this._closePeer(fp);
  }
  _log(text,isErr=false){ this.onLog?.(text,isErr); (isErr?console.warn:console.log)('[TQ]',text); }
}
