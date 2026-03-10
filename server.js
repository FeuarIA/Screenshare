const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// rooms[roomId][socketId] = { id, username }
const rooms = {};

io.on('connection', (socket) => {

  socket.on('join-room', ({ roomId, username }) => {
    socket.data.roomId = roomId;
    socket.data.username = username;

    if (!rooms[roomId]) rooms[roomId] = {};

    // Envoyer les utilisateurs existants au nouvel arrivant
    socket.emit('room-users', Object.values(rooms[roomId]));

    // Ajouter l'arrivant à la room
    rooms[roomId][socket.id] = { id: socket.id, username };
    socket.join(roomId);

    // Notifier les autres
    socket.to(roomId).emit('user-joined', { id: socket.id, username });

    // Mettre à jour le compteur pour tout le monde
    io.to(roomId).emit('user-count', Object.keys(rooms[roomId]).length);
  });

  // Relayer l'offre WebRTC avec le username de l'expéditeur
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', {
      from: socket.id,
      username: socket.data.username,
      offer,
    });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    const { roomId, username } = socket.data;
    if (!roomId || !rooms[roomId]) return;

    delete rooms[roomId][socket.id];

    if (Object.keys(rooms[roomId]).length === 0) {
      delete rooms[roomId];
    } else {
      io.to(roomId).emit('user-left', { id: socket.id, username });
      io.to(roomId).emit('user-count', Object.keys(rooms[roomId]).length);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✓ Serveur lancé sur http://localhost:${PORT}`);
});
