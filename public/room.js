'use strict';

// ─── Params URL ───────────────────────────────────────────────────────────────
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

// Largeur cible par résolution (en pixels)
const TARGET_WIDTHS = {
  '480p':  854,
  '720p':  1280,
  '1080p': 1920,
  '1440p': 2560,
  'natif': Infinity,
};

// Présets rapides
const PRESETS = {
  gaming:   { resolution: '720p',  fps: 60, bitrate: 3  },
  balanced: { resolution: '1080p', fps: 30, bitrate: 6  },
  quality:  { resolution: '1440p', fps: 30, bitrate: 15 },
};

// ─── État ─────────────────────────────────────────────────────────────────────
const socket = io();
let localStream       = null;   // stream combiné envoyé aux pairs
let localScreenStream = null;   // stream de capture d'écran
let localAudioStream  = null;   // stream audio séparé (si source spécifique)
let isSharing         = false;
let selectedPeerId    = null;
let fitMode           = 'fill'; // 'fill' | 'contain'

// Paramètres de stream (modifiables dans le panneau)
const settings = { resolution: '1080p', fps: 30, bitrate: 6 };

const peers          = {};
const remoteStreams  = {};
const usersMap       = {};
const pendingIce     = {};
const knownUsernames = {};

// ─── Éléments UI ─────────────────────────────────────────────────────────────
const mainVideo     = document.getElementById('main-video');
const placeholder   = document.getElementById('placeholder');
const shareBtn      = document.getElementById('share-btn');
const settingsPanel = document.getElementById('settings-panel');
const fitBtn        = document.getElementById('fit-btn');
const fitLabel      = document.getElementById('fit-label');

// ─── Room code ────────────────────────────────────────────────────────────────
document.getElementById('room-code').textContent = ROOM_ID;
document.getElementById('room-code').addEventListener('click', () => {
  navigator.clipboard.writeText(ROOM_ID).catch(() => {});
  const el = document.getElementById('copied-msg');
  el.style.display = 'inline';
  setTimeout(() => (el.style.display = 'none'), 1500);
});

// ─── Boutons principaux ───────────────────────────────────────────────────────
document.getElementById('leave-btn').addEventListener('click', () => {
  if (isSharing) stopShare();
  window.location.href = '/';
});

shareBtn.addEventListener('click', toggleShare);

// Plein écran sur le lecteur
document.getElementById('fs-btn').addEventListener('click', () => {
  const viewer = document.getElementById('viewer');
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    viewer.requestFullscreen().catch(() => mainVideo.requestFullscreen?.().catch(() => {}));
  }
});

// Mode fit : remplir ↔ letterbox
fitBtn.addEventListener('click', () => {
  fitMode = fitMode === 'fill' ? 'contain' : 'fill';
  mainVideo.style.objectFit = fitMode;
  fitLabel.textContent = fitMode === 'fill' ? 'Letterbox' : 'Remplir';
});

// ─── Panneau de paramètres ────────────────────────────────────────────────────
document.getElementById('settings-btn').addEventListener('click', () => {
  const open = settingsPanel.classList.toggle('open');
  document.getElementById('settings-btn').classList.toggle('active', open);
  if (open) populateAudioDevices(); // charger les périphériques à l'ouverture
});

document.getElementById('settings-close').addEventListener('click', () => {
  settingsPanel.classList.remove('open');
  document.getElementById('settings-btn').classList.remove('active');
});

// Résolution
document.getElementById('s-resolution').addEventListener('change', (e) => {
  settings.resolution = e.target.value;
  if (isSharing) updateAllEncoders();
});

// FPS
document.getElementById('s-fps').addEventListener('change', (e) => {
  settings.fps = parseInt(e.target.value);
  if (isSharing) updateAllEncoders();
});

// Débit (slider)
const bitrateSlider  = document.getElementById('s-bitrate');
const bitrateDisplay = document.getElementById('bitrate-display');
bitrateSlider.addEventListener('input', () => {
  settings.bitrate = parseInt(bitrateSlider.value);
  bitrateDisplay.textContent = `${settings.bitrate} Mbps`;
  if (isSharing) updateAllEncoders();
});

// Présets
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = PRESETS[btn.dataset.preset];
    settings.resolution = preset.resolution;
    settings.fps        = preset.fps;
    settings.bitrate    = preset.bitrate;

    // Sync les inputs
    document.getElementById('s-resolution').value = preset.resolution;
    document.getElementById('s-fps').value         = preset.fps;
    bitrateSlider.value                            = preset.bitrate;
    bitrateDisplay.textContent                     = `${preset.bitrate} Mbps`;

    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (isSharing) updateAllEncoders();
  });
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
    const isSelected = (id === selectedPeerId) || (isSelf && selectedPeerId === 'local');

    const chip = document.createElement('button');
    chip.className = 'chip';
    if (isSelected)     chip.classList.add('chip-selected');
    if (user.isSharing) chip.classList.add('chip-live');
    if (!user.isSharing && !isSelf) chip.classList.add('chip-inactive');

    const dot  = document.createElement('span');
    dot.className = 'chip-dot';

    const name = document.createElement('span');
    name.textContent = user.username + (isSelf ? ' (moi)' : '');

    const role = document.createElement('span');
    role.className = `chip-role ${user.isHost ? 'role-host' : 'role-guest'}`;
    role.textContent = user.isHost ? 'Hôte' : 'Invité';

    chip.appendChild(dot);
    chip.appendChild(name);
    chip.appendChild(role);

    chip.addEventListener('click', () => {
      if (isSelf || !user.isSharing) return;
      if (isSelected) clearVideo();
      else selectPeer(id);
    });

    container.appendChild(chip);
  }
}

