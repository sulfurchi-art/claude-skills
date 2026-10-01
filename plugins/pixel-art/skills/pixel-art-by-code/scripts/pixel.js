#!/usr/bin/env node
/* pixel.js - zero-dependency pixel-art toolkit for drawing with code (Node >= 16).
 *
 * A model that can only output text draws by writing code / character grids that this
 * library turns into pixels, then looks at the result (upscaled PNG, contact sheet, or the
 * ASCII read-back) and iterates.
 *
 * Library:   const P = require('./pixel.js')
 *   colours    P.c('#d97757') -> packed colour     P.hex(c)    P.mix(a, b, t)
 *              P.ramp(base, n, opts) -> hue-shifted shade ramp (dark .. light)
 *              P.palette({ o: '#3a170f', b: '#d97757' }) -> { o: packed, b: packed }
 *   surfaces   P.surface(w, h)   P.load('in.png')   s.save('out.png', { scale })
 *              s.copy()  s.crop(x, y, w, h)  s.blit(src, x, y, { flip, scale })  s.flip('x'|'y')
 *   drawing    s.set(x, y, c)  s.fill(x, y, w, h, c)  s.rect(...)  s.line(x0, y0, x1, y1, c)
 *              s.ellipse(cx, cy, rx, ry, c)  s.ring(cx, cy, rx, ry, c, th)  s.poly([x, y, ...], c)
 *              s.roundRect(x, y, w, h, r, c)  s.stroke([x, y, ...], radius, c)
 *              s.stamp(rows, pal, x, y, { flip })  - character-grid sprite ('.' = transparent)
 *              s.dither(x, y, w, h, c, alpha)  s.ditherEllipse(cx, cy, rx, ry, c, alpha)
 *              s.gradient(x, y, w, h, [c0, c1, ...], { dir: 'v'|'h' })   (Bayer-dithered bands)
 *   finishing  s.rim(hi, sh, { depth, group })  - light from the top-left: lit / shaded edge pixels
 *              s.outline(c, { diagonal })      - 1 px outline around everything opaque
 *              s.mirror({ from: 'left'|'right' })  s.recolor({ '#from': '#to' })
 *   inspect    s.bbox()  s.colors()  s.stats()  s.ascii({ crop })
 *   layout     P.sheet([{ img, label }], { cols, gap, bg })  P.text(s, str, x, y, c, { scale, outline })
 *              P.strip(frames, gap)  P.gif('out.gif', frames, { fps, scale })
 *   reference  P.pixelate(img, { pixel, colors, bg }) - reference image -> clean 1:1 pixel art
 *
 * CLI:       node pixel.js help
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ------------------------------------------------------------------ colours (packed 0xAABBGGRR)
const pack = (r, g, b, a = 255) => (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
const R = (c) => c & 255;
const G = (c) => (c >>> 8) & 255;
const B = (c) => (c >>> 16) & 255;
const A = (c) => c >>> 24;

/** Any colour spelling -> packed colour. '#rgb' '#rrggbb' '#rrggbbaa' [r,g,b,a] packed-number 'transparent' */
function c(v) {
  if (typeof v === 'number') return v >>> 0;
  if (v === null || v === undefined || v === 'transparent' || v === '') return 0;
  if (Array.isArray(v)) return pack(v[0], v[1], v[2], v.length > 3 ? v[3] : 255);
  let s = String(v).trim();
  if (s[0] === '#') s = s.slice(1);
  if (s.length === 3 || s.length === 4) s = s.split('').map((ch) => ch + ch).join('');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) throw new Error(`pixel.js: bad colour "${v}"`);
  const n = parseInt(s.slice(0, 6), 16);
  return pack((n >> 16) & 255, (n >> 8) & 255, n & 255, s.length === 8 ? parseInt(s.slice(6), 16) : 255);
}
const hex = (v) => {
  const k = c(v);
  const h = '#' + [R(k), G(k), B(k)].map((x) => x.toString(16).padStart(2, '0')).join('');
  return A(k) === 255 ? h : h + A(k).toString(16).padStart(2, '0');
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => {
  a = c(a); b = c(b); t = clamp(t, 0, 1);
  const m = (x, y) => Math.round(x + (y - x) * t);
  return pack(m(R(a), R(b)), m(G(a), G(b)), m(B(a), B(b)), m(A(a), A(b)));
};
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx];
}
function hsv2rgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}
/** Hue-shifted ramp around `base`, dark -> light. Shadows drift towards blue/purple and get a bit
 *  more saturated, highlights drift towards yellow and get a bit less saturated - the classic
 *  pixel-art way to get rich shading from few colours. The base colour sits in the middle. */
function ramp(base, n = 5, o = {}) {
  const hueShift = o.hueShift === undefined ? 12 : o.hueShift;      // degrees per step
  const valStep = o.valStep === undefined ? 0.14 : o.valStep;
  const satStep = o.satStep === undefined ? 0.06 : o.satStep;
  const k0 = c(base), [h, s, v] = rgb2hsv(R(k0), G(k0), B(k0));
  const mid = (n - 1) / 2, out = [];
  const towards = (from, to, amount) => {             // rotate hue `from` towards `to` by <= amount degrees
    let d = ((to - from + 540) % 360) - 180;
    return from + Math.sign(d) * Math.min(Math.abs(d), amount);
  };
  for (let i = 0; i < n; i++) {
    const k = i - mid;
    if (k === 0) { out.push(k0); continue; }
    const hh = k < 0 ? towards(h, 250, hueShift * -k) : towards(h, 55, hueShift * k);
    const ss = clamp(s - k * satStep, 0, 1);
    const vv = clamp(v + k * valStep, 0.04, 1);
    const [r, g, b] = hsv2rgb(hh, ss, vv);
    out.push(pack(r, g, b, 255));
  }
  return out;
}
const palette = (o) => { const r = {}; for (const k in o) r[k] = c(o[k]); return r; };

