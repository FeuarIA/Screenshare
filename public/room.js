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

const QUALITY = {
  '720p':  { width: { ideal: 1280 }, height: { ideal: 720  }, frameRate: { ideal: 30 }, bitrate: 4_000_000  },
  '1080p': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, bitrate: 8_000_000  },
  '1440p': { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30 }, bitrate: 15_000_000 },
};

// ─── État global ──────────────────────────────────────────────────────────────
const socket = io();
let localStream   = null;
let isSharing     = false;
let focusedPeerId = null;
let unreadChat    = 0;

const peers          = {};
const usersMap       = {};
const pendingIce     = {};
const knownUsernames = {};

// ─── Éléments UI ─────────────────────────────────────────────────────────────
const grid         = document.getElementById('video-grid');
const shareBtn     = document.getElementById('share-btn');
const qualitySel   = document.getElementById('quality-select');
const chatInput    = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const roomBody     = document.getElementById('room-body');

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

qualitySel.addEventListener('change', async () => {
  if (isSharing) { await stopShare(); await startShare(); }
});

// ─── Navigation mobile ────────────────────────────────────────────────────────
document.querySelectorAll('.mobile-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const panel = tab.dataset.panel;
    document.querySelectorAll('.mobile-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    roomBody.dataset.activeTab = panel;

    // Réinitialiser le badge chat quand on ouvre le chat
    if (panel === 'chat') {
      unreadChat = 0;
      updateChatBadge();
    }
  });
});

function updateChatBadge() {
  const badge = document.getElementById('chat-badge');
  if (!badge) return;
  badge.textContent = unreadChat > 0 ? unreadChat : '';
  badge.style.display = unreadChat > 0 ? 'inline-flex' : 'none';
}

function isChatVisible() {
  const isMobile = window.innerWidth <= 768;
  return !isMobile || roomBody.dataset.activeTab === 'chat';
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  chatInput.value = '';
}

document.getElementById('send-btn').addEventListener('click', sendChat);
chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChat(); });

