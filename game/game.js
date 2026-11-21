/* Lamplight — a small stealth game.
 *
 * Top-down, one level, no network and no build step: everything the page loads
 * is this file and index.html.
 *
 * The design goal is the brief's own list: a level seen from above, guards with
 * visible vision cones, cover to hide behind, and an exit to reach unseen. The
 * twist that makes it its own game is the light: the yard is dark, three lamps
 * burn, and each guard's cone is a lit wedge. Standing in a guard's cone is
 * what raises the alarm; standing in cover or outside every cone cools it.
 * Dashing is faster than sneaking but louder, so the safe route is slow.
 *
 * Rendering is a lit scene: the level is drawn once per frame, then a dark
 * multiply pass is cut away by each lamp, so a guard's cone is literally a
 * hole in the darkness. Everything is procedural: no image, sound or font is
 * loaded from anywhere.
 */

'use strict';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;

const elAlarm = document.getElementById('alarm');
const elAlarmTxt = document.getElementById('alarmTxt');
const elMsg = document.getElementById('msg');
const elMsgTitle = document.getElementById('msgTitle');
const elMsgSub = document.getElementById('msgSub');

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/* ---------------------------------------------------------------- level ---- */

// Solid walls. The yard is a walled compound with interior blocks to hide
// behind; the player starts bottom-left, the gate is top-right.
const walls = [
  // outer wall
  [0, 0, W, 16], [0, H - 16, W, 16], [0, 0, 16, H], [W - 16, 0, 16, H],
  // interior cover blocks
  [150, 120, 40, 200],
  [150, 120, 190, 40],
  [300, 300, 220, 40],
  [560, 150, 40, 190],
  [470, 380, 40, 180],
  [190, 470, 190, 40],
  [660, 430, 250, 40],
  [740, 200, 150, 40],
];

// Lamps: the pools of light in the yard. Guards see inside their cones; the
// lamps are also what the player can use to read the level.
const lamps = [
  { x: 250, y: 300, r: 250 },
  { x: 620, y: 260, r: 250 },
  { x: 500, y: 520, r: 230 },
];

const gate = { x: W - 78, y: 78, r: 26 };

/* ---------------------------------------------------------------- input ---- */

const keys = new Set();
let started = false;

addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  keys.add(e.key.toLowerCase());
  if (!started && e.key !== 'Shift') begin();
  if (e.key.toLowerCase() === 'r') reset();
});

addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

/* Sim state. Kept in one object so reset() is a single assignment. */
let S;
function reset() {
  S = {
    player: { x: 92, y: H - 92, vx: 0, vy: 0, r: 11, sneak: false },
    alarm: 0,          // 0..1, 1 means caught
    won: false,
    lost: false,
    t: 0,
    dash: 0,
    dashes: 3,
    trace: [],         // recent player positions, drawn as a faint trail
    guards: makeGuards(),
  };
  setMsg(null);
  elAlarm.style.width = '0%';
  elAlarm.style.background = '#6fe08a';
  elAlarmTxt.textContent = 'calm';
}

function makeGuards() {
  // Each guard walks a fixed patrol and sweeps its cone as it goes. Speeds
  // differ so the cones are never in lockstep, which keeps the route readable
  // but never solved.
  const specs = [
    { pts: [[250, 300], [250, 500], [120, 500]], i: 0, t: 0, speed: 62,
      fov: 0.72, range: 190, sweep: 0.5, phase: 0, name: 'A' },
    { pts: [[620, 260], [620, 120], [780, 120]], i: 0, t: 0, speed: 74,
      fov: 0.66, range: 205, sweep: 0.42, phase: 1.7, name: 'B' },
    { pts: [[500, 520], [780, 520], [780, 400]], i: 0, t: 0, speed: 56,
      fov: 0.8, range: 180, sweep: 0.6, phase: 3.1, name: 'C' },
    { pts: [[360, 190], [540, 190], [540, 300]], i: 0, t: 0, speed: 68,
      fov: 0.6, range: 200, sweep: 0.36, phase: 4.4, name: 'D' },
  ];
  // Start each guard on its first waypoint: a guard with no position yet would
  // aim its cone at NaN and take the frame down.
  return specs.map((g) => ({ ...g, x: g.pts[0][0], y: g.pts[0][1], face: 0 }));
}

