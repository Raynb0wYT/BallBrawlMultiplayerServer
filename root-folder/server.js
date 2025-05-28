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
        player.trail.shift(); // Always fade the trail, even if not moving
      }
    }
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
    rooms[room].players[socket.id] = { 
      x: color === "blue" ? 100 : 500, 
      y: 200, 
      color, 
      name: username,
      trail: [] // <-- Add this when creating a player
    };
    rooms[room].scores[socket.id] = 0;
    rooms[room].usernames[socket.id] = username;
    socket.emit('player-info', { id: socket.id, color });

    // If two players, start the game
    if (Object.keys(rooms[room].players).length === 2) {
      io.to(room).emit('start-game', rooms[room]);
    }
  });

  socket.on('player-input', ({ room, input }) => {
    console.log("Received input:", input); // <--- Add this line
    if (rooms[room] && rooms[room].players[socket.id]) {
      // Move player
      rooms[room].players[socket.id].x += input.dx;
      rooms[room].players[socket.id].y += input.dy;

      // Clamp to canvas
      rooms[room].players[socket.id].x = Math.max(15, Math.min(CANVAS_WIDTH - 15, rooms[room].players[socket.id].x));
      rooms[room].players[socket.id].y = Math.max(15, Math.min(CANVAS_HEIGHT - 15, rooms[room].players[socket.id].y));

      // --- Add this block to update the trail ---
      let player = rooms[room].players[socket.id];
      const oldX = player.x;
      const oldY = player.y;
      player.x = Math.max(15, Math.min(CANVAS_WIDTH - 15, player.x));
      player.y = Math.max(15, Math.min(CANVAS_HEIGHT - 15, player.y));
      if (player.x !== oldX || player.y !== oldY) {
        if (!player.trail) player.trail = [];
        player.trail.push({ x: player.x, y: player.y });
        // No need to shift here, since the interval above handles fading
      }
      // ------------------------------------------

      // Collision detection with red balls
      for (let i = 0; i < rooms[room].redBalls.length; i++) {
        const ball = rooms[room].redBalls[i];
        const dx = rooms[room].players[socket.id].x - ball.x;
        const dy = rooms[room].players[socket.id].y - ball.y;
        if (Math.sqrt(dx*dx + dy*dy) < 25) { // 15 (player) + 10 (red)
          // Score and respawn red ball
          rooms[room].scores[socket.id]++;
          rooms[room].redBalls[i] = spawnRedBall();
        }
      }

      io.to(room).emit('state-update', rooms[room]);
    }
  });

  socket.on('disconnect', () => {
    for (let room in rooms) {
      if (rooms[room].players[socket.id]) {
        const otherPlayerId = Object.keys(rooms[room].players).find(id => id !== socket.id);
        // Notify the other player they win
        if (otherPlayerId) {
          io.to(otherPlayerId).emit('opponent-left');
        }
        // Notify the disconnecting player
        socket.emit('self-disconnected');
        // Remove player from room
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
