'use strict';

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Game constants (mirrored from game.js) ───────────────────────────────────

const SPEED_LNG      = 0.003;
const SPEED_LAT      = 0.0015;
const M_PER_DEG_LAT  = 111320;
const M_PER_DEG_LNG  = 56900;
const PICKUP_RADIUS  = 30;
const DELIVERY_RADIUS = 40;
const STEAL_RADIUS   = 35;
const STEAL_COOLDOWN_MS = 2000;
const TICK_MS        = 50;   // 20 Hz

const BOUNDS = { minLng: 17.90, maxLng: 18.15, minLat: 59.27, maxLat: 59.40 };

const SPAWN_ZONE = { minLng: 17.97, maxLng: 18.12, minLat: 59.29, maxLat: 59.37 };

const ITEM_TYPES = [
  { name: 'Hot Dog',     emoji: '🌭', points: 5,  weight: 65 },
  { name: 'Nocco',       emoji: '🥤', points: 10, weight: 20 },
  { name: 'Snus',        emoji: '🫙', points: 20, weight: 10 },
  { name: 'Kanelbullar', emoji: '🍩', points: 30, weight: 5  },
];

const STOCKHOLM_LOCATIONS = [
  { name: 'Gamla Stan',        lng: 18.0686, lat: 59.3250 },
  { name: 'Sergels Torg',      lng: 18.0634, lat: 59.3326 },
  { name: 'Medborgarplatsen',  lng: 18.0742, lat: 59.3154 },
  { name: 'Stureplan',         lng: 18.0763, lat: 59.3362 },
  { name: 'Slussen',           lng: 18.0722, lat: 59.3189 },
  { name: 'Stadshuset',        lng: 18.0543, lat: 59.3276 },
  { name: 'Humlegården',       lng: 18.0793, lat: 59.3394 },
  { name: 'Karlaplan',         lng: 18.0944, lat: 59.3386 },
  { name: 'Folkungagatan',     lng: 18.0805, lat: 59.3143 },
  { name: 'Östermalmstorg',    lng: 18.0775, lat: 59.3343 },
  { name: 'Söder Mälarstrand', lng: 18.0534, lat: 59.3179 },
  { name: 'Riddarholmen',      lng: 18.0636, lat: 59.3253 },
];

const RACER_COLORS = ['#2563eb', '#dc2626', '#facc15', '#16a34a', '#db2777'];

const SPAWN_POSITIONS = [
  { lng: 18.0634, lat: 59.3326 },
  { lng: 18.0686, lat: 59.3250 },
  { lng: 18.0742, lat: 59.3154 },
  { lng: 18.0763, lat: 59.3362 },
  { lng: 18.0722, lat: 59.3189 },
];

// ─── In-memory rooms ──────────────────────────────────────────────────────────

const rooms = {};

// ─── Utilities ────────────────────────────────────────────────────────────────

function lngLatDist(a, b) {
  const dLat = (a.lat - b.lat) * M_PER_DEG_LAT;
  const dLng = (a.lng - b.lng) * M_PER_DEG_LNG;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function randomInZone() {
  return {
    lng: SPAWN_ZONE.minLng + Math.random() * (SPAWN_ZONE.maxLng - SPAWN_ZONE.minLng),
    lat: SPAWN_ZONE.minLat + Math.random() * (SPAWN_ZONE.maxLat - SPAWN_ZONE.minLat),
  };
}

function randomLocation(excludePos) {
  let pool = STOCKHOLM_LOCATIONS;
  if (excludePos) {
    const f = STOCKHOLM_LOCATIONS.filter(l => lngLatDist(l, excludePos) > 300);
    if (f.length) pool = f;
  }
  return { ...pool[Math.floor(Math.random() * pool.length)] };
}

function randomItemType() {
  const total = ITEM_TYPES.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of ITEM_TYPES) { r -= t.weight; if (r <= 0) return t; }
  return ITEM_TYPES[0];
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? generateRoomCode() : code;
}

function clamp(racer) {
  racer.lng = Math.max(BOUNDS.minLng, Math.min(BOUNDS.maxLng, racer.lng));
  racer.lat = Math.max(BOUNDS.minLat, Math.min(BOUNDS.maxLat, racer.lat));
}

// ─── Server-side game logic ───────────────────────────────────────────────────

function createServerGs(racers) {
  const pkgLoc = randomLocation();
  return {
    phase: 'SEEKING',
    racers,
    pkg: { lng: pkgLoc.lng, lat: pkgLoc.lat, isHeld: false, holder: null, type: randomItemType(), locName: pkgLoc.name },
    delivery: null,
    announcementText: '',
    announcementSeq: 0,
    winner: null,
    winScore: 100,
  };
}

