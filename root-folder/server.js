const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { 
    origin: "http://127.0.0.1:3000", 
    methods: ["GET", "POST"]
  }
});

let rooms = {};
let waitingPlayer = null;

const RED_RADIUS = 5;
const RED_SPEED = 3.5;
const TRAIL_LENGTH = 30;

// Helper to initialize a red ball with trail
function spawnRedBall() {
  let angle = Math.random() * 2 * Math.PI;
  return {
    x: Math.random() * (600 - 2 * RED_RADIUS) + RED_RADIUS,
    y: Math.random() * (400 - 2 * RED_RADIUS) + RED_RADIUS,
    dx: Math.cos(angle) * RED_SPEED,
    dy: Math.sin(angle) * RED_SPEED,
    trail: []
  };
}

// Update red balls every 30ms
setInterval(() => {
  for (const roomName in rooms) {
    const room = rooms[roomName];
    if (!room.redBalls) continue;
    for (const red of room.redBalls) {
      // Move
      red.x += red.dx;
      red.y += red.dy;
      // Bounce off walls
      if (red.x <= RED_RADIUS || red.x >= 600 - RED_RADIUS) {
        red.dx *= -1;
        red.x = Math.max(RED_RADIUS, Math.min(red.x, 600 - RED_RADIUS));
      }
      if (red.y <= RED_RADIUS || red.y >= 400 - RED_RADIUS) {
        red.dy *= -1;
        red.y = Math.max(RED_RADIUS, Math.min(red.y, 400 - RED_RADIUS));
      }
      // Trails
      if (!red.trail) red.trail = [];
      red.trail.push({ x: red.x, y: red.y });
      if (red.trail.length > TRAIL_LENGTH) red.trail.shift();
    }
    // Broadcast new state
    io.to(roomName).emit('state-update', room);
  }
}, 30);

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
        redBalls: Array.from({length: 10}, () => spawnRedBall()),
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
