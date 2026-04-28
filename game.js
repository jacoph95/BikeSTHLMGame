'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const SPEED_LNG     = 0.003;   // base deg/s east-west  (~35 px/s at zoom 14)
const SPEED_LAT     = 0.0015;  // base deg/s north-south (visually symmetric)
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 56900;

const PICKUP_RADIUS    = 30;
const DELIVERY_RADIUS  = 40;
const STEAL_RADIUS     = 35;
const STEAL_COOLDOWN_MS = 3000;

const ITEM_TYPES = [
  { name: 'Hot Dog',     emoji: '🌭', points: 5,  weight: 65 },
  { name: 'Nocco',       emoji: '🥤', points: 10, weight: 20 },
  { name: 'Snus',        emoji: '🫙', points: 20, weight: 10 },
  { name: 'Kanelbullar', emoji: '🍩', points: 30, weight: 5  },
];

function randomItemType() {
  const total = ITEM_TYPES.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of ITEM_TYPES) { r -= t.weight; if (r <= 0) return t; }
  return ITEM_TYPES[0];
}

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

const RACER_CONFIGS = [
  { name: 'You',   color: '#2563eb', isPlayer: true,  speedMultiplier: 1.00 },
  { name: 'Bot A', color: '#dc2626', isPlayer: false, speedMultiplier: 0.75 },
  { name: 'Bot B', color: '#facc15', isPlayer: false, speedMultiplier: 0.85 },
  { name: 'Bot C', color: '#16a34a', isPlayer: false, speedMultiplier: 0.90 },
  { name: 'Bot D', color: '#db2777', isPlayer: false, speedMultiplier: 1.05 },
];

// Mutable — set after map loads
let BOUNDS = { minLng: 17.90, maxLng: 18.15, minLat: 59.27, maxLat: 59.40 };
let roadLayerIds = [];
let waterLayerIds = [];

const GAME_SETTINGS = { speedMultiplier: 1, winScore: 100 };

// ─── Utilities ────────────────────────────────────────────────────────────────

function lngLatDist(a, b) {
  const dLat = (a.lat - b.lat) * M_PER_DEG_LAT;
  const dLng = (a.lng - b.lng) * M_PER_DEG_LNG;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function randomLocation(excludePos) {
  let pool = STOCKHOLM_LOCATIONS;
  if (excludePos) {
    const f = STOCKHOLM_LOCATIONS.filter(l => lngLatDist(l, excludePos) > 300);
    if (f.length) pool = f;
  }
  return { ...pool[Math.floor(Math.random() * pool.length)] };
}

// ─── Road snapping (generous channel — same rules for everyone) ───────────────

function initRoadLayers() {
  roadLayerIds = map.getStyle().layers
    .filter(l => l.type === 'line' && /road|bridge|tunnel/.test(l.id) && !l.id.includes('case'))
    .map(l => l.id);
}

function initWaterLayers() {
  waterLayerIds = map.getStyle().layers
    .filter(l => l.type === 'fill' && /^water/.test(l.id))
    .map(l => l.id);
}

function isInWater(lng, lat) {
  if (!waterLayerIds.length) return false;
  try {
    const pt = map.project([lng, lat]);
    return map.queryRenderedFeatures([pt.x, pt.y], { layers: waterLayerIds }).length > 0;
  } catch (_) {
    return false;
  }
}

function _nearestOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq)) : 0;
  const nx = a.x + t * dx, ny = a.y + t * dy;
  return { x: nx, y: ny, dist: Math.sqrt((p.x - nx) ** 2 + (p.y - ny) ** 2) };
}

// CHANNEL_HALF_WIDTH: how far off the road centre a racer can be before being nudged back.
// 40px at zoom 14 ≈ 30 m — wide enough to never feel stuck.
const CHANNEL_HALF_WIDTH = 40;
const ROAD_QUERY_BUFFER  = 120;

