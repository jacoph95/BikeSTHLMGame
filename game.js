'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const SPEED_LAT    = 0.0000375; // degrees/sec ≈ 15 km/h
const SPEED_LNG    = 0.0000733; // degrees/sec (corrected for Stockholm latitude)
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 56900;   // 111320 * cos(59.3° * π/180)

const PICKUP_RADIUS    = 30;   // meters
const DELIVERY_RADIUS  = 40;   // meters
const STEAL_RADIUS     = 35;   // meters
const WIN_SCORE        = 100;
const STEAL_COOLDOWN_MS = 2000;

const ITEM_TYPES = [
  { name: 'Hot Dog',     emoji: '🌭', points: 5,  weight: 65 },
  { name: 'Nocco',       emoji: '🥤', points: 10, weight: 20 },
  { name: 'Snus',        emoji: '🫙', points: 20, weight: 10 },
  { name: 'Kanelbullar', emoji: '🍩', points: 30, weight: 5  },
];

function randomItemType() {
  const total = ITEM_TYPES.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of ITEM_TYPES) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return ITEM_TYPES[0];
}

const BOUNDS = {
  minLng: 17.90, maxLng: 18.15,
  minLat:  59.27, maxLat:  59.40,
};

// Tighter inner zone for spawning objects (avoids water edges)
const SPAWN_ZONE = {
  minLng: 17.97, maxLng: 18.12,
  minLat:  59.29, maxLat:  59.37,
};

const RACER_CONFIGS = [
  { name: 'Player', color: '#3b82f6', isPlayer: true,  speedMultiplier: 1.00 },
  { name: 'Bot 1',  color: '#ef4444', isPlayer: false, speedMultiplier: 1.00 },
  { name: 'Bot 2',  color: '#f97316', isPlayer: false, speedMultiplier: 1.00 },
  { name: 'Bot 3',  color: '#a855f7', isPlayer: false, speedMultiplier: 1.00 },
  { name: 'Bot 4',  color: '#ec4899', isPlayer: false, speedMultiplier: 1.00 },
];

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

// ─── InputHandler ─────────────────────────────────────────────────────────────

class InputHandler {
  constructor() {
    this.keys = new Set();
    this.spaceJustPressed = false;
    this._spaceHeld = false;

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.key);
      if (e.key === ' ') {
        e.preventDefault();
        if (!this._spaceHeld) this.spaceJustPressed = true;
        this._spaceHeld = true;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key);
      if (e.key === ' ') this._spaceHeld = false;
    });
  }

  isDown(key) { return this.keys.has(key); }

  clearFrame() { this.spaceJustPressed = false; }
}

// ─── Racer ───────────────────────────────────────────────────────────────────

class Racer {
  constructor(config, lng, lat) {
    this.lng  = lng;
    this.lat  = lat;
    this.name = config.name;
    this.color = config.color;
    this.isPlayer = config.isPlayer;
    this.speedMultiplier = config.speedMultiplier;
    this.hasPackage = false;
    this.score = 0;
    this.stealFlashMs = 0;
    this.stealCooldownMs = 0;
    this.initial = config.isPlayer ? 'P' : config.name[4]; // '1','2','3','4'
  }

  updateAsPlayer(dt, input) {
    const s = this.speedMultiplier;
    if (input.isDown('ArrowUp')    || input.isDown('w') || input.isDown('W'))
      this.lat += SPEED_LAT * s * dt;
    if (input.isDown('ArrowDown')  || input.isDown('s') || input.isDown('S'))
      this.lat -= SPEED_LAT * s * dt;
    if (input.isDown('ArrowLeft')  || input.isDown('a') || input.isDown('A'))
      this.lng -= SPEED_LNG * s * dt;
    if (input.isDown('ArrowRight') || input.isDown('d') || input.isDown('D'))
      this.lng += SPEED_LNG * s * dt;
    this._clamp();
  }