function applyPlayerInput(racer, input, dt) {
  const s = racer.speedMultiplier;
  if (input.up)    racer.lat += SPEED_LAT * s * dt;
  if (input.down)  racer.lat -= SPEED_LAT * s * dt;
  if (input.left)  racer.lng -= SPEED_LNG * s * dt;
  if (input.right) racer.lng += SPEED_LNG * s * dt;
  clamp(racer);
}

function applyBotMovement(racer, target, dt) {
  if (!target) return;
  const s  = racer.speedMultiplier;
  const dx = target.lng - racer.lng;
  const dy = target.lat - racer.lat;
  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag < 1e-9) return;
  racer.lng += (dx / mag) * SPEED_LNG * s * dt;
  racer.lat += (dy / mag) * SPEED_LAT * s * dt;
  clamp(racer);
}

function botTarget(gs, racer) {
  if (gs.phase === 'SEEKING') return gs.pkg;
  if (racer.hasPackage) return gs.delivery;
  return gs.racers.find(r => r.hasPackage) || gs.delivery;
}

function serverAnnounce(gs, text) {
  gs.announcementText = text;
  gs.announcementSeq++;
}

function serverTick(room) {
  const gs = room.gs;
  if (!gs || gs.winner) return;

  const dt = TICK_MS / 1000;

  // Tick steal cooldowns
  for (const r of gs.racers) {
    if (r.stealFlashMs > 0) r.stealFlashMs = Math.max(0, r.stealFlashMs - TICK_MS);
    if (r.stealCooldownMs > 0) r.stealCooldownMs = Math.max(0, r.stealCooldownMs - TICK_MS);
  }

  // Move racers
  for (let i = 0; i < gs.racers.length; i++) {
    const racer = gs.racers[i];
    if (racer.isHuman) {
      const input = room.inputs[racer.socketId] || { up: false, down: false, left: false, right: false, space: false };
      applyPlayerInput(racer, input, dt);
      // Clear space after using it
      if (input.space) {
        if (room.inputs[racer.socketId]) room.inputs[racer.socketId].space = false;
      }
    } else {
      applyBotMovement(racer, botTarget(gs, racer), dt);
    }
  }

  // Sync package to holder
  if (gs.pkg.isHeld && gs.pkg.holder !== null) {
    const holder = gs.racers[gs.pkg.holder];
    if (holder) { gs.pkg.lng = holder.lng; gs.pkg.lat = holder.lat; }
  }

  // Phase logic
  if (gs.phase === 'SEEKING') {
    for (const racer of gs.racers) {
      if (lngLatDist(racer, gs.pkg) <= PICKUP_RADIUS) {
        racer.hasPackage = true;
        gs.pkg.isHeld = true;
        gs.pkg.holder = gs.racers.indexOf(racer);
        const delivLoc = randomLocation(gs.pkg);
        gs.delivery = { lng: delivLoc.lng, lat: delivLoc.lat, locName: delivLoc.name };
        gs.phase = 'DELIVERING';
        serverAnnounce(gs, `${racer.name} picked up ${gs.pkg.type.emoji} ${gs.pkg.type.name} at ${gs.pkg.locName}!`);
        break;
      }
    }
  } else {
    const holderIdx = gs.racers.findIndex(r => r.hasPackage);
    if (holderIdx === -1) { gs.phase = 'SEEKING'; return; }
    const holder = gs.racers[holderIdx];

    // Deliver
    if (lngLatDist(holder, gs.delivery) <= DELIVERY_RADIUS) {
      const pts = gs.pkg.type.points;
      holder.score += pts;
      holder.hasPackage = false;
      gs.pkg.isHeld = false;
      gs.pkg.holder = null;
      gs.delivery = null;
      serverAnnounce(gs, `${holder.name} delivered ${gs.pkg.type.emoji} ${gs.pkg.type.name}! +${pts}pts`);

      if (holder.score >= gs.winScore) {
        gs.winner = { name: holder.name, color: holder.color };
        io.to(room.code).emit('stateSync', gs);
        clearInterval(room.interval);
        return;
      }

      const pkgLoc = randomLocation();
      gs.pkg = { lng: pkgLoc.lng, lat: pkgLoc.lat, isHeld: false, holder: null, type: randomItemType(), locName: pkgLoc.name };
      gs.phase = 'SEEKING';
      return;
    }

    // Steal — bots steal from holder
    for (const racer of gs.racers) {
      if (racer === holder || racer.hasPackage) continue;
      if (racer.stealCooldownMs > 0) continue;
      if (lngLatDist(racer, holder) <= STEAL_RADIUS) {
        if (!racer.isHuman) {
          // Bot auto-steals
          holder.hasPackage = false;
          racer.hasPackage = true;
          gs.pkg.holder = gs.racers.indexOf(racer);
          holder.stealFlashMs = 600;
          holder.stealCooldownMs = STEAL_COOLDOWN_MS;
          serverAnnounce(gs, `${racer.name} stole the package from ${holder.name}!`);
          break;
        }
      }
    }

    // Human steal via space
    for (const racer of gs.racers) {
      if (racer === holder || !racer.isHuman) continue;
      const input = room.inputs[racer.socketId];
      if (!input || !input.space) continue;
      if (racer.stealCooldownMs > 0) continue;
      if (lngLatDist(racer, holder) <= STEAL_RADIUS) {
        holder.hasPackage = false;
        racer.hasPackage = true;
        gs.pkg.holder = gs.racers.indexOf(racer);
        holder.stealFlashMs = 600;
        holder.stealCooldownMs = STEAL_COOLDOWN_MS;
        serverAnnounce(gs, `${racer.name} stole the package from ${holder.name}!`);
        if (room.inputs[racer.socketId]) room.inputs[racer.socketId].space = false;
        break;
      }
    }
  }

  io.to(room.code).emit('stateSync', gs);
}

