'use strict';

// ─── Params URL ───────────────────────────────────────────────────────────────
const params   = new URLSearchParams(window.location.search);
const ROOM_ID  = params.get('room');
const USERNAME = params.get('username');
if (!ROOM_ID || !USERNAME) window.location.href = '/';

// ─── Config ───────────────────────────────────────────────────────────────────
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// Contrôle de qualité uniquement via le débit (pas de contraintes de résolution
// qui peuvent bloquer le partage plein écran sur certains navigateurs)
const BITRATES = {
  '720p':  4_000_000,
  '1080p': 8_000_000,
  '1440p': 15_000_000,
};

// ─── État ─────────────────────────────────────────────────────────────────────
const socket = io();
let localStream    = null;
let isSharing      = false;
let selectedPeerId = null;   // peer actuellement affiché dans le lecteur principal

// peers[id]         = { pc: RTCPeerConnection, username }
// remoteStreams[id] = MediaStream reçu de ce peer
// usersMap[id]      = { username, isHost, isSharing }
const peers         = {};
const remoteStreams = {};
const usersMap      = {};
const pendingIce    = {};
const knownUsernames = {};

// ─── Éléments UI ─────────────────────────────────────────────────────────────
const mainVideo  = document.getElementById('main-video');
const placeholder = document.getElementById('placeholder');
const shareBtn   = document.getElementById('share-btn');
const qualitySel = document.getElementById('quality-select');

// ─── Room code ────────────────────────────────────────────────────────────────
document.getElementById('room-code').textContent = ROOM_ID;
document.getElementById('room-code').addEventListener('click', () => {
  navigator.clipboard.writeText(ROOM_ID).catch(() => {});
  const el = document.getElementById('copied-msg');
  el.style.display = 'inline';
  setTimeout(() => (el.style.display = 'none'), 1500);
});

// ─── Boutons ──────────────────────────────────────────────────────────────────
document.getElementById('leave-btn').addEventListener('click', () => {
  if (isSharing) stopShare();
  window.location.href = '/';
});

shareBtn.addEventListener('click', toggleShare);

qualitySel.addEventListener('change', async () => {
  if (isSharing) { await stopShare(); await startShare(); }
});

// Plein écran sur le lecteur principal
document.getElementById('fs-btn').addEventListener('click', () => {
  const el = document.querySelector('.viewer');
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    el.requestFullscreen().catch(() => mainVideo.requestFullscreen?.().catch(() => {}));
  }
});

// ─── Lecteur principal ────────────────────────────────────────────────────────
function selectPeer(peerId) {
  selectedPeerId = peerId;

  if (peerId === 'local' && localStream) {
    mainVideo.srcObject = localStream;
    mainVideo.muted     = true;
    showVideo();
  } else if (remoteStreams[peerId]) {
    mainVideo.srcObject = remoteStreams[peerId];
    mainVideo.muted     = false;
    showVideo();
  } else {
    clearVideo();
  }
  renderChips();
}

function showVideo() {
  mainVideo.style.display = 'block';
  placeholder.style.display = 'none';
}

function clearVideo() {
  mainVideo.style.display = 'none';
  mainVideo.srcObject = null;
  placeholder.style.display = 'flex';
  selectedPeerId = null;
  renderChips();
}

// ─── Chips utilisateurs ───────────────────────────────────────────────────────
function renderChips() {
  const container = document.getElementById('user-chips');
  container.innerHTML = '';

  for (const [id, user] of Object.entries(usersMap)) {
    const isSelf     = id === socket.id;
    const isSelected = id === selectedPeerId ||
                       (isSelf && selectedPeerId === 'local');
    const canWatch   = !isSelf && user.isSharing;

    const chip = document.createElement('button');
    chip.className = 'chip';
    if (isSelected)    chip.classList.add('chip-selected');
    if (user.isSharing) chip.classList.add('chip-live');
    if (!canWatch && !isSelf) chip.classList.add('chip-inactive');

    chip.title = user.isHost ? 'Hôte' : 'Invité';

    const dot = document.createElement('span');
    dot.className = 'chip-dot';

    const name = document.createElement('span');
    name.textContent = user.username + (isSelf ? ' (moi)' : '');

    const role = document.createElement('span');
    role.className = `chip-role ${user.isHost ? 'role-host' : 'role-guest'}`;
    role.textContent = user.isHost ? 'Hôte' : 'Invité';

    chip.appendChild(dot);
    chip.appendChild(name);
    chip.appendChild(role);

    // Clic → voir leur écran (ou dé-sélectionner)
    chip.addEventListener('click', () => {
      if (isSelf) return; // on ne se sélectionne pas soi-même
      if (!user.isSharing) return; // pas de stream disponible
      if (isSelected) {
        clearVideo();
      } else {
        selectPeer(id);
      }
    });

    container.appendChild(chip);
  }
}

// ─── WebRTC ───────────────────────────────────────────────────────────────────
async function createPeer(peerId, peerUsername, initiator) {
  if (peers[peerId]) return peers[peerId].pc;

  const pc = new RTCPeerConnection(ICE_CONFIG);
  peers[peerId]      = { pc, username: peerUsername };
  pendingIce[peerId] = pendingIce[peerId] || [];

  pc.ontrack = ({ track, streams }) => {
    if (track.kind !== 'video') return;

    const stream = (streams && streams[0]) || new MediaStream([track]);
    remoteStreams[peerId] = stream;

    // Si ce peer est actuellement sélectionné, mettre à jour le lecteur
    if (selectedPeerId === peerId) {
      mainVideo.srcObject = stream;
      showVideo();
    }
    // Auto-sélectionner si personne d'autre n'est sélectionné
    if (!selectedPeerId) selectPeer(peerId);

    // Signaler à l'UI que ce peer partage
    if (usersMap[peerId]) usersMap[peerId].isSharing = true;
    renderChips();

    track.addEventListener('ended', () => {
      delete remoteStreams[peerId];
      if (usersMap[peerId]) usersMap[peerId].isSharing = false;
      if (selectedPeerId === peerId) clearVideo();
      renderChips();
    });
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { to: peerId, candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      delete remoteStreams[peerId];
      if (selectedPeerId === peerId) clearVideo();
      pc.close();
      delete peers[peerId];
    }
  };

  if (initiator) {
    pc.addTransceiver('video', { direction: 'sendrecv' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: peerId, offer });
  }

  return pc;
}

