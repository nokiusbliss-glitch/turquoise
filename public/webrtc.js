/**
 * webrtc.js — Turquoise v7.1
 *
 * Multi-layer transport stack:
 *   Layer 1 : WebRTC DataChannel  (direct P2P)
 *   Layer 2 : STUN traversal
 *   Layer 3 : WebSocket relay fallback
 */

import { TQLog } from './tqlog.js';

let _ice = [
  { urls: ['stun:stun.l.google.com:19302','stun:stun2.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.stunprotocol.org:3478' }
];

const LOW     = 64 * 1024;
const HIGH    = 1024 * 1024;
const HB_IV   = 8000;
const HB_DL   = 6000;
const HB_MAX  = 3;
const RB_BASE = 2000;
const RB_MAX  = 30000;

const FILE='webrtc';

const jit=(b,f=0.25)=>b*(1-f/2+Math.random()*f);

const ab2b64 = buf => {
  const u=new Uint8Array(buf);
  let s='';
  for(let i=0;i<u.length;i++) s+=String.fromCharCode(u[i]);
  return btoa(s);
};

const b642ab = s => {
  const b=atob(s);
  const u=new Uint8Array(b.length);
  for(let i=0;i<b.length;i++) u[i]=b.charCodeAt(i);
  return u.buffer;
};

export class TurquoiseNetwork {

constructor(identity){
  if(!identity?.fingerprint) throw new Error('identity.fingerprint required');

  this.id=identity;
  this.peers=new Map();

  this.ws=null;
  this._wsURL=null;
  this._retry=0;
  this._wsOK=false;
  this._dead=false;

  this._known=new Map();
  this._initiating=new Set();

  this._hbTimer=null;
  this._ping=null;

  this._log=TQLog.get();

  this.onPeerConnected=null;
  this.onPeerDisconnected=null;
  this.onMessage=null;
  this.onBinaryChunk=null;
  this.onRemoteStream=null;      // NEW callback

  this.onLog=null;
  this.onSignalingConnected=null;
  this.onSignalingDisconnected=null;
}

connect(url){
  this._wsURL=url;
  this._dead=false;
  this._retry=0;

  if(this.ws?.readyState<=WebSocket.OPEN){
    try{this.ws.close()}catch{}
  }

  this._openWS();
  this._startHB();
}

_openWS(){
  if(this._dead)return;

  let ws;
  try{ws=new WebSocket(this._wsURL)}catch{
    this._schedWS();
    return;
  }

  this.ws=ws;

  ws.onopen=()=>{
    this._retry=0;
    this._wsOK=true;

    this._log.info(FILE,'ws','signaling connected ✓');

    try{
      ws.send(JSON.stringify({
        type:'announce',
        from:this.id.fingerprint,
        nick:this.id.nickname
      }));
    }catch{}

    this.onSignalingConnected?.();
    this._reconnectKnown();

    clearInterval(this._ping);
    this._ping=setInterval(()=>{
      if(ws.readyState===WebSocket.OPEN){
        try{ws.send(JSON.stringify({type:'ping'}))}catch{}
      }
    },25000);
  };

  ws.onmessage=e=>{
    try{this._onSig(JSON.parse(e.data))}catch{}
  };

  ws.onclose=e=>{
    this._wsOK=false;
    clearInterval(this._ping);

    if(this._dead)return;

    this._log.warn(FILE,'ws',`closed code=${e.code}`);

    this.onSignalingDisconnected?.();
    this._schedWS();
  };
}

_schedWS(){
  if(this._dead)return;
  const d=jit(Math.min(RB_MAX,RB_BASE*Math.pow(1.618,Math.min(this._retry++,8))));
  setTimeout(()=>this._openWS(),d);
}

_sig(obj){
  if(this.ws?.readyState===WebSocket.OPEN){
    try{
      this.ws.send(JSON.stringify(obj));
      return;
    }catch{}
  }

  const target=obj.to;
  if(!target)return;

  for(const[,ps]of this.peers){
    if(ps.ctrl?.readyState==='open'){
      try{
        ps.ctrl.send(JSON.stringify({
          type:'p2p-relay',
          target,
          payload:obj
        }));
        return;
      }catch{}
    }
  }
}

_onSig(msg){
  if(!msg?.type)return;

  const {type,from}=msg;

  if(type==='ice-config'&&Array.isArray(msg.iceServers)){
    _ice=msg.iceServers;
    return;
  }

  if(type==='peer'){
    const fp=msg.fingerprint;
    if(!fp||fp===this.id.fingerprint)return;

    const k=this._known.get(fp)||{retry:0,timer:null};
    k.nick=msg.nick||fp.slice(0,8);
    this._known.set(fp,k);

    if(!this.peers.has(fp)) this._initiate(fp,k.nick);
    return;
  }

  if(type==='pong')return;
  if(!from||from===this.id.fingerprint)return;

  switch(type){

    case 'offer':
      this._onOffer(msg);
      break;

    case 'answer':
      this._onAnswer(msg);
      break;

    case 'ice':
      this._onIce(msg);
      break;

    case 'offer-reneg':
      this._onOffer(msg,true);
      this.onMessage?.(from,msg);
      break;

    case 'answer-reneg':
      this._onAnswer(msg);
      this.onMessage?.(from,msg);
      break;

    default:
      this.onMessage?.(from,msg);
  }
}

_initiate(fp,nick){
  if(this._initiating.has(fp)||this.peers.has(fp))return;

  this._initiating.add(fp);

  const ps=this._makePS(fp,nick);
  this.peers.set(fp,ps);

  ps.ctrl=this._mkDC(fp,ps,'ctrl',{ordered:true,negotiated:true,id:0});
  ps.data=this._mkDC(fp,ps,'data',{ordered:false,maxRetransmits:0,negotiated:true,id:1});

  ps.pc.onnegotiationneeded=async()=>{
    if(ps.makingOffer)return;

    try{
      ps.makingOffer=true;

      await ps.pc.setLocalDescription();

      this._sig({
        type:'offer',
        sdp:ps.pc.localDescription.sdp,
        to:fp,
        from:this.id.fingerprint
      });

    }catch(e){
      this._log.warn(FILE,'neg',e.message);
    }finally{
      ps.makingOffer=false;
    }
  };

  this._initiating.delete(fp);
}

_makePS(fp,nick){

  const pc=new RTCPeerConnection({
    iceServers:_ice,
    iceCandidatePoolSize:4,
    bundlePolicy:'max-bundle'
  });

  const ps={
    pc,
    nick:nick||fp.slice(0,8),
    ready:false,
    ctrl:null,
    data:null,
    stream:null,
    makingOffer:false,
    ignoreOffer:false,
    pendingIce:[],
    hbMiss:0,
    hbTimer:null,
    _resolve:null,
    _reject:null
  };

  pc.onicecandidate=e=>{
    if(e.candidate){
      this._sig({
        type:'ice',
        ice:e.candidate.toJSON(),
        to:fp,
        from:this.id.fingerprint
      });
    }
  };

  pc.onconnectionstatechange=()=>{
    const s=pc.connectionState;

    if(s==='connected'&&!ps.ready){
      ps.ready=true;
      this._onReady(fp,ps);
    }

    if(s==='disconnected'){
      ps.ready=false;
      try{pc.restartIce()}catch{}
      setTimeout(()=>{
        if(ps.pc.connectionState==='disconnected')
          this._teardown(fp,'timeout');
      },8000);
    }

    if(s==='failed')this._teardown(fp,'failed');
    if(s==='closed')this._teardown(fp,'closed');
  };

  pc.ondatachannel=e=>{
    if(e.channel.label==='ctrl')
      ps.ctrl=this._mkDC(fp,ps,'ctrl',null,e.channel);

    if(e.channel.label==='data')
      ps.data=this._mkDC(fp,ps,'data',null,e.channel);
  };

  pc.addEventListener('track',e=>{
    const stream=e.streams[0]||null;
    ps.stream=stream;

    if(stream) this.onRemoteStream?.(fp,stream);
  });

  return ps;
}

_mkDC(fp,ps,label,init,existing){

  const dc=existing||ps.pc.createDataChannel(label,init);

  dc.bufferedAmountLowThreshold=LOW;

  if(label==='ctrl'){

    dc.onopen=()=>{
      if(!ps.ready){
        ps.ready=true;
        this._onReady(fp,ps);
      }
    };

    dc.onmessage=e=>this._onCtrl(fp,e.data);

  }else{

    dc.onmessage=e=>{
      const d=e.data;

      if(d instanceof ArrayBuffer){
        this.onBinaryChunk?.(fp,d);
        return;
      }

      if(d instanceof Blob){
        d.arrayBuffer().then(b=>this.onBinaryChunk?.(fp,b));
      }
    };

    dc.onbufferedamountlow=()=>{
      ps._resolve?.();
      ps._resolve=null;
      ps._reject=null;
    };

  }

  return dc;
}

_onReady(fp,ps){
  this.onPeerConnected?.(fp,ps.nick);
}

_teardown(fp){
  const ps=this.peers.get(fp);
  if(!ps)return;

  this.peers.delete(fp);

  try{ps.pc.close()}catch{}

  if(ps.ready){
    this.onPeerDisconnected?.(fp,ps.nick);
  }
}

async _onOffer(msg,reneg=false){

  const {from:fp,sdp}=msg;
  if(!fp||!sdp)return;

  let ps=this.peers.get(fp);

  if(!ps){
    ps=this._makePS(fp);
    this.peers.set(fp,ps);
  }

  try{
    await ps.pc.setRemoteDescription({type:'offer',sdp});
    await ps.pc.setLocalDescription();

    this._sig({
      type:reneg?'answer-reneg':'answer',
      sdp:ps.pc.localDescription.sdp,
      to:fp,
      from:this.id.fingerprint
    });

  }catch{}
}

async _onAnswer(msg){
  const ps=this.peers.get(msg.from);
  if(!ps)return;

  try{
    await ps.pc.setRemoteDescription({
      type:'answer',
      sdp:msg.sdp
    });
  }catch{}
}

async _onIce(msg){

  const ps=this.peers.get(msg.from);
  if(!ps)return;

  if(ps.pc.remoteDescription){
    try{
      await ps.pc.addIceCandidate(msg.ice);
    }catch{}
  }else{
    ps.pendingIce.push(msg.ice);
  }
}

_onCtrl(fp,text){

  let msg;
  try{msg=JSON.parse(text)}catch{return}

  if(msg.type==='bin-relay'){
    try{
      this.onBinaryChunk?.(fp,b642ab(msg.data));
    }catch{}
    return;
  }

  this.onMessage?.(fp,msg);
}

sendCtrl(fp,msg){
  const ps=this.peers.get(fp);

  if(ps?.ctrl?.readyState==='open'){
    try{
      ps.ctrl.send(JSON.stringify(msg));
      return true;
    }catch{}
  }

  if(this.ws?.readyState===WebSocket.OPEN){
    try{
      this.ws.send(JSON.stringify({...msg,to:fp,_relay:true}));
      return true;
    }catch{}
  }

  return false;
}

sendBinary(fp,buf){

  const ps=this.peers.get(fp);

  if(ps?.data?.readyState==='open'){
    if(ps.data.bufferedAmount>HIGH)return false;

    try{
      ps.data.send(buf);
      return true;
    }catch{}
  }

  if(this.ws?.readyState===WebSocket.OPEN){
    try{
      this.ws.send(JSON.stringify({
        type:'bin-relay',
        to:fp,
        data:ab2b64(buf)
      }));
      return true;
    }catch{}
  }

  return false;
}

waitForBuffer(fp){

  const ps=this.peers.get(fp);

  if(!ps?.data||ps.data.bufferedAmount<=HIGH)
    return Promise.resolve();

  return new Promise((res,rej)=>{
    ps._resolve=res;
    ps._reject=rej;
  });
}

async offerWithStream(fp,stream){

  const ps=this.peers.get(fp);
  if(!ps)return;

  for(const track of stream.getTracks()){
    const exists=ps.pc.getSenders().some(s=>s.track===track);
    if(!exists) ps.pc.addTrack(track,stream);
  }

  const offer=await ps.pc.createOffer({
    offerToReceiveAudio:true,
    offerToReceiveVideo:true
  });

  await ps.pc.setLocalDescription(offer);

  this._sig({
    type:'offer-reneg',
    sdp:ps.pc.localDescription.sdp,
    to:fp,
    from:this.id.fingerprint
  });
}

async answerWithStream(fp,stream){

  const ps=this.peers.get(fp);
  if(!ps)return;

  try{

    for(const track of stream.getTracks()){
      const exists=ps.pc.getSenders().some(s=>s.track===track);
      if(!exists) ps.pc.addTrack(track,stream);
    }

    const answer=await ps.pc.createAnswer();
    await ps.pc.setLocalDescription(answer);

    this._sig({
      type:'answer-reneg',
      sdp:ps.pc.localDescription.sdp,
      to:fp,
      from:this.id.fingerprint
    });

  }catch(e){
    this._log.warn(FILE,'answerStream',e.message);
  }
}

stopMedia(fp){

  const ps=this.peers.get(fp);
  if(!ps?.stream)return;

  const tracks=ps.stream.getTracks();

  tracks.forEach(t=>{
    t.stop();

    try{
      const s=ps.pc.getSenders().find(x=>x.track===t);
      if(s) ps.pc.removeTrack(s);
    }catch{}
  });

  ps.stream=null;
}

getConnectedPeers(){
  return [...this.peers.entries()]
  .filter(([,ps])=>ps.ready)
  .map(([fp])=>fp);
}

connTier(fp){

  const ps=this.peers.get(fp);

  if(!ps?.ready) return 'disconnected';

  if(ps.ctrl?.readyState==='open') return 'p2p';

  if(this._wsOK) return 'ws-relay';

  return 'disconnected';
}

destroy(){

  if(this._dead)return;

  this._dead=true;

  clearInterval(this._hbTimer);
  clearInterval(this._ping);

  for(const fp of [...this.peers.keys()])
    this._teardown(fp);

  try{this.ws?.close(1000)}catch{}

  this.ws=null;
}

}