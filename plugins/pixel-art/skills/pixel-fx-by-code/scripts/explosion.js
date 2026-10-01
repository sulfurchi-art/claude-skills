#!/usr/bin/env node
'use strict';
/* explosion.js - pixel-art burst effects from one small simulation.
 *
 *   node explosion.js [out] [--preset explosion|magic|dust|hit] [--seed N] [--scale S] [--fps N]
 *                     [--set path=value ...]     e.g. --set puffs.n=22 --set "puffs.r=[4,7]" --set ring=null
 *
 * explosion  flash star -> white flash disc -> a fireball of flat puffs that each cool on their own
 *            (white -> yellow -> orange -> red -> dark smoke) -> rising smoke bitten away into
 *            crescents; plus a two-colour shock ring, sparks behind the cloud and embers in front
 * magic      the same motion with a white -> cyan -> violet palette, floating sparks, lingering dust
 * dust       no fire: a flat, ground-hugging puff of dust for landings and footsteps
 * hit        a tiny impact: flash, ring and fast sparks, no puffs (32x32, 20 fps)
 *
 * It renders until every element is gone, trims empty frames at both ends, prints one line of
 * numbers per frame and writes the frames, a sprite sheet + JSON, a GIF and the check images
 * (see fx.exportAll). For a new effect, copy a preset below and change it.
 */
const path = require('path');
const FX = require('./fx.js');
const P = FX.P;

// Lengths are in pixels (multiplied by --scale), times in seconds, [a, b] = random between a and b.
const EXPLOSION = {
  canvas: [64, 80], center: [32, 52], fps: 15, duration: 'auto', seed: 7,   // auto: until every element is gone
  fire: ['#fffbe6', '#ffe66d', '#ffb53b', '#f5712b', '#d43d2a', '#8e2032', '#4f1a33'],   // hot -> cold
  heat: [1.05, 0.82, 0.64, 0.5, 0.38, 0.28, 0.2],   // a puff at least this hot gets that fire colour
  smoke: ['#8f8496', '#655c70', '#463f54', '#2f2a3b'],   // light -> dark
  freshSmoke: 0.12,                                 // smoke still hotter than this uses the darker three
  ringColours: ['#fff1b8', '#f5712b'],              // outer, inner
  sparkColours: [0, 1, 2, 3],                       // fire colours by spark age
  outline: null,                                    // e.g. '#2b2f6b': 1 px dark edge round the puffs, for light backgrounds
  drag: 5,
  flash: { star: { ray: 11, down: 9, diag: 6, core: 4 }, starUntil: 0.033, disc: 12, discY: -1, discUntil: 0.1 },
  ring: { start: 0.02, dur: 0.24, r0: 6, r1: 22, thick2: 0.6, squash: 1, dy: 0 },   // ground blast: squash 0.35, dy 14
  core: { r: 9, grow: 0.12, heat: 1.4, tau: 0.24, life: 1.1, buoy: 90, vy: -4, z: 0.75 },
  puffs: {
    n: 11, jitter: 0.6, arc: [0, Math.PI * 2], offset: [1, 4], speed: [28, 60], squash: 0.8, buoy: [90, 150],
    t0: [0, 0.04], r: [6, 10], grow: [0.1, 0.18], heat: [1.2, 1.5], tau: [0.16, 0.28], life: [0.8, 1.25], z: [0.3, 0.9],
  },
  column: {
    n: 6, jitter: 0.8, spread: 2.2, offset: [4, 9], lift: 3, speed: 10, buoy: [130, 180],
    t0: [0.12, 0.26], r: [5, 8.5], grow: [0.22, 0.32], heat: 0.3, tau: 0.2, life: [0.8, 1.15], z: [0, 0.3],
  },
  life: { hold: 0.05, expand: 0.4, shrink: 0.75, shrinkFrom: 0.6, eatFrom: 0.45, eatTo: 0.95, eatDir: Math.PI / 2, eatSpread: 1.6, eatSize: 1.2 },
  sparks: { n: 18, jitter: 1, speed: [45, 100], squash: 0.75, lift: 20, t0: [0.02, 0.07], life: [0.22, 0.47], drag: 4, grav: 90, trail: 0.05 },
  embers: { n: 7, spreadX: 16, spreadY: 10, lift: 4, rise: [14, 26], t0: [0.3, 0.5], life: [0.35, 0.65], wobble: 1.5, blink: 3 },
};
const PRESETS = {
  explosion: {},
  magic: {
    fire: ['#ffffff', '#d9fbff', '#8ff0ff', '#4fb8ff', '#5d6cf2', '#6b46c9', '#4b2c86'],
    smoke: ['#c7a6f0', '#9a74d6', '#6f4fae', '#48337a'],
    ringColours: ['#f2fdff', '#4fb8ff'],
    outline: '#2b2f6b',                             // white and cyan vanish on light backgrounds without it
    core: { life: 0.9, buoy: 40 },
    puffs: { buoy: [40, 80], life: [0.6, 0.95] },
    column: { n: 3 },
    sparks: { n: 24, grav: 15, life: [0.3, 0.6] },
    embers: { n: 12, rise: [8, 16], life: [0.4, 0.7] },
  },
  dust: {
    canvas: [72, 40], center: [36, 31],
    smoke: ['#e3d3b8', '#bfa888', '#937b62', '#66543f'],
    flash: null, ring: null, sparks: null, embers: null, column: null,
    core: { r: 6, heat: 0, buoy: 10, vy: -2, life: 0.7 },
    puffs: { n: 9, arc: [Math.PI, Math.PI * 2], jitter: 0.8, offset: [2, 5], speed: [30, 70], squash: 0.35,
      buoy: [10, 30], r: [4, 7], grow: [0.08, 0.14], heat: [0, 0], life: [0.45, 0.75] },
  },
  hit: {
    canvas: [32, 32], center: [16, 16], fps: 20,
    flash: { star: { ray: 7, down: 7, diag: 4, core: 2 }, starUntil: 0.025, disc: 6, discY: 0, discUntil: 0.075 },
    ring: { start: 0.02, dur: 0.18, r0: 3, r1: 13, thick2: 0.5 },
    core: null, puffs: null, column: null, embers: null,
    sparks: { n: 10, speed: [50, 100], squash: 1, lift: 0, life: [0.12, 0.25], drag: 7, grav: 0, trail: 0.04 },
  },
};
function merge(a, b) {                               // presets override the defaults; null switches a part off
  if (b === null) return null;
  if (b === undefined) return a;
  if (typeof b !== 'object' || Array.isArray(b) || !a || typeof a !== 'object' || Array.isArray(a)) return b;
  const r = { ...a };
  for (const k in b) r[k] = merge(a[k], b[k]);
  return r;
}

