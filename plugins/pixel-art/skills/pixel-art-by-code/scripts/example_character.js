#!/usr/bin/env node
/* example_character.js - a complete worked example of drawing a character with code.
 * Copy it as the starting point for a new character.
 *
 *   node example_character.js [outDir]
 *
 * Writes <outDir>/pip_<expression>.png (1:1), pip_sheet.png (all expressions + blink / talk
 * variants, 6x), pip_idle.gif (breathing loop, 6x) and prints the "happy" face as characters.
 *
 * The method, step by step:
 *   1. SPEC     canvas 32x32, light from the top-left, a hue-shifted ramp per material
 *   2. PARTS    eyes / mouths / effects as character grids (each character = one pixel)
 *   3. BODY     big shapes from primitives -> rim light -> 1 px outline   (no pixel-by-pixel work)
 *   4. FACE     drawn after the outline so it stays crisp; an expression is one row of parameters
 *   5. VARIANTS blink / talk / animation frame are just more parameters of the same function
 *   6. LOOK     contact sheet + GIF + ASCII, then fix numbers and render again
 */
'use strict';
const path = require('path');
const P = require('./pixel.js');

// ------------------------------------------------------------------ 1. spec
const W = 32, H = 32;
const body = P.ramp('#4fb3a2', 5);              // [deep shadow, shadow, base, light, highlight]
const gold = P.ramp('#f2b544', 3);              // antenna ball
const C = P.palette({
  line: '#1d1b2e',                              // outline + eyes: a cool near-black, never pure #000
  white: '#ffffff', blush: '#ff8ba0', mouth: '#5b2340', tongue: '#ff6f8a',
  drop: '#3d74d9', dropHi: '#a9dcff', vein: '#ff4057', spark: '#fff1a8',
});
// The sprite is mirror-symmetric around x = 16: pixel x pairs with pixel 31 - x, so a part
// drawn at x with width w is mirrored to 32 - x - w (see pair() below).
const EYE = [11, 15];                           // top-left of the left eye
const MOUTH_Y = 20;

// ------------------------------------------------------------------ 2. parts (character grids)
// '.' = transparent; letters map to the palette passed to stamp().
const EYES = {
  dot: ['wo', 'oo', 'oo'],                      // 2x3 with a highlight
  happy: ['.o.', 'o.o'],                        // ^ ^
  closed: ['...', '...', 'ooo'],                // blink / sleepy (sits on the eye's bottom row)
  shock: ['www', 'wow', 'www'],                 // big white eye, tiny pupil
};
const BROWS = {                                 // above the left eye; mirrored for the right one
  sad: ['..o', 'oo.'],                          // inner end up
  angry: ['oo.', '..o'],                        // inner end down
};
const MOUTHS = {                                // centred on x = 16
  smile: ['o..o', '.oo.'],
  open: ['oooo', 'otto', '.oo.'],
  frown: ['.oo.', 'o..o'],
  flat: ['oo'],
  o: ['.oo.', 'ommo', '.oo.'],
  wavy: ['o.o.', '.o.o'],
};
const FX = {
  drop: ['..d..', '.dbd.', '.dbd.', 'dbwbd', 'dbbbd', '.ddd.'],
  vein: ['.v.v.', 'vv.vv', '.....', 'vv.vv', '.v.v.'],      // the manga anger mark
  spark: ['..s..', '..s..', 'sssss', '..s..', '..s..'],
  z: ['zzzz', '..z.', '.z..', 'zzzz'],
};

// ------------------------------------------------------------------ expressions = one row each
const EXPR = {
  neutral: { eye: 'dot', mouth: 'smile' },
  happy: { eye: 'happy', mouth: 'open', blush: true, spark: true },
  sad: { eye: 'dot', brow: 'sad', mouth: 'frown', tear: true },
  angry: { eye: 'dot', brow: 'angry', mouth: 'flat', vein: true },
  surprised: { eye: 'shock', mouth: 'o', sweat: true },
  sleepy: { eye: 'closed', mouth: 'wavy', zz: true },
};
const BLINKABLE = new Set(['dot', 'shock']);

