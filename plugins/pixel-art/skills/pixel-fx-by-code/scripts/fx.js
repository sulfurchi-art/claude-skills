#!/usr/bin/env node
'use strict';
/* fx.js - helpers for pixel-art VFX (explosions, smoke, magic bursts, hit sparks) on top of pixel.js.
 *
 * Do not draw the frames. Simulate a few kinds of elements (puffs, sparks, rings, flashes), work
 * out each element's state from the time, colour it from a short palette by its heat or age,
 * render layer by layer, clean the puff layer, then read the numbers and look at the sheets.
 *
 *   const FX = require('./fx.js'); const P = FX.P;
 *   random    FX.rng(seed)  FX.between(rnd, [a, b])  FX.stratified(i, n, rnd, { jitter, arc })
 *   noise     FX.noise2(x, y, seed) -> 0..1, smooth value noise
 *   timing    FX.clamp(v, a, b)  FX.smooth(a, b, x)  FX.ease.outCubic / inCubic / outBack
 *   motion    FX.integrate(body, u, { drag, buoy, grav, dt })  fixed-step: any force is one more line
 *             FX.ballistic(body, u, { drag, grav })            closed form, cheap, for sparks
 *   drawing   FX.puff(s, x, y, r, [hi, base, shade], { eat, eatDir, eatSize })   flat pixel-art puff
 *             FX.ring(s, cx, cy, R, th, [outer, inner], alpha, { squash })     dithered shock ring
 *             FX.star(s, cx, cy, { ray, down, diag, core }, rayColour, coreColour)
 *             FX.disc(s, cx, cy, r, rimColour, fillColour)
 *   cleanup   FX.clean(layer, { open, minIsland, minHole, lonely })   puff layers only, never sparks
 *   checks    FX.metrics(img, { layer, groups })  FX.report(frames, { layers, groups })
 *   export    FX.trim(frames)  FX.unionCrop(frames, margin)  FX.exportAll(dir, name, frames, { fps, anchor, ... })
 */
const fs = require('fs');
const path = require('path');
const P = require('./pixel.js');

