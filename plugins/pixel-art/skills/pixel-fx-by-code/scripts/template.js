#!/usr/bin/env node
'use strict';
/* template.js - the smallest complete effect built with fx.js: a "poof" (an item vanishing).
 * Copy it to start a new effect: change the elements, the colours and the timing, run, look, repeat.
 *
 *   node template.js [out]
 */
const path = require('path');
const FX = require('./fx.js');
const P = FX.P;

const W = 40, H = 40, CX = 20, CY = 22, FPS = 15;
const SMOKE = ['#ffffff', '#d8dcef', '#9aa3c7'];            // lit, base, shade
const LINE = '#5a6190', SPARK = '#ffd34d';                  // a light effect needs a dark edge to show on light backgrounds
const rnd = FX.rng(3);                                      // seeded: same frames on every run

// 1. elements: a ring of puffs thrown outwards, then a few twinkles
const puffs = [];
for (let i = 0; i < 8; i++) {
  const a = FX.stratified(i, 8, rnd), sp = FX.between(rnd, [35, 55]);
  puffs.push({ x: CX, y: CY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.8, r: FX.between(rnd, [4, 6]),
    t0: FX.between(rnd, [0, 0.05]), life: FX.between(rnd, [0.45, 0.7]), eatDir: a + Math.PI });   // bitten from the inside
}
const twinkles = [];
for (let i = 0; i < 4; i++) {
  const a = FX.stratified(i, 4, rnd);
  twinkles.push({ x: CX + Math.cos(a) * 11, y: CY + Math.sin(a) * 9, t0: 0.1 + i * 0.06 });
}

// 2. one frame = the state of every element at time t, drawn layer by layer
function render(t) {
  const cloud = P.surface(W, H);
  for (const p of puffs) {
    const u = t - p.t0;
    if (u < 0 || u > p.life) continue;
    const { x, y } = FX.integrate(p, u, { drag: 7, buoy: 25 });
    const r = p.r * FX.ease.outCubic(FX.clamp(u / 0.1, 0, 1)) * (1 - 0.6 * FX.smooth(0.5 * p.life, p.life, u));
    FX.puff(cloud, x, y, r, SMOKE, { eat: FX.smooth(0.35 * p.life, p.life, u), eatDir: p.eatDir });
  }
  FX.clean(cloud);                                          // clean the puff layer only
  const s = P.surface(W, H).blit(cloud.copy().outline(LINE), 0, 0);   // outline a copy: the check counts the clean layer
  for (const k of twinkles) {                               // 1 px wide, so drawn after cleaning
    const u = t - k.t0;
    if (u >= 0 && u < 0.2) FX.star(s, k.x, k.y, { ray: u < 0.1 ? 2 : 1, diag: 0 }, SPARK, SPARK);
  }
  return { img: s, cloud };
}

// 3. render until everything is gone, read the numbers, export, then look at the images
const all = [], layers = [];
for (let i = 0; i <= Math.ceil(0.8 * FPS); i++) { const r = render(i / FPS); all.push(r.img); layers.push(r.cloud); }
const kept = FX.trim(all, layers);
FX.report(kept.frames, { layers: kept.layers, groups: { smoke: SMOKE, line: [LINE], spark: [SPARK] } });
const out = process.argv[2] || path.join('out', 'poof');
FX.exportAll(out, 'poof', kept.frames, { fps: FPS, anchor: [CX, CY] });
console.log(`${out}: look at sheet.png, backgrounds.png and sizes.png`);
