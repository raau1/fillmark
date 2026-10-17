import type { Rect } from './types';

/**
 * Image-based detection of printed form elements on a rendered page.
 *
 * Works on any page that can be rendered (vector, scanned, text converted to
 * outlines), because it only looks at pixels:
 *  - "holes": enclosed blank regions bounded by ink. An enclosed, empty,
 *    rectangular hole is the inside of a printed box: small and square → a
 *    checkbox; wide → a text box (tall → multi-line). Round small holes → radio.
 *  - "underlines": thin horizontal ink lines with blank space above and some
 *    ink (a label) to their left → a blank line to write on.
 *
 * Everything is returned as suggestions with a confidence; the user reviews them.
 */

export type DetectedKind = 'checkbox' | 'radio' | 'box' | 'multibox' | 'line';

export interface Detected {
  kind: DetectedKind;
  rect: Rect; // display points
  confidence: number; // 0..1
}

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array; // RGBA
}

export interface DetectOptions {
  /** pixels per display point of the rendered image */
  scale: number;
  checkboxes?: boolean;
  boxes?: boolean;
  lines?: boolean;
}

/** Ink = anything clearly darker than paper or clearly coloured (thin coloured frames). */
export function inkMask(img: PixelImage): Uint8Array {
  const { width, height, data } = img;
  const m = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < m.length; p++, i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue;
    const lum = (r * 299 + g * 587 + b * 114) / 1000;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (lum < 200 || (sat > 60 && lum < 235)) m[p] = 1;
  }
  return m;
}

interface Comp {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  border: boolean;
}

/** Connected components of pixels where mask[p] === value (4-connectivity). */
function components(mask: Uint8Array, w: number, h: number, value: number, maxArea = Infinity): Comp[] {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out: Comp[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (seen[start] || mask[start] !== value) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    const c: Comp = { x0: w, y0: h, x1: -1, y1: -1, area: 0, border: false };
    while (sp) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) c.border = true;
      if (x > 0 && !seen[p - 1] && mask[p - 1] === value) (seen[p - 1] = 1), (stack[sp++] = p - 1);
      if (x < w - 1 && !seen[p + 1] && mask[p + 1] === value) (seen[p + 1] = 1), (stack[sp++] = p + 1);
      if (y > 0 && !seen[p - w] && mask[p - w] === value) (seen[p - w] = 1), (stack[sp++] = p - w);
      if (y < h - 1 && !seen[p + w] && mask[p + w] === value) (seen[p + w] = 1), (stack[sp++] = p + w);
    }
    if (c.area <= maxArea) out.push(c);
  }
  return out;
}

/**
 * How much ink surrounds a hole, measured outward from the middle of each side.
 * Printed boxes have a thin frame on every side; holes inside solid shapes or
 * white lettering on coloured banners are surrounded by thick ink on some side.
 */
function ringThickness(mask: Uint8Array, w: number, h: number, c: Comp): { median: number; max: number } {
  const cx = (c.x0 + c.x1) >> 1;
  const cy = (c.y0 + c.y1) >> 1;
  const run = (x: number, y: number, dx: number, dy: number) => {
    let n = 0;
    while (x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] && n < 400) {
      n++;
      x += dx;
      y += dy;
    }
    return n;
  };
  const t = [run(c.x0 - 1, cy, -1, 0), run(c.x1 + 1, cy, 1, 0), run(cx, c.y0 - 1, 0, -1), run(cx, c.y1 + 1, 0, 1)].sort((a, b) => a - b);
  return { median: (t[1] + t[2]) / 2, max: t[3] };
}

