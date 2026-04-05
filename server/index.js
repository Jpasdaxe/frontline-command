const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.static(path.join(__dirname, '../client')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client', 'index.html')));

// ─── UTILS ───────────────────────────────────────────────────────────────────

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  return Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}
const NAMES = ['ALPHA','BRAVO','CHARLIE','DELTA','ECHO','FOXTROT','GHOST','HAWK','IRON','JAGER','KILO','LIMA','NOVA','OMEGA'];
function randName() {
  return NAMES[Math.floor(Math.random()*NAMES.length)] + '-' + String(Math.floor(Math.random()*99)+1).padStart(2,'0');
}
const PLAYER_COLORS = ['#e84b3a','#4b8fc8','#4bc87a','#c8a84b','#c84bc8','#4bc8c8'];

// ─── BUILDINGS & UNITS ────────────────────────────────────────────────────────

const BUILDINGS_DEF = {
  recruit_post: {
    id: 'recruit_post',
    name: 'Poste de recrutement',
    baseCost: { gold: 325, mat: 450 },
    // +50% par poste déjà construit
    getCost(ownedCount) {
      const mult = Math.pow(1.5, ownedCount);
      return { gold: Math.round(325 * mult), mat: Math.round(450 * mult) };
    },
  },
  military_camp: {
    id: 'military_camp',
    name: 'Camp militaire',
    baseCost: { gold: 1000, mat: 800 },
    getCost() { return { gold: 1000, mat: 800 }; },
  },
};

const UNITS_DEF = {
  soldier: {
    id: 'soldier',
    name: 'Soldat',
    emoji: '🪖',
    cost: { gold: 100, mec: 25 },
    productionTime: 30000, // 30s en ms
    hp: 3,
    maxHp: 3,
    resistance: 2,       // 1 chance sur N de perdre 1 PV lors d'une attaque
    attackSpeed: 2000,   // ms entre chaque attaque
    moveSpeed: 10000,    // ms par arête
  },
};

// ─── HEX MAP ─────────────────────────────────────────────────────────────────

function getNeighbors(col, row, cols, rows) {
  const dirs = col % 2 === 0
    ? [[-1,-1],[-1,0],[0,-1],[0,1],[1,-1],[1,0]]
    : [[-1,0],[-1,1],[0,-1],[0,1],[1,0],[1,1]];
  return dirs.map(([dc,dr]) => ({ col: col+dc, row: row+dr }))
    .filter(({ col: c, row: r }) => c >= 0 && r >= 0 && c < cols && r < rows);
}

function generateMap(cols=10, rows=8) {
  const tiles = {};
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const key = `${c},${r}`;
      const edgeFactor = (c===0||c===cols-1||r===0||r===rows-1) ? 0.45 : 0.18;
      tiles[key] = { col:c, row:r, active: Math.random()>edgeFactor, owner:null, color:null, building:null, troops:0 };
    }
  }
  const centerKey = `${Math.floor(cols/2)},${Math.floor(rows/2)}`;
  tiles[centerKey].active = true;
  const visited = new Set([centerKey]);
  const queue = [centerKey];
  while (queue.length) {
    const key = queue.shift();
    const [c,r] = key.split(',').map(Number);
    for (const nb of getNeighbors(c,r,cols,rows)) {
      const nbKey = `${nb.col},${nb.row}`;
      if (!visited.has(nbKey) && tiles[nbKey].active) { visited.add(nbKey); queue.push(nbKey); }
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
      const candidate = active[Math.floor(Math.random()*active.length)];
      const key = `${candidate.col},${candidate.row}`;
      if (positions.some(p => p.key === key)) continue;
      const minD = positions.reduce((min,p) => Math.min(min, Math.abs(candidate.col-p.col)+Math.abs(candidate.row-p.row)), Infinity);
      if (positions.length === 0 || minD > bestDist) { bestDist = minD; best = { key, col:candidate.col, row:candidate.row }; }
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
    resources: { gold:0, mat:0, mec:0, fuel:0 },
    troops: 0, // troupes disponibles (non déployées)
  };
  const room = {
    code, hostId: hostSocket.id,
    players: new Map([[hostSocket.id, player]]),
    status: 'lobby', tickInterval: null, tickCount: 0, map: null,
    productionQueues: new Map(), // tileKey → [{ unitId, playerId, endsAt }]
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
    resources: { gold:0, mat:0, mec:0, fuel:0 },
    troops: 0,
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
      if (tile.owner === socketId) { tile.owner = null; tile.color = null; tile.building = null; tile.troops = 0; }
    }
    io.to(code).emit('map:update', room.map.tiles);
  }
  broadcastLobby(code);
}