function snapToRoad(lng, lat) {
  if (!roadLayerIds.length) return { lng, lat };
  try {
    const pt = map.project([lng, lat]);
    const features = map.queryRenderedFeatures(
      [[pt.x - ROAD_QUERY_BUFFER, pt.y - ROAD_QUERY_BUFFER],
       [pt.x + ROAD_QUERY_BUFFER, pt.y + ROAD_QUERY_BUFFER]],
      { layers: roadLayerIds }
    );
    if (!features.length) return { lng, lat };

    // Collect all line-segment coordinate pairs, handling both LineString and MultiLineString
    const lines = [];
    for (const feat of features) {
      const g = feat.geometry;
      if (g.type === 'LineString') lines.push(g.coordinates);
      else if (g.type === 'MultiLineString') lines.push(...g.coordinates);
    }

    let bestDist = Infinity, bestPt = null;
    for (const coords of lines) {
      for (let i = 0; i < coords.length - 1; i++) {
        const p = _nearestOnSegment(pt, map.project(coords[i]), map.project(coords[i + 1]));
        if (p.dist < bestDist) { bestDist = p.dist; bestPt = p; }
      }
    }
    if (!bestPt || bestDist <= CHANNEL_HALF_WIDTH) return { lng, lat };

    const ratio = CHANNEL_HALF_WIDTH / bestDist;
    const sx = bestPt.x + (pt.x - bestPt.x) * ratio;
    const sy = bestPt.y + (pt.y - bestPt.y) * ratio;
    const sl = map.unproject([sx, sy]);
    if (isNaN(sl.lng) || isNaN(sl.lat)) return { lng, lat };
    return { lng: sl.lng, lat: sl.lat };
  } catch (_) {
    return { lng, lat };
  }
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
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
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
    this.lng  = lng; this.lat = lat;
    this.name = config.name;
    this.color = config.color;
    this.isPlayer = config.isPlayer;
    this.speedMultiplier = config.speedMultiplier;
    this.hasPackage = false;
    this.score = 0;
    this.stealFlashMs = 0;
    this.stealCooldownMs = 0;
  }

  updateAsPlayer(dt, input) {
    const prevLng = this.lng, prevLat = this.lat;
    const s = this.speedMultiplier * GAME_SETTINGS.speedMultiplier;
    if (input.isDown('ArrowUp')    || input.isDown('w') || input.isDown('W')) this.lat += SPEED_LAT * s * dt;
    if (input.isDown('ArrowDown')  || input.isDown('s') || input.isDown('S')) this.lat -= SPEED_LAT * s * dt;
    if (input.isDown('ArrowLeft')  || input.isDown('a') || input.isDown('A')) this.lng -= SPEED_LNG * s * dt;
    if (input.isDown('ArrowRight') || input.isDown('d') || input.isDown('D')) this.lng += SPEED_LNG * s * dt;
    const snapped = snapToRoad(this.lng, this.lat);
    this.lng = snapped.lng; this.lat = snapped.lat;
    if (isInWater(this.lng, this.lat)) { this.lng = prevLng; this.lat = prevLat; }
    this._clamp();
  }

  updateAsBot(dt, target) {
    if (!target) return;
    const prevLng = this.lng, prevLat = this.lat;
    const s  = this.speedMultiplier * GAME_SETTINGS.speedMultiplier;
    const dx = target.lng - this.lng, dy = target.lat - this.lat;
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag > 1e-9) {
      this.lng += (dx / mag) * SPEED_LNG * s * dt;
      this.lat += (dy / mag) * SPEED_LAT * s * dt;
    }
    const snapped = snapToRoad(this.lng, this.lat);
    this.lng = snapped.lng; this.lat = snapped.lat;
    if (isInWater(this.lng, this.lat)) { this.lng = prevLng; this.lat = prevLat; }
    this._clamp();
  }

  clearRoute() {}

  _clamp() {
    this.lng = Math.max(BOUNDS.minLng, Math.min(BOUNDS.maxLng, this.lng));
    this.lat = Math.max(BOUNDS.minLat, Math.min(BOUNDS.maxLat, this.lat));
  }

  draw(ctx, map, dt) {
    const pt = map.project([this.lng, this.lat]);
    const x = pt.x, y = pt.y;
    const R = 15; // anchor distance used by direction arrows below

    if (this.stealFlashMs > 0) this.stealFlashMs -= dt * 1000;

    const bodyColor  = this.stealFlashMs > 0 ? '#ff3333' : this.color;
    const wheelColor = '#1e293b';
    const skinColor  = '#fde68a';

    ctx.save();

    // Drop shadow
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur  = 6;

    // Rear wheel (top of top-down view)
    ctx.beginPath();
    ctx.arc(x, y - 10, 6, 0, Math.PI * 2);
    ctx.fillStyle = wheelColor;
    ctx.fill();

    // Front wheel (bottom)
    ctx.beginPath();
    ctx.arc(x, y + 10, 6, 0, Math.PI * 2);
    ctx.fillStyle = wheelColor;
    ctx.fill();

    ctx.shadowBlur = 0;

    // Bike frame — line connecting wheels
    ctx.beginPath();
    ctx.moveTo(x, y - 10);
    ctx.lineTo(x, y + 10);
    ctx.strokeStyle = bodyColor;
    ctx.lineWidth   = 4;
    ctx.stroke();

    // Handlebars — horizontal bar near front wheel
    ctx.beginPath();
    ctx.moveTo(x - 6, y + 6);
    ctx.lineTo(x + 6, y + 6);
    ctx.strokeStyle = bodyColor;
    ctx.lineWidth   = 2.5;
    ctx.stroke();

    // Rider body — oval torso
    ctx.beginPath();
    ctx.ellipse(x, y, 5, 7, 0, 0, Math.PI * 2);
    ctx.fillStyle = bodyColor;
    ctx.fill();

    // Rider head
    ctx.beginPath();
    ctx.arc(x, y - 5, 4, 0, Math.PI * 2);
    ctx.fillStyle = skinColor;
    ctx.fill();
    ctx.strokeStyle = bodyColor;
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Steal-cooldown shield ring
    if (this.stealCooldownMs > 0) {
      const progress = this.stealCooldownMs / STEAL_COOLDOWN_MS;
      ctx.beginPath();
      ctx.arc(x, y, 24, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.strokeStyle = `rgba(99,220,99,${0.5 + 0.4 * progress})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Package indicator — yellow ring around whole figure
    if (this.hasPackage) {
      ctx.beginPath();
      ctx.arc(x, y, 20, 0, Math.PI * 2);
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth   = 3;
      ctx.stroke();
    }

    // Name label below
    ctx.font         = '11px Arial';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    const labelW = ctx.measureText(this.name).width + 8;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(x - labelW / 2, y + 16, labelW, 14);
    ctx.fillStyle = '#1e293b';
    ctx.fillText(this.name, x, y + 17);

    // Direction arrows for player
    if (this.isPlayer && gs) {
      let arrowTarget = null;
      if (gs.phase === 'SEEKING') {
        arrowTarget = gs.pkg;
      } else {
        arrowTarget = this.hasPackage
          ? gs.delivery
          : (gs.racers.find(r => r.hasPackage) || null);
      }
      if (arrowTarget) {
        const tpt   = map.project([arrowTarget.lng, arrowTarget.lat]);
        const angle = Math.atan2(tpt.y - y, tpt.x - x);
        const sz    = 8;
        ctx.save();
        ctx.translate(x + Math.cos(angle) * (R + 22), y + Math.sin(angle) * (R + 22));
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(sz, 0); ctx.lineTo(-sz * 0.65, sz * 0.65); ctx.lineTo(-sz * 0.65, -sz * 0.65);
        ctx.closePath();
        ctx.fillStyle = '#6b21a8';
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.restore();
  }
}

// ─── Package ─────────────────────────────────────────────────────────────────

class Package {
  constructor(loc) { this.reset(loc); }

  reset(loc) {
    this.lng = loc.lng; this.lat = loc.lat;
    this.locName = loc.name;
    this.isHeld = false; this.holder = null;
    this.type = randomItemType();
  }

  draw(ctx, map) {
    if (this.isHeld) return;
    const pt = map.project([this.lng, this.lat]);
    const x = pt.x, y = pt.y;
    const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 280);
    ctx.save();
    const glowColor = this.type.points >= 20
      ? `rgba(168,85,247,${pulse * 0.9})` : `rgba(250,204,21,${pulse * 0.8})`;
    ctx.shadowColor = glowColor; ctx.shadowBlur = 18;
    ctx.fillStyle = '#facc15'; ctx.strokeStyle = '#b45309'; ctx.lineWidth = 2;
    _roundRect(ctx, x - 14, y - 14, 28, 28, 5); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.font = '18px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(this.type.emoji, x, y);
    ctx.fillStyle = '#1e293b'; ctx.font = 'bold 10px Arial'; ctx.textBaseline = 'bottom';
    ctx.fillText(`${this.locName} · ${this.type.name} (+${this.type.points}pt)`, x, y - 17);
    ctx.restore();
  }
}

// ─── DeliveryPoint ───────────────────────────────────────────────────────────

class DeliveryPoint {
  constructor(loc) { this.lng = loc.lng; this.lat = loc.lat; this.locName = loc.name; }

  draw(ctx, map) {
    const pt = map.project([this.lng, this.lat]);
    const x = pt.x, y = pt.y;
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 380);
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, 28 + 8 * pulse, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(34,197,94,${0.35 + 0.3 * pulse})`; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(34,197,94,0.25)'; ctx.fill();
    ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x - 1, y + 7); ctx.lineTo(x + 8, y - 7); ctx.stroke();
    ctx.fillStyle = '#15803d'; ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(this.locName, x, y + 24);
    ctx.restore();
  }
}