export function detectFormElements(img: PixelImage, opts: DetectOptions): Detected[] {
  const { width: w, height: h } = img;
  const k = opts.scale; // px per pt
  const want = { checkboxes: opts.checkboxes ?? true, boxes: opts.boxes ?? true, lines: opts.lines ?? true };
  const ink = inkMask(img);
  const out: Detected[] = [];
  const pageArea = (w / k) * (h / k);

  // ---- holes (enclosed blank regions)
  const holes = components(ink, w, h, 0);
  for (const c of holes) {
    if (c.border) continue;
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    const fill = c.area / (bw * bh);
    const wp = bw / k;
    const hp = bh / k;
    if (wp * hp > pageArea * 0.5) continue; // page frames
    const rect: Rect = { x: c.x0 / k, y: c.y0 / k, w: wp, h: hp };
    const aspect = wp / hp;
    const small = wp >= 3.5 && hp >= 3.5 && wp <= 24 && hp <= 24 && aspect > 0.7 && aspect < 1.43;
    if (small && want.checkboxes) {
      const ring = ringThickness(ink, w, h, c);
      // frame (plus an optional drop shadow) must be thin on every side
      const limit = Math.max(2.2, 0.35 * Math.min(wp, hp)) * k;
      if (ring.max > limit) continue;
      if (fill >= 0.88) {
        out.push({ kind: 'checkbox', rect, confidence: Math.min(1, 0.55 + (fill - 0.88) * 3 + (Math.abs(1 - aspect) < 0.1 ? 0.15 : 0)) });
      } else if (fill > 0.7 && fill < 0.86 && Math.abs(1 - aspect) < 0.1 && Math.min(wp, hp) >= 5) {
        // a round hole: radio button (letter counters like "O" are narrower or smaller)
        out.push({ kind: 'radio', rect, confidence: 0.5 });
      }
      continue;
    }
    if (!want.boxes) continue;
    if (wp >= 24 && hp >= 7 && fill >= 0.965) {
      const ring = ringThickness(ink, w, h, c);
      if (ring.median > 4 * k) continue; // inside thick/solid shapes, not a frame
      const kind: DetectedKind = hp >= 28 ? 'multibox' : 'box';
      out.push({ kind, rect, confidence: Math.min(1, 0.6 + (fill - 0.965) * 8) });
    }
  }

  // ---- underlines (blank lines to write on)
  if (want.lines) {
    const inkComps = components(ink, w, h, 1, (w * h) / 8);
    const inkAt = (x0: number, y0: number, x1: number, y1: number) => {
      let n = 0;
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
        for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) if (ink[y * w + x]) n++;
      return n;
    };
    for (const c of inkComps) {
      const bw = c.x1 - c.x0 + 1;
      const bh = c.y1 - c.y0 + 1;
      const wp = bw / k;
      const hp = bh / k;
      if (hp > 2.2 || wp < 36 || wp > (w / k) * 0.85) continue;
      if (c.area / (bw * bh) < 0.6) continue; // dotted / dashed lines are not handled
      const fieldH = 14;
      // blank space above the line
      const above = inkAt(c.x0 + 2, Math.round(c.y0 - fieldH * k), c.x1 - 2, c.y0 - Math.round(0.8 * k));
      if (above > bw * 0.02) continue;
      // something (a label) to the left on the same line
      const left = inkAt(Math.round(c.x0 - 160 * k), Math.round(c.y0 - 12 * k), c.x0 - Math.round(2 * k), c.y0 + 1);
      if (left < 6 * k * k) continue;
      out.push({ kind: 'line', rect: { x: c.x0 / k, y: c.y0 / k - fieldH, w: wp, h: fieldH }, confidence: 0.5 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grouping and labelling helpers (pure geometry)

export interface TextItem {
  str: string;
  rect: Rect; // display points
}

const vOverlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** OCR often reads frame lines as "[", "|" or "="; such tokens are never labels. */
const meaningful = (t: TextItem) => /[\p{L}\p{N}]/u.test(t.str);

/** Text immediately to the right of a checkbox, on the same line. */
export function labelRightOf(box: Rect, items: TextItem[], stopAt: Rect[] = []): string {
  const line = items
    .filter(meaningful)
    .filter((t) => vOverlap(t.rect, box) > Math.min(t.rect.h, box.h) * 0.4 && t.rect.x >= box.x + box.w - 1)
    .sort((a, b) => a.rect.x - b.rect.x);
  const parts: string[] = [];
  let edge = box.x + box.w;
  for (const t of line) {
    if (t.rect.x - edge > (parts.length ? 12 : 30)) break;
    if (stopAt.some((s) => s !== box && s.x > box.x && s.x < t.rect.x && vOverlap(s, box) > 0)) break;
    parts.push(t.str);
    edge = t.rect.x + t.rect.w;
  }
  return clean(parts.join(' '));
}

/** Label for a text box: text to the left on the same line, otherwise just above it. */
export function labelForBox(box: Rect, all: TextItem[], exclude?: Set<TextItem>): string {
  const items = all.filter((t) => meaningful(t) && !exclude?.has(t));
  const mid = box.y + box.h / 2;
  const left = items
    .filter((t) => t.rect.x + t.rect.w <= box.x + 2 && box.x - (t.rect.x + t.rect.w) < 200 && t.rect.y <= mid && t.rect.y + t.rect.h >= mid - Math.min(box.h / 2, 8))
    .sort((a, b) => b.rect.x - a.rect.x);
  if (left.length) {
    // collect contiguous items ending at the box
    const row = left.filter((t) => Math.abs(t.rect.y - left[0].rect.y) < 3).sort((a, b) => a.rect.x - b.rect.x);
    return clean(row.map((t) => t.str).join(' '));
  }
  const above = items
    .filter((t) => t.rect.y + t.rect.h <= box.y + 1 && box.y - (t.rect.y + t.rect.h) < 14 && t.rect.x < box.x + box.w && t.rect.x + t.rect.w > box.x)
    .sort((a, b) => b.rect.y - a.rect.y);
  if (above.length) {
    const y = above[0].rect.y;
    return clean(above.filter((t) => Math.abs(t.rect.y - y) < 3).sort((a, b) => a.rect.x - b.rect.x).map((t) => t.str).join(' '));
  }
  return '';
}

function clean(s: string) {
  return s.replace(/\s+/g, ' ').replace(/^[\s:._\-–—/]+|[\s:._\-–—]+$/g, '').trim().slice(0, 120);
}

export interface Placed {
  kind: DetectedKind;
  rect: Rect;
}

/**
 * Splits a page's checkboxes into lists: same column (left edges within 3 pt)
 * and no vertical gap larger than `gap`. Returns a list index per element.
 */
export function clusterColumns(items: Placed[], gap = 40): number[] {
  const idx = items.map((_, i) => i).sort((a, b) => items[a].rect.x - items[b].rect.x || items[a].rect.y - items[b].rect.y);
  const group = new Array<number>(items.length).fill(-1);
  const cols: number[][] = [];
  for (const i of idx) {
    const col = cols.find((c) => Math.abs(items[c[0]].rect.x - items[i].rect.x) <= 3);
    if (col) col.push(i);
    else cols.push([i]);
  }
  let g = 0;
  for (const col of cols) {
    col.sort((a, b) => items[a].rect.y - items[b].rect.y);
    let prev: Rect | null = null;
    for (const i of col) {
      const r = items[i].rect;
      if (prev && r.y - (prev.y + prev.h) > gap) g++;
      group[i] = g;
      prev = r;
    }
    g++;
  }
  return group;
}

/**
 * Small rows of 2–3 checkboxes that stand alone (no checkbox directly above or
 * below in the same column) usually mean "choose one" (Sí / No, H / M).
 * Returns rows as arrays of indices.
 */
export function choiceRows(items: Placed[]): number[][] {
  const boxes = items.map((it, i) => ({ ...it, i })).filter((it) => it.kind === 'checkbox' || it.kind === 'radio');
  const rows: number[][] = [];
  const used = new Set<number>();
  for (const b of boxes) {
    if (used.has(b.i)) continue;
    const sameLine = boxes
      .filter((o) => Math.abs(o.rect.y - b.rect.y) < 2 && Math.abs(o.rect.h - b.rect.h) < 2)
      .sort((a, c) => a.rect.x - c.rect.x);
    // split the line where boxes are far apart (two questions side by side)
    const runs: (typeof sameLine)[] = [];
    for (const o of sameLine) {
      const last = runs[runs.length - 1];
      if (last && o.rect.x - (last[last.length - 1].rect.x + last[last.length - 1].rect.w) <= 60) last.push(o);
      else runs.push([o]);
    }
    const row = runs.find((r) => r.some((o) => o.i === b.i))!;
    if (row.length < 2 || row.length > 3) continue;
    const span = row[row.length - 1].rect.x - row[0].rect.x;
    if (span > 90) continue;
    const stacked = row.some((r) =>
      boxes.some((o) => !row.includes(o) && Math.abs(o.rect.x - r.rect.x) < 3 && Math.abs(o.rect.y - r.rect.y) < 22),
    );
    if (stacked) continue;
    row.forEach((r) => used.add(r.i));
    rows.push(row.map((r) => r.i));
  }
  return rows;
}

export function iou(a: Rect, b: Rect): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = x * y;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}