// ------------------------------------------------------------------ randomness (always seeded)
function rng(seed) {                         // mulberry32
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (rnd, r) => (Array.isArray(r) ? r[0] + rnd() * (r[1] - r[0]) : r);
/** Angle for element i of n: the arc is cut into n equal slots and each gets one jittered angle,
 *  so directions never bunch up on one side (fully random angles made a lopsided fireball). */
function stratified(i, n, rnd, o = {}) {
  const [a0, a1] = o.arc || [0, Math.PI * 2], j = o.jitter === undefined ? 0.6 : o.jitter;
  return a0 + ((i + rnd() * j) / n) * (a1 - a0);
}
const hash = (x) => {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
};
const h2 = (ix, iy, s) => hash((ix * 73856093) ^ (iy * 19349663) ^ (s * 83492791)) / 4294967296;
function noise2(x, y, s = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = h2(ix, iy, s), b = h2(ix + 1, iy, s), c = h2(ix, iy + 1, s), d = h2(ix + 1, iy + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// ------------------------------------------------------------------ timing
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ease = {
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inCubic: (t) => t * t * t,
  outBack: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
};

// ------------------------------------------------------------------ motion
/** Position `u` seconds after launch. body: { x, y, vx, vy }. Drag slows everything, buoy pushes
 *  up, grav pulls down. Fixed 1/120 s steps, so any new force is one more line and frames match. */
function integrate(b, u, o = {}) {
  const drag = o.drag || 0, buoy = o.buoy || 0, grav = o.grav || 0, dt = o.dt || 1 / 120;
  let x = b.x, y = b.y, vx = b.vx || 0, vy = b.vy || 0;
  for (let n = Math.round(u / dt); n > 0; n--) {
    vx -= vx * drag * dt;
    vy -= (vy * drag + buoy - grav) * dt;
    x += vx * dt; y += vy * dt;
  }
  return { x, y };
}
/** Closed form for particles: velocity decays with drag, gravity adds 0.5*g*u^2 on top. */
function ballistic(b, u, o = {}) {
  const k = o.drag || 1e-9, e = 1 - Math.exp(-k * u);
  return { x: b.x + ((b.vx || 0) / k) * e, y: b.y + ((b.vy || 0) / k) * e + 0.5 * (o.grav || 0) * u * u };
}

// ------------------------------------------------------------------ drawing
/** Flat pixel-art puff: base colour, a lit disc offset to the top-left and a shadow crescent on
 *  the bottom-right. eat (0..1) bites it away with a growing circle from eatDir, which is how
 *  smoke dissolves into shrinking crescents. Puffs under 3 px get the base colour only. */
function puff(s, cx, cy, r, tones, o = {}) {
  if (r < 0.7) return s;
  const [hi, base, sh] = tones.map(P.c);
  const dir = o.eatDir === undefined ? Math.PI / 2 : o.eatDir, er = (o.eat || 0) * r * (o.eatSize || 1.2);
  const ex = cx + Math.cos(dir) * r, ey = cy + Math.sin(dir) * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    if (dx * dx + dy * dy >= r * r) continue;
    if (er > 0 && (x + 0.5 - ex) ** 2 + (y + 0.5 - ey) ** 2 < er * er) continue;
    let col = base;
    if (r >= 3) {
      if ((dx + 0.18 * r) ** 2 + (dy + 0.18 * r) ** 2 > (0.86 * r) ** 2) col = sh;
      else if ((dx + 0.3 * r) ** 2 + (dy + 0.35 * r) ** 2 < (0.45 * r) ** 2) col = hi;
    }
    s.set(x, y, col);
  }
  return s;
}
/** Ring of thickness th (1 or 2) at radius R, faded with the Bayer matrix by alpha. Two colours:
 *  the outer pixel is `outer`, the inner one (and the whole ring once it is 1 px) is `inner`, so a
 *  pale ring still shows on light backgrounds. squash < 1 flattens it for ground explosions. */
function ring(s, cx, cy, R, th, colours, alpha, o = {}) {
  const outer = P.c(colours[0]), inner = P.c(colours[1] === undefined ? colours[0] : colours[1]), sq = o.squash || 1;
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const d = Math.hypot(x + 0.5 - cx, (y + 0.5 - cy) / sq);
    if (d < R && d > R - th && alpha > P.bayer(x, y)) s.set(x, y, th === 1 || d < R - 1 ? inner : outer);
  }
  return s;
}
function star(s, cx, cy, o, ray, core) {
  const L = o.ray, D = o.down === undefined ? L : o.down, G = o.diag === undefined ? Math.round(L * 0.55) : o.diag;
  for (const [dx, dy, len] of [[1, 0, L], [-1, 0, L], [0, 1, D], [0, -1, L], [1, 1, G], [-1, 1, G], [1, -1, G], [-1, -1, G]]) {
    s.line(cx, cy, cx + dx * len, cy + dy * len, ray);
  }
  if (o.core) s.ellipse(cx, cy, o.core, o.core, core);
  return s;
}
function disc(s, cx, cy, r, rim, fill) {
  s.ellipse(cx, cy, r, r, rim);
  s.ellipse(cx, cy, r - 1, r - 1, fill);
  return s;
}

// ------------------------------------------------------------------ cleanup (puff layers only)
/** 1. open: erode then dilate with a plus-shaped kernel - removes spikes under 3 px wide and
 *     rounds corners (the bitten crescents otherwise leave hooks and claws);
 *  2. drop islands smaller than minIsland px (6: a 5 px plus is what opening leaves of a tiny puff);
 *  3. fill enclosed holes smaller than minHole px;
 *  4. lonely: a pixel with no same-coloured 4-neighbour takes the most common neighbour colour.
 *  Never run this on spark or ember layers: they are 1 px wide on purpose. */
function clean(s, o = {}) {
  const w = s.w, h = s.h, N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const minIsland = o.minIsland === undefined ? 6 : o.minIsland, minHole = o.minHole === undefined ? 4 : o.minHole;
  if (o.open !== false) {
    const m = (x, y) => x >= 0 && y >= 0 && x < w && y < h && s.px[y * w + x] >>> 24 !== 0;
    const core = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) core[y * w + x] = m(x, y) && N4.every(([dx, dy]) => m(x + dx, y + dy)) ? 1 : 0;
    const c = (x, y) => x >= 0 && y >= 0 && x < w && y < h && core[y * w + x] === 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m(x, y) && !c(x, y) && !N4.some(([dx, dy]) => c(x + dx, y + dy))) s.px[y * w + x] = 0;
  }
  const comps = (want) => {
    const seen = new Uint8Array(w * h), out = [];
    for (let i = 0; i < w * h; i++) {
      if (seen[i] || !!(s.px[i] >>> 24) !== want) continue;
      const list = [i], q = [i];
      seen[i] = 1;
      let border = false;
      while (q.length) {
        const j = q.pop(), x = j % w, y = (j / w) | 0;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
        for (const [dx, dy] of N4) {
          const xx = x + dx, yy = y + dy, k = yy * w + xx;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || seen[k] || !!(s.px[k] >>> 24) !== want) continue;
          seen[k] = 1; q.push(k); list.push(k);
        }
      }
      out.push({ list, border });
    }
    return out;
  };
  for (const c of comps(true)) if (c.list.length < minIsland) for (const i of c.list) s.px[i] = 0;
  const near = (i) => {
    const x = i % w, y = (i / w) | 0, cnt = new Map();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = s.get(x + dx, y + dy);
      if ((dx || dy) && k >>> 24) cnt.set(k, (cnt.get(k) || 0) + 1);
    }
    let best = 0, bn = 0;
    for (const [k, n] of cnt) if (n > bn) { best = k; bn = n; }
    return best;
  };
  for (const c of comps(false)) if (!c.border && c.list.length < minHole) for (const i of c.list) s.px[i] = near(i);
  if (o.lonely !== false) {
    const src = s.px.slice();
    for (let i = 0; i < w * h; i++) {
      const k = src[i];
      if (!(k >>> 24)) continue;
      const x = i % w, y = (i / w) | 0;
      if (N4.some(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h && src[(y + dy) * w + x + dx] === k)) continue;
      s.px[i] = near(i) || k;
    }
  }
  return s;
}