function roomPublicState(room) {
  return {
    code: room.code, status: room.status, hostId: room.hostId,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, isHost: p.isHost, color: p.color,
      resources: p.resources, troops: p.troops,
    })),
  };
}

function broadcastLobby(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit('lobby:update', roomPublicState(room));
}

function broadcastResources(room) {
  const data = {};
  for (const [sid, p] of room.players) {
    data[sid] = { resources: p.resources, troops: p.troops };
  }
  io.to(room.code).emit('game:resources', data);
}

function isAdjacentToPlayer(map, col, row, playerId) {
  return getNeighbors(col, row, map.cols, map.rows).some(nb => {
    const t = map.tiles[`${nb.col},${nb.row}`];
    return t && t.owner === playerId;
  });
}

// ─── PRODUCTION ───────────────────────────────────────────────────────────────

function processProduction(room) {
  const now = Date.now();
  const updatedTiles = {};
  let resourcesChanged = false;

  for (const [tileKey, queue] of room.productionQueues) {
    if (!queue.length) { room.productionQueues.delete(tileKey); continue; }

    const tile = room.map?.tiles[tileKey];
    if (!tile || !tile.active) { room.productionQueues.delete(tileKey); continue; }

    // Traiter tous les items terminés dans la file
    while (queue.length > 0 && queue[0].endsAt <= now) {
      const item = queue.shift();
      const player = room.players.get(item.playerId);
      if (player) {
        // Créer l'unité sur le camp
        const tile = room.map?.tiles[tileKey];
        if (tile) {
          const def = UNITS_DEF[item.unitId];
          const unit = {
            id: `u${room.nextUnitId++}`,
            playerId: item.playerId,
            color: player.color,
            type: item.unitId,
            col: tile.col, row: tile.row,
            hp: def.hp, maxHp: def.maxHp,
            state: 'idle',
            path: [], pathIndex: 0,
            moveStartTime: 0,
            lastAttackTime: 0,
            attackTarget: null,
            captureTimer: null,
          };
          room.units.set(unit.id, unit);
          io.to(room.code).emit('unit:update', serializeUnit(unit));
          resourcesChanged = true;
          console.log(`[PROD] ${player.name} +1 ${item.unitId} (id: ${unit.id})`);
        }
      }
    }

    // Nettoyer si vide
    if (queue.length === 0) {
      room.productionQueues.delete(tileKey);
    }

    updatedTiles[tileKey] = tile;
  }

  if (resourcesChanged) {
    broadcastResources(room);
  }

  // Broadcast de l'état des files de production
  const queuesState = {};
  for (const [tileKey, queue] of room.productionQueues) {
    if (queue.length > 0) {
      queuesState[tileKey] = {
        count: queue.length,
        nextEndsAt: queue[0].endsAt,
        playerId: queue[0].playerId,
      };
    }
  }
  io.to(room.code).emit('production:update', queuesState);
}

// ─── PATHFINDING A* HEX ──────────────────────────────────────────────────────

function hexDistance(c1, r1, c2, r2) {
  // Distance approximative en hex
  return Math.sqrt((c1-c2)**2 + (r1-r2)**2);
}