async function flushPendingIce(peerId) {
  const pc  = peers[peerId]?.pc;
  const buf = pendingIce[peerId];
  if (!pc?.remoteDescription || !buf?.length) return;
  for (const c of buf) await pc.addIceCandidate(c).catch(() => {});
  pendingIce[peerId] = [];
}

// ─── Événements Socket ────────────────────────────────────────────────────────
socket.on('room-users', async (users) => {
  for (const u of users) {
    usersMap[u.id] = { username: u.username, isHost: u.isHost, isSharing: u.isSharing };
  }
  usersMap[socket.id] = { username: USERNAME, isHost: false, isSharing: false };
  renderChips();
  for (const u of users) await createPeer(u.id, u.username, true);
});

socket.on('user-joined', ({ id, username, isHost }) => {
  usersMap[id] = { username, isHost, isSharing: false };
  knownUsernames[id] = username;
  renderChips();
});

socket.on('user-left', ({ id }) => {
  delete remoteStreams[id];
  delete usersMap[id];
  if (selectedPeerId === id) clearVideo();
  if (peers[id]) { peers[id].pc.close(); delete peers[id]; }
  renderChips();
});

socket.on('new-host', ({ id }) => {
  for (const uid in usersMap) usersMap[uid].isHost = false;
  if (usersMap[id]) usersMap[id].isHost = true;
  renderChips();
});

socket.on('sharing-status', ({ id, isSharing: sharing }) => {
  if (usersMap[id]) usersMap[id].isSharing = sharing;
  if (!sharing && selectedPeerId === id) clearVideo();
  renderChips();
});

socket.on('user-count', (n) => {
  // (optionnel, non affiché dans le nouveau design)
});

socket.on('offer', async ({ from, username, offer }) => {
  const name = username || knownUsernames[from] || '?';
  const pc   = peers[from]?.pc || await createPeer(from, name, false);
  await pc.setRemoteDescription(offer);
  if (localStream) {
    const vt = localStream.getVideoTracks()[0];
    const tr = pc.getTransceivers().find(t => t.receiver.track?.kind === 'video');
    if (tr && vt) await tr.sender.replaceTrack(vt).catch(() => {});
  }
  await flushPendingIce(from);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { to: from, answer });
});

socket.on('answer', async ({ from, answer }) => {
  const peer = peers[from];
  if (!peer) return;
  await peer.pc.setRemoteDescription(answer);
  await flushPendingIce(from);
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const peer = peers[from];
  if (!peer?.pc.remoteDescription) {
    pendingIce[from] = pendingIce[from] || [];
    pendingIce[from].push(candidate);
    return;
  }
  await peer.pc.addIceCandidate(candidate).catch(() => {});
});

// ─── Partage d'écran ──────────────────────────────────────────────────────────
async function startShare() {
  try {
    // Pas de contraintes de résolution forcées — le navigateur laisse le choix
    // complet à l'utilisateur (fenêtre, onglet, écran entier)
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: true,
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') console.error(e);
    return;
  }

  isSharing = true;
  shareBtn.textContent = 'Arrêter le partage';
  shareBtn.className   = 'btn btn-sharing';
  socket.emit('sharing-status', { isSharing: true });
  if (usersMap[socket.id]) usersMap[socket.id].isSharing = true;

  // Afficher son propre stream dans le lecteur
  selectedPeerId = 'local';
  mainVideo.srcObject = localStream;
  mainVideo.muted     = true;
  showVideo();
  renderChips();

  const vt = localStream.getVideoTracks()[0];
  const at = localStream.getAudioTracks()[0];
  const bitrate = BITRATES[qualitySel.value];

  for (const [peerId, { pc }] of Object.entries(peers)) {
    for (const sender of pc.getSenders()) pc.removeTrack(sender);
    pc.addTrack(vt, localStream);
    if (at) pc.addTrack(at, localStream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: peerId, offer });
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) applyBitrate(sender, bitrate);
  }

  vt.addEventListener('ended', stopShare);
}

async function stopShare() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  isSharing = false;
  shareBtn.textContent = 'Partager mon écran';
  shareBtn.className   = 'btn btn-share';
  socket.emit('sharing-status', { isSharing: false });
  if (usersMap[socket.id]) usersMap[socket.id].isSharing = false;

  if (selectedPeerId === 'local') clearVideo();
  renderChips();

  for (const [peerId, { pc }] of Object.entries(peers)) {
    for (const sender of pc.getSenders()) pc.removeTrack(sender);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: peerId, offer });
  }
}

async function toggleShare() {
  if (isSharing) await stopShare();
  else await startShare();
}

function applyBitrate(sender, maxBitrate) {
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = maxBitrate;
  sender.setParameters(params).catch(() => {});
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
usersMap[socket.id] = { username: USERNAME, isHost: false, isSharing: false };
renderChips();
socket.emit('join-room', { roomId: ROOM_ID, username: USERNAME });