// ─── Socket.io events ─────────────────────────────────────────────────────────

function findRoomBySocket(socketId) {
  return Object.values(rooms).find(r => r.players.some(p => p.socketId === socketId));
}

io.on('connection', (socket) => {

  socket.on('createRoom', ({ playerName }) => {
    const code = generateRoomCode();
    const player = { socketId: socket.id, name: playerName || 'Player 1', color: RACER_COLORS[0], index: 0 };
    rooms[code] = {
      code,
      hostSocketId: socket.id,
      players: [player],
      gs: null,
      interval: null,
      inputs: {},
      started: false,
    };
    socket.join(code);
    socket.emit('roomCreated', { code, yourIndex: 0, players: [player] });
  });

  socket.on('joinRoom', ({ code, playerName }) => {
    const room = rooms[code];
    if (!room) { socket.emit('joinError', 'Room not found'); return; }
    if (room.started) { socket.emit('joinError', 'Game already started'); return; }
    if (room.players.length >= 5) { socket.emit('joinError', 'Room is full'); return; }

    const idx = room.players.length;
    const player = { socketId: socket.id, name: playerName || `Player ${idx + 1}`, color: RACER_COLORS[idx], index: idx };
    room.players.push(player);
    socket.join(code);
    socket.emit('roomJoined', { code, yourIndex: idx, players: room.players });
    socket.to(code).emit('playerJoined', { players: room.players });
  });

  socket.on('startGame', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostSocketId !== socket.id) return;
    room.started = true;

    // Build racers: humans first, then bots to fill 5 slots
    const racers = [];
    for (let i = 0; i < 5; i++) {
      const human = room.players.find(p => p.index === i);
      if (human) {
        racers.push({
          lng: SPAWN_POSITIONS[i].lng, lat: SPAWN_POSITIONS[i].lat,
          name: human.name, color: human.color,
          isHuman: true, isPlayer: i === 0,
          socketId: human.socketId,
          speedMultiplier: 1.0,
          hasPackage: false, score: 0,
          stealFlashMs: 0, stealCooldownMs: 0,
        });
      } else {
        const botNames = ['Bot A', 'Bot B', 'Bot C', 'Bot D', 'Bot E'];
        const botSpeeds = [0.75, 0.85, 0.90, 1.05, 0.80];
        racers.push({
          lng: SPAWN_POSITIONS[i].lng, lat: SPAWN_POSITIONS[i].lat,
          name: botNames[i] || `Bot ${i}`, color: RACER_COLORS[i],
          isHuman: false, isPlayer: false,
          socketId: null,
          speedMultiplier: botSpeeds[i] || 0.85,
          hasPackage: false, score: 0,
          stealFlashMs: 0, stealCooldownMs: 0,
        });
      }
    }

    room.gs = createServerGs(racers);
    room.inputs = {};

    // Tell each player their index and the racer configs
    for (const player of room.players) {
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (playerSocket) {
        playerSocket.emit('gameStarted', {
          yourIndex: player.index,
          racers: racers.map(r => ({ name: r.name, color: r.color, isHuman: r.isHuman })),
        });
      }
    }

    room.interval = setInterval(() => serverTick(room), TICK_MS);
  });

  socket.on('playerInput', (input) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    room.inputs[socket.id] = input;
  });

  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;

    room.players = room.players.filter(p => p.socketId !== socket.id);
    delete room.inputs[socket.id];

    // Convert their racer to a bot
    if (room.gs) {
      const racer = room.gs.racers.find(r => r.socketId === socket.id);
      if (racer) { racer.isHuman = false; racer.socketId = null; racer.name += ' (left)'; }
    }

    if (room.players.length === 0) {
      clearInterval(room.interval);
      delete rooms[room.code];
    } else {
      io.to(room.code).emit('playerLeft', { players: room.players });
      // Pass host to next player if host left
      if (room.hostSocketId === socket.id && room.players.length > 0) {
        room.hostSocketId = room.players[0].socketId;
        io.to(room.hostSocketId).emit('youAreHost');
      }
    }
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`BikeSTHLM server running on http://localhost:${PORT}`));
