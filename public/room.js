'use strict';

// ─── Paramètres URL ───────────────────────────────────────────────────────────
const params   = new URLSearchParams(window.location.search);
const ROOM_ID  = params.get('room');
const USERNAME = params.get('username');
if (!ROOM_ID || !USERNAME) window.location.href = '/';

// ─── Config WebRTC ────────────────────────────────────────────────────────────
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// Contraintes + débit max par qualité
const QUALITY = {
  '720p':  { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30 }, bitrate: 4_000_000  },
  '1080p': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, bitrate: 8_000_000  },
  '1440p': { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30 }, bitrate: 15_000_000 },
};

// ─── État ─────────────────────────────────────────────────────────────────────
const socket = io();
let localStream = null;
let isSharing   = false;

// peers[socketId] = { pc: RTCPeerConnection, username: string }
const peers = {};

// Candidats ICE reçus avant que la remote description soit définie
const pendingIce = {};

// Usernames reçus via user-joined avant que l'offre arrive
const knownUsernames = {};

// ─── Éléments UI ─────────────────────────────────────────────────────────────
const grid         = document.getElementById('video-grid');
const noStreamMsg  = document.getElementById('no-stream-msg');
const shareBtn     = document.getElementById('share-btn');
const qualitySelect = document.getElementById('quality-select');

document.getElementById('room-code-display').textContent = ROOM_ID;

document.getElementById('room-code-display').addEventListener('click', () => {
  navigator.clipboard.writeText(ROOM_ID).catch(() => {});
  const el = document.getElementById('copied-msg');
  el.style.display = 'inline';
  setTimeout(() => (el.style.display = 'none'), 1500);
});

document.getElementById('leave-btn').addEventListener('click', () => {
  if (isSharing) stopShare();
  window.location.href = '/';
});

shareBtn.addEventListener('click', toggleShare);

qualitySelect.addEventListener('change', async () => {
  if (isSharing) {
    await stopShare();
    await startShare();
  }
});

// ─── Gestion des tuiles vidéo ─────────────────────────────────────────────────
function checkEmpty() {
  noStreamMsg.style.display = grid.querySelectorAll('.video-tile').length === 0 ? 'flex' : 'none';
}