function build(cfg, S) {
  const W = Math.round(cfg.canvas[0] * S), H = Math.round(cfg.canvas[1] * S), CX = cfg.center[0] * S, CY = cfg.center[1] * S;
  const rnd = FX.rng(cfg.seed), B = (r) => FX.between(rnd, r), L = cfg.life;
  const fire = cfg.fire.map(P.c), smoke = cfg.smoke.map(P.c);
  const puffs = [];
  const add = (o) => { o.eatDir = L.eatDir + (rnd() - 0.5) * L.eatSpread; puffs.push(o); };
  const C = cfg.core;
  if (C) add({ x: CX, y: CY, vx: 0, vy: C.vy * S, buoy: C.buoy * S, t0: 0, rmax: C.r * S, grow: C.grow, heat: C.heat, tau: C.tau, life: C.life, z: C.z });
  const F = cfg.puffs;
  for (let i = 0; F && i < F.n; i++) {               // the fireball: one jittered direction per slot
    const a = FX.stratified(i, F.n, rnd, { jitter: F.jitter, arc: F.arc }), d = B(F.offset) * S, sp = B(F.speed) * S;
    add({
      x: CX + Math.cos(a) * d, y: CY + Math.sin(a) * d, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * F.squash,
      buoy: B(F.buoy) * S, t0: B(F.t0), rmax: B(F.r) * S, grow: B(F.grow), heat: B(F.heat), tau: B(F.tau), life: B(F.life), z: B(F.z),
    });
  }
  const K = cfg.column;
  for (let i = 0; K && i < K.n; i++) {               // smoke column: later, behind, rises faster
    const a = -Math.PI / 2 + ((i + rnd() * K.jitter) / K.n - 0.5) * K.spread, d = B(K.offset) * S;
    add({
      x: CX + Math.cos(a) * d, y: CY - K.lift * S + Math.sin(a) * d, vx: Math.cos(a) * K.speed * S, vy: Math.sin(a) * K.speed * S,
      buoy: B(K.buoy) * S, t0: B(K.t0), rmax: B(K.r) * S, grow: B(K.grow), heat: B(K.heat), tau: B(K.tau), life: B(K.life), z: B(K.z),
    });
  }
  puffs.sort((a, b) => a.z - b.z);                   // fixed painter's order - never re-sort per frame
  const sparks = [], Sp = cfg.sparks;
  for (let i = 0; Sp && i < Sp.n; i++) {
    const a = FX.stratified(i, Sp.n, rnd, { jitter: Sp.jitter === undefined ? 1 : Sp.jitter }), sp = B(Sp.speed) * S;
    sparks.push({ x: CX, y: CY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * Sp.squash - Sp.lift * S, t0: B(Sp.t0), life: B(Sp.life) });
  }
  const embers = [], E = cfg.embers;
  for (let i = 0; E && i < E.n; i++) {
    embers.push({ x: CX + (rnd() - 0.5) * E.spreadX * S, y: CY - E.lift * S + (rnd() - 0.5) * E.spreadY * S, rise: B(E.rise) * S,
      t0: B(E.t0), life: B(E.life), ph: rnd() * 6.28, seed: (rnd() * 1e9) | 0 });
  }

  const R0 = cfg.ring;
  const tones = (heat) => {                          // [lit, base, shade] for a puff this hot
    const b = cfg.heat.findIndex((th) => heat >= th);
    if (b < 0) return heat >= cfg.freshSmoke ? [smoke[1], smoke[2], smoke[3]] : [smoke[0], smoke[1], smoke[2]];
    return [fire[Math.max(0, b - 1)], fire[b], b + 1 < fire.length ? fire[b + 1] : smoke[2]];
  };
  const puffAt = (p, t) => {
    const u = t - p.t0;
    if (u < 0 || u > p.life) return null;
    const { x, y } = FX.integrate(p, u, { drag: cfg.drag, buoy: p.buoy });
    const r = p.rmax * FX.ease.outCubic(FX.clamp(u / p.grow, 0, 1)) * (1 + L.expand * Math.max(0, u - p.grow)) *
      (1 - L.shrink * FX.smooth(L.shrinkFrom * p.life, p.life, u));
    return { x, y, r, heat: p.heat * Math.exp(-Math.max(0, u - L.hold) / p.tau), eat: FX.smooth(L.eatFrom * p.life, L.eatTo * p.life, u) };
  };

  function render(t) {
    const s = P.surface(W, H), R = cfg.ring;
    if (R) {                                         // 1. shock ring, at the back
      const tr = (t - R.start) / R.dur;
      if (tr >= 0 && tr < 1) {
        const th = (tr < R.thick2 ? 2 : 1) * Math.max(1, Math.round(S));
        FX.ring(s, CX, CY + (R.dy || 0) * S, (R.r0 + (R.r1 - R.r0) * FX.ease.outCubic(tr)) * S, th, cfg.ringColours, 1 - tr * tr, { squash: R.squash });
      }
    }
    for (const sp of sparks) {                       // 2. sparks behind the cloud: seen once they fly out
      const u = t - sp.t0;
      if (u < 0 || u > sp.life) continue;
      const a1 = FX.ballistic(sp, u, { drag: Sp.drag, grav: Sp.grav * S }), a0 = FX.ballistic(sp, Math.max(0, u - Sp.trail), { drag: Sp.drag, grav: Sp.grav * S });
      const age = u / sp.life, k = cfg.sparkColours;
      s.line(a0.x, a0.y, a1.x, a1.y, fire[k[age < 0.3 ? 0 : age < 0.55 ? 1 : age < 0.8 ? 2 : 3]]);
    }
    const cloud = P.surface(W, H);                   // 3. puffs, cleaned on their own layer
    for (const p of puffs) {
      const q = puffAt(p, t);
      if (q) FX.puff(cloud, q.x, q.y, q.r, tones(q.heat), { eat: q.eat, eatDir: p.eatDir, eatSize: L.eatSize });
    }
    FX.clean(cloud);
    s.blit(cfg.outline ? cloud.copy().outline(cfg.outline) : cloud, 0, 0);   // outline a copy: checks count the clean layer
    for (const e of embers) {                        // 4. embers in front, dark every few frames
      const u = t - e.t0;
      if (u < 0 || u > e.life) continue;
      const lit = ((Math.floor(t * cfg.fps) + e.seed) % E.blink) !== 0;
      s.set(e.x + Math.sin(e.ph + u * 9) * E.wobble * S, e.y - e.rise * u, fire[lit ? (u / e.life < 0.5 ? 1 : 2) : 3]);
    }
    const Fl = cfg.flash;                            // 5. flash on top: a star, then a clean full disc
    if (Fl && Fl.star && t < Fl.starUntil) {
      const st = Fl.star;
      FX.star(s, CX, CY, { ray: st.ray * S, down: st.down * S, diag: st.diag * S, core: st.core * S }, fire[1], fire[0]);
    } else if (Fl && Fl.disc && t < Fl.discUntil) {
      FX.disc(s, CX, CY + Fl.discY * S, Fl.disc * S, fire[1], fire[0]);
    }
    return { img: s, cloud };
  }
  const ends = [...puffs, ...sparks, ...embers].map((e) => e.t0 + e.life);
  if (R0) ends.push(R0.start + R0.dur);
  if (cfg.flash) ends.push(cfg.flash.discUntil || cfg.flash.starUntil || 0);
  return { W, H, CX, CY, render, end: Math.max(0, ...ends) };
}