// ─── Canvas helper ────────────────────────────────────────────────────────────

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
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
let minimapMap, minimapCanvas, minimapCtx, minimapReady = false;
let gs;
let lastTimestamp = null;
let rafId = null;

function createGameState() {
  const spawns = [
    STOCKHOLM_LOCATIONS.find(l => l.name === 'Sergels Torg'),
    STOCKHOLM_LOCATIONS.find(l => l.name === 'Gamla Stan'),
    STOCKHOLM_LOCATIONS.find(l => l.name === 'Medborgarplatsen'),
    STOCKHOLM_LOCATIONS.find(l => l.name === 'Stureplan'),
    STOCKHOLM_LOCATIONS.find(l => l.name === 'Slussen'),
  ];
  const racers = RACER_CONFIGS.map((cfg, i) => new Racer(cfg, spawns[i].lng, spawns[i].lat));
  return {
    phase: 'SEEKING',
    racers,
    pkg: new Package(randomLocation()),
    delivery: null,
    announcementMs: 0,
    winner: null,
  };
}

// ─── Loop ─────────────────────────────────────────────────────────────────────

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
  for (const r of gs.racers) { if (r.stealCooldownMs > 0) r.stealCooldownMs -= dt * 1000; }
  gs.racers[0].updateAsPlayer(dt, input);
  for (let i = 1; i < gs.racers.length; i++) gs.racers[i].updateAsBot(dt, botTarget(gs.racers[i]));
  if (gs.pkg.isHeld && gs.pkg.holder) { gs.pkg.lng = gs.pkg.holder.lng; gs.pkg.lat = gs.pkg.holder.lat; }
  gs.phase === 'SEEKING' ? updateSeeking() : updateDelivering();
  if (gs.announcementMs > 0) {
    gs.announcementMs -= dt * 1000;
    if (gs.announcementMs <= 0) document.getElementById('hud-announcement').style.display = 'none';
  }

  // Keep map centred on the player
  const player = gs.racers[0];
  map.easeTo({ center: [player.lng, player.lat], duration: 100, easing: t => t });
}

