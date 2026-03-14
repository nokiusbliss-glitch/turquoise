/* Turquoise v7 UI Controller
   Handles UI, messaging, calls, files, circles
*/

import { loadPeers, savePeer, loadMessages, saveMessage, clearAllData } from './messages.js'
import { resetIdentity } from './identity.js'
import { FileTransferEngine, fmtBytes, fmtRate, fmtEta } from './files.js'
import { WebRTCNetwork } from './webrtc.js'


/* ------------------ CONSTANTS ------------------ */

const MSG_ROT_MAX = 0.35
const FILE_URL_TTL = 600000
const MAX_INPUT_ROWS = 6

const $ = id => document.getElementById(id)



/* ------------------ UTILITIES ------------------ */

function randomRotation(){
  return (Math.random()*2-1)*MSG_ROT_MAX
}

function autoGrowTextarea(el){

  el.style.height='auto'

  const rows = Math.min(
    MAX_INPUT_ROWS,
    Math.floor(el.scrollHeight / 20)
  )

  el.style.height = (rows*20+6)+'px'
}



/* ------------------ APP CLASS ------------------ */

export class TurquoiseApp{

constructor(){

/* ---------- CORE ---------- */

this.net = new WebRTCNetwork()

this.fileEngine = new FileTransferEngine(this.net)

this.peers = new Map()

this.messages = new Map()

this._fileUrls = new Map()

this.call = null

this.circleCall = null

this.activePeer = null

this._audioEl = Object.assign(
document.createElement('audio'),
{autoplay:true,playsInline:true}
)

document.body.appendChild(this._audioEl)


/* ---------- DOM ---------- */

this.chatArea = $('chat-area')
this.peerList = $('peer-list')
this.statusLine = $('status-line')
this.msgInput = $('msg-input')
this.sendBtn = $('send-btn')

this.plusBtn = $('plus-btn')
this.plusMenu = $('plus-menu')

this.callPanel = $('call-panel')


/* ---------- INIT ---------- */

this._initIdentity()

this._initNetwork()

this._bindUI()

this._loadPeers()

this._status('ready','ok')

}



/* ------------------ IDENTITY ------------------ */

_initIdentity(){

try{

const stored = localStorage.getItem('tq-nick')

if(stored){
this.nick = stored
}
else{
this.nick = 'node-'+Math.random().toString(36).slice(2,6)
localStorage.setItem('tq-nick',this.nick)
}

}catch(e){

this.nick = 'node'

}

}



/* ------------------ NETWORK ------------------ */

_initNetwork(){

this.net.onPeerConnected = fp=>{
this._onPeerConnected(fp)
}

this.net.onPeerDisconnected = fp=>{
this._onPeerDisconnected(fp)
}

this.net.onMessage = (fp,msg)=>{
this._onMessage(fp,msg)
}

this.net.onRemoteStream = (fp,stream)=>{
this._onRemoteStream(fp,stream)
}

this.net.onSignalingConnected = ()=>{
this._status('signaling connected','ok')
}

this.net.onSignalingDisconnected = ()=>{
this._status('signaling lost','warn')
}

}



/* ------------------ UI EVENTS ------------------ */

_bindUI(){

/* send message */

this.sendBtn.onclick = ()=>{
this._sendMessage()
}

/* enter key */

this.msgInput.addEventListener('keydown',e=>{

if(e.key==='Enter' && !e.shiftKey){

e.preventDefault()

this._sendMessage()

}

})

/* textarea grow */

this.msgInput.addEventListener('input',()=>{
autoGrowTextarea(this.msgInput)
})


/* plus menu */

this.plusBtn.onclick = ()=>{
this.plusMenu.style.display =
this.plusMenu.style.display==='flex'
?'none':'flex'
}

document.addEventListener('click',e=>{
if(!this.plusMenu.contains(e.target) && e.target!==this.plusBtn){
this.plusMenu.style.display='none'
}
})


/* file send */

$('send-file').onclick=()=>{
this._pickFile()
}

$('send-folder').onclick=()=>{
this._pickFolder()
}

$('start-call').onclick=()=>{
this._startCall()
}

}



/* ------------------ PEERS ------------------ */

_loadPeers(){

const peers = loadPeers()

for(const p of peers){

this.peers.set(p.fp,p)

this._renderPeer(p)

}

}



_onPeerConnected(fp){

if(!this.peers.has(fp)){

const peer={
fp,
nick:fp.slice(0,8)
}

this.peers.set(fp,peer)

savePeer(peer)

this._renderPeer(peer)

}

this._status('peer '+fp.slice(0,6)+' connected','ok')

}



_onPeerDisconnected(fp){

this._status('peer '+fp.slice(0,6)+' disconnected','warn')

}



/* ------------------ RENDER PEERS ------------------ */

_renderPeer(peer){

const el=document.createElement('div')

el.className='peer'

el.textContent=peer.nick

el.onclick=()=>{

this.activePeer=peer.fp

this._openChat(peer.fp)

}

this.peerList.appendChild(el)

}



/* ------------------ MESSAGES ------------------ */

_sendMessage(){

const text=this.msgInput.value.trim()

if(!text) return

if(!this.activePeer) return

const msg={
type:'text',
text,
ts:Date.now(),
from:'me'
}

this._appendMsg(this.activePeer,msg)

this.net.send(this.activePeer,msg)

saveMessage(this.activePeer,msg)

this.msgInput.value=''
autoGrowTextarea(this.msgInput)

}



_openChat(fp){

this.chatArea.innerHTML=''

const msgs=loadMessages(fp)||[]

for(const m of msgs){
this._appendMsg(fp,m,false)
}

}



/* ------------------ MESSAGE UI ------------------ */

_appendMsg(fp,msg,save=true){

const el=document.createElement('div')

el.className='msg'

if(msg.from==='me') el.classList.add('self')

el.textContent=msg.text || ''

const rot=randomRotation()

el.style.transform=`rotate(${rot.toFixed(2)}deg)`

this.chatArea.appendChild(el)

this.chatArea.scrollTop=this.chatArea.scrollHeight

if(save) saveMessage(fp,msg)

}



/* ------------------ FILE PICKERS ------------------ */

_pickFile(){

const input=document.createElement('input')

input.type='file'

input.onchange=e=>{
const file=e.target.files[0]
if(file) this._sendFile(file)
}

input.click()

}



_pickFolder(){

const input=document.createElement('input')

input.type='file'

input.webkitdirectory=true

input.onchange=e=>{
const files=[...e.target.files]
if(files.length) this._sendFolder(files)
}

input.click()

}



/* ------------------ STATUS ------------------ */

_status(msg,type='info'){

this.statusLine.textContent=msg

this.statusLine.dataset.type=type

}

}