function appendChatMessage({ fromId, username, text, time }) {
  const isSelf = fromId === socket.id;
  const wrap = document.createElement('div');
  wrap.className = `chat-msg ${isSelf ? 'chat-msg-self' : ''}`;
  const heure = new Date(time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  wrap.innerHTML = `
    <span class="chat-author">${escapeHtml(username)}</span>
    <span class="chat-time">${heure}</span>
    <div class="chat-text">${escapeHtml(text)}</div>
  `;
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Badge non-lu sur mobile si chat pas visible
  if (!isSelf && !isChatVisible()) {
    unreadChat++;
    updateChatBadge();
  }
}

function appendSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'chat-system';
  el.textContent = text;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Liste des utilisateurs ───────────────────────────────────────────────────
function renderUserList() {
  const list = document.getElementById('user-list');
  list.innerHTML = '';

  for (const [id, user] of Object.entries(usersMap)) {
    const isSelf = id === socket.id;
    const item = document.createElement('div');
    item.className = 'user-item';

    const info = document.createElement('div');
    info.className = 'user-info';

    const name = document.createElement('span');
    name.className = 'user-name';
    name.textContent = user.username + (isSelf ? ' (moi)' : '');
    info.appendChild(name);

    const badges = document.createElement('div');
    badges.className = 'badges-row';
    if (user.isHost) {
      const b = document.createElement('span');
      b.className = 'badge badge-host';
      b.textContent = 'Hôte';
      badges.appendChild(b);
    } else {
      const b = document.createElement('span');
      b.className = 'badge badge-guest';
      b.textContent = 'Invité';
      badges.appendChild(b);
    }
    if (user.isSharing) {
      const b = document.createElement('span');
      b.className = 'badge badge-live';
      b.textContent = '● Live';
      badges.appendChild(b);
    }
    info.appendChild(badges);
    item.appendChild(info);

    if (!isSelf && user.isSharing) {
      const btn = document.createElement('button');
      const isFocused = focusedPeerId === id;
      btn.className = `btn btn-watch ${isFocused ? 'btn-watch-active' : ''}`;
      btn.textContent = isFocused ? 'Focalisé ✕' : 'Regarder';
      btn.addEventListener('click', () => {
        if (isFocused) unfocusStream();
        else focusStream(id);
      });
      item.appendChild(btn);
    }

    list.appendChild(item);
  }
}

// ─── Focus / unfocus ──────────────────────────────────────────────────────────
function focusStream(peerId) {
  focusedPeerId = peerId;
  grid.querySelectorAll('.video-tile').forEach(tile => {
    tile.classList.toggle('tile-hidden', tile.id !== `tile-${peerId}`);
  });
  grid.classList.add('grid-focus');
  renderUserList();
}

function unfocusStream() {
  focusedPeerId = null;
  grid.querySelectorAll('.video-tile').forEach(tile => tile.classList.remove('tile-hidden'));
  grid.classList.remove('grid-focus');
  renderUserList();
}

// ─── Tuiles vidéo ─────────────────────────────────────────────────────────────
function checkEmpty() {
  const count = grid.querySelectorAll('.video-tile').length;
  document.getElementById('no-stream-msg').style.display = count === 0 ? 'flex' : 'none';
}

function createTileBtn(icon, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'tile-btn';
  btn.title = title;
  btn.textContent = icon;
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

function addVideoTile(id, username, stream) {
  if (document.getElementById(`tile-${id}`)) return;

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${id}`;
  if (focusedPeerId && focusedPeerId !== id) tile.classList.add('tile-hidden');

  const video = document.createElement('video');
  video.autoplay    = true;
  video.playsInline = true;
  video.muted       = (id === 'local');
  video.srcObject   = stream;

  // Double-clic pour focus (desktop)
  video.addEventListener('dblclick', () => {
    if (id === 'local') return;
    if (focusedPeerId === id) unfocusStream();
    else focusStream(id);
  });

  const label = document.createElement('span');
  label.className   = 'video-label';
  label.textContent = username;

  // ── Overlay avec les boutons de contrôle ──
  const overlay = document.createElement('div');
  overlay.className = 'tile-overlay';

  // Bouton Plein écran
  const fsBtn = createTileBtn('⛶', 'Plein écran', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      tile.requestFullscreen().catch(() => {
        // Fallback : plein écran sur la vidéo directement
        video.requestFullscreen?.().catch(() => {});
      });
    }
  });
  overlay.appendChild(fsBtn);

  // Bouton Pop-up (Picture-in-Picture)
  if (document.pictureInPictureEnabled) {
    const pipBtn = createTileBtn('⧉', 'Mini fenêtre (pop-up)', async () => {
      try {
        if (document.pictureInPictureElement === video) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (e) {
        console.warn('PiP non disponible:', e);
      }
    });
    overlay.appendChild(pipBtn);
  }

  // Bouton Focus (seulement pour les streams distants)
  if (id !== 'local') {
    const focusBtn = createTileBtn('⤢', 'Focus / Dé-focus', () => {
      if (focusedPeerId === id) unfocusStream();
      else focusStream(id);
    });
    overlay.appendChild(focusBtn);
  }

  tile.appendChild(video);
  tile.appendChild(label);
  tile.appendChild(overlay);
  grid.appendChild(tile);
  checkEmpty();
}

function removeVideoTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) { tile.remove(); checkEmpty(); }
  if (focusedPeerId === id) unfocusStream();
}

// ─── WebRTC ───────────────────────────────────────────────────────────────────
async function createPeer(peerId, peerUsername, initiator) {
  if (peers[peerId]) return peers[peerId].pc;

  const pc = new RTCPeerConnection(ICE_CONFIG);
  peers[peerId]      = { pc, username: peerUsername };
  pendingIce[peerId] = pendingIce[peerId] || [];

  pc.ontrack = ({ track, streams }) => {
    if (track.kind !== 'video') return;
    const stream = streams[0] || new MediaStream([track]);
    addVideoTile(peerId, peerUsername, stream);
    track.addEventListener('ended', () => removeVideoTile(peerId));
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
  updateCount(users.length + 1);
  renderUserList();
  for (const u of users) await createPeer(u.id, u.username, true);
});

socket.on('user-joined', ({ id, username, isHost }) => {
  usersMap[id] = { username, isHost, isSharing: false };
  knownUsernames[id] = username;
  renderUserList();
  appendSystemMessage(`${username} a rejoint la room.`);
});

socket.on('user-count', updateCount);

socket.on('user-left', ({ id }) => {
  const user = usersMap[id];
  if (user) appendSystemMessage(`${user.username} a quitté la room.`);
  removeVideoTile(id);
  delete usersMap[id];
  if (peers[id]) { peers[id].pc.close(); delete peers[id]; }
  renderUserList();
});

socket.on('new-host', ({ id }) => {
  for (const uid in usersMap) usersMap[uid].isHost = false;
  if (usersMap[id]) usersMap[id].isHost = true;
  if (id === socket.id) appendSystemMessage("Tu es maintenant l'hôte de la room.");
  renderUserList();
});

socket.on('sharing-status', ({ id, isSharing: sharing }) => {
  if (usersMap[id]) usersMap[id].isSharing = sharing;
  if (!sharing && focusedPeerId === id) unfocusStream();
  renderUserList();
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

socket.on('chat-message', appendChatMessage);

// ─── Partage d'écran ──────────────────────────────────────────────────────────
async function startShare() {
  const preset = QUALITY[qualitySel.value];
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: preset.width, height: preset.height, frameRate: preset.frameRate },
      audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 44100 },
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
  renderUserList();

  addVideoTile('local', USERNAME + ' (moi)', localStream);

  const vt = localStream.getVideoTracks()[0];
  const at = localStream.getAudioTracks()[0];

  for (const [peerId, { pc }] of Object.entries(peers)) {
    for (const sender of pc.getSenders()) pc.removeTrack(sender);
    pc.addTrack(vt, localStream);
    if (at) pc.addTrack(at, localStream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: peerId, offer });
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) applyBitrate(sender, preset.bitrate);
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
  renderUserList();
  removeVideoTile('local');

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

// ─── Utilitaires ──────────────────────────────────────────────────────────────
function applyBitrate(sender, maxBitrate) {
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = maxBitrate;
  sender.setParameters(params).catch(() => {});
}

function updateCount(n) {
  document.getElementById('user-count').textContent =
    n === 1 ? '1 connecté' : `${n} connectés`;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
usersMap[socket.id] = { username: USERNAME, isHost: false, isSharing: false };
renderUserList();
socket.emit('join-room', { roomId: ROOM_ID, username: USERNAME });