function findPath(map, startCol, startRow, endCol, endRow) {
  const key = (c,r) => `${c},${r}`;
  const open = new Map();
  const closed = new Set();
  const gScore = new Map();
  const fScore = new Map();
  const parent = new Map();

  const startKey = key(startCol, startRow);
  const endKey = key(endCol, endRow);

  open.set(startKey, { col: startCol, row: startRow });
  gScore.set(startKey, 0);
  fScore.set(startKey, hexDistance(startCol, startRow, endCol, endRow));

  let iterations = 0;
  while (open.size > 0 && iterations++ < 500) {
    // Trouver le noeud avec le plus petit fScore
    let current = null, bestF = Infinity;
    for (const [k, node] of open) {
      const f = fScore.get(k) ?? Infinity;
      if (f < bestF) { bestF = f; current = k; }
    }
    if (!current) break;
    if (current === endKey) {
      // Reconstruire le chemin
      const path = [];
      let c = current;
      while (parent.has(c)) { path.unshift(c); c = parent.get(c); }
      return path;
    }
    const node = open.get(current);
    open.delete(current);
    closed.add(current);

    for (const nb of getNeighbors(node.col, node.row, map.cols, map.rows)) {
      const nbKey = key(nb.col, nb.row);
      if (closed.has(nbKey)) continue;
      const tile = map.tiles[nbKey];
      if (!tile || !tile.active) continue;

      const tentativeG = (gScore.get(current) ?? Infinity) + 1;
      if (tentativeG < (gScore.get(nbKey) ?? Infinity)) {
        parent.set(nbKey, current);
        gScore.set(nbKey, tentativeG);
        fScore.set(nbKey, tentativeG + hexDistance(nb.col, nb.row, endCol, endRow));
        open.set(nbKey, nb);
      }
    }
  }
  return null; // pas de chemin
}

function serializeUnit(u) {
  return {
    id: u.id, playerId: u.playerId, color: u.color,
    col: u.col, row: u.row,
    type: u.type, hp: u.hp, maxHp: u.maxHp,
    state: u.state, path: u.path,
    attackTarget: u.attackTarget || null,
  };
}

// ─── TICK UNITÉS ─────────────────────────────────────────────────────────────

function processUnits(room) {
  if (!room.units || room.units.size === 0) return;
  const now = Date.now();
  const updatedUnits = [];
  const updatedTiles = {};

  for (const [, unit] of room.units) {
    // Déplacement
    if (unit.state === 'moving' && unit.path && unit.path.length > 0) {
      const moveTime = UNITS_DEF[unit.type].moveSpeed;
      const elapsed = now - unit.moveStartTime;
      if (elapsed >= moveTime) {
        // Avancer d'un pas
        const nextKey = unit.path[unit.pathIndex];
        if (nextKey) {
          const [nc, nr] = nextKey.split(',').map(Number);
          unit.col = nc; unit.row = nr;
          unit.pathIndex++;
          unit.moveStartTime = now;

          // Vérifier si arrivé à destination ou hex ennemi adjacent
          const tile = room.map.tiles[nextKey];
          if (tile && tile.owner && tile.owner !== unit.playerId) {
            // Hex ennemi atteint → attaquer
            unit.state = 'attacking';
            unit.attackTarget = nextKey;
            unit.lastAttackTime = now;
            unit.path = [];
          } else if (unit.pathIndex >= unit.path.length) {
            unit.state = 'idle';
            unit.path = [];
          }
          updatedUnits.push(unit);
        }
      }
    }

    // Attaque
    if (unit.state === 'attacking' && unit.attackTarget) {
      const def = UNITS_DEF[unit.type];
      const tile = room.map.tiles[unit.attackTarget];

      // Vérifier que la tile est toujours ennemie
      if (!tile || tile.owner === unit.playerId || !tile.owner) {
        // Plus d'ennemi — capturer si pas de troupes
        if (tile && !tile.owner) {
          // Timer de 5s pour capturer
          if (!unit.captureTimer) unit.captureTimer = now;
          if (now - unit.captureTimer >= 5000) {
            tile.owner = unit.playerId;
            const player = room.players.get(unit.playerId);
            tile.color = player?.color || '#fff';
            updatedTiles[unit.attackTarget] = tile;
            unit.state = 'idle';
            unit.attackTarget = null;
            unit.captureTimer = null;
            updatedUnits.push(unit);

            // Vérif victoire
            const activeTiles = Object.values(room.map.tiles).filter(t => t.active).length;
            const owned = Object.values(room.map.tiles).filter(t => t.owner === unit.playerId).length;
            if (owned / activeTiles >= 0.6) {
              clearInterval(room.tickInterval);
              const p = room.players.get(unit.playerId);
              io.to(room.code).emit('game:over', { winner: { id: unit.playerId, name: p?.name, color: p?.color } });
            }
          }
        } else {
          unit.state = 'idle';
          unit.attackTarget = null;
          unit.captureTimer = null;
          updatedUnits.push(unit);
        }
        continue;
      }

      unit.captureTimer = null;

      // Attaque toutes les attackSpeed ms
      if (now - (unit.lastAttackTime || 0) >= def.attackSpeed) {
        unit.lastAttackTime = now;

        if ((tile.troops || 0) > 0) {
          // Troupes présentes — attaquer une troupe
          tile.troops--;
          updatedTiles[unit.attackTarget] = tile;

          // L'unité peut perdre un PV (1 chance sur resistance)
          if (Math.random() < 1 / def.resistance) {
            unit.hp--;
            if (unit.hp <= 0) {
              // Unité détruite
              room.units.delete(unit.id);
              io.to(room.code).emit('unit:remove', { id: unit.id });
              continue;
            }
          }
        } else {
          // Plus de troupes — lancer le timer de capture (5s)
          if (!unit.captureTimer) unit.captureTimer = now;
        }
        updatedUnits.push(unit);
      }
    }
  }

  // Broadcast des changements
  if (updatedUnits.length > 0) {
    io.to(room.code).emit('units:batch', updatedUnits.map(serializeUnit));
  }
  if (Object.keys(updatedTiles).length > 0) {
    io.to(room.code).emit('map:update', updatedTiles);
    broadcastResources(room);
  }
}