/* ------------------ FILE SENDING ------------------ */

_sendFile(file){

if(!this.activePeer){
this._status('select a peer first','warn')
return
}

const transfer=this.fileEngine.sendFile(
this.activePeer,
file
)

this._renderFileTransfer(
this.activePeer,
transfer,
file.name,
file.size
)

}



/* ------------------ SEND FOLDER ------------------ */

_sendFolder(files){

if(!this.activePeer){
this._status('select a peer first','warn')
return
}

const folderName =
files[0].webkitRelativePath.split('/')[0]

const transfer =
this.fileEngine.sendFolder(
this.activePeer,
files
)

this._renderFolderTransfer(
this.activePeer,
transfer,
folderName,
files.length
)

}



/* ------------------ FILE TRANSFER UI ------------------ */

_renderFileTransfer(fp,transfer,name,size){

const card=document.createElement('div')

card.className='file-card'

const title=document.createElement('div')
title.textContent=name

const progress=document.createElement('div')
progress.style.height='6px'
progress.style.background='#003b33'
progress.style.marginTop='6px'

const bar=document.createElement('div')
bar.style.height='100%'
bar.style.width='0%'
bar.style.background='#00ffd0'

progress.appendChild(bar)

const stats=document.createElement('div')
stats.style.fontSize='11px'
stats.style.marginTop='4px'

card.appendChild(title)
card.appendChild(progress)
card.appendChild(stats)

this.chatArea.appendChild(card)

this.chatArea.scrollTop=this.chatArea.scrollHeight


transfer.onProgress=p=>{

bar.style.width=(p.percent*100)+'%'

stats.textContent=
fmtBytes(p.sent)+' / '+fmtBytes(size)+' · '+
fmtRate(p.rate)+' · '+
fmtEta(p.eta)

}


transfer.onComplete=fileInfo=>{

bar.style.width='100%'

stats.textContent='completed'

this._fileUrls.set(
fileInfo.fileId,
fileInfo
)

this._addDownloadButton(card,fileInfo)

}


transfer.onError=e=>{

stats.textContent='transfer failed'

this._status(e.message,'error')

}

}



