// Runnable self-check for the stealth game's logic.
//
// The game is one classic script with closure-scoped state, so this loads it in
// a VM with a stub DOM and drives the same update() the browser runs. It proves
// the three things a screenshot cannot: guards have finite positions, the win
// branch fires when the player reaches the gate, the lose branch fires at full
// alarm, and a guard cannot see through a wall.
//
// Run: node game/_check.js   (expects game/_test.js beside it, written by the
// generator below when the game is built)
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const canvasCtx = new Proxy({}, {
  get: (_t, k) => {
    if (k === 'createRadialGradient' || k === 'createLinearGradient') {
      return () => ({ addColorStop() {} });
    }
    return () => {};
  },
});

const mkEl = (id) => ({
  id, style: {}, textContent: '', innerHTML: '', width: 960, height: 600,
  classList: { add() {}, remove() {}, contains: () => false },
  getContext: () => canvasCtx, addEventListener() {}, getBoundingClientRect: () => ({}),
});

const els = {};
global.document = {
  getElementById: (id) => (els[id] ||= mkEl(id)),
  createElement: (t) => mkEl(t),
  activeElement: { tagName: 'BODY' },
};
global.window = global;
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = () => 0;
global.addEventListener = () => {};

// The game file plus a trailing export of its internals, for tests only.
const gameSrc = fs.readFileSync(path.join(__dirname, 'game', 'game.js'), 'utf8');
const hooked = gameSrc +
  '\n;globalThis.__t = { get S(){return S}, update, guardSees, reset,' +
  ' get started(){return started}, set started(v){started=v} };\n';
vm.runInThisContext(hooked);

const T = globalThis.__t;
let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails++;
};

T.reset();
T.started = true;
check('guards start at finite positions',
  T.S.guards.every((g) => Number.isFinite(g.x) && Number.isFinite(g.y)),
  JSON.stringify(T.S.guards.map((g) => [Math.round(g.x), Math.round(g.y)])));

// Win: stand on the gate and step.
const S = T.S;
S.player.x = 882; S.player.y = 78;
T.update(0.016);
check('reaching the gate wins', S.won === true, 'title=' + els.msgTitle.textContent);

// Lose: stay in a guard's cone and let the alarm run up. The guard keeps
// walking, so the player is re-placed in front of it each step — a stationary
// player gets out of view before the alarm fills, which is the game working.
T.reset(); T.started = true;
{
  T.update(0.016);
  let steps = 0;
  let peak = 0;
  while (!T.S.lost && steps < 1200) {
    const g0 = T.S.guards[0];
    T.S.player.x = g0.x + Math.cos(g0.face) * 40;
    T.S.player.y = g0.y + Math.sin(g0.face) * 40;
    T.update(0.016);
    peak = Math.max(peak, T.S.alarm);
    steps++;
  }
  check('being seen long enough loses', T.S.lost === true,
    `peak=${peak.toFixed(2)} steps=${steps} title=${els.msgTitle.textContent}`);
}

// Detection shape and wall occlusion.
T.reset();
const g = T.S.guards[0];
check('a guard sees straight ahead', T.guardSees(g, g.x + 30, g.y) === true);
check('a guard does not see behind', T.guardSees(g, g.x - 60, g.y) === false);
check('a guard does not see through a wall',
  T.guardSees({ x: 100, y: 200, face: 0, fov: 0.8, range: 300 }, 560, 200) === false);

// The level is winnable: a path exists from the spawn to the gate.
const walls = [
  [0, 0, 960, 16], [0, 584, 960, 16], [0, 0, 16, 600], [944, 0, 16, 600],
  [150, 120, 40, 200], [150, 120, 190, 40], [300, 300, 220, 40], [560, 150, 40, 190],
  [470, 380, 40, 180], [190, 470, 190, 40], [660, 430, 250, 40], [740, 200, 150, 40],
];
const free = (x, y, r = 11) => {
  if (x - r < 16 || y - r < 16 || x + r > 944 || y + r > 584) return false;
  return !walls.some(([wx, wy, ww, wh]) => {
    const cx = Math.min(Math.max(x, wx), wx + ww);
    const cy = Math.min(Math.max(y, wy), wy + wh);
    return (x - cx) ** 2 + (y - cy) ** 2 < r * r;
  });
};
const step = 8;
const start = [96, 512];
const goal = [880, 80];
const seen = new Set([start.join()]);
const queue = [start];
let found = false;
while (queue.length) {
  const [cx, cy] = queue.shift();
  if (Math.abs(cx - goal[0]) <= step && Math.abs(cy - goal[1]) <= step) { found = true; break; }
  for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
    const nx = cx + dx, ny = cy + dy;
    const k = nx + ',' + ny;
    if (seen.has(k) || nx < 16 || ny < 16 || nx > 944 || ny > 584) continue;
    if (!free(nx, ny)) continue;
    seen.add(k); queue.push([nx, ny]);
  }
}
check('a path exists from spawn to gate', found, `${seen.size} tiles reachable`);

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