  updateAsBot(dt, target) {
    if (!target) return;
    const dx = target.lng - this.lng;
    const dy = target.lat - this.lat;
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag < 1e-9) return;
    const s = this.speedMultiplier;
    this.lng += (dx / mag) * SPEED_LNG * s * dt;
    this.lat += (dy / mag) * SPEED_LAT * s * dt;
    this._clamp();
  }

  _clamp() {
    this.lng = Math.max(BOUNDS.minLng, Math.min(BOUNDS.maxLng, this.lng));
    this.lat = Math.max(BOUNDS.minLat, Math.min(BOUNDS.maxLat, this.lat));
  }

  draw(ctx, map, dt) {
    const pt = map.project([this.lng, this.lat]);
    const x = pt.x, y = pt.y;
    const R = 15;

    if (this.stealFlashMs > 0) this.stealFlashMs -= dt * 1000;

    const fill = this.stealFlashMs > 0 ? '#ff3333' : this.color;

    ctx.save();

    // Drop shadow
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur  = 8;

    // Body circle
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fillStyle   = fill;
    ctx.fill();
    ctx.shadowBlur  = 0;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 2.5;
    ctx.stroke();

    // Package indicator ring
    if (this.hasPackage) {
      ctx.beginPath();
      ctx.arc(x, y, R + 6, 0, Math.PI * 2);
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth   = 3;
      ctx.stroke();
    }

    // Initial letter
    ctx.fillStyle       = '#ffffff';
    ctx.font            = `bold ${R}px Arial`;
    ctx.textAlign       = 'center';
    ctx.textBaseline    = 'middle';
    ctx.fillText(this.initial, x, y);

    // Name label below
    ctx.fillStyle    = 'rgba(15,23,42,0.8)';
    ctx.font         = '11px Arial';
    ctx.textBaseline = 'top';
    // Small background pill
    const labelW = ctx.measureText(this.name).width + 8;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(x - labelW / 2, y + R + 3, labelW, 14);
    ctx.fillStyle    = '#1e293b';
    ctx.fillText(this.name, x, y + R + 4);

    ctx.restore();
  }
}

// ─── Package ─────────────────────────────────────────────────────────────────

class Package {
  constructor(lng, lat) {
    this.lng    = lng;
    this.lat    = lat;
    this.isHeld = false;
    this.holder = null;
    this.type   = randomItemType();
  }

  reset(lng, lat) {
    this.lng    = lng;
    this.lat    = lat;
    this.isHeld = false;
    this.holder = null;
    this.type   = randomItemType();
  }

  draw(ctx, map) {
    if (this.isHeld) return;
    const pt = map.project([this.lng, this.lat]);
    const x = pt.x, y = pt.y;
    const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 280);

    ctx.save();

    // Glow (colour shifts by rarity: common=yellow, rare=purple)
    const glowColor = this.type.points >= 20
      ? `rgba(168,85,247,${pulse * 0.9})`
      : `rgba(250,204,21,${pulse * 0.8})`;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur  = 18;

    // Box body
    ctx.fillStyle   = '#facc15';
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth   = 2;
    _roundRect(ctx, x - 14, y - 14, 28, 28, 5);
    ctx.fill();
    ctx.stroke();

    ctx.shadowBlur = 0;

    // Item emoji
    ctx.font         = '18px Arial';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.type.emoji, x, y);

    // Item name + points label above
    ctx.fillStyle    = '#1e293b';
    ctx.font         = 'bold 10px Arial';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${this.type.name} (+${this.type.points}pt)`, x, y - 17);

    ctx.restore();
  }
}

// ─── DeliveryPoint ───────────────────────────────────────────────────────────

class DeliveryPoint {
  constructor(lng, lat) {
    this.lng = lng;
    this.lat = lat;
  }

  draw(ctx, map) {
    const pt = map.project([this.lng, this.lat]);
    const x = pt.x, y = pt.y;
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 380);
    const outerR = 28 + 8 * pulse;

    ctx.save();

    // Outer pulsing ring
    ctx.beginPath();
    ctx.arc(x, y, outerR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(34,197,94,${0.35 + 0.3 * pulse})`;
    ctx.lineWidth   = 3;
    ctx.stroke();

    // Inner filled circle
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.fillStyle   = 'rgba(34,197,94,0.25)';
    ctx.fill();
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth   = 3;
    ctx.stroke();

    // Checkmark
    ctx.strokeStyle = '#16a34a';
    ctx.lineWidth   = 3;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(x - 7, y);
    ctx.lineTo(x - 1, y + 7);
    ctx.lineTo(x + 8, y - 7);
    ctx.stroke();

    // "DELIVER" label
    ctx.fillStyle    = '#15803d';
    ctx.font         = 'bold 11px Arial';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('DELIVER HERE', x, y + 23);

    ctx.restore();
  }
}