/* ------------------ FOLDER TRANSFER UI ------------------ */

_renderFolderTransfer(fp,transfer,name,count){

const card=document.createElement('div')

card.className='folder-card'

const title=document.createElement('div')
title.textContent=name+' ('+count+' files)'

const progress=document.createElement('div')
progress.style.height='6px'
progress.style.background='#003b33'
progress.style.marginTop='6px'

const bar=document.createElement('div')
bar.style.height='100%'
bar.style.width='0%'
bar.style.background='#00ffd0'

progress.appendChild(bar)

const stats=document.createElement('div')
stats.style.fontSize='11px'
stats.style.marginTop='4px'

card.appendChild(title)
card.appendChild(progress)
card.appendChild(stats)

this.chatArea.appendChild(card)

this.chatArea.scrollTop=this.chatArea.scrollHeight


transfer.onProgress=p=>{

bar.style.width=(p.percent*100)+'%'

stats.textContent=
p.filesDone+' / '+count+' files'

}


transfer.onComplete=folderInfo=>{

bar.style.width='100%'

stats.textContent='folder ready'

this._addFolderDownload(card,folderInfo)

}


transfer.onError=e=>{

stats.textContent='transfer failed'

this._status(e.message,'error')

}

}



/* ------------------ RECEIVE FILE ------------------ */

_onIncomingFile(fp,fileInfo){

this._fileUrls.set(
fileInfo.fileId,
fileInfo
)

const card=document.createElement('div')

card.className='file-card'

const name=document.createElement('div')
name.textContent=fileInfo.name

const btn=document.createElement('button')
btn.textContent='download'

btn.onclick=()=>{
this._downloadFile(fileInfo)
}

card.appendChild(name)
card.appendChild(btn)

this.chatArea.appendChild(card)

}



/* ------------------ DOWNLOAD FILE ------------------ */

_downloadFile(info){

const a=document.createElement('a')

a.href=info.url
a.download=info.name

document.body.appendChild(a)

a.click()

a.remove()

setTimeout(()=>{

const stored=this._fileUrls.get(info.fileId)

if(stored && stored.url===info.url){

URL.revokeObjectURL(info.url)

this._fileUrls.delete(info.fileId)

}

},FILE_URL_TTL)

}



/* ------------------ DOWNLOAD BUTTON ------------------ */

_addDownloadButton(card,info){

const btn=document.createElement('button')

btn.textContent='download'

btn.onclick=()=>{
this._downloadFile(info)
}

card.appendChild(btn)

}



/* ------------------ FOLDER DOWNLOAD ------------------ */

_addFolderDownload(card,folderInfo){

const btn=document.createElement('button')

btn.textContent='download folder'

btn.onclick=()=>{

for(const file of folderInfo.files){

this._downloadFile(file)

}

}

card.appendChild(btn)

}

/* ------------------ START CALL ------------------ */

async _startCall(){

if(!this.activePeer){
this._status('select peer first','warn')
return
}

if(this.call){
this._status('call already active','warn')
return
}

try{

const stream = await navigator.mediaDevices.getUserMedia({
audio:true,
video:true
})

this.call={
fp:this.activePeer,
type:'video',
phase:'calling',
localStream:stream,
remoteStream:null
}

await this.net.offerWithStream(
this.activePeer,
stream
)

this._attachRemote1to1(this.activePeer)

this._renderCallPanel()

this._status('calling '+this.activePeer.slice(0,6),'info')

}catch(e){

this._status('camera/mic denied','error')

}

}



/* ------------------ REMOTE STREAM HANDLER ------------------ */

_onRemoteStream(fp,stream){

if(!stream) return

this._audioEl.srcObject=stream

this._audioEl.play().catch(()=>{})

if(this.call && this.call.fp===fp){

this.call.remoteStream=stream

this.call.phase='active'

this._renderCallPanel()

this._startStatsPolling(fp)

this._status(
'call active · '+fp.slice(0,6),
'ok'
)

}

}



/* ------------------ ATTACH REMOTE ------------------ */

_attachRemote1to1(fp){

const ps=this.net.peers.get(fp)

if(!ps) return

if(ps._tqTrackBound) return

ps.pc.addEventListener('track',e=>{

const stream=e.streams[0]

if(stream){

this._onRemoteStream(fp,stream)

}

})

ps._tqTrackBound=true

}