function begin() {
  started = true;
  if (S.won || S.lost) reset();
  setMsg(null);
}

function setMsg(title, sub) {
  if (title === null) { elMsg.classList.add('hide'); return; }
  elMsg.classList.remove('hide');
  elMsgTitle.textContent = title;
  elMsgSub.innerHTML = sub || '';
}

/* ------------------------------------------------------------- collision --- */

function hitsWall(x, y, r) {
  if (x - r < 0 || y - r < 0 || x + r > W || y + r > H) return true;
  for (const [wx, wy, ww, wh] of walls) {
    const cx = clamp(x, wx, wx + ww);
    const cy = clamp(y, wy, wy + wh);
    if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return true;
  }
  return false;
}

/* Segment/AABB test, so a cone is blocked by walls rather than seeing through
 * them: this is what makes cover actually work. */
function segBlocked(ax, ay, bx, by) {
  for (const [wx, wy, ww, wh] of walls) {
    if (segRect(ax, ay, bx, by, wx, wy, ww, wh)) return true;
  }
  return false;
}

function segRect(ax, ay, bx, by, rx, ry, rw, rh) {
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - rx, rx + rw - ax, ay - ry, ry + rh - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

/* ----------------------------------------------------------------- update -- */

function update(dt) {
  S.t += dt;
  const p = S.player;

  if (S.won || S.lost) {
    p.vx = p.vy = 0;
    updateGuards(dt);
    return;
  }

  p.sneak = keys.has('shift');
  const speed = p.sneak ? 78 : 150;

  let ix = 0, iy = 0;
  if (keys.has('a') || keys.has('arrowleft')) ix -= 1;
  if (keys.has('d') || keys.has('arrowright')) ix += 1;
  if (keys.has('w') || keys.has('arrowup')) iy -= 1;
  if (keys.has('s') || keys.has('arrowdown')) iy += 1;

  const len = Math.hypot(ix, iy) || 1;
  ix /= len; iy /= len;

  // Dash: a burst that costs one of three charges, on a short cooldown.
  S.dash = Math.max(0, S.dash - dt);
  if (keys.has(' ') && S.dashes > 0 && S.dash === 0 && (ix || iy)) {
    S.dashes -= 1;
    S.dash = 0.55;
  }
  const boost = S.dash > 0 ? 1.75 : 1;

  const nx = p.x + ix * speed * boost * dt;
  const ny = p.y + iy * speed * boost * dt;
  // Axis-separated movement, so sliding along a wall feels right.
  if (!hitsWall(nx, p.y, p.r)) p.x = nx;
  if (!hitsWall(p.x, ny, p.r)) p.y = ny;

  S.trace.push([p.x, p.y]);
  if (S.trace.length > 90) S.trace.shift();

  updateGuards(dt);

  // Exposure: how much of the player is inside any guard's cone, with the
  // nearest guard weighted most. One guard watching is enough to raise alarm;
  // two watching at once raise it much faster.
  let seen = 0;
  for (const g of S.guards) {
    if (guardSees(g, p.x, p.y)) {
      const d = dist(g.x, g.y, p.x, p.y);
      seen = Math.max(seen, clamp(1 - d / g.range, 0.25, 1));
    }
  }

  // Sneaking and distance both slow the rise. Alarm falls whenever unseen.
  if (seen > 0) {
    const rate = seen * (p.sneak ? 0.5 : 1) * 1.15;
    S.alarm += rate * dt;
  } else {
    S.alarm -= 0.62 * dt;
  }
  S.alarm = clamp(S.alarm, 0, 1);

  if (S.alarm >= 1) {
    S.lost = true;
    setMsg('SPOTTED', 'The lamplighters have you.<br>Press R to try again.');
  }

  if (dist(p.x, p.y, gate.x, gate.y) < gate.r + p.r) {
    S.won = true;
    setMsg('THROUGH THE GATE', `Unseen, with the alarm at ${Math.round(S.alarm * 100)}%.<br>Press R to run it again.`);
  }

  // HUD
  const pct = Math.round(S.alarm * 100);
  elAlarm.style.width = pct + '%';
  elAlarm.style.background = S.alarm < 0.4 ? '#6fe08a' : S.alarm < 0.75 ? '#e8c766' : '#e2675d';
  elAlarmTxt.textContent = S.alarm < 0.05 ? 'calm' : S.alarm < 0.4 ? 'uneasy'
    : S.alarm < 0.75 ? 'suspicious' : 'almost caught';
}

function updateGuards(dt) {
  for (const g of S.guards) {
    const a = g.pts[g.i];
    const b = g.pts[(g.i + 1) % g.pts.length];
    const d = dist(a[0], a[1], b[0], b[1]);
    g.t += (g.speed * dt) / d;
    while (g.t >= 1) { g.t -= 1; g.i = (g.i + 1) % g.pts.length; }
    const a2 = g.pts[g.i];
    const b2 = g.pts[(g.i + 1) % g.pts.length];
    const px = g.x, py = g.y;
    g.x = lerp(a2[0], b2[0], g.t);
    g.y = lerp(a2[1], b2[1], g.t);
    // Face the direction of travel, plus a slow sweep so cones scan.
    const want = Math.atan2(g.y - py, g.x - px);
    g.face = want + Math.sin(S.t * g.sweep + g.phase) * 0.55;
  }
}

function guardSees(g, x, y) {
  const d = dist(g.x, g.y, x, y);
  if (d > g.range) return false;
  let da = Math.atan2(y - g.y, x - g.x) - g.face;
  while (da > Math.PI) da -= TAU;
  while (da < -Math.PI) da += TAU;
  if (Math.abs(da) > g.fov / 2) return false;
  return !segBlocked(g.x, g.y, x, y);
}

/* ----------------------------------------------------------------- render -- */

// The dark overlay is built once and punched through by each light, then
// multiplied over the scene. Cheap, and it makes the cones read as light.
const shade = document.createElement('canvas');
shade.width = W; shade.height = H;
const sctx = shade.getContext('2d');

function render() {
  // 1. floor
  ctx.fillStyle = '#20272f';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#252d37';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // 2. trail: where the player has been, a cold line on the ground
  if (S.trace.length > 1) {
    ctx.strokeStyle = 'rgba(120,190,235,0.30)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(S.trace[0][0], S.trace[0][1]);
    for (const [x, y] of S.trace) ctx.lineTo(x, y);
    ctx.stroke();
  }

  // 3. gate
  const pulse = 0.5 + 0.5 * Math.sin(S.t * 2.4);
  ctx.fillStyle = `rgba(120,230,150,${0.18 + 0.16 * pulse})`;
  ctx.beginPath(); ctx.arc(gate.x, gate.y, gate.r + 10, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#77e39a'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(gate.x, gate.y, gate.r, 0, TAU); ctx.stroke();
  ctx.fillStyle = '#cfeedd'; ctx.font = '12px ui-monospace, monospace'; ctx.textAlign = 'center';
  ctx.fillText('GATE', gate.x, gate.y + 4);

  // 4. lamps on the ground
  for (const l of lamps) {
    const grd = ctx.createRadialGradient(l.x, l.y, 4, l.x, l.y, l.r);
    grd.addColorStop(0, 'rgba(255,226,160,0.30)');
    grd.addColorStop(1, 'rgba(255,226,160,0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(l.x, l.y, l.r, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffe6a6'; ctx.beginPath(); ctx.arc(l.x, l.y, 5, 0, TAU); ctx.fill();
  }

  // 5. walls
  for (const [x, y, w, h] of walls) {
    ctx.fillStyle = '#39434f';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#4a5765';
    ctx.fillRect(x, y, w, 4);
  }

  // 6. vision cones, drawn as translucent wedges over the floor
  for (const g of S.guards) {
    const seeing = S.alarm > 0.001 && guardSees(g, S.player.x, S.player.y);
    const grd = ctx.createRadialGradient(g.x, g.y, 8, g.x, g.y, g.range);
    const hot = seeing ? '255,110,96' : '255,196,110';
    grd.addColorStop(0, `rgba(${hot},0.30)`);
    grd.addColorStop(1, `rgba(${hot},0)`);
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.moveTo(g.x, g.y);
    ctx.arc(g.x, g.y, g.range, g.face - g.fov / 2, g.face + g.fov / 2);
    ctx.closePath();
    ctx.fill();
  }

  // 7. player
  const p = S.player;
  ctx.fillStyle = p.sneak ? '#7fd0ff' : '#a9e2ff';
  ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#0d141b'; ctx.lineWidth = 2; ctx.stroke();

  // 8. guards
  for (const g of S.guards) {
    ctx.fillStyle = '#e8b45f';
    ctx.beginPath(); ctx.arc(g.x, g.y, 10, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#0d141b'; ctx.lineWidth = 2; ctx.stroke();
    // facing tick
    ctx.strokeStyle = '#ffe6a6'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(g.x, g.y);
    ctx.lineTo(g.x + Math.cos(g.face) * 17, g.y + Math.sin(g.face) * 17);
    ctx.stroke();
  }

  // 9. darkness, punched by lamps and cones
  sctx.globalCompositeOperation = 'source-over';
  sctx.clearRect(0, 0, W, H);
  sctx.fillStyle = 'rgba(6,9,14,0.82)';
  sctx.fillRect(0, 0, W, H);
  sctx.globalCompositeOperation = 'destination-out';
  for (const l of lamps) {
    const grd = sctx.createRadialGradient(l.x, l.y, 6, l.x, l.y, l.r * 1.1);
    grd.addColorStop(0, 'rgba(0,0,0,1)');
    grd.addColorStop(0.65, 'rgba(0,0,0,0.85)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    sctx.fillStyle = grd;
    sctx.beginPath(); sctx.arc(l.x, l.y, l.r * 1.1, 0, TAU); sctx.fill();
  }
  for (const g of S.guards) {
    const grd = sctx.createRadialGradient(g.x, g.y, 8, g.x, g.y, g.range);
    grd.addColorStop(0, 'rgba(0,0,0,0.95)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    sctx.fillStyle = grd;
    sctx.beginPath();
    sctx.moveTo(g.x, g.y);
    sctx.arc(g.x, g.y, g.range, g.face - g.fov / 2, g.face + g.fov / 2);
    sctx.closePath(); sctx.fill();
  }
  // a small pool of sight around the player, so you always know where you are
  const pg = sctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, 96);
  pg.addColorStop(0, 'rgba(0,0,0,0.95)');
  pg.addColorStop(1, 'rgba(0,0,0,0)');
  sctx.fillStyle = pg;
  sctx.beginPath(); sctx.arc(p.x, p.y, 96, 0, TAU); sctx.fill();

  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(shade, 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  // 10. a vignette and the dash charges, drawn on top of the darkness
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'left';
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(220,232,245,0.75)';
  ctx.fillText('dashes ' + '●'.repeat(S.dashes) + '○'.repeat(3 - S.dashes), 16, H - 34);
}

/* ------------------------------------------------------------- main loop --- */

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  try {
    if (started) update(dt);
    render();
  } catch (err) {
    // A thrown frame would stop the loop for good, leaving a dead canvas. Keep
    // drawing instead, so a bad value costs one frame rather than the game.
    console.error('frame:', err && err.message);
  }
  requestAnimationFrame(frame);
}

reset();
// reset() clears the overlay, so the title screen goes back up after it: the
// player should see the objective before the level starts moving.
setMsg('LAMPLIGHT',
  'Cross the yard to the gate. The lamplighters are looking.<br>Press any key to begin.');
requestAnimationFrame(frame);