// ─── Canvas helper ───────────────────────────────────────────────────────────

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Game state ───────────────────────────────────────────────────────────────

let map, canvas, ctx, input;
let gs; // game state object
let lastTimestamp = null;
let rafId = null;

function createGameState() {
  const spawnPositions = [
    { lng: 18.07,  lat: 59.330 },
    { lng: 18.055, lat: 59.338 },
    { lng: 18.085, lat: 59.338 },
    { lng: 18.055, lat: 59.322 },
    { lng: 18.085, lat: 59.322 },
  ];

  const racers = RACER_CONFIGS.map((cfg, i) =>
    new Racer(cfg, spawnPositions[i].lng, spawnPositions[i].lat)
  );

  const pkgPos = randomInZone();

  return {
    phase: 'SEEKING',
    racers,
    pkg: new Package(pkgPos.lng, pkgPos.lat),
    delivery: null,
    announcementMs: 0,
    winner: null,
  };
}

// ─── Main loop ────────────────────────────────────────────────────────────────

function startGame() {
  if (rafId) cancelAnimationFrame(rafId);
  lastTimestamp = null;
  document.getElementById('win-screen').style.display = 'none';
  gs = createGameState();
  updateScoreHUD();
  setPhaseHUD();
  rafId = requestAnimationFrame(loop);
}

function loop(ts) {
  if (gs.winner) { showWinScreen(gs.winner); return; }

  const dt = lastTimestamp === null ? 0 : Math.min((ts - lastTimestamp) / 1000, 0.1);
  lastTimestamp = ts;

  update(dt);
  render(dt);
  input.clearFrame();

  rafId = requestAnimationFrame(loop);
}

// ─── Update ───────────────────────────────────────────────────────────────────

function update(dt) {
  // Tick steal cooldowns
  for (const racer of gs.racers) {
    if (racer.stealCooldownMs > 0) racer.stealCooldownMs -= dt * 1000;
  }

  // Move player
  gs.racers[0].updateAsPlayer(dt, input);

  // Move bots
  for (let i = 1; i < gs.racers.length; i++) {
    gs.racers[i].updateAsBot(dt, botTarget(gs.racers[i]));
  }

  // Sync package to holder
  if (gs.pkg.isHeld && gs.pkg.holder) {
    gs.pkg.lng = gs.pkg.holder.lng;
    gs.pkg.lat = gs.pkg.holder.lat;
  }

  // Phase logic
  if (gs.phase === 'SEEKING') {
    updateSeeking();
  } else {
    updateDelivering();
  }

  // Tick announcement
  if (gs.announcementMs > 0) {
    gs.announcementMs -= dt * 1000;
    if (gs.announcementMs <= 0) {
      document.getElementById('hud-announcement').style.display = 'none';
    }
  }
}

function botTarget(bot) {
  if (gs.phase === 'SEEKING') return gs.pkg;
  if (bot.hasPackage)         return gs.delivery;
  // seek whoever holds the package
  return gs.racers.find(r => r.hasPackage) || gs.delivery;
}

function updateSeeking() {
  for (const racer of gs.racers) {
    if (lngLatDist(racer, gs.pkg) < PICKUP_RADIUS) {
      pickupPackage(racer);
      return;
    }
  }
}

function pickupPackage(racer) {
  racer.hasPackage  = true;
  gs.pkg.isHeld     = true;
  gs.pkg.holder     = racer;

  // Spawn delivery point far enough from current package location
  let pos, attempts = 0;
  do { pos = randomInZone(); attempts++; }
  while (lngLatDist(pos, gs.pkg) < 300 && attempts < 30);

  gs.delivery = new DeliveryPoint(pos.lng, pos.lat);
  gs.phase    = 'DELIVERING';

  announce(`${racer.name} picked up ${gs.pkg.type.emoji} ${gs.pkg.type.name}! Deliver for ${gs.pkg.type.points}pts!`);
  setPhaseHUD();
  updateScoreHUD();
}