// ------------------------------------------------------------------ 3. body
// squash: breathing (0 or 1 px wider and lower), bob: the antenna ball lags behind by bob px
function drawBody(s, squash = 0, bob = 0) {
  // feet first, the body overlaps their tops
  s.ellipse(11.5, 29, 2.6, 1.5, body[1]).ellipse(20.5, 29, 2.6, 1.5, body[1]);
  // antenna: stem + ball
  s.line(16, 9 + squash, 16, 7 + bob, body[1]);
  // tiny round things are cleaner as a hand-written grid than as an ellipse primitive
  s.stamp(['.gg.', 'gggg', 'gggg', '.gg.'], { g: gold[1] }, 14, 3 + bob);
  // the silhouette: one blob
  s.ellipse(16, 19 + squash * 0.5, 11 + squash * 0.5, 10 - squash * 0.5, body[2]);
  // rim light: top/left edges lighter, bottom/right edges darker - one call shades everything
  const up = new Map([[body[2], body[3]], [body[1], body[2]], [gold[1], gold[2]]]);
  const down = new Map([[body[2], body[1]], [gold[1], gold[0]]]);
  s.rim((k) => up.get(k), (k) => down.get(k), { group: (k) => (k === gold[1] ? 'gold' : 'body') });
  // interior details go on after the rim pass, so they don't get shaded edges of their own
  s.ellipse(16, 25.5 + squash, 5, 2.2, body[3]);         // lighter belly
  s.fill(8, 13, 2, 1, body[4]).set(8, 14, body[4]);      // glossy highlight, top-left
  s.set(15, 4 + bob, C.white);                           // specular dot on the ball
  s.outline(C.line);
  return s;
}

// ------------------------------------------------------------------ 4. face
// a part on the left at x, and its mirror image on the right
function pair(s, rows, pal, x, y) {
  s.stamp(rows, pal, x, y);
  s.stamp(rows, pal, 32 - x - rows[0].length, y, { flip: true });
}
function drawFace(s, e, v = {}) {
  const pal = { o: C.line, w: C.white, t: C.tongue, m: C.mouth };
  const eye = v.blink && BLINKABLE.has(e.eye) ? 'closed' : e.eye;
  pair(s, EYES[eye], pal, EYE[0], EYE[1]);
  if (e.brow) pair(s, BROWS[e.brow], pal, EYE[0] - 1, EYE[1] - 3);
  const mouth = v.talk ? (e.mouth === 'open' ? 'o' : 'open') : e.mouth;
  const m = MOUTHS[mouth];
  s.stamp(m, pal, 16 - (m[0].length >> 1), MOUTH_Y);
  if (e.blush) pair(s, ['bb'], { b: C.blush }, 8, 19);
  if (e.tear) s.fill(EYE[0], EYE[1] + 3, 1, 3, C.dropHi);
  if (e.sweat) s.stamp(FX.drop, { d: C.drop, b: C.dropHi, w: C.white }, 25, 8);
  if (e.vein) s.stamp(FX.vein, { v: C.vein }, 24, 9);
  if (e.spark) s.stamp(FX.spark, { s: C.spark }, 25, 7);
  if (e.zz) s.stamp(FX.z, { z: C.white }, 25, 5);
  return s;
}

// ------------------------------------------------------------------ 5. one function for every variant
function sprite(expr, v = {}) {
  const s = P.surface(W, H);
  drawBody(s, v.squash || 0, v.bob || 0);
  return drawFace(s, EXPR[expr], v);
}

// ------------------------------------------------------------------ 6. render everything and look
if (require.main === module) {
  const out = process.argv[2] || path.join(process.cwd(), 'out');
  const items = [];
  for (const name of Object.keys(EXPR)) {
    const s = sprite(name);
    s.save(path.join(out, `pip_${name}.png`));
    items.push({ img: s, label: name });
  }
  items.push({ img: sprite('neutral', { blink: true }), label: 'blink' });
  items.push({ img: sprite('neutral', { talk: true }), label: 'talk' });
  items.push({ img: sprite('happy', { talk: true }), label: 'happy talk' });
  P.sheet(items, { cols: 6 }).save(path.join(out, 'pip_sheet.png'), { scale: 6 });

  // idle loop: breathing squash and a lagging antenna, blink on one frame
  const squash = [0, 0, 1, 1, 1, 0, 0, 0];
  const bob = [0, 0, 0, 1, 1, 1, 0, 0];
  const frames = squash.map((sq, i) => sprite('neutral', { squash: sq, bob: bob[i], blink: i === 6 }));
  P.gif(path.join(out, 'pip_idle.gif'), frames, { fps: 6, scale: 6 });
  P.strip(frames).save(path.join(out, 'pip_idle_strip.png'), { scale: 6 });

  console.log(sprite('happy').ascii());
  console.log(`wrote ${out}/pip_*.png, pip_sheet.png, pip_idle.gif`);
}

module.exports = { sprite, EXPR };