/* ------------------ INCOMING MESSAGE HANDLER ------------------ */

_onMessage(fp,msg){

switch(msg.type){

case 'text':

this._appendMsg(fp,msg)

break


case 'call-offer':

this._onIncomingCall(fp,msg)

break


case 'call-answer':

this._onCallAnswered(fp,msg)

break


case 'call-end':

this._endCall()

break


case 'file-meta':

this._onIncomingFile(fp,msg)

break

}

}



/* ------------------ INCOMING CALL ------------------ */

async _onIncomingCall(fp,msg){

if(this.call){
return
}

const accept = confirm(
'Incoming call from '+fp.slice(0,6)
)

if(!accept) return

try{

const stream = await navigator.mediaDevices.getUserMedia({
audio:true,
video:true
})

this.call={
fp,
type:'video',
phase:'answering',
localStream:stream,
remoteStream:null
}

await this.net.answerWithStream(
fp,
stream
)

this._attachRemote1to1(fp)

this._renderCallPanel()

}catch(e){

this._status('cannot answer call','error')

}

}



/* ------------------ CALL ANSWERED ------------------ */

_onCallAnswered(fp,msg){

if(!this.call) return

if(this.call.fp!==fp) return

this.call.phase='connecting'

this._status('connecting…','info')

}



/* ------------------ END CALL ------------------ */

_endCall(){

if(!this.call) return

if(this.call.localStream){

for(const t of this.call.localStream.getTracks()){
t.stop()
}

}

this.call=null

this._stopStatsPolling()

this._renderCallPanel()

this._status('call ended','warn')

}



/* ------------------ CIRCLE CALL START ------------------ */

async _startCircleCall(peers){

if(this.circleCall) return

try{

const stream = await navigator.mediaDevices.getUserMedia({
audio:true,
video:true
})

this.circleCall={
peers,
localStream:stream,
remoteStreams:new Map(),
audioEls:new Map(),
phase:'calling'
}

for(const fp of peers){

await this.net.offerWithStream(fp,stream)

this._attachCircleRemote(fp)

}

this._renderCircleCallPanel()

}catch(e){

this._status('circle call failed','error')

}

}



/* ------------------ CIRCLE REMOTE STREAM ------------------ */

_attachCircleRemote(fp){

const ps=this.net.peers.get(fp)

if(!ps) return

if(ps._circleTrackBound) return

ps.pc.addEventListener('track',e=>{

const stream=e.streams[0]

if(!stream || !this.circleCall) return

this.circleCall.remoteStreams.set(fp,stream)

let audio=this.circleCall.audioEls.get(fp)

if(!audio){

audio=document.createElement('audio')

audio.autoplay=true
audio.playsInline=true
audio.style.display='none'

document.body.appendChild(audio)

this.circleCall.audioEls.set(fp,audio)

}

audio.srcObject=stream

audio.play().catch(()=>{})

this.circleCall.phase='active'

this._renderCircleCallPanel()

})

ps._circleTrackBound=true

}



/* ------------------ END CIRCLE CALL ------------------ */

_endCircleCall(){

if(!this.circleCall) return

for(const t of this.circleCall.localStream.getTracks()){
t.stop()
}

for(const a of this.circleCall.audioEls.values()){
a.remove()
}

this.circleCall=null

this._renderCircleCallPanel()

this._status('circle call ended','warn')

}

/* ------------------ CALL PANEL RENDER ------------------ */

_renderCallPanel(){

const panel=this.callPanel

if(!panel) return

panel.innerHTML=''

if(!this.call){
panel.style.display='none'
return
}

panel.style.display='flex'

const vids=document.createElement('div')
vids.id='call-videos'
vids.style.display='flex'
vids.style.flexWrap='wrap'
vids.style.gap='10px'

panel.appendChild(vids)



/* ---------- LOCAL VIDEO ---------- */

if(this.call.localStream){

const tile=document.createElement('div')
tile.className='call-video-tile'

const v=document.createElement('video')

v.autoplay=true
v.muted=true
v.playsInline=true

v.srcObject=this.call.localStream

tile.appendChild(v)

vids.appendChild(tile)

}



/* ---------- REMOTE VIDEO ---------- */

if(this.call.remoteStream){

const tile=document.createElement('div')
tile.className='call-video-tile'

const v=document.createElement('video')

v.autoplay=true
v.playsInline=true

v.srcObject=this.call.remoteStream

tile.appendChild(v)

vids.appendChild(tile)

}



/* ---------- END BUTTON ---------- */

const endBtn=document.createElement('button')

endBtn.textContent='End Call'

endBtn.onclick=()=>{

this.net.send(
this.call.fp,
{type:'call-end'}
)

this._endCall()

}

panel.appendChild(endBtn)



/* ---------- PIP WINDOW ---------- */

const pip=document.createElement('div')

pip.className='call-pip'

const pv=document.createElement('video')

pv.autoplay=true
pv.muted=true
pv.playsInline=true

pv.srcObject=this.call.localStream

pip.appendChild(pv)

panel.querySelector('.call-pip')?.remove()

panel.appendChild(pip)

this._makePIPDraggable(pip)

}