function updateDelivering() {
  const holder = gs.racers.find(r => r.hasPackage);
  if (!holder) return;

  // Delivery check (takes priority)
  if (lngLatDist(holder, gs.delivery) < DELIVERY_RADIUS) {
    deliverPackage(holder);
    return;
  }

  if (holder.stealCooldownMs > 0) return;

  // Bot auto-steal (only first eligible bot fires per frame)
  for (let i = 1; i < gs.racers.length; i++) {
    const bot = gs.racers[i];
    if (bot.hasPackage) continue;
    if (lngLatDist(bot, holder) < STEAL_RADIUS) {
      stealPackage(bot, holder);
      return;
    }
  }

  // Player steal (requires Space)
  const player = gs.racers[0];
  if (!player.hasPackage && input.spaceJustPressed) {
    if (lngLatDist(player, holder) < STEAL_RADIUS) {
      stealPackage(player, holder);
    }
  }
}

function stealPackage(thief, victim) {
  victim.hasPackage    = false;
  thief.hasPackage     = true;
  gs.pkg.holder        = thief;
  victim.stealFlashMs  = 600;
  victim.stealCooldownMs = STEAL_COOLDOWN_MS;
  announce(`${thief.name} stole the ${gs.pkg.type.name} from ${victim.name}!`);
}

function deliverPackage(holder) {
  const pts = gs.pkg.type.points;
  holder.score += pts;
  holder.hasPackage = false;
  gs.pkg.isHeld     = false;
  gs.pkg.holder     = null;
  gs.delivery       = null;

  updateScoreHUD();
  announce(`${holder.name} delivered ${gs.pkg.type.emoji} ${gs.pkg.type.name}! +${pts}pts (${holder.score} total)`);

  if (holder.score >= WIN_SCORE) {
    gs.winner = holder;
    return;
  }

  const p = randomInZone();
  gs.pkg.reset(p.lng, p.lat);
  gs.phase = 'SEEKING';
  setPhaseHUD();
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render(dt) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (gs.delivery)    gs.delivery.draw(ctx, map);
  if (!gs.pkg.isHeld) gs.pkg.draw(ctx, map);

  for (const racer of gs.racers) racer.draw(ctx, map, dt);
}

// ─── HUD helpers ─────────────────────────────────────────────────────────────

function announce(text) {
  const el = document.getElementById('hud-announcement');
  el.textContent = text;
  el.style.display = 'block';
  gs.announcementMs = 2500;
}

function setPhaseHUD() {
  const el = document.getElementById('hud-phase');
  if (gs.phase === 'SEEKING') {
    el.textContent = 'Phase 1: Race to the package!';
    el.className   = 'phase-seeking';
  } else {
    const holder = gs.racers.find(r => r.hasPackage);
    el.textContent = `Phase 2: ${holder ? holder.name : '?'} must deliver!`;
    el.className   = 'phase-delivering';
  }
}

function updateScoreHUD() {
  const el = document.getElementById('hud-scores');
  el.innerHTML = gs.racers
    .slice()
    .sort((a, b) => b.score - a.score)
    .map(r => `<div class="score-row" style="--color:${r.color}">
      <span class="score-name">${r.name}</span>
      <span class="score-val">${r.score}</span>
    </div>`)
    .join('');
}

function showWinScreen(racer) {
  const el = document.getElementById('win-screen');
  const nm = document.getElementById('win-name');
  nm.textContent = racer.name;
  nm.style.color = racer.color;
  el.style.display = 'flex';
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

function syncCanvasSize() {
  const c = map.getContainer();
  canvas.width  = c.offsetWidth;
  canvas.height = c.offsetHeight;
}

window.addEventListener('DOMContentLoaded', () => {
  mapboxgl.accessToken = MAPBOX_TOKEN;

  map = new mapboxgl.Map({
    container: 'map',
    style:     'mapbox://styles/mapbox/streets-v12',
    center:    [18.07, 59.33],
    zoom:      14,
    interactive: false,
  });

  canvas = document.getElementById('gameCanvas');
  ctx    = canvas.getContext('2d');
  input  = new InputHandler();

  map.on('load', () => {
    syncCanvasSize();
    window.addEventListener('resize', syncCanvasSize);
    startGame();
  });

  document.getElementById('btn-restart').addEventListener('click', startGame);
});