// 4x4 ordered-dither thresholds in (0,1): a pixel is drawn when alpha > threshold
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x, y) => BAYER[((y & 3) << 2) | (x & 3)];

// ------------------------------------------------------------------ surface
class Surface {
  constructor(w, h) {
    this.w = Math.max(0, w | 0);
    this.h = Math.max(0, h | 0);
    this.px = new Uint32Array(this.w * this.h);
  }
  inside(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  get(x, y) { x = Math.round(x); y = Math.round(y); return this.inside(x, y) ? this.px[y * this.w + x] : 0; }
  set(x, y, col) { x = Math.round(x); y = Math.round(y); if (this.inside(x, y)) this.px[y * this.w + x] = c(col); return this; }
  opaque(x, y) { return this.inside(x, y) && A(this.px[y * this.w + x]) !== 0; }
  clear(col = 0) { this.px.fill(c(col)); return this; }

  // ---------- rectangles & lines
  fill(x, y, w, h, col) {
    const k = c(col);
    x = Math.round(x); y = Math.round(y);
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(this.w, x + Math.round(w)), y1 = Math.min(this.h, y + Math.round(h));
    for (let yy = y0; yy < y1; yy++) this.px.fill(k, yy * this.w + x0, yy * this.w + x1);
    return this;
  }
  rect(x, y, w, h, col) {
    this.fill(x, y, w, 1, col); this.fill(x, y + h - 1, w, 1, col);
    this.fill(x, y + 1, 1, h - 2, col); this.fill(x + w - 1, y + 1, 1, h - 2, col);
    return this;
  }
  /** Bresenham line: one pixel per step, no doubled corners ("pixel-perfect"). */
  line(x0, y0, x1, y1, col) {
    const k = c(col);
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 100000; guard++) {
      if (this.inside(x0, y0)) this.px[y0 * this.w + x0] = k;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return this;
  }

  // ---------- shapes (float centres, sampled at pixel centres)
  ellipse(cx, cy, rx, ry, col) {
    if (rx <= 0 || ry <= 0) return this;
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      const dy = (y + 0.5 - cy) / ry, t = 1 - dy * dy;
      if (t < 0) continue;
      const hw = rx * Math.sqrt(t), xa = Math.ceil(cx - hw - 0.5), xb = Math.floor(cx + hw - 0.5);
      if (xb >= xa) this.fill(xa, y, xb - xa + 1, 1, col);
    }
    return this;
  }
  ring(cx, cy, rx, ry, col, th = 1) {
    const k = c(col), irx = rx - th, iry = ry - th;
    for (let y = Math.floor(cy - ry) - 1; y <= Math.ceil(cy + ry) + 1; y++) {
      for (let x = Math.floor(cx - rx) - 1; x <= Math.ceil(cx + rx) + 1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const o = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
        const i = irx > 0 && iry > 0 ? (dx * dx) / (irx * irx) + (dy * dy) / (iry * iry) : 2;
        if (o <= 1 && i > 1 && this.inside(x, y)) this.px[y * this.w + x] = k;
      }
    }
    return this;
  }
  /** Filled polygon, pts = [x0, y0, x1, y1, ...] */
  poly(pts, col) {
    const n = pts.length >> 1;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { minY = Math.min(minY, pts[i * 2 + 1]); maxY = Math.max(maxY, pts[i * 2 + 1]); }
    const xs = [];
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      const yc = y + 0.5;
      xs.length = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, xi = pts[i * 2], yi = pts[i * 2 + 1], xj = pts[j * 2], yj = pts[j * 2 + 1];
        if ((yi <= yc && yj > yc) || (yj <= yc && yi > yc)) xs.push(xi + ((yc - yi) * (xj - xi)) / (yj - yi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.ceil(xs[k] - 0.5), xb = Math.floor(xs[k + 1] - 0.5);
        if (xb >= xa) this.fill(xa, y, xb - xa + 1, 1, col);
      }
    }
    return this;
  }
  roundRect(x, y, w, h, r, col) {
    if (r <= 0) return this.fill(x, y, w, h, col);
    for (let yy = 0; yy < h; yy++) {
      const dy = yy < r ? r - yy - 0.5 : yy >= h - r ? yy - (h - r) + 0.5 : -1;
      const inset = dy >= 0 ? Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy))) : 0;
      this.fill(x + inset, y + yy, w - inset * 2, 1, col);
    }
    return this;
  }
  /** Thick polyline drawn with a round brush of `radius`. */
  stroke(pts, radius, col) {
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3];
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
      for (let s = 0; s <= steps; s++) this.ellipse(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, radius, radius, col);
    }
    return this;
  }

  /** Character-grid sprite. rows: array of strings, or one multi-line string (indentation is
   *  removed). '.' and ' ' are transparent, every other character is looked up in pal. */
  stamp(rows, pal, x = 0, y = 0, o = {}) {
    if (typeof rows === 'string') rows = dedent(rows);
    const p = {};
    for (const k in pal) p[k] = c(pal[k]);
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j];
      for (let i = 0; i < row.length; i++) {
        const ch = row[o.flip ? row.length - 1 - i : i];
        if (ch === '.' || ch === ' ') continue;
        if (!(ch in p)) throw new Error(`pixel.js stamp: character "${ch}" is not in the palette`);
        this.set(x + i, y + j, p[ch]);
      }
    }
    return this;
  }

  // ---------- dithering (pixel-art transparency and gradients)
  dither(x, y, w, h, col, alpha) {
    const k = c(col);
    x = Math.round(x); y = Math.round(y);
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + Math.round(h)); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.w, x + Math.round(w)); xx++) {
        if (alpha > bayer(xx, yy)) this.px[yy * this.w + xx] = k;
      }
    }
    return this;
  }
  ditherEllipse(cx, cy, rx, ry, col, alpha) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      const dy = (y + 0.5 - cy) / ry, t = 1 - dy * dy;
      if (t < 0) continue;
      const hw = rx * Math.sqrt(t), xa = Math.ceil(cx - hw - 0.5), xb = Math.floor(cx + hw - 0.5);
      if (xb >= xa) this.dither(xa, y, xb - xa + 1, 1, col, alpha);
    }
    return this;
  }
  /** Banded gradient through `colors`, the band edges dithered with the Bayer matrix. */
  gradient(x, y, w, h, colors, o = {}) {
    const ks = colors.map(c), vertical = (o.dir || 'v') === 'v', len = vertical ? h : w;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const t = ((vertical ? yy : xx) / Math.max(1, len - 1)) * (ks.length - 1);
      const i = Math.min(ks.length - 2, Math.floor(t)), f = t - i;
      this.set(x + xx, y + yy, f > bayer(x + xx, y + yy) ? ks[i + 1] : ks[i]);
    }
    return this;
  }

  // ---------- finishing passes
  /** Rim shading with the light from the top-left. For every opaque pixel on an edge of its
   *  shape: top / left edges become `hi(c)`, bottom / right edges (within `depth` px) become
   *  `sh(c)`. hi / sh: function(colour) -> colour, a { '#from': '#to' } map, a colour, or null.
   *  `group(c)` keeps shading inside regions (pixels of another group count as outside). */
  rim(hi, sh, o = {}) {
    const depth = o.depth || 1, w = this.w, h = this.h, src = this.px.slice();
    const fn = (m) => {
      if (m === null || m === undefined) return () => undefined;
      if (typeof m === 'function') return (k) => { const r = m(k); return r === undefined || r === null ? undefined : c(r); };
      if (typeof m === 'object' && !Array.isArray(m)) { const t = new Map(); for (const k in m) t.set(c(k), c(m[k])); return (k) => t.get(k); }
      const k1 = c(m); return () => k1;
    };
    const fh = fn(hi), fs = fn(sh), gk = o.group || (() => 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = src[y * w + x];
      if (!A(k)) continue;
      const g = gk(k);
      if (g === null || g === undefined) continue;
      const ins = (xx, yy) => xx >= 0 && yy >= 0 && xx < w && yy < h && A(src[yy * w + xx]) !== 0 && gk(src[yy * w + xx]) === g;
      const top = !ins(x, y - 1), left = !ins(x - 1, y);
      let bottom = false, right = false;
      for (let d = 1; d <= depth; d++) { if (!ins(x, y + d)) bottom = true; if (!ins(x + d, y)) right = true; }
      let r;
      if (top) r = fh(k); else if (bottom) r = fs(k); else if (left) r = fh(k); else if (right) r = fs(k);
      if (r !== undefined) this.px[y * w + x] = r;
    }
    return this;
  }
  /** 1 px outline on the transparent pixels around everything opaque (4-neighbour by default). */
  outline(col, o = {}) {
    const k = c(col), w = this.w, h = this.h, src = this.px.slice();
    const N = o.diagonal ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (A(src[y * w + x])) continue;
      for (const [dx, dy] of N) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && A(src[yy * w + xx])) { this.px[y * w + x] = k; break; }
      }
    }
    return this;
  }
  /** Copy one half onto the other for symmetric designs. */
  mirror(o = {}) {
    const fromRight = o.from === 'right';
    for (let y = 0; y < this.h; y++) for (let x = 0; x < (this.w >> 1); x++) {
      const a = y * this.w + x, b = y * this.w + (this.w - 1 - x);
      if (fromRight) this.px[a] = this.px[b]; else this.px[b] = this.px[a];
    }
    return this;
  }
  recolor(map) {
    const t = new Map();
    for (const k in map) t.set(c(k), c(map[k]));
    for (let i = 0; i < this.px.length; i++) { const r = t.get(this.px[i]); if (r !== undefined) this.px[i] = r; }
    return this;
  }

  // ---------- copies
  copy() { const s = new Surface(this.w, this.h); s.px.set(this.px); return s; }
  crop(x, y, w, h) { const s = new Surface(w, h); s.blit(this, -x, -y); return s; }
  flip(axis = 'x') {
    const s = new Surface(this.w, this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      s.px[y * this.w + x] = axis === 'x' ? this.px[y * this.w + (this.w - 1 - x)] : this.px[(this.h - 1 - y) * this.w + x];
    }
    return s;
  }
  /** Draw `src` at (x, y); transparent pixels are skipped. o: { flip, scale } */
  blit(src, x = 0, y = 0, o = {}) {
    const sc = Math.max(1, o.scale | 0 || 1);
    x = Math.round(x); y = Math.round(y);
    for (let yy = 0; yy < src.h * sc; yy++) for (let xx = 0; xx < src.w * sc; xx++) {
      const tx = x + xx, ty = y + yy;
      if (!this.inside(tx, ty)) continue;
      let sx = (xx / sc) | 0;
      if (o.flip) sx = src.w - 1 - sx;
      const k = src.px[((yy / sc) | 0) * src.w + sx];
      if (A(k)) this.px[ty * this.w + tx] = k;
    }
    return this;
  }
  scaled(sc) { const s = new Surface(this.w * sc, this.h * sc); s.blit(this, 0, 0, { scale: sc }); return s; }

  // ---------- inspection
  bbox() {
    let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (A(this.px[y * this.w + x])) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  /** [[hex, count], ...] of the opaque colours, most used first */
  colors() {
    const m = new Map();
    for (const k of this.px) if (A(k)) m.set(k, (m.get(k) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => [hex(k), n]);
  }
  stats() {
    let semi = 0;
    for (const k of this.px) if (A(k) > 0 && A(k) < 255) semi++;
    return { w: this.w, h: this.h, bbox: this.bbox(), colors: this.colors().length, semiTransparent: semi };
  }
  /** One character per pixel ('.' = transparent) + colour legend, cropped to the opaque box. */
  ascii(o = {}) {
    const b = o.crop || this.bbox();
    if (!b) return '(empty)';
    const SYM = '#ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@%&*+=?!$';
    const keys = new Map(), rows = [];
    for (let y = b.y; y < b.y + b.h; y++) {
      let row = '';
      for (let x = b.x; x < b.x + b.w; x++) {
        const k = this.get(x, y);
        if (!A(k)) { row += '.'; continue; }
        if (!keys.has(k)) keys.set(k, SYM[keys.size % SYM.length]);
        row += keys.get(k);
      }
      rows.push(row);
    }
    const legend = [...keys].map(([k, s]) => `${s}=${hex(k)}`).join(' ');
    return `${this.w}x${this.h}, box (${b.x},${b.y}) ${b.w}x${b.h}\n${rows.join('\n')}\n${legend}`;
  }
  save(file, o = {}) {
    const sc = Math.max(1, o.scale | 0 || 1);
    const img = sc === 1 ? this : this.scaled(sc);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, encodePNG(img));
    return file;
  }
}
const surface = (w, h) => new Surface(w, h);

