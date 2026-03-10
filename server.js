const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// rooms[roomId] = { host: socketId, users: { [socketId]: { id, username, isSharing } } }
const rooms = {};

io.on('connection', (socket) => {

  socket.on('join-room', ({ roomId, username }) => {
    socket.data.roomId = roomId;
    socket.data.username = username;

    const isNewRoom = !rooms[roomId];
    if (isNewRoom) rooms[roomId] = { host: socket.id, users: {} };

    const isHost = rooms[roomId].host === socket.id;
    rooms[roomId].users[socket.id] = { id: socket.id, username, isSharing: false, isHost };
    socket.join(roomId);

    // Envoyer la liste complète au nouvel arrivant
    socket.emit('room-users', Object.values(rooms[roomId].users));

    // Notifier les autres
    socket.to(roomId).emit('user-joined', { id: socket.id, username, isHost: false });

    io.to(roomId).emit('user-count', Object.keys(rooms[roomId].users).length);
  });

  // Relais WebRTC
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, username: socket.data.username, offer });
  });
  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });
  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // Statut de partage d'écran
  socket.on('sharing-status', ({ isSharing }) => {
    const { roomId } = socket.data;
    if (!roomId || !rooms[roomId]) return;
    if (rooms[roomId].users[socket.id]) {
      rooms[roomId].users[socket.id].isSharing = isSharing;
    }
    io.to(roomId).emit('sharing-status', { id: socket.id, isSharing });
  });

  // Chat
  socket.on('chat-message', ({ text }) => {
    const { roomId, username } = socket.data;
    if (!roomId || !text?.trim()) return;
    io.to(roomId).emit('chat-message', {
      fromId: socket.id,
      username,
      text: text.trim().slice(0, 500),
      time: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    const { roomId } = socket.data;
    if (!roomId || !rooms[roomId]) return;

    delete rooms[roomId].users[socket.id];

    if (Object.keys(rooms[roomId].users).length === 0) {
      delete rooms[roomId];
    } else {
      // Transférer le rôle d'hôte si nécessaire
      if (rooms[roomId].host === socket.id) {
        const nextId = Object.keys(rooms[roomId].users)[0];
        rooms[roomId].host = nextId;
        rooms[roomId].users[nextId].isHost = true;
        io.to(roomId).emit('new-host', { id: nextId });
      }
      io.to(roomId).emit('user-left', { id: socket.id });
      io.to(roomId).emit('user-count', Object.keys(rooms[roomId].users).length);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✓ Serveur lancé sur http://localhost:${PORT}`));