function botTarget(bot) {
  if (gs.phase === 'SEEKING') return gs.pkg;
  if (bot.hasPackage) return gs.delivery;
  return gs.racers.find(r => r.hasPackage) || gs.delivery;
}

function updateSeeking() {
  for (const r of gs.racers) {
    if (lngLatDist(r, gs.pkg) < PICKUP_RADIUS) { pickupPackage(r); return; }
  }
}

function pickupPackage(racer) {
  racer.hasPackage = true; gs.pkg.isHeld = true; gs.pkg.holder = racer;
  const delivLoc = randomLocation(gs.pkg);
  gs.delivery = new DeliveryPoint(delivLoc);
  gs.phase = 'DELIVERING';
  gs.racers.forEach(r => r.clearRoute());
  announce(`${racer.name} got ${gs.pkg.type.emoji} ${gs.pkg.type.name} at ${gs.pkg.locName}! Deliver to ${delivLoc.name} for ${gs.pkg.type.points}pts!`);
  setPhaseHUD(); updateScoreHUD();
}

function updateDelivering() {
  const holder = gs.racers.find(r => r.hasPackage);
  if (!holder) return;
  if (lngLatDist(holder, gs.delivery) < DELIVERY_RADIUS) { deliverPackage(holder); return; }
  if (holder.stealCooldownMs > 0) return;
  for (let i = 1; i < gs.racers.length; i++) {
    const bot = gs.racers[i];
    if (!bot.hasPackage && lngLatDist(bot, holder) < STEAL_RADIUS) { stealPackage(bot, holder); return; }
  }
  const player = gs.racers[0];
  if (!player.hasPackage && input.spaceJustPressed && lngLatDist(player, holder) < STEAL_RADIUS) {
    stealPackage(player, holder);
  }
}

