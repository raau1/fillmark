import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FontFiles } from '../src/core/fonts';
import type { Rect } from '../src/core/types';

const FONT_DIR = join(__dirname, '../src/assets/fonts');
let cached: FontFiles | null = null;
export function loadForFontsOnce(): FontFiles {
  if (cached) return cached;
  const f = (n: string) => new Uint8Array(readFileSync(join(FONT_DIR, n)));
  cached = {
    'DejaVuSans.ttf': f('DejaVuSans.ttf'),
    'DejaVuSansCondensed.ttf': f('DejaVuSansCondensed.ttf'),
    'DejaVuSerif.ttf': f('DejaVuSerif.ttf'),
  };
  return cached;
}

export interface Raster {
  width: number;
  height: number;
  data: Uint8Array; // RGB triplets
  dpi: number;
}

/** Rasterise one page with poppler (independent of pdf.js), honouring CropBox and /Rotate. */
export function rasterizeAt(pdf: Uint8Array, pageIndex: number, dpi = 288): Raster {
  const dir = mkdtempSync(join(tmpdir(), 'pff-'));
  const inp = join(dir, 'in.pdf');
  writeFileSync(inp, pdf);
  const out = join(dir, 'out');
  execFileSync('pdftoppm', ['-r', String(dpi), '-cropbox', '-aa', 'no', '-aaVector', 'no', '-f', String(pageIndex + 1), '-l', String(pageIndex + 1), '-singlefile', inp, out]);
  const buf = readFileSync(out + '.ppm');
  let pos = 0;
  const tokens: string[] = [];
  while (tokens.length < 4) {
    while (buf[pos] <= 0x20) pos++;
    if (buf[pos] === 0x23) {
      while (buf[pos] !== 0x0a) pos++;
      continue;
    }
    let s = '';
    while (buf[pos] > 0x20) s += String.fromCharCode(buf[pos++]);
    tokens.push(s);
  }
  pos++;
  return { width: +tokens[1], height: +tokens[2], data: new Uint8Array(buf.subarray(pos)), dpi };
}

/**
 * Bounding box (display points) of pixels matching `pred`. If `region` is given,
 * only pixels within region ± margin (points) are considered.
 */
export function bboxOf(r: Raster, pred: (R: number, G: number, B: number) => boolean, region?: Rect, margin = 0) {
  const k = r.dpi / 72;
  const xs = region ? Math.max(0, Math.floor((region.x - margin) * k)) : 0;
  const ys = region ? Math.max(0, Math.floor((region.y - margin) * k)) : 0;
  const xe = region ? Math.min(r.width, Math.ceil((region.x + region.w + margin) * k)) : r.width;
  const ye = region ? Math.min(r.height, Math.ceil((region.y + region.h + margin) * k)) : r.height;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (let y = ys; y < ye; y++) {
    for (let x = xs; x < xe; x++) {
      const i = (y * r.width + x) * 3;
      if (pred(r.data[i], r.data[i + 1], r.data[i + 2])) {
        n++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (!n) return null;
  return { x0: x0 / k, y0: y0 / k, x1: (x1 + 1) / k, y1: (y1 + 1) / k, count: n };
}

export const isRed = (R: number, G: number, B: number) => R > 160 && G < 110 && B < 110;
export const isBlue = (R: number, G: number, B: number) => B > 160 && R < 110 && G < 110;