function dedent(str) {
  const lines = str.split('\n').map((l) => l.replace(/\r$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(ind));
}

// ------------------------------------------------------------------ PNG
const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let k = n; for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1; CRC[n] = k >>> 0; }
const crc32 = (buf) => { let k = 0xffffffff; for (let i = 0; i < buf.length; i++) k = CRC[(k ^ buf[i]) & 255] ^ (k >>> 8); return (k ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(s) {
  const stride = s.w * 4 + 1, raw = Buffer.alloc(stride * s.h);
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const k = s.px[y * s.w + x], i = y * stride + 1 + x * 4;
    raw[i] = R(k); raw[i + 1] = G(k); raw[i + 2] = B(k); raw[i + 3] = A(k);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s.w, 0); ihdr.writeUInt32BE(s.h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/** PNG -> Surface (colour types 0/2/3/4/6, bit depths 1-16, not interlaced). */
function load(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG (convert it first, e.g. ffmpeg -i in.jpg out.png)`);
  let pos = 8, w = 0, h = 0, depth = 8, type = 6, interlace = 0, plte = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), t = buf.toString('ascii', pos + 4, pos + 8), d = buf.subarray(pos + 8, pos + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (t === 'PLTE') plte = d;
    else if (t === 'tRNS') trns = d;
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    pos += 12 + len;
  }
  if (interlace) throw new Error(`${file}: interlaced PNG is not supported - re-save it without interlacing`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const bpp = Math.max(1, (ch * depth) >> 3), stride = Math.ceil((w * ch * depth) / 8);
  const data = zlib.inflateSync(Buffer.concat(idat)), px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = data[y * (stride + 1)], row = data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[y * stride + i - bpp] : 0, b = y > 0 ? px[(y - 1) * stride + i] : 0;
      const cc = i >= bpp && y > 0 ? px[(y - 1) * stride + i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
      px[y * stride + i] = v & 255;
    }
  }
  const sample = (y, idx) => {   // idx-th sample of row y, scaled to 0..255
    if (depth === 8) return px[y * stride + idx];
    if (depth === 16) return px[y * stride + idx * 2];
    const per = 8 / depth, byte = px[y * stride + Math.floor(idx / per)], shift = 8 - depth * ((idx % per) + 1);
    const v = (byte >> shift) & ((1 << depth) - 1);
    return type === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  const s = new Surface(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r, g, b, a = 255;
    if (type === 3) {
      const i = sample(y, x); r = plte[i * 3]; g = plte[i * 3 + 1]; b = plte[i * 3 + 2];
      if (trns && i < trns.length) a = trns[i];
    } else if (type === 0 || type === 4) {
      r = g = b = sample(y, x * ch); if (type === 4) a = sample(y, x * ch + 1);
      else if (trns && depth <= 8 && sample(y, x) === Math.round((trns.readUInt16BE(0) * 255) / ((1 << depth) - 1))) a = 0;
    } else {
      r = sample(y, x * ch); g = sample(y, x * ch + 1); b = sample(y, x * ch + 2); if (type === 6) a = sample(y, x * ch + 3);
    }
    s.px[y * w + x] = pack(r, g, b, a);
  }
  return s;
}

// ------------------------------------------------------------------ 5x7 text (labels, UI)
const GLYPH_ROWS = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.....', '..#..'],
  ',': ['.....', '.....', '.....', '.....', '.....', '..#..', '.#...'],
  ':': ['.....', '..#..', '.....', '.....', '.....', '..#..', '.....'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '%': ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'],
  "'": ['..#..', '..#..', '.....', '.....', '.....', '.....', '.....'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '*': ['.....', '#.#.#', '.###.', '#####', '.###.', '#.#.#', '.....'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '<': ['...#.', '..#..', '.#...', '#....', '.#...', '..#..', '...#.'],
  '>': ['.#...', '..#..', '...#.', '....#', '...#.', '..#..', '.#...'],
  '_': ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '@': ['.....', '.#.#.', '#####', '#####', '.###.', '..#..', '.....'],
  '^': ['.....', '..#..', '.###.', '#####', '.....', '.....', '.....'],
  '~': ['.....', '.....', '.#...', '#.#.#', '...#.', '.....', '.....'],
  ' ': ['...', '...', '...', '...', '...', '...', '...'],
  };
const GLYPHS = {};
for (const k in GLYPH_ROWS) GLYPHS[k] = GLYPH_ROWS[k].map((r) => r.padEnd(5, '.')).join('');
function text(s, str, x, y, col, o = {}) {
  const sc = Math.max(1, o.scale | 0 || 1);
  const draw = (k, ox, oy) => {
    let cx = x;
    for (const ch0 of String(str)) {
      const g = GLYPHS[ch0.toUpperCase()] || GLYPHS['?'];
      for (let j = 0; j < 7; j++) for (let i = 0; i < 5; i++) if (g[j * 5 + i] === '#') s.fill(cx + i * sc + ox, y + j * sc + oy, sc, sc, k);
      cx += 6 * sc;
    }
  };
  if (o.outline !== undefined) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) draw(c(o.outline), dx, dy);
  draw(c(col), 0, 0);
  return s;
}
const textWidth = (str, sc = 1) => Math.max(0, String(str).length * 6 * sc - sc);

// ------------------------------------------------------------------ contact sheets & strips
/** items: [{ img: Surface, label }] or Surfaces. Laid out at 1x on a flat background; save it
 *  with { scale } to look at it. Every cell gets the same size so expressions line up. */
function sheet(items, o = {}) {
  items = items.map((it) => (it instanceof Surface ? { img: it } : it));
  const cols = Math.max(1, o.cols || Math.min(items.length, 6)), gap = o.gap === undefined ? 4 : o.gap;
  const labels = items.some((it) => it.label) && o.labels !== false;
  const cw = Math.max(...items.map((it) => Math.max(it.img.w, labels ? textWidth(it.label || '') : 0)));
  const ch = Math.max(...items.map((it) => it.img.h)) + (labels ? 10 : 0);
  const rows = Math.ceil(items.length / cols);
  const s = new Surface(gap + cols * (cw + gap), gap + rows * (ch + gap)).clear(o.bg || '#3c3c4b');
  items.forEach((it, i) => {
    const x = gap + (i % cols) * (cw + gap), y = gap + Math.floor(i / cols) * (ch + gap);
    if (o.cellBg) s.fill(x, y, cw, ch, o.cellBg);
    s.blit(it.img, x + ((cw - it.img.w) >> 1), y);
    if (labels && it.label) text(s, it.label, x + ((cw - textWidth(it.label)) >> 1), y + ch - 7, o.labelColor || '#e8e8f0');
  });
  return s;
}
const strip = (frames, gap = 1) => sheet(frames, { cols: frames.length, gap, labels: false, bg: 'transparent' });

// ------------------------------------------------------------------ animated GIF (no dependencies)
/** frames: Surfaces of equal size. o: { fps = 6, delays: [seconds per frame], scale = 1, loop = 0 } */
function gif(file, frames, o = {}) {
  const sc = Math.max(1, o.scale | 0 || 1);
  const fr = frames.map((f) => (sc === 1 ? f : f.scaled(sc)));
  const w = fr[0].w, h = fr[0].h;
  const colors = new Map([[0, 0]]);            // index 0 = transparent
  for (const f of fr) for (const k of f.px) { const kk = A(k) ? (k | 0xff000000) >>> 0 : 0; if (!colors.has(kk)) colors.set(kk, colors.size); }
  if (colors.size > 256) throw new Error(`gif: ${colors.size - 1} colours - pixel art should stay under 255 (reduce the palette)`);
  let bits = 1;
  while (1 << bits < colors.size) bits++;
  const out = [];
  const u16 = (v) => out.push(v & 255, (v >> 8) & 255);
  out.push(...Buffer.from('GIF89a'));
  u16(w); u16(h); out.push(0x80 | 0x70 | (bits - 1), 0, 0);
  const table = new Array(3 << bits).fill(0);
  for (const [k, i] of colors) { table[i * 3] = R(k); table[i * 3 + 1] = G(k); table[i * 3 + 2] = B(k); }
  out.push(...table);
  out.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1); u16(o.loop || 0); out.push(0);
  const minCode = Math.max(2, bits);
  fr.forEach((f, n) => {
    const delay = Math.round(100 * (o.delays ? o.delays[n] : 1 / (o.fps || 6)));
    out.push(0x21, 0xf9, 4, (2 << 2) | 1); u16(delay); out.push(0, 0);
    out.push(0x2c); u16(0); u16(0); u16(w); u16(h); out.push(0);
    const idx = new Uint8Array(w * h);
    for (let i = 0; i < f.px.length; i++) { const k = f.px[i]; idx[i] = A(k) ? colors.get((k | 0xff000000) >>> 0) : 0; }
    out.push(minCode);
    const data = lzw(idx, minCode);
    for (let i = 0; i < data.length; i += 255) { const blk = data.slice(i, i + 255); out.push(blk.length, ...blk); }
    out.push(0);
  });
  out.push(0x3b);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, Buffer.from(out));
  return file;
}
function lzw(index, minCode) {               // GIF variable-length LZW (same scheme as omggif)
  const clear = 1 << minCode, eoi = clear + 1, out = [];
  let size = minCode + 1, next = eoi + 1, cur = 0, shift = 0, table = new Map();
  const emit = (code) => { cur |= code << shift; shift += size; while (shift >= 8) { out.push(cur & 255); cur >>>= 8; shift -= 8; } };
  emit(clear);
  let prefix = index[0];
  for (let i = 1; i < index.length; i++) {
    const k = index[i], key = (prefix << 8) | k, code = table.get(key);
    if (code !== undefined) { prefix = code; continue; }
    emit(prefix);
    if (next === 4096) { emit(clear); next = eoi + 1; size = minCode + 1; table = new Map(); }
    else { if (next >= 1 << size) size++; table.set(key, next++); }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (shift > 0) out.push(cur & 255);
  return out;
}

// ------------------------------------------------------------------ reference image -> pixel art
/** Snap a picture onto a pixel grid. o: { pixel: cell size in source px (required), offset: [x, y],
 *  colors: palette size (default 16, 0 = keep), bg: 'auto' | 'none' | colour, tolerance (bg,
 *  default 12), despeckle (default true) }.
 *  1. every cell takes the dominant colour of its inner part (the blurry rim is ignored)
 *  2. the background is flood-filled away from the border BEFORE the palette is reduced, so dark
 *     hair next to a dark background is not eaten
 *  3. the palette is reduced with median cut + k-means
 *  4. isolated single cells whose neighbours almost all agree are replaced (noise, not detail)
 *  It is a first pass: look at the result, then fix the rest by hand. Returns a 1:1 Surface. */
function pixelate(src, o = {}) {
  const N = o.pixel;
  if (!(N >= 1)) throw new Error('pixelate: give the source pixel size, e.g. { pixel: 4 } (look at the image to count it)');
  const [ox, oy] = o.offset || [0, 0];
  const cols = Math.floor((src.w - ox) / N), rows = Math.floor((src.h - oy) / N);
  const out = new Surface(cols, rows), m = N >= 4 ? Math.floor(N / 4) : 0;
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    const bins = new Map();
    let n = 0, clear = 0;
    for (let y = oy + cy * N + m; y < oy + (cy + 1) * N - m; y++) for (let x = ox + cx * N + m; x < ox + (cx + 1) * N - m; x++) {
      const k = src.get(x, y); n++;
      if (A(k) < 128) { clear++; continue; }
      const key = ((R(k) >> 3) << 10) | ((G(k) >> 3) << 5) | (B(k) >> 3);
      const e = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += R(k); e.g += G(k); e.b += B(k); bins.set(key, e);
    }
    if (clear * 2 >= n || !bins.size) continue;
    let best = null;
    for (const e of bins.values()) if (!best || e.n > best.n) best = e;
    out.px[cy * cols + cx] = pack(Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n));
  }
  if ((o.bg || 'auto') !== 'none') removeBackground(out, o.bg === 'auto' || !o.bg ? null : c(o.bg), o.tolerance === undefined ? 12 : o.tolerance);
  const K = o.colors === undefined ? 16 : o.colors;
  if (K > 0) quantize(out, K);
  if (o.despeckle !== false) despeckle(out);
  return out;
}
/** Replace single cells that differ from all 8 neighbours while >= 6 of those neighbours share
 *  one colour (JPEG / gradient noise). Real 1-px details such as eye highlights usually sit
 *  next to more than one colour and survive. */
function despeckle(s) {
  const src = s.px.slice(), w = s.w, h = s.h;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const k = src[y * w + x];
    if (!A(k)) continue;
    const count = new Map();
    let same = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const n = src[(y + dy) * w + x + dx];
      if (n === k) same = true;
      count.set(n, (count.get(n) || 0) + 1);
    }
    if (same) continue;
    for (const [n, cnt] of count) if (cnt >= 6 && A(n)) { s.px[y * w + x] = n; break; }
  }
  return s;
}
const dist2 = (a, b) => { const dr = R(a) - R(b), dg = G(a) - G(b), db = B(a) - B(b); return 0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db; };
function quantize(s, K) {
  const cols = [];
  for (const k of s.px) if (A(k)) cols.push(k);
  if (!cols.length) return s;
  let boxes = [cols];
  while (boxes.length < K) {                  // median cut on the widest channel
    let bi = -1, bw = 0, bch = 0;
    boxes.forEach((bx, i) => {
      if (bx.length < 2) return;
      for (const [ch, f] of [[0, R], [1, G], [2, B]]) {
        let lo = 255, hi = 0;
        for (const k of bx) { lo = Math.min(lo, f(k)); hi = Math.max(hi, f(k)); }
        if (hi - lo > bw) { bw = hi - lo; bi = i; bch = ch; }
      }
    });
    if (bi < 0 || bw === 0) break;
    const f = [R, G, B][bch], bx = boxes[bi].slice().sort((a, b) => f(a) - f(b)), mid = bx.length >> 1;
    boxes.splice(bi, 1, bx.slice(0, mid), bx.slice(mid));
  }
  let pal = boxes.map((bx) => { let r = 0, g = 0, b = 0; for (const k of bx) { r += R(k); g += G(k); b += B(k); } return pack(Math.round(r / bx.length), Math.round(g / bx.length), Math.round(b / bx.length)); });
  for (let it = 0; it < 4; it++) {           // k-means refinement
    const acc = pal.map(() => [0, 0, 0, 0]);
    for (const k of cols) { let bi = 0, bd = Infinity; pal.forEach((p, i) => { const d = dist2(k, p); if (d < bd) { bd = d; bi = i; } }); const a = acc[bi]; a[0] += R(k); a[1] += G(k); a[2] += B(k); a[3]++; }
    pal = pal.map((p, i) => (acc[i][3] ? pack(Math.round(acc[i][0] / acc[i][3]), Math.round(acc[i][1] / acc[i][3]), Math.round(acc[i][2] / acc[i][3])) : p));
  }
  for (let i = 0; i < s.px.length; i++) {
    const k = s.px[i];
    if (!A(k)) continue;
    let best = pal[0], bd = Infinity;
    for (const p of pal) { const d = dist2(k, p); if (d < bd) { bd = d; best = p; } }
    s.px[i] = best;
  }
  return s;
}
function removeBackground(s, bg, tol) {
  const w = s.w, h = s.h, border = [];
  for (let x = 0; x < w; x++) border.push([x, 0], [x, h - 1]);
  for (let y = 1; y < h - 1; y++) border.push([0, y], [w - 1, y]);
  if (bg === null) {
    // already transparent around the edge -> nothing to remove (don't mistake the outline for a background)
    const opaque = border.filter(([x, y]) => A(s.px[y * w + x])).length;
    if (opaque * 2 < border.length) return s;
    const m = new Map();                     // dominant border colour: coarse bins, then their mean
    for (const [x, y] of border) {
      const k = s.px[y * w + x];
      if (!A(k)) continue;
      const key = ((R(k) >> 4) << 8) | ((G(k) >> 4) << 4) | (B(k) >> 4), e = m.get(key) || [0, 0, 0, 0];
      e[0]++; e[1] += R(k); e[2] += G(k); e[3] += B(k); m.set(key, e);
    }
    const e = [...m.values()].sort((p, q) => q[0] - p[0])[0];
    bg = pack(Math.round(e[1] / e[0]), Math.round(e[2] / e[0]), Math.round(e[3] / e[0]));
  }
  const same = (k) => A(k) && dist2(k, bg) <= tol * tol;
  const seen = new Uint8Array(w * h), stack = border.filter(([x, y]) => same(s.px[y * w + x]));
  while (stack.length) {                     // flood only through background-coloured cells
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h || seen[y * w + x]) continue;
    seen[y * w + x] = 1;
    if (!same(s.px[y * w + x])) continue;
    s.px[y * w + x] = 0;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return s;
}

module.exports = {
  Surface, surface, load, c, hex, mix, ramp, palette, pack, rgb2hsv, hsv2rgb, bayer, BAYER,
  text, textWidth, sheet, strip, gif, pixelate, quantize, removeBackground, despeckle, encodePNG, dedent,
};

// ------------------------------------------------------------------ CLI
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = {}, pos = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); flags[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else pos.push(argv[i]);
  }
  const num = (v, d) => (v === undefined || v === true ? d : +v);
  const base = (f) => path.basename(f).replace(/\.[^.]+$/, '');
  const run = {
    view() {                                 // upscaled copy for looking at; --grid draws pixel lines
      const s = load(pos[0]), sc = num(flags.scale, Math.max(2, Math.min(12, Math.floor(640 / Math.max(s.w, s.h)))));
      const out = pos[1] || pos[0].replace(/\.png$/i, `_x${sc}.png`);
      const bg = new Surface(s.w * sc, s.h * sc);
      if (flags.bg !== 'none') {             // checkerboard behind transparency
        const c1 = c(flags.bg && flags.bg !== true ? flags.bg : '#3c3c4b'), c2 = mix(c1, '#ffffff', 0.08);
        for (let y = 0; y < bg.h; y++) for (let x = 0; x < bg.w; x++) bg.px[y * bg.w + x] = ((Math.floor(x / (sc * 2)) + Math.floor(y / (sc * 2))) & 1) ? c2 : c1;
      }
      bg.blit(s, 0, 0, { scale: sc });
      if (flags.grid) {                      // darken the first row / column of every art pixel
        for (let y = 0; y < bg.h; y++) for (let x = 0; x < bg.w; x++) if (x % sc === 0 || y % sc === 0) bg.px[y * bg.w + x] = mix(bg.px[y * bg.w + x], '#000000', 0.25);
      }
      bg.save(out);
      console.log(`${out}  (${s.w}x${s.h} at ${sc}x)`);
    },
    ascii() {
      const s = load(pos[0]);
      let crop;
      if (flags.crop) { const [x, y, w, h] = String(flags.crop).split(',').map(Number); crop = { x, y, w, h }; }
      console.log(s.ascii({ crop }));
    },
    stats() {
      for (const f of pos) {
        const s = load(f), st = s.stats(), cols = s.colors();
        console.log(`${f}: ${st.w}x${st.h}, opaque box ${st.bbox ? `${st.bbox.x},${st.bbox.y} ${st.bbox.w}x${st.bbox.h}` : 'none'}, ${st.colors} colours` +
          (st.semiTransparent ? `, WARNING ${st.semiTransparent} semi-transparent pixels (pixel art should be 0/255)` : ''));
        console.log('  ' + cols.slice(0, 32).map(([k, n]) => `${k}:${n}`).join(' ') + (cols.length > 32 ? ' ...' : ''));
      }
    },
    sheet() {
      const out = pos[0], files = pos.slice(1);
      const s = sheet(files.map((f) => ({ img: load(f), label: flags.labels === 'none' ? '' : base(f) })), { cols: num(flags.cols, Math.min(files.length, 6)), bg: flags.bg });
      s.save(out, { scale: num(flags.scale, 4) });
      console.log(`${out}  (${files.length} images, ${num(flags.scale, 4)}x)`);
    },
    diff() {
      const a = load(pos[0]), b = load(pos[1]);
      if (a.w !== b.w || a.h !== b.h) { console.log(`size differs: ${a.w}x${a.h} vs ${b.w}x${b.h}`); process.exitCode = 1; return; }
      const m = new Surface(a.w, a.h);
      let n = 0;
      for (let i = 0; i < a.px.length; i++) if (a.px[i] !== b.px[i] && (A(a.px[i]) || A(b.px[i]))) { n++; m.px[i] = c('#ff3355'); }
      console.log(`${n} differing pixels`);
      if (pos[2]) { sheet([{ img: a, label: 'A' }, { img: b, label: 'B' }, { img: m, label: 'DIFF' }], { cols: 3 }).save(pos[2], { scale: num(flags.scale, 4) }); console.log(pos[2]); }
    },
    anim() {
      const out = pos[0], frames = pos.slice(1).map(load);
      gif(out, frames, { fps: num(flags.fps, 6), scale: num(flags.scale, 4) });
      strip(frames).save(out.replace(/\.gif$/i, '_strip.png'), { scale: num(flags.scale, 4) });
      console.log(`${out} + strip (${frames.length} frames, ${num(flags.fps, 6)} fps)`);
    },
    pixelate() {
      const s = load(pos[0]);
      const out = pixelate(s, { pixel: num(flags.pixel, 0), colors: num(flags.colors, 16), bg: flags.bg || 'auto',
        offset: flags.offset ? String(flags.offset).split(',').map(Number) : [0, 0], tolerance: num(flags.tolerance, 12),
        despeckle: flags['no-despeckle'] ? false : true });
      out.save(pos[1]);
      out.save(pos[1].replace(/\.png$/i, '_preview.png'), { scale: num(flags.scale, 6) });
      console.log(`${pos[1]}  (${out.w}x${out.h}, ${out.colors().length} colours) + _preview.png`);
    },
    help() {
      console.log(`pixel.js - draw pixel art with code, then look at it
  node pixel.js view  in.png [out.png] [--scale N] [--grid] [--bg #hex|none]   upscaled copy to look at
  node pixel.js ascii in.png [--crop x,y,w,h]                                 print as characters + legend
  node pixel.js stats in.png ...                                              size, box, colours, alpha check
  node pixel.js sheet out.png a.png b.png ... [--cols N] [--scale 4]          labelled contact sheet
  node pixel.js diff  a.png b.png [diff.png]                                  count / show differing pixels
  node pixel.js anim  out.gif f0.png f1.png ... [--fps 6] [--scale 4]         animated GIF + strip
  node pixel.js pixelate ref.png out.png --pixel N [--colors 16] [--bg auto|none|#hex] [--tolerance 12]
                         [--offset x,y] [--no-despeckle]                     reference -> 1:1 pixel art
Library: const P = require('./pixel.js')  (see the header of this file)`);
    },
  };
  (run[cmd] || run.help)();
}
