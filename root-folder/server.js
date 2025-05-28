const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { 
    origin: ["http://127.0.0.1:3000",
             "https://game-2077d.firebaseapp.com",
             "https://game-2077d.web.app"],
    methods: ["GET", "POST"]
  }
});

let rooms = {};
let waitingPlayer = null;

const RED_RADIUS = 5;
const RED_SPEED = 3.5;
const TRAIL_LENGTH = 30; // Increase this value for a longer trail
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

// Helper to initialize a red ball with trail
function spawnRedBall() {
  let angle = Math.random() * 2 * Math.PI;
  return {
    x: Math.random() * (CANVAS_WIDTH - 2 * RED_RADIUS) + RED_RADIUS,
    y: Math.random() * (CANVAS_HEIGHT - 2 * RED_RADIUS) + RED_RADIUS,
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
      if (red.x <= RED_RADIUS || red.x >= CANVAS_WIDTH - RED_RADIUS) {
        red.dx *= -1;
        red.x = Math.max(RED_RADIUS, Math.min(red.x, CANVAS_WIDTH - RED_RADIUS));
      }
      if (red.y <= RED_RADIUS || red.y >= CANVAS_HEIGHT - RED_RADIUS) {
        red.dy *= -1;
        red.y = Math.max(RED_RADIUS, Math.min(red.y, CANVAS_HEIGHT - RED_RADIUS));
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

// Add this interval at the top-level, after your setInterval for red balls:
setInterval(() => {
  for (const roomName in rooms) {
    const room = rooms[roomName];
    if (!room.players) continue;
    for (const id in room.players) {
      let player = room.players[id];
      if (player.trail && player.trail.length > 0) {
        player.trail.shift(); // Always fade, even if not moving
      }
    }
  }
}, 30);

io.on('connection', (socket) => {
  // Matchmaking logic
  socket.on('find-match', ({ username }) => {
    if (waitingPlayer && waitingPlayer.connected) {
      const room = `room-${waitingPlayer.id}-${socket.id}`;
      socket.join(room);
      waitingPlayer.join(room);
      io.to(room).emit('match-found', { room });
      waitingPlayer = null;
    } else {
      waitingPlayer = socket;
    }
  });

  // Game logic
  socket.on('join-room', ({ room, username, persistentId }) => {
    socket.join(room);

    if (!rooms[room]) {
      rooms[room] = {
        players: {},
        redBalls: Array.from({length: 10}, () => spawnRedBall()),
        scores: {},
        usernames: {},
        persistentMap: {}, // <-- Add this
        persistentColorMap: {} // <-- Add this
      };
    }

    // If this persistentId already exists, transfer state to new socket
    if (persistentId && rooms[room].persistentMap && rooms[room].persistentMap[persistentId]) {
      const oldSocketId = rooms[room].persistentMap[persistentId];
      if (rooms[room].players[oldSocketId]) {
        // Transfer player state to new socket
        rooms[room].players[socket.id] = rooms[room].players[oldSocketId];
        rooms[room].scores[socket.id] = rooms[room].scores[oldSocketId];
        rooms[room].usernames[socket.id] = rooms[room].usernames[oldSocketId];
        delete rooms[room].players[oldSocketId];
        delete rooms[room].scores[oldSocketId];
        delete rooms[room].usernames[oldSocketId];
      }
      rooms[room].persistentMap[persistentId] = socket.id;
    } else {
      // Assign color: first is blue, second is green
      let color;
      if (persistentId && rooms[room].persistentColorMap[persistentId]) {
        // Assign the previous color
        color = rooms[room].persistentColorMap[persistentId];
      } else {
        // Assign color as usual
        color = Object.keys(rooms[room].players).length === 0 ? "blue" : "green";
        if (persistentId) rooms[room].persistentColorMap[persistentId] = color;
      }
      rooms[room].players[socket.id] = { 
        x: color === "blue" ? 100 : 500, 
        y: 200, 
        color, 
        name: username,
        trail: [],
        trailTick: 0,
        disconnected: false
      };
      rooms[room].scores[socket.id] = 0;
      rooms[room].usernames[socket.id] = username;
      if (!rooms[room].persistentMap) rooms[room].persistentMap = {};
      rooms[room].persistentMap[persistentId] = socket.id;
    }

    socket.emit('player-info', { id: socket.id, color: rooms[room].players[socket.id].color });

    // If two players, start the game
    if (Object.keys(rooms[room].players).length === 2) {
      io.to(room).emit('start-game', rooms[room]);
    }
  });

  socket.on('player-input', ({ room, input }) => {
    if (rooms[room] && rooms[room].players[socket.id]) {
      let player = rooms[room].players[socket.id];
      player.trailTick = (player.trailTick || 0) + 1;
      const oldX = player.x;
      const oldY = player.y;
      player.x += input.dx;
      player.y += input.dy;
      player.x = Math.max(15, Math.min(CANVAS_WIDTH - 15, player.x));
      player.y = Math.max(15, Math.min(CANVAS_HEIGHT - 15, player.y));
      if (player.x !== oldX || player.y !== oldY) {
        if (!player.trail) player.trail = [];
        if (player.trailTick % 3 === 0) {
          player.trail.push({ x: player.x, y: player.y });
        }
      }
      for (let i = 0; i < rooms[room].redBalls.length; i++) {
        const ball = rooms[room].redBalls[i];
        const dx = rooms[room].players[socket.id].x - ball.x;
        const dy = rooms[room].players[socket.id].y - ball.y;
        if (Math.sqrt(dx*dx + dy*dy) < 25) {
          rooms[room].scores[socket.id]++;
          rooms[room].redBalls[i] = spawnRedBall();
        }
      }
      io.to(room).emit('state-update', rooms[room]);
    }
  });

  socket.on('player-left', ({ room }) => {
    const otherPlayerId = Object.keys(rooms[room].players).find(id => id !== socket.id);
    if (otherPlayerId) {
      io.to(otherPlayerId).emit('opponent-left');
    }
    // Remove player from room, etc.
  });

  socket.on('disconnect', () => {
    for (let room in rooms) {
      if (rooms[room].players[socket.id]) {
        // Remove persistentId mapping
        if (rooms[room].persistentMap) {
          for (const pid in rooms[room].persistentMap) {
            if (rooms[room].persistentMap[pid] === socket.id) {
              delete rooms[room].persistentMap[pid];
              break;
            }
          }
        }
        // Remove player from room entirely
        delete rooms[room].players[socket.id];
        delete rooms[room].scores[socket.id];
        delete rooms[room].usernames[socket.id];
        if (Object.keys(rooms[room].players).length === 0) {
          delete rooms[room];
        }
        // Do NOT emit 'force-disconnect' here!
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