/* ------------------ CIRCLE PANEL ------------------ */

_renderCircleCallPanel(){

const panel=this.callPanel

panel.innerHTML=''

if(!this.circleCall){
panel.style.display='none'
return
}

panel.style.display='flex'

const vids=document.createElement('div')
vids.style.display='flex'
vids.style.flexWrap='wrap'
vids.style.gap='10px'

panel.appendChild(vids)



/* ---------- LOCAL ---------- */

const localTile=document.createElement('div')
localTile.className='call-video-tile'

const lv=document.createElement('video')

lv.autoplay=true
lv.muted=true
lv.playsInline=true

lv.srcObject=this.circleCall.localStream

localTile.appendChild(lv)

vids.appendChild(localTile)



/* ---------- REMOTES ---------- */

for(const [fp,stream] of this.circleCall.remoteStreams){

const tile=document.createElement('div')
tile.className='call-video-tile'

const v=document.createElement('video')

v.autoplay=true
v.playsInline=true

v.srcObject=stream

tile.appendChild(v)

vids.appendChild(tile)

}



/* ---------- END ---------- */

const endBtn=document.createElement('button')

endBtn.textContent='End Circle'

endBtn.onclick=()=>{

for(const fp of this.circleCall.peers){
this.net.send(fp,{type:'call-end'})
}

this._endCircleCall()

}

panel.appendChild(endBtn)

}



/* ------------------ PIP DRAG ------------------ */

_makePIPDraggable(el){

let ox=0
let oy=0
let mx=0
let my=0
let dragging=false

const start=e=>{

dragging=true

const s=e.touches?e.touches[0]:e

mx=s.clientX
my=s.clientY

ox=el.offsetLeft
oy=el.offsetTop

document.addEventListener('mousemove',move)
document.addEventListener('touchmove',move,{passive:true})

}

const move=e=>{

if(!dragging) return

const s=e.touches?e.touches[0]:e

el.style.left=(ox+s.clientX-mx)+'px'
el.style.top =(oy+s.clientY-my)+'px'

el.style.right='auto'
el.style.bottom='auto'

}

const end=()=>{

dragging=false

document.removeEventListener('mousemove',move)
document.removeEventListener('touchmove',move)

}

el.addEventListener('mousedown',start)
el.addEventListener('touchstart',start,{passive:true})

document.addEventListener('mouseup',end)
document.addEventListener('touchend',end)

}



/* ------------------ STATS POLLING ------------------ */

_startStatsPolling(fp){

this._statsTimer=setInterval(async()=>{

const ps=this.net.peers.get(fp)

if(!ps) return

const stats=await ps.pc.getStats()

let rtt=0
let bitrate=0

stats.forEach(r=>{

if(r.type==='candidate-pair' && r.currentRoundTripTime){
rtt=r.currentRoundTripTime*1000
}

if(r.type==='outbound-rtp' && r.bytesSent){

bitrate=Math.floor(r.bytesSent/1024)

}

})

this._status(
'RTT '+rtt.toFixed(0)+'ms · '+bitrate+' KB',
'info'
)

},2000)

}



_stopStatsPolling(){

if(this._statsTimer){
clearInterval(this._statsTimer)
this._statsTimer=null
}

}



/* ------------------ REMOTE STREAM EVENT ------------------ */

_onRemoteStream(fp,stream){

if(!stream) return

this._audioEl.srcObject=stream

this._audioEl.play().catch(()=>{})

if(this.call && this.call.fp===fp){

this.call.remoteStream=stream

this.call.phase='active'

this._renderCallPanel()

this._startStatsPolling(fp)

this._status(
'call active · '+fp.slice(0,6),
'ok'
)

}

}