function addVideoTile(id, username, stream) {
  if (document.getElementById(`tile-${id}`)) return;

  const tile  = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${id}`;

  const video = document.createElement('video');
  video.autoplay    = true;
  video.playsInline = true;
  video.muted       = (id === 'local');
  video.srcObject   = stream;

  const label = document.createElement('span');
  label.className   = 'video-label';
  label.textContent = username;

  tile.appendChild(video);
  tile.appendChild(label);
  grid.appendChild(tile);
  checkEmpty();
}

function removeVideoTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) { tile.remove(); checkEmpty(); }
}

// ─── WebRTC — création d'une connexion pair ───────────────────────────────────
async function createPeer(peerId, peerUsername, initiator) {
  if (peers[peerId]) return peers[peerId].pc;

  const pc = new RTCPeerConnection(ICE_CONFIG);
  peers[peerId]    = { pc, username: peerUsername };
  pendingIce[peerId] = pendingIce[peerId] || [];

  // Réception d'une piste vidéo distante
  pc.ontrack = ({ track, streams }) => {
    if (track.kind !== 'video') return;
    const stream = streams[0] || new MediaStream([track]);

    // Afficher la tuile dès qu'il y a des données
    const show = () => addVideoTile(peerId, peerUsername, stream);
    const hide = () => removeVideoTile(peerId);
    track.addEventListener('unmute', show);
    track.addEventListener('mute',   hide);
    if (!track.muted) show();
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { to: peerId, candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      removeVideoTile(peerId);
      pc.close();
      delete peers[peerId];
    }
  };

  // L'initiateur crée l'offre
  if (initiator) {
    const transceiver = pc.addTransceiver('video', { direction: 'sendrecv' });

    if (localStream) {
      const vt = localStream.getVideoTracks()[0];
      if (vt) await transceiver.sender.replaceTrack(vt);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: peerId, offer });
  }

  return pc;
}

// Vider le buffer de candidats ICE en attente
async function flushPendingIce(peerId) {
  const pc  = peers[peerId]?.pc;
  const buf = pendingIce[peerId];
  if (!pc || !pc.remoteDescription || !buf?.length) return;
  for (const c of buf) await pc.addIceCandidate(c).catch(() => {});
  pendingIce[peerId] = [];
}

// ─── Événements Socket ────────────────────────────────────────────────────────
socket.on('room-users', async (users) => {
  updateCount(users.length + 1);
  for (const u of users) {
    await createPeer(u.id, u.username, true);
  }
});

socket.on('user-joined', ({ id, username }) => {
  knownUsernames[id] = username;
  // Le nouvel arrivant va nous envoyer une offre ; on attend.
});

socket.on('user-count', updateCount);

socket.on('offer', async ({ from, username, offer }) => {
  const name = username || knownUsernames[from] || '?';
  const pc   = peers[from]?.pc || await createPeer(from, name, false);

  await pc.setRemoteDescription(offer);

  // Si on partage déjà, attacher notre piste vidéo au transceiver
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
  if (!peer || !peer.pc.remoteDescription) {
    pendingIce[from] = pendingIce[from] || [];
    pendingIce[from].push(candidate);
    return;
  }
  await peer.pc.addIceCandidate(candidate).catch(() => {});
});

socket.on('user-left', ({ id }) => {
  removeVideoTile(id);
  if (peers[id]) {
    peers[id].pc.close();
    delete peers[id];
  }
});

// ─── Partage d'écran ──────────────────────────────────────────────────────────
async function startShare() {
  const preset = QUALITY[qualitySelect.value];

  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width:     preset.width,
        height:    preset.height,
        frameRate: preset.frameRate,
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        sampleRate: 44100,
      },
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') console.error('getDisplayMedia:', e);
    return;
  }

  isSharing = true;
  shareBtn.textContent = 'Arrêter le partage';
  shareBtn.className   = 'btn btn-sharing';

  // Aperçu local
  addVideoTile('local', USERNAME + ' (moi)', localStream);

  const vt = localStream.getVideoTracks()[0];
  const at = localStream.getAudioTracks()[0];

  // Ajouter / remplacer la piste dans toutes les connexions existantes
  for (const [peerId, { pc }] of Object.entries(peers)) {
    const transceivers = pc.getTransceivers();
    const videoTr = transceivers.find(t => t.receiver.track?.kind === 'video');

    if (videoTr) {
      await videoTr.sender.replaceTrack(vt).catch(() => {});
    } else {
      // Pas de transceiver vidéo encore → en créer un et renégocier
      pc.addTrack(vt, localStream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peerId, offer });
    }

    // Audio système (si disponible)
    if (at) {
      const audioTr = transceivers.find(t => t.receiver.track?.kind === 'audio');
      if (audioTr) await audioTr.sender.replaceTrack(at).catch(() => {});
    }

    // Limiter le débit au niveau demandé
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) applyBitrate(sender, preset.bitrate);
  }

  // Détecter l'arrêt via le bouton natif du navigateur
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
  removeVideoTile('local');

  // Mettre la piste à null pour tous les pairs
  for (const { pc } of Object.values(peers)) {
    for (const sender of pc.getSenders()) {
      if (sender.track) await sender.replaceTrack(null).catch(() => {});
    }
  }
}

async function toggleShare() {
  if (isSharing) await stopShare();
  else await startShare();
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────
function applyBitrate(sender, maxBitrate) {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  params.encodings[0].maxBitrate = maxBitrate;
  sender.setParameters(params).catch(() => {});
}

function updateCount(n) {
  document.getElementById('user-count').textContent =
    n === 1 ? '1 personne connectée' : `${n} personnes connectées`;
}

// ─── Connexion ────────────────────────────────────────────────────────────────
socket.emit('join-room', { roomId: ROOM_ID, username: USERNAME });