// ------------------------------------------------------------------ checks
/** Numbers for one frame: opaque px, px per colour group, lonely px in `layer` (the cleaned puff
 *  layer), px touching the canvas edge (clipped effect!), bounding box. */
function metrics(img, o = {}) {
  const groups = {};
  for (const g in o.groups || {}) groups[g] = new Set(o.groups[g].map(P.c));
  const r = { n: 0, edge: 0, lonely: 0, bbox: img.bbox() };
  for (const g in groups) r[g] = 0;
  const L = o.layer;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const k = img.get(x, y);
    if (!(k >>> 24)) continue;
    r.n++;
    for (const g in groups) if (groups[g].has(k)) r[g]++;
    if (x === 0 || y === 0 || x === img.w - 1 || y === img.h - 1) r.edge++;
    if (L) {
      const kl = L.get(x, y);
      if (kl >>> 24 && ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => L.get(x + dx, y + dy) === kl)) r.lonely++;
    }
  }
  return r;
}
/** Prints one row per frame. Read it before looking: the coverage bar should jump up in 2-3
 *  frames and fall slowly; `edge` must stay 0; `lonely` should be ~0. */
function report(frames, o = {}) {
  const gs = Object.keys(o.groups || {});
  const rows = frames.map((f, i) => metrics(f, { groups: o.groups, layer: o.layers && o.layers[i] }));
  const peak = Math.max(1, ...rows.map((r) => r.n));
  console.log(['frame', '   px', ...gs.map((g) => g.padStart(5)), 'lonely', 'edge', 'bbox'.padEnd(14), 'coverage'].join(' '));
  rows.forEach((r, i) => {
    const b = r.bbox ? `${r.bbox.x},${r.bbox.y} ${r.bbox.w}x${r.bbox.h}` : '-';
    console.log([String(i).padStart(5), String(r.n).padStart(5), ...gs.map((g) => String(r[g]).padStart(5)),
      String(r.lonely).padStart(6), String(r.edge).padStart(4), b.padEnd(14), '#'.repeat(Math.round((r.n / peak) * 30))].join(' '));
  });
  const clipped = rows.filter((r) => r.edge).length;
  if (clipped) console.log(`WARNING: ${clipped} frame(s) touch the canvas edge - the effect is clipped; enlarge the canvas or slow it down`);
  return rows;
}

// ------------------------------------------------------------------ export
/** Drop empty frames at the start and the end (an effect should start on its first visible frame
 *  and stop when the last pixel is gone). Returns { frames, first } - first = index of the kept start. */
function trim(frames, layers) {
  const empty = (f) => !f.bbox();
  let a = 0, b = frames.length;
  while (a < b && empty(frames[a])) a++;
  while (b > a && empty(frames[b - 1])) b--;
  return { frames: frames.slice(a, b), layers: layers ? layers.slice(a, b) : undefined, first: a };
}
/** Crop every frame by the union of all bounding boxes (+ margin): the same box for all frames,
 *  so the effect does not jump. Returns the offset so you can move the anchor. */