// ─── Source audio : lister les périphériques disponibles ─────────────────────
async function populateAudioDevices() {
  const select = document.getElementById('s-audio');
  const currentVal = select.value;

  // Demander la permission micro pour que les labels soient visibles
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    tmp.getTracks().forEach(t => t.stop());
  } catch (_) { /* permission refusée, on continue avec les labels génériques */ }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs  = devices.filter(d => d.kind === 'audioinput');

  // Garder les options fixes, retirer les périphériques précédents
  while (select.options.length > 2) select.remove(2);

  inputs.forEach((dev, i) => {
    const opt = document.createElement('option');
    opt.value       = dev.deviceId;
    opt.textContent = dev.label || `Microphone ${i + 1}`;
    select.appendChild(opt);
  });

  // Restaurer la sélection si elle existe toujours
  if ([...select.options].some(o => o.value === currentVal)) {
    select.value = currentVal;
  }
}

// ─── Encodeur : appliquer résolution + FPS + débit ───────────────────────────
function computeScaleDown(sourceWidth) {
  const target = TARGET_WIDTHS[settings.resolution];
  if (!target || target >= sourceWidth) return 1;
  return sourceWidth / target;
}

function applyEncoderToSender(sender) {
  if (!sender || !localStream) return;
  const track = localStream.getVideoTracks()[0];
  const sourceWidth = track?.getSettings().width || 1920;
  const scale = computeScaleDown(sourceWidth);

  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].maxBitrate    = settings.bitrate * 1_000_000;
  params.encodings[0].maxFramerate  = settings.fps;
  params.encodings[0].scaleResolutionDownBy = scale;
  sender.setParameters(params).catch(() => {});
}

function updateAllEncoders() {
  for (const { pc } of Object.values(peers)) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) applyEncoderToSender(sender);
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

    if (selectedPeerId === peerId) {
      mainVideo.srcObject = stream;
      showVideo();
    }
    if (!selectedPeerId) selectPeer(peerId);

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
  const audioSource = document.getElementById('s-audio').value;

  // ── 1. Capturer l'écran (vidéo, et audio système si demandé) ──
  try {
    localScreenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: settings.fps, max: settings.fps } },
      audio: audioSource === 'system'
        ? { systemAudio: 'include', echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') console.error(e);
    return;
  }

  // ── 2. Capturer l'audio depuis un périphérique spécifique si besoin ──
  let audioTrack = null;

  if (audioSource === 'system') {
    audioTrack = localScreenStream.getAudioTracks()[0] || null;
  } else if (audioSource !== 'none') {
    try {
      localAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId:         { exact: audioSource },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
        },
      });
      audioTrack = localAudioStream.getAudioTracks()[0] || null;
    } catch (e) {
      console.warn('Source audio indisponible :', e);
    }
  }

  // ── 3. Construire le stream combiné ──
  const vt = localScreenStream.getVideoTracks()[0];
  const tracks = audioTrack ? [vt, audioTrack] : [vt];
  localStream = new MediaStream(tracks);

  isSharing = true;
  shareBtn.textContent = 'Arrêter le partage';
  shareBtn.className   = 'btn btn-sharing';
  socket.emit('sharing-status', { isSharing: true });
  if (usersMap[socket.id]) usersMap[socket.id].isSharing = true;

  // Aperçu local dans le lecteur
  selectedPeerId = 'local';
  mainVideo.srcObject = localStream;
  mainVideo.muted     = true;
  showVideo();
  renderChips();

  // ── 4. Envoyer aux pairs ──
  for (const [peerId, { pc }] of Object.entries(peers)) {
    for (const sender of pc.getSenders()) pc.removeTrack(sender);
    pc.addTrack(vt, localStream);
    if (audioTrack) pc.addTrack(audioTrack, localStream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: peerId, offer });
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) applyEncoderToSender(sender);
  }

  // Arrêt automatique si l'utilisateur clique "Arrêter" dans le navigateur
  vt.addEventListener('ended', stopShare);
}

async function stopShare() {
  if (localScreenStream) {
    localScreenStream.getTracks().forEach(t => t.stop());
    localScreenStream = null;
  }
  if (localAudioStream) {
    localAudioStream.getTracks().forEach(t => t.stop());
    localAudioStream = null;
  }
  localStream = null;

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

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Mode fit par défaut : remplir (pas de barres noires)
mainVideo.style.objectFit = fitMode;

usersMap[socket.id] = { username: USERNAME, isHost: false, isSharing: false };
renderChips();
socket.emit('join-room', { roomId: ROOM_ID, username: USERNAME });