function stealPackage(thief, victim) {
  victim.hasPackage = false; thief.hasPackage = true;
  gs.pkg.holder = thief;
  victim.stealFlashMs = 600;
  thief.stealCooldownMs = STEAL_COOLDOWN_MS;
  thief.clearRoute();
  announce(`${thief.name} stole the ${gs.pkg.type.name} from ${victim.name}!`);
}

function deliverPackage(holder) {
  const pts = gs.pkg.type.points;
  const delivName = gs.delivery.locName;
  holder.score += pts; holder.hasPackage = false;
  gs.pkg.isHeld = false; gs.pkg.holder = null; gs.delivery = null;
  gs.racers.forEach(r => r.clearRoute());
  updateScoreHUD();
  announce(`${holder.name} delivered ${gs.pkg.type.emoji} to ${delivName}! +${pts}pts (${holder.score} total)`);
  if (holder.score >= GAME_SETTINGS.winScore) { gs.winner = holder; return; }
  gs.pkg.reset(randomLocation());
  gs.phase = 'SEEKING';
  setPhaseHUD();
}


function renderMinimap() {
  if (!minimapReady || !minimapCanvas || !gs) return;
  const player = gs.racers[0];
  minimapMap.jumpTo({ center: [player.lng, player.lat] });
  const W = minimapCanvas.width, H = minimapCanvas.height;
  minimapCtx.clearRect(0, 0, W, H);
  function proj(lng, lat) {
    const pt = minimapMap.project([lng, lat]);
    return { x: pt.x, y: pt.y };
  }
  if (gs.delivery) {
    const p = proj(gs.delivery.lng, gs.delivery.lat);
    minimapCtx.beginPath(); minimapCtx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    minimapCtx.fillStyle = '#22c55e'; minimapCtx.fill();
  }
  if (!gs.pkg.isHeld) {
    const p = proj(gs.pkg.lng, gs.pkg.lat);
    minimapCtx.beginPath(); minimapCtx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    minimapCtx.fillStyle = '#facc15'; minimapCtx.fill();
  }
  for (const r of gs.racers) {
    const p = proj(r.lng, r.lat);
    minimapCtx.beginPath(); minimapCtx.arc(p.x, p.y, r.isPlayer ? 5 : 3, 0, Math.PI * 2);
    minimapCtx.fillStyle = r.color; minimapCtx.fill();
  }
}
// ─── Render ───────────────────────────────────────────────────────────────────

