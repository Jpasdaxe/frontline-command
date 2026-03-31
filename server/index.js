const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.static(path.join(__dirname, '../client')));

// ─── UTILS ───────────────────────────────────────────────────────────────────

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  return Array.from({ length: 4 }, () =>
    CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  ).join('');
}

const NAMES = ['ALPHA','BRAVO','CHARLIE','DELTA','ECHO','FOXTROT','GHOST',
               'HAWK','IRON','JAGER','KILO','LIMA','NOVA','OMEGA'];
function randName() {
  const n = NAMES[Math.floor(Math.random() * NAMES.length)];
  const num = String(Math.floor(Math.random() * 99) + 1).padStart(2, '0');
  return `${n}-${num}`;
}

// ─── STATE ────────────────────────────────────────────────────────────────────

// rooms: Map<code, Room>
// Room = { code, hostId, players: Map<socketId, Player>, status: 'lobby'|'playing'|'ended', tickInterval }
// Player = { id, name, socketId, ready }
const rooms = new Map();

// socketId → roomCode  (pour retrouver la salle d'un joueur rapidement)
const playerRoom = new Map();

// ─── ROOM HELPERS ─────────────────────────────────────────────────────────────

function createRoom(hostSocket) {
  let code;
  do { code = genCode(); } while (rooms.has(code));

  const player = {
    id: hostSocket.id,
    name: randName(),
    socketId: hostSocket.id,
    isHost: true,
  };

  const room = {
    code,
    hostId: hostSocket.id,
    players: new Map([[hostSocket.id, player]]),
    status: 'lobby',
    tickInterval: null,
    tickCount: 0,
  };

  rooms.set(code, room);
  playerRoom.set(hostSocket.id, code);
  hostSocket.join(code);

  console.log(`[ROOM] Créée: ${code} par ${player.name}`);
  return { room, player };
}

function joinRoom(code, socket) {
  const room = rooms.get(code.toUpperCase());
  if (!room) return { error: 'SALLE INTROUVABLE — VÉRIFIEZ LE CODE' };
  if (room.status !== 'lobby') return { error: 'PARTIE DÉJÀ EN COURS' };
  if (room.players.size >= 8) return { error: 'SALLE PLEINE (8/8)' };

  const player = {
    id: socket.id,
    name: randName(),
    socketId: socket.id,
    isHost: false,
  };

  room.players.set(socket.id, player);
  playerRoom.set(socket.id, code.toUpperCase());
  socket.join(code.toUpperCase());

  console.log(`[ROOM] ${player.name} a rejoint ${code}`);
  return { room, player };
}

function leaveRoom(socketId) {
  const code = playerRoom.get(socketId);
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  const player = room.players.get(socketId);
  room.players.delete(socketId);
  playerRoom.delete(socketId);

  console.log(`[ROOM] ${player?.name || socketId} a quitté ${code}`);

  // Si plus personne → supprimer la salle
  if (room.players.size === 0) {
    if (room.tickInterval) clearInterval(room.tickInterval);
    rooms.delete(code);
    console.log(`[ROOM] Salle ${code} supprimée (vide)`);
    return;
  }

  // Si l'hôte est parti → transférer le host au premier joueur restant
  if (room.hostId === socketId) {
    const newHost = room.players.values().next().value;
    newHost.isHost = true;
    room.hostId = newHost.socketId;
    console.log(`[ROOM] ${newHost.name} est le nouvel hôte de ${code}`);
  }

  broadcastLobby(code);
}

function roomPublicState(room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
    })),
  };
}

function broadcastLobby(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('lobby:update', roomPublicState(room));
}

// ─── GAME TICK ────────────────────────────────────────────────────────────────

function startGame(room) {
  room.status = 'playing';
  broadcastLobby(room.code); // notif de changement de statut

  io.to(room.code).emit('game:start', {
    message: 'Partie lancée ! (moteur de jeu à venir)',
    players: Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name })),
  });

  // Tick loop — toutes les 500ms
  room.tickInterval = setInterval(() => {
    room.tickCount++;
    io.to(room.code).emit('game:tick', {
      tick: room.tickCount,
      timestamp: Date.now(),
      // Plus tard : état complet de la carte, unités, ressources
    });
  }, 500);

  console.log(`[GAME] Partie démarrée dans ${room.code}`);
}

// ─── SOCKET EVENTS ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // Créer une salle
  socket.on('room:create', (_, cb) => {
    const { room, player } = createRoom(socket);
    cb?.({ success: true, room: roomPublicState(room), me: player });
    broadcastLobby(room.code);
  });

  // Rejoindre une salle
  socket.on('room:join', ({ code }, cb) => {
    const result = joinRoom(code, socket);
    if (result.error) {
      cb?.({ success: false, error: result.error });
      return;
    }
    const { room, player } = result;
    cb?.({ success: true, room: roomPublicState(room), me: player });
    broadcastLobby(room.code);
  });

  // Quitter manuellement
  socket.on('room:leave', () => {
    leaveRoom(socket.id);
  });

  // Lancer la partie (hôte seulement)
  socket.on('game:start', (_, cb) => {
    const code = playerRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return cb?.({ success: false, error: 'Salle introuvable' });
    if (room.hostId !== socket.id) return cb?.({ success: false, error: 'Seul l\'hôte peut lancer' });
    if (room.players.size < 2) return cb?.({ success: false, error: 'Minimum 2 joueurs' });
    if (room.status !== 'lobby') return cb?.({ success: false, error: 'Partie déjà lancée' });

    startGame(room);
    cb?.({ success: true });
  });

  // Déconnexion
  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] ${socket.id}`);
    leaveRoom(socket.id);
  });

  // Debug: liste des salles (dev only)
  socket.on('debug:rooms', (_, cb) => {
    const list = Array.from(rooms.values()).map(r => ({
      code: r.code,
      players: r.players.size,
      status: r.status,
    }));
    cb?.({ rooms: list });
  });
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎖  FRONTLINE COMMAND — Serveur démarré`);
  console.log(`📡  http://localhost:${PORT}\n`);
});
