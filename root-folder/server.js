const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { 
    origin: "127.0.0.1:3000", 
    methods: ["GET", "POST"]
  }
});

let rooms = {};
let waitingPlayer = null;

io.on('connection', (socket) => {
  // Matchmaking logic
  socket.on('find-match', ({ username }) => {
    if (waitingPlayer && waitingPlayer.connected) {
      // Pair with waiting player
      const room = `room-${waitingPlayer.id}-${socket.id}`;
      socket.join(room);
      waitingPlayer.join(room);
      // Notify both players
      io.to(room).emit('match-found', { room });
      waitingPlayer = null;
    } else {
      // No one waiting, add to queue
      waitingPlayer = socket;
    }
  });

  // Game logic
  socket.on('join-room', ({ room, username }) => {
    socket.join(room);
    if (!rooms[room]) {
      // First player: create room state
      rooms[room] = {
        players: {},
        redBalls: Array.from({length: 10}, () => ({
          x: Math.random() * 560 + 20,
          y: Math.random() * 360 + 20
        })),
        scores: {},
        usernames: {}
      };
    }
    // Assign color: first is blue, second is green
    const color = Object.keys(rooms[room].players).length === 0 ? "blue" : "green";
    rooms[room].players[socket.id] = { x: color === "blue" ? 100 : 500, y: 200, color, name: username };
    rooms[room].scores[socket.id] = 0;
    rooms[room].usernames[socket.id] = username;
    socket.emit('player-info', { id: socket.id, color });

    // If two players, start the game
    if (Object.keys(rooms[room].players).length === 2) {
      io.to(room).emit('start-game', rooms[room]);
    }
  });

  socket.on('player-input', ({ room, input }) => {
    if (rooms[room] && rooms[room].players[socket.id]) {
      // Move player
      rooms[room].players[socket.id].x += input.dx;
      rooms[room].players[socket.id].y += input.dy;

      // Clamp to canvas
      rooms[room].players[socket.id].x = Math.max(15, Math.min(585, rooms[room].players[socket.id].x));
      rooms[room].players[socket.id].y = Math.max(15, Math.min(385, rooms[room].players[socket.id].y));

      // Collision detection with red balls
      for (let i = 0; i < rooms[room].redBalls.length; i++) {
        const ball = rooms[room].redBalls[i];
        const dx = rooms[room].players[socket.id].x - ball.x;
        const dy = rooms[room].players[socket.id].y - ball.y;
        if (Math.sqrt(dx*dx + dy*dy) < 25) { // 15 (player) + 10 (red)
          // Score and respawn red ball
          rooms[room].scores[socket.id]++;
          rooms[room].redBalls[i] = {
            x: Math.random() * 560 + 20,
            y: Math.random() * 360 + 20
          };
        }
      }

      io.to(room).emit('state-update', rooms[room]);
    }
  });

  socket.on('disconnect', () => {
    if (waitingPlayer === socket) waitingPlayer = null;
    for (let room in rooms) {
      if (rooms[room].players[socket.id]) {
        delete rooms[room].players[socket.id];
        delete rooms[room].scores[socket.id];
        if (Object.keys(rooms[room].players).length === 0) {
          delete rooms[room];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