function unionCrop(frames, margin = 1) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of frames) {
    const b = f.bbox();
    if (b) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  }
  if (x0 === Infinity) return { frames, x: 0, y: 0, w: frames[0].w, h: frames[0].h };
  const W = frames[0].w, H = frames[0].h;
  x0 = Math.max(0, x0 - margin); y0 = Math.max(0, y0 - margin); x1 = Math.min(W, x1 + margin); y1 = Math.min(H, y1 + margin);
  return { frames: frames.map((f) => f.crop(x0, y0, x1 - x0, y1 - y0)), x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
/** Writes everything needed to look at and to ship an effect:
 *    frames/<name>_NN.png      1x transparent frames (cropped)
 *    <name>_sheet.png / .json  1x horizontal sprite sheet + frame size, durations, anchor
 *    <name>.gif                preview on `bg`, `scale`x, `hold` s of blank at the end
 *    sheet.png                 numbered contact sheet (3x)
 *    backgrounds.png           `pick` frames on dark / mid / light backgrounds
 *    sizes.png                 a few frames at 1x and 2x - real game size
 *  o: { fps, anchor: [x, y] on the uncropped canvas, bg, scale = 6, hold = 0.5, pick, crop = true, loop = false } */
function exportAll(dir, name, frames, o = {}) {
  const fps = o.fps || 15, bg = o.bg || '#34465e';
  const cut = o.crop === false ? { frames, x: 0, y: 0, w: frames[0].w, h: frames[0].h } : unionCrop(frames, 1);
  const fr = cut.frames, W = cut.w, H = cut.h;
  const anchor = o.anchor ? { x: o.anchor[0] - cut.x, y: o.anchor[1] - cut.y } : null;
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  fr.forEach((f, i) => f.save(path.join(dir, 'frames', `${name}_${String(i).padStart(2, '0')}.png`)));
  const strip = P.surface(W * fr.length, H);
  fr.forEach((f, i) => strip.blit(f, i * W, 0));
  strip.save(path.join(dir, `${name}_sheet.png`));
  fs.writeFileSync(path.join(dir, `${name}_sheet.json`), JSON.stringify({
    image: `${name}_sheet.png`, frameWidth: W, frameHeight: H, frames: fr.length, fps,
    durations: fr.map(() => +(1 / fps).toFixed(4)), anchor, loop: !!o.loop,
  }, null, 2) + '\n');
  const onBg = (f, c = bg) => P.surface(W, H).clear(c).blit(f, 0, 0);
  const hold = o.hold === undefined ? 0.5 : o.hold;
  P.gif(path.join(dir, `${name}.gif`), [...fr.map((f) => onBg(f)), ...(hold > 0 ? [onBg(P.surface(W, H))] : [])],
    { delays: [...fr.map(() => 1 / fps), ...(hold > 0 ? [hold] : [])], scale: o.scale || 6 });
  P.sheet(fr.map((f, i) => ({ img: f, label: String(i) })), { cols: Math.min(fr.length, 9), bg }).save(path.join(dir, 'sheet.png'), { scale: 3 });
  const pick = (o.pick || [1, 2, 3, 6, 9, 12, 15]).filter((i) => i < fr.length);
  const bgs = ['#1b1c2b', '#4a6b8a', '#c9d6e3'];
  P.sheet(bgs.flatMap((c) => pick.map((i) => ({ img: onBg(fr[i], c) }))), { cols: pick.length, gap: 2, bg: '#000000' })
    .save(path.join(dir, 'backgrounds.png'), { scale: 3 });
  const few = pick.filter((_, k) => k % 2 === 1).slice(0, 4);
  const sizes = P.surface(4 + few.length * (W * 3 + 4), H * 2 + 8).clear('#4a6b8a');
  few.forEach((i, k) => {
    const x = 4 + k * (W * 3 + 4);
    sizes.blit(fr[i], x, 4);
    sizes.blit(fr[i], x + W + 2, 4, { scale: 2 });
  });
  sizes.save(path.join(dir, 'sizes.png'));
  return { w: W, h: H, frames: fr.length, anchor, crop: cut };
}

module.exports = {
  P, rng, between, stratified, hash, noise2, clamp, smooth, ease,
  integrate, ballistic, puff, ring, star, disc, clean, metrics, report, trim, unionCrop, exportAll,
};