// ─── GAME START ───────────────────────────────────────────────────────────────

function startGame(room) {
  room.status = 'playing';
  room.map = generateMap(10, 8);
  room.units = new Map(); // id → unit
  room.nextUnitId = 1;
  const playerList = Array.from(room.players.values());
  const starts = chooseStartPositions(room.map, playerList.length);

  starts.forEach((pos, i) => {
    if (!pos) return;
    const player = playerList[i];
    const tile = room.map.tiles[pos.key];
    tile.owner = player.id;
    tile.color = player.color;
    player.resources = { gold: 500, mat: 500, mec: 500, fuel: 500 };
    player.troops = 0;

    // Donner 1 soldat de départ sur la case de départ
    const startUnit = {
      id: `u${room.nextUnitId++}`,
      playerId: player.id,
      color: player.color,
      type: 'soldier',
      col: pos.col, row: pos.row,
      hp: 3, maxHp: 3,
      state: 'idle',
      path: [], pathIndex: 0,
      moveStartTime: 0,
      lastAttackTime: 0,
      attackTarget: null,
      captureTimer: null,
    };
    room.units.set(startUnit.id, startUnit);
  });

  io.to(room.code).emit('game:start', {
    map: room.map,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, color: p.color, resources: p.resources, troops: p.troops,
    })),
    units: Array.from(room.units.values()).map(serializeUnit),
  });

  for (const [sid, player] of room.players) {
    io.to(sid).emit('game:myId', { myId: sid, color: player.color });
  }

  broadcastResources(room);

  room.tickInterval = setInterval(() => {
    room.tickCount++;

    // Traitement de la production toutes les 500ms
    processProduction(room);

    // Traitement des unités
    processUnits(room);

    // Gain de ressources toutes les 4 ticks (2s)
    if (room.tickCount % 4 === 0) {
      for (const player of room.players.values()) {
        const tiles = Object.values(room.map.tiles).filter(t => t.owner === player.id);
        const owned = tiles.length;
        const camps = tiles.filter(t => t.building === 'military_camp').length;
        const posts = tiles.filter(t => t.building === 'recruit_post').length;

        player.resources.gold += owned;
        player.resources.mat += Math.floor(owned / 2);
        player.resources.mec += camps * 2;
        player.resources.fuel += posts;
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

  // ── Capture de territoire (plus par l'or, préparation pour unités) ──
  // Gardé pour compatibilité mais coût réduit
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
    if (player.resources.gold < 5) return cb?.({ success: false, error: 'Pas assez d\'or (5💰)' });

    player.resources.gold -= 5;
    tile.owner = socket.id;
    tile.color = player.color;
    // Les troupes ennemies sur la case restent (seront gérées par le combat plus tard)

    io.to(code).emit('map:update', { [key]: tile });
    broadcastResources(room);
    cb?.({ success: true });

    const activeTiles = Object.values(room.map.tiles).filter(t => t.active).length;
    const owned = Object.values(room.map.tiles).filter(t => t.owner === socket.id).length;
    if (owned / activeTiles >= 0.6) {
      clearInterval(room.tickInterval);
      io.to(code).emit('game:over', { winner: { id: socket.id, name: player.name, color: player.color } });
    }
  });

  // ── Construction ──
  socket.on('tile:build', ({ col, row, buildingId }, cb) => {
    const code = playerRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return cb?.({ success: false, error: 'Partie non active' });
    const player = room.players.get(socket.id);
    if (!player) return cb?.({ success: false, error: 'Joueur introuvable' });

    const key = `${col},${row}`;
    const tile = room.map.tiles[key];
    if (!tile || !tile.active) return cb?.({ success: false, error: 'Case invalide' });
    if (tile.owner !== socket.id) return cb?.({ success: false, error: 'Pas votre territoire' });
    if (tile.building) return cb?.({ success: false, error: 'Un bâtiment existe déjà ici' });

    const def = BUILDINGS_DEF[buildingId];
    if (!def) return cb?.({ success: false, error: 'Bâtiment inconnu' });

    // Calcul du coût réel côté serveur
    let cost;
    if (buildingId === 'recruit_post') {
      const postCount = Object.values(room.map.tiles).filter(
        t => t.owner === socket.id && t.building === 'recruit_post'
      ).length;
      cost = def.getCost(postCount);
    } else {
      cost = def.getCost();
    }

    if ((player.resources.gold ?? 0) < cost.gold)
      return cb?.({ success: false, error: `Pas assez d'or (${cost.gold}💰 requis)` });
    if ((player.resources.mat ?? 0) < cost.mat)
      return cb?.({ success: false, error: `Pas assez de matériaux (${cost.mat}🪨 requis)` });

    player.resources.gold -= cost.gold;
    player.resources.mat -= cost.mat;
    // Les troupes sur la case sont CONSERVÉES
    tile.building = buildingId;

    io.to(code).emit('map:update', { [key]: tile });
    broadcastResources(room);
    cb?.({ success: true });
  });

  // ── Recrutement de troupes (poste de recrutement) ──
  socket.on('troops:recruit', ({ col, row, amount }, cb) => {
    const code = playerRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return cb?.({ success: false, error: 'Partie non active' });
    const player = room.players.get(socket.id);
    if (!player) return cb?.({ success: false, error: 'Joueur introuvable' });

    const key = `${col},${row}`;
    const tile = room.map.tiles[key];
    if (!tile || tile.owner !== socket.id || tile.building !== 'recruit_post')
      return cb?.({ success: false, error: 'Pas un poste de recrutement valide' });

    if (!Number.isInteger(amount) || amount < 1 || amount > 500)
      return cb?.({ success: false, error: 'Nombre invalide' });

    const TROOP_COST = 20;
    const totalCost = amount * TROOP_COST;
    // Le client a déjà débité localement — on vérifie quand même côté serveur
    if (player.resources.gold < totalCost)
      return cb?.({ success: false, error: `Pas assez d'or (${totalCost}💰 requis)` });

    // Débiter côté serveur
    player.resources.gold -= totalCost;
    // Les troupes seront ajoutées progressivement par le client via l'animation (1s/troupe)
    // Le serveur les ajoute d'un coup pour rester synchronisé
    player.troops += amount;
    broadcastResources(room);

    cb?.({ success: true, troops: player.troops });
    console.log(`[RECRUIT] ${player.name} recrute ${amount} troupes (coût: ${totalCost}💰)`);
  });

  // ── Production d'unités (camp militaire) ──
  socket.on('unit:produce', ({ col, row, unitId, quantity }, cb) => {
    const code = playerRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return cb?.({ success: false, error: 'Partie non active' });
    const player = room.players.get(socket.id);
    if (!player) return cb?.({ success: false, error: 'Joueur introuvable' });

    const key = `${col},${row}`;
    const tile = room.map.tiles[key];
    if (!tile || tile.owner !== socket.id || tile.building !== 'military_camp')
      return cb?.({ success: false, error: 'Pas un camp militaire valide' });

    const unitDef = UNITS_DEF[unitId];
    if (!unitDef) return cb?.({ success: false, error: 'Unité inconnue' });

    const qty = Math.max(1, Math.min(quantity || 1, 20));
    const totalCost = {
      gold: unitDef.cost.gold * qty,
      mec: (unitDef.cost.mec || 0) * qty,
    };

    if (player.resources.gold < totalCost.gold)
      return cb?.({ success: false, error: `Pas assez d'or (${totalCost.gold}💰 requis)` });
    if (player.resources.mec < totalCost.mec)
      return cb?.({ success: false, error: `Pas assez de mécanisme (${totalCost.mec}⚙️ requis)` });

    // Déduire les ressources immédiatement
    player.resources.gold -= totalCost.gold;
    player.resources.mec -= totalCost.mec;
    broadcastResources(room);

    // Ajouter à la file de production
    if (!room.productionQueues.has(key)) room.productionQueues.set(key, []);
    const queue = room.productionQueues.get(key);
    const now = Date.now();

    for (let i = 0; i < qty; i++) {
      // Chaque unité se termine après la précédente
      const lastEndsAt = queue.length > 0 ? queue[queue.length-1].endsAt : now;
      queue.push({
        unitId,
        playerId: socket.id,
        endsAt: lastEndsAt + unitDef.productionTime,
      });
    }

    // Broadcast immédiat de la file
    const queuesState = {};
    for (const [tKey, q] of room.productionQueues) {
      if (q.length > 0) queuesState[tKey] = { count: q.length, nextEndsAt: q[0].endsAt, playerId: q[0].playerId };
    }
    io.to(code).emit('production:update', queuesState);

    cb?.({ success: true, queued: qty, endsAt: queue[queue.length-1].endsAt });
    console.log(`[PRODUCE] ${player.name} commande ${qty}× ${unitId}`);
  });

  // ── Déploiement de troupes sur la carte (clic droit pinceau) ──
  socket.on('troops:deploy', ({ deployments }, cb) => {
    // deployments = [{ col, row, amount }, ...]
    const code = playerRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return cb?.({ success: false });
    const player = room.players.get(socket.id);
    if (!player) return cb?.({ success: false });

    let totalCost = 0;
    const valid = [];

    for (const d of deployments) {
      const key = `${d.col},${d.row}`;
      const tile = room.map.tiles[key];
      if (!tile || !tile.active || tile.owner !== socket.id) continue;
      const amount = Math.max(1, Math.floor(d.amount));
      totalCost += amount;
      valid.push({ key, tile, amount });
    }

    if (totalCost > player.troops)
      return cb?.({ success: false, error: `Pas assez de troupes (${totalCost} requis, ${player.troops} disponibles)` });

    // Appliquer
    player.troops -= totalCost;
    const updatedTiles = {};
    for (const { key, tile, amount } of valid) {
      tile.troops = (tile.troops || 0) + amount;
      updatedTiles[key] = tile;
    }

    broadcastResources(room);
    io.to(code).emit('map:update', updatedTiles);
    cb?.({ success: true, troops: player.troops });
  });

  // ── Déplacement d'unités ──
  socket.on('unit:move', ({ unitId, targetCol, targetRow }, cb) => {
    const code = playerRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return cb?.({ success: false });
    const player = room.players.get(socket.id);
    if (!player) return cb?.({ success: false });

    const unit = room.units?.get(unitId);
    if (!unit || unit.playerId !== socket.id) return cb?.({ success: false, error: 'Unité introuvable' });

    const targetTile = room.map.tiles[`${targetCol},${targetRow}`];
    if (!targetTile || !targetTile.active) return cb?.({ success: false, error: 'Destination invalide' });

    // Calculer le chemin A*
    const path = findPath(room.map, unit.col, unit.row, targetCol, targetRow);
    if (!path || path.length === 0) return cb?.({ success: false, error: 'Chemin introuvable' });

    unit.path = path;
    unit.pathIndex = 0;
    unit.state = 'moving';
    unit.moveStartTime = Date.now();

    io.to(code).emit('unit:update', serializeUnit(unit));
    cb?.({ success: true });
  });

  // ── Arrêt d'une unité ──
  socket.on('unit:stop', ({ unitId }, cb) => {
    const code = playerRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return cb?.({ success: false });
    const unit = room.units?.get(unitId);
    if (!unit || unit.playerId !== socket.id) return cb?.({ success: false });
    unit.path = [];
    unit.state = 'idle';
    io.to(code).emit('unit:update', serializeUnit(unit));
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