function render(dt) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (gs.delivery) gs.delivery.draw(ctx, map);
  if (!gs.pkg.isHeld) gs.pkg.draw(ctx, map);
  for (const r of gs.racers) r.draw(ctx, map, dt);
  renderMinimap();
}

// ─── HUD ──────────────────────────────────────────────────────────────────────

function announce(text) {
  const el = document.getElementById('hud-announcement');
  el.textContent = text; el.style.display = 'block';
  gs.announcementMs = 2500;
}

function setPhaseHUD() {
  const el = document.getElementById('hud-phase');
  if (gs.phase === 'SEEKING') {
    el.textContent = `Phase 1: Race to ${gs.pkg.locName}!`;
    el.className = 'phase-seeking';
  } else {
    const dest = gs.delivery ? gs.delivery.locName : '?';
    el.textContent = `Phase 2: Deliver to ${dest}!`;
    el.className = 'phase-delivering';
  }
}

function updateScoreHUD() {
  document.getElementById('hud-scores').innerHTML = gs.racers
    .slice().sort((a, b) => b.score - a.score)
    .map(r => `<div class="score-row" style="--color:${r.color}">
      <span class="score-name">${r.name}</span>
      <span class="score-val">${r.score}</span>
    </div>`).join('');
}

function showWinScreen(racer) {
  const nm = document.getElementById('win-name');
  nm.textContent = racer.name; nm.style.color = racer.color;
  document.getElementById('win-screen').style.display = 'flex';
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function initSettings() {
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.toggle('visible');
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.remove('visible');
  });
  document.getElementById('btn-newgame-settings').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.remove('visible');
    startGame();
  });
  document.querySelectorAll('#setting-speed button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#setting-speed button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      GAME_SETTINGS.speedMultiplier = parseFloat(btn.dataset.val);
    });
  });
  document.querySelectorAll('#setting-win button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#setting-win button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      GAME_SETTINGS.winScore = parseInt(btn.dataset.val);
    });
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

function initBounds() {
  const b = map.getBounds();
  BOUNDS = { minLng: b.getWest(), maxLng: b.getEast(), minLat: b.getSouth(), maxLat: b.getNorth() };
}

function syncCanvasSize() {
  const c = map.getContainer();
  canvas.width = c.offsetWidth; canvas.height = c.offsetHeight;
}

window.addEventListener('DOMContentLoaded', () => {
  mapboxgl.accessToken = MAPBOX_TOKEN;
  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [18.07, 59.33],
    zoom: 14,
    minZoom:   14,
    maxZoom:   14,
    interactive: false,
  });
  canvas = document.getElementById('gameCanvas');
  ctx    = canvas.getContext('2d');
  minimapCanvas = document.getElementById('minimap-canvas');
  minimapCtx = minimapCanvas.getContext('2d');
  minimapMap = new mapboxgl.Map({
    container: 'minimap-map',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [18.07, 59.33],
    zoom: 12,
    interactive: false,
    attributionControl: false,
  });
  minimapMap.on('load', () => {
    minimapMap.scrollZoom.disable();
    const c = document.getElementById('minimap-container');
    minimapCanvas.width = c.offsetWidth;
    minimapCanvas.height = c.offsetHeight;
    minimapReady = true;
  });
  input  = new InputHandler();
  initSettings();
  map.on('load', () => {
    map.scrollZoom.disable();
    map.doubleClickZoom.disable();
    map.touchZoomRotate.disable();
    syncCanvasSize();
    initBounds();
    initRoadLayers();
    initWaterLayers();
    window.addEventListener('resize', () => { syncCanvasSize(); initBounds(); });
    map.on('move', initBounds);
    startGame();
  });

  // Block scroll/pinch zoom reaching the map through the pointer-events:none canvas
  document.getElementById('map').addEventListener('wheel', e => e.preventDefault(), { passive: false });

  document.getElementById('btn-restart').addEventListener('click', startGame);
});
