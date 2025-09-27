// server.js
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_FILE = path.join(__dirname, 'users.json');
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [] }, null, 2));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple CORS-safe responses for local dev
app.get('/health', (req, res) => res.json({ ok: true }));

// Register endpoint
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });

  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (data.users.find(u => u.username === username)) {
    return res.status(409).json({ error: 'username already taken' });
  }

  const hash = bcrypt.hashSync(password, 8);
  data.users.push({ username, passwordHash: hash, createdAt: Date.now() });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  return res.json({ ok: true, username });
});

// Login endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const user = data.users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const valid = bcrypt.compareSync(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'invalid credentials' });
  // For simplicity we return a basic session token = base64(username:timestamp)
  const token = Buffer.from(`${username}:${Date.now()}`).toString('base64');
  return res.json({ ok: true, username, token });
});

// In-memory state for socket connections
const online = {}; // socketId -> { username }
const usersByName = {}; // username -> socketId (last)

io.on('connection', socket => {
  console.log('socket connected', socket.id);

  // client will emit 'join' with { username, token }
  socket.on('join', ({ username }) => {
    if (!username) return;
    online[socket.id] = { username };
    usersByName[username] = socket.id;
    // notify others
    io.emit('user-list', Object.values(online).map(o => o.username));
    socket.broadcast.emit('system-message', { text: `${username} bergabung`, time: Date.now() });
    console.log(`${username} joined (socket ${socket.id})`);
  });

  socket.on('chat-message', msg => {
    // msg: { to: optional, text }
    const sender = online[socket.id] ? online[socket.id].username : 'Anon';
    const payload = {
      from: sender,
      text: msg.text,
      time: Date.now(),
      to: msg.to || null
    };
    if (msg.to) {
      // private message -> send to specific user if online
      const targetSocket = usersByName[msg.to];
      if (targetSocket) {
        io.to(targetSocket).emit('chat-message', payload);
        socket.emit('chat-message', payload); // echo for sender
      } else {
        socket.emit('system-message', { text: `${msg.to} tidak online`, time: Date.now() });
      }
    } else {
      // public broadcast
      io.emit('chat-message', payload);
    }
  });

  // Game events: 'game-join', 'game-state', 'game-action', 'spawn-item'
  // Simple relay: clients send positions/actions, server rebroadcasts
  socket.on('game-join', (data) => {
    const name = online[socket.id] ? online[socket.id].username : `Player-${socket.id.slice(0,4)}`;
    socket.gameName = name;
    socket.emit('game-joined', { name });
    socket.broadcast.emit('game-player-joined', { name, id: socket.id });
  });

  socket.on('game-action', (action) => {
    // action includes pos/dir etc - broadcast to others
    const name = socket.gameName || (online[socket.id] && online[socket.id].username) || 'Anon';
    io.emit('game-action', { id: socket.id, name, action });
  });

  socket.on('disconnect', () => {
    const user = online[socket.id];
    if (user) {
      socket.broadcast.emit('system-message', { text: `${user.username} keluar`, time: Date.now() });
      delete usersByName[user.username];
    }
    delete online[socket.id];
    io.emit('user-list', Object.values(online).map(o => o.username));
    console.log('socket disconnected', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ReactTelegram server running on http://localhost:${PORT}`);
});
