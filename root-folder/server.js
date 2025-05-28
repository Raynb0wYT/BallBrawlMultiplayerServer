const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer();
const io = new Server(server, {
  cors: { origin: "*" }
});

let waitingPlayer = null;

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('queue', () => {
    if (waitingPlayer && waitingPlayer.connected) {
      // Pair with waiting player
      const room = `room-${waitingPlayer.id}-${socket.id}`;
      socket.join(room);
      waitingPlayer.join(room);
      io.to(room).emit('match-found', { room });
      waitingPlayer = null;
    } else {
      // No one waiting, add to queue
      waitingPlayer = socket;
    }
  });

  socket.on('disconnect', () => {
    if (waitingPlayer === socket) waitingPlayer = null;
    console.log('User disconnected:', socket.id);
  });
});

server.listen(3000, () => {
  console.log('Socket.IO server running on port 3000');
});