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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client', 'index.html'));
});

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

const PLAYER_COLORS = ['#e84b3a','#4b8fc8','#4bc87a','#c8a84b','#c84bc8','#4bc8c8'];

// ─── BÂTIMENTS ────────────────────────────────────────────────────────────────
const BUILDINGS_DEF = {
  recruit_post: {
    id: 'recruit_post',
    name: 'Poste de recrutement',
    cost: { gold: 325, mat: 450 },
  },
};

// ─── HEX MAP ─────────────────────────────────────────────────────────────────

function getNeighbors(col, row, cols, rows) {
  const isEven = col % 2 === 0;
  const dirs = isEven
    ? [[-1,-1],[-1,0],[0,-1],[0,1],[1,-1],[1,0]]
    : [[-1,0],[-1,1],[0,-1],[0,1],[1,0],[1,1]];
  return dirs
    .map(([dc, dr]) => ({ col: col + dc, row: row + dr }))
    .filter(({ col: c, row: r }) => c >= 0 && r >= 0 && c < cols && r < rows);
}

function generateMap(cols = 10, rows = 8) {
  const tiles = {};
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const key = `${c},${r}`;
      const edgeFactor = (c === 0 || c === cols-1 || r === 0 || r === rows-1) ? 0.45 : 0.18;
      tiles[key] = {
        col: c, row: r,
        active: Math.random() > edgeFactor,
        owner: null,
        color: null,
        building: null,
      };
    }
  }

  const centerKey = `${Math.floor(cols/2)},${Math.floor(rows/2)}`;
  tiles[centerKey].active = true;
  const visited = new Set([centerKey]);
  const queue = [centerKey];
  while (queue.length) {
    const key = queue.shift();
    const [c, r] = key.split(',').map(Number);
    for (const nb of getNeighbors(c, r, cols, rows)) {
      const nbKey = `${nb.col},${nb.row}`;
      if (!visited.has(nbKey) && tiles[nbKey].active) {
        visited.add(nbKey);
        queue.push(nbKey);
      }
    }
  }
  for (const key of Object.keys(tiles)) {
    if (tiles[key].active && !visited.has(key)) tiles[key].active = false;
  }

  return { tiles, cols, rows };
}

function chooseStartPositions(map, count) {
  const active = Object.values(map.tiles).filter(t => t.active);
  const positions = [];
  for (let i = 0; i < count; i++) {
    let best = null, bestDist = -1;
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = active[Math.floor(Math.random() * active.length)];
      const key = `${candidate.col},${candidate.row}`;
      if (positions.some(p => p.key === key)) continue;
      const minD = positions.reduce((min, p) => {
        return Math.min(min, Math.abs(candidate.col - p.col) + Math.abs(candidate.row - p.row));
      }, Infinity);
      if (positions.length === 0 || minD > bestDist) {
        bestDist = minD;
        best = { key, col: candidate.col, row: candidate.row };
      }
    }
    if (best) positions.push(best);
  }
  return positions;
}

// ─── STATE ────────────────────────────────────────────────────────────────────

const rooms = new Map();
const playerRoom = new Map();

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function createRoom(hostSocket) {
  let code;
  do { code = genCode(); } while (rooms.has(code));
  const player = {
    id: hostSocket.id, name: randName(), socketId: hostSocket.id,
    isHost: true, colorIndex: 0, color: PLAYER_COLORS[0],
    resources: { gold: 0, mat: 0, mec: 0, fuel: 0 },
  };
  const room = {
    code, hostId: hostSocket.id,
    players: new Map([[hostSocket.id, player]]),
    status: 'lobby', tickInterval: null, tickCount: 0, map: null,
  };
  rooms.set(code, room);
  playerRoom.set(hostSocket.id, code);
  hostSocket.join(code);
  return { room, player };
}

function joinRoom(code, socket) {
  const room = rooms.get(code.toUpperCase());
  if (!room) return { error: 'SALLE INTROUVABLE — VÉRIFIEZ LE CODE' };
  if (room.status !== 'lobby') return { error: 'PARTIE DÉJÀ EN COURS' };
  if (room.players.size >= 6) return { error: 'SALLE PLEINE (6/6)' };
  const colorIndex = room.players.size;
  const player = {
    id: socket.id, name: randName(), socketId: socket.id,
    isHost: false, colorIndex, color: PLAYER_COLORS[colorIndex],
    resources: { gold: 0, mat: 0, mec: 0, fuel: 0 },
  };
  room.players.set(socket.id, player);
  playerRoom.set(socket.id, code.toUpperCase());
  socket.join(code.toUpperCase());
  return { room, player };
}

function leaveRoom(socketId) {
  const code = playerRoom.get(socketId);
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  room.players.delete(socketId);
  playerRoom.delete(socketId);
  if (room.players.size === 0) {
    if (room.tickInterval) clearInterval(room.tickInterval);
    rooms.delete(code);
    return;
  }
  if (room.hostId === socketId) {
    const newHost = room.players.values().next().value;
    newHost.isHost = true;
    room.hostId = newHost.socketId;
  }
  if (room.map) {
    for (const tile of Object.values(room.map.tiles)) {
      if (tile.owner === socketId) { tile.owner = null; tile.color = null; tile.building = null; }
    }
    io.to(code).emit('map:update', room.map.tiles);
  }
  broadcastLobby(code);
}

function roomPublicState(room) {
  return {
    code: room.code, status: room.status, hostId: room.hostId,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, isHost: p.isHost, color: p.color, resources: p.resources,
    })),
  };
}

function broadcastLobby(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit('lobby:update', roomPublicState(room));
}

function isAdjacentToPlayer(map, col, row, playerId) {
  return getNeighbors(col, row, map.cols, map.rows).some(nb => {
    const t = map.tiles[`${nb.col},${nb.row}`];
    return t && t.owner === playerId;
  });
}

function broadcastResources(room) {
  const resources = {};
  for (const [sid, p] of room.players) resources[sid] = p.resources;
  io.to(room.code).emit('game:resources', resources);
}

function startGame(room) {
  room.status = 'playing';
  room.map = generateMap(10, 8);
  const playerList = Array.from(room.players.values());
  const starts = chooseStartPositions(room.map, playerList.length);

  starts.forEach((pos, i) => {
    if (!pos) return;
    const player = playerList[i];
    const tile = room.map.tiles[pos.key];
    tile.owner = player.id;
    tile.color = player.color;
    // Ressources de départ
    player.resources = { gold: 500, mat: 500, mec: 500, fuel: 500 };
  });

  io.to(room.code).emit('game:start', {
    map: room.map,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, color: p.color, resources: p.resources,
    })),
  });

  for (const [sid, player] of room.players) {
    io.to(sid).emit('game:myId', { myId: sid, color: player.color });
  }

  broadcastResources(room);

  room.tickInterval = setInterval(() => {
    room.tickCount++;
    // Toutes les 4 ticks (2 secondes) : gain de ressources
    if (room.tickCount % 4 === 0) {
      for (const player of room.players.values()) {
        const owned = Object.values(room.map.tiles).filter(t => t.owner === player.id).length;
        player.resources.gold += owned;
        // Légère production passive de mat et fuel selon les cases possédées
        player.resources.mat += Math.floor(owned / 2);
      }
      broadcastResources(room);
    }
    io.to(room.code).emit('game:tick', { tick: room.tickCount });
  }, 500);
}

// ─── SOCKET EVENTS ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  socket.on('room:create', (_, cb) => {
    const { room, player } = createRoom(socket);
    cb?.({ success: true, room: roomPublicState(room), me: player });
    broadcastLobby(room.code);
  });

  socket.on('room:join', ({ code }, cb) => {
    const result = joinRoom(code, socket);
    if (result.error) { cb?.({ success: false, error: result.error }); return; }
    const { room, player } = result;
    cb?.({ success: true, room: roomPublicState(room), me: player });
    broadcastLobby(room.code);
  });

  socket.on('room:leave', () => leaveRoom(socket.id));

  socket.on('game:start', (_, cb) => {
    const code = playerRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return cb?.({ success: false, error: 'Salle introuvable' });
    if (room.hostId !== socket.id) return cb?.({ success: false, error: 'Seul l\'hôte peut lancer' });
    if (room.players.size < 2) return cb?.({ success: false, error: 'Minimum 2 joueurs' });
    if (room.status !== 'lobby') return cb?.({ success: false, error: 'Déjà lancée' });
    startGame(room);
    cb?.({ success: true });
  });

  socket.on('tile:capture', ({ col, row }, cb) => {
    const code = playerRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const key = `${col},${row}`;
    const tile = room.map.tiles[key];
    if (!tile || !tile.active) return cb?.({ success: false, error: 'Case invalide' });
    if (tile.owner === socket.id) return cb?.({ success: false, error: 'Déjà à toi' });
    if (!isAdjacentToPlayer(room.map, col, row, socket.id)) return cb?.({ success: false, error: 'Pas adjacent' });
    if (player.resources.gold < 5) return cb?.({ success: false, error: 'Pas assez d\'argent (5💰 requis)' });

    player.resources.gold -= 5;
    tile.owner = socket.id;
    tile.color = player.color;

    io.to(code).emit('map:update', { [key]: tile });
    broadcastResources(room);
    cb?.({ success: true });

    // Vérif victoire 60%
    const activeTiles = Object.values(room.map.tiles).filter(t => t.active).length;
    const owned = Object.values(room.map.tiles).filter(t => t.owner === socket.id).length;
    if (owned / activeTiles >= 0.6) {
      clearInterval(room.tickInterval);
      io.to(code).emit('game:over', { winner: { id: socket.id, name: player.name, color: player.color } });
    }
  });

  // ── Construction de bâtiment ──
  socket.on('tile:build', ({ col, row, buildingId }, cb) => {
    const code = playerRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return cb?.({ success: false, error: 'Partie non active' });
    const player = room.players.get(socket.id);
    if (!player) return cb?.({ success: false, error: 'Joueur introuvable' });

    const key = `${col},${row}`;
    const tile = room.map.tiles[key];
    if (!tile || !tile.active) return cb?.({ success: false, error: 'Case invalide' });
    if (tile.owner !== socket.id) return cb?.({ success: false, error: 'Ce n\'est pas votre territoire' });
    if (tile.building) return cb?.({ success: false, error: 'Un bâtiment existe déjà ici' });

    const def = BUILDINGS_DEF[buildingId];
    if (!def) return cb?.({ success: false, error: 'Bâtiment inconnu' });

    // Vérifier les ressources
    for (const [resType, cost] of Object.entries(def.cost)) {
      if ((player.resources[resType] ?? 0) < cost) {
        return cb?.({ success: false, error: `Pas assez de ${resType} (${cost} requis)` });
      }
    }

    // Débiter les ressources
    for (const [resType, cost] of Object.entries(def.cost)) {
      player.resources[resType] -= cost;
    }

    tile.building = buildingId;
    io.to(code).emit('map:update', { [key]: tile });
    broadcastResources(room);
    cb?.({ success: true });
  });

  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] ${socket.id}`);
    leaveRoom(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎖  FRONTLINE COMMAND — Serveur démarré`);
  console.log(`📡  http://localhost:${PORT}\n`);
});