if (require.main === module) {
  const argv = process.argv.slice(2), flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { pos.push(argv[i]); continue; }
    const k = argv[i].slice(2), v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    if (k === 'set') (flags.set = flags.set || []).push(v); else flags[k] = v;
  }
  const name = flags.preset || 'explosion';
  if (!PRESETS[name]) { console.error(`unknown preset "${name}" - use ${Object.keys(PRESETS).join(', ')}`); process.exit(1); }
  const cfg = merge(EXPLOSION, PRESETS[name]);
  if (flags.seed !== undefined) cfg.seed = +flags.seed;
  if (flags.fps !== undefined) cfg.fps = +flags.fps;
  for (const kv of flags.set || []) {                // --set puffs.n=22: change any parameter without editing
    const at = String(kv).indexOf('=');
    if (at < 1) { console.error(`--set needs path=value, got "${kv}"`); process.exit(1); }
    const keys = kv.slice(0, at).split('.'), raw = kv.slice(at + 1);
    let val;
    try { val = JSON.parse(raw); } catch (e) { val = raw; }
    let o = cfg;
    for (const k of keys.slice(0, -1)) { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    o[keys[keys.length - 1]] = val;
  }
  const S = flags.scale !== undefined ? +flags.scale : 1;
  const out = pos[0] || path.join('out', name);
  const fx = build(cfg, S);
  const n = cfg.duration === 'auto' ? Math.ceil(fx.end * cfg.fps) + 1 : Math.max(1, Math.round(cfg.duration * cfg.fps));
  const all = [], allLayers = [];
  for (let i = 0; i < n; i++) { const r = fx.render(i / cfg.fps); all.push(r.img); allLayers.push(r.cloud); }
  const { frames, layers, first } = FX.trim(all, allLayers);    // no empty frames at either end
  if (first || frames.length < all.length) console.log(`trimmed ${first} empty frame(s) at the start, ${all.length - first - frames.length} at the end`);
  FX.report(frames, { layers, groups: { fire: cfg.fire, smoke: cfg.smoke } });
  const info = FX.exportAll(out, name, frames, { fps: cfg.fps, anchor: [fx.CX, fx.CY] });
  console.log(`${out}: ${info.frames} frames of ${info.w}x${info.h} at ${cfg.fps} fps, anchor (${info.anchor.x}, ${info.anchor.y})`);
}

module.exports = { EXPLOSION, PRESETS, merge, build };
