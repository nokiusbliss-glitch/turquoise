export class Mesh {
  constructor(sendSignal) {
    this.peers = new Map();
    this.sendSignal = sendSignal;
    this.localStream = null;
  }

  async initLocal() {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });

    return this.localStream;
  }

  async createPeer(id, initiator = false) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal({ to: id, candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      const video = document.createElement("video");
      video.srcObject = e.streams[0];
      video.autoplay = true;
      video.playsInline = true;
      video.className = "remote-video";
      document.getElementById("videos").appendChild(video);
    };

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal({ to: id, description: pc.localDescription });
    }

    this.peers.set(id, pc);
  }

  async handleSignal(from, data) {
    const pc = this.peers.get(from);
    if (!pc) return;

    if (data.description) {
      await pc.setRemoteDescription(data.description);
      if (data.description.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendSignal({ to: from, description: pc.localDescription });
      }
    }

    if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  }
}