/**
 * Drawn signatures are kept as pen strokes (vector paths), not as a picture:
 * they are drawn in the field's colour, can be recoloured at any time, and stay
 * sharp at any zoom and in the exported PDF.
 *
 * Stored value: "sig:" + JSON { v: 1, w, h, lw, d: [svg path, ...] }
 * in the pad's own units (CSS pixels), already trimmed to the ink.
 * Uploaded images are still stored as data: URLs and keep their own colours.
 */

export interface InkSignature {
  v: 1;
  /** size of the drawing, including padding */
  w: number;
  h: number;
  /** pen width */
  lw: number;
  /** one SVG path per stroke (M, Q and L commands, absolute coordinates) */
  d: string[];
}

export type Point = { x: number; y: number };

const PREFIX = 'sig:';

export const isInkValue = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIX);
export const isImageValue = (v: unknown): v is string => typeof v === 'string' && /^data:image\/(png|jpeg);/.test(v);
export const hasSignature = (v: unknown) => isInkValue(v) || isImageValue(v);

export function parseInk(v: string): InkSignature | null {
  if (!isInkValue(v)) return null;
  try {
    const s = JSON.parse(v.slice(PREFIX.length)) as InkSignature;
    if (s.v !== 1 || !(s.w > 0) || !(s.h > 0) || !(s.lw > 0) || !Array.isArray(s.d)) return null;
    if (!s.d.every((p) => typeof p === 'string' && /^[MQL0-9.\s-]+$/.test(p))) return null;
    return s;
  } catch {
    return null;
  }
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A smooth path through the points (quadratic curves between midpoints). */
export function strokePath(pts: Point[]): string {
  if (pts.length === 0) return '';
  const P = (p: Point) => `${r1(p.x)} ${r1(p.y)}`;
  // a single tap is a dot: a tiny segment drawn with round caps
  if (pts.length === 1) return `M ${P(pts[0])} L ${r1(pts[0].x + 0.1)} ${r1(pts[0].y)}`;
  if (pts.length === 2) return `M ${P(pts[0])} L ${P(pts[1])}`;
  let d = `M ${P(pts[0])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    d += ` Q ${P(pts[i])} ${P(mid)}`;
  }
  return `${d} L ${P(pts[pts.length - 1])}`;
}

/** Trims the strokes to the ink (plus padding) and encodes them as a field value. */
export function encodeInk(strokes: Point[][], lw: number): string | null {
  const all = strokes.flat();
  if (!all.length) return null;
  const pad = lw;
  const x0 = Math.min(...all.map((p) => p.x)) - pad;
  const y0 = Math.min(...all.map((p) => p.y)) - pad;
  const x1 = Math.max(...all.map((p) => p.x)) + pad;
  const y1 = Math.max(...all.map((p) => p.y)) + pad;
  const sig: InkSignature = {
    v: 1,
    w: r1(Math.max(x1 - x0, 1)),
    h: r1(Math.max(y1 - y0, 1)),
    lw,
    d: strokes.filter((s) => s.length).map((s) => strokePath(s.map((p) => ({ x: p.x - x0, y: p.y - y0 })))),
  };
  return PREFIX + JSON.stringify(sig);
}

/** Where the signature goes inside a box: scaled to fit, centred, 1 pt inset. Display coordinates. */
export function fitInk(sig: { w: number; h: number }, rect: { x: number; y: number; w: number; h: number }, inset = 1) {
  const bw = Math.max(0, rect.w - 2 * inset);
  const bh = Math.max(0, rect.h - 2 * inset);
  const scale = Math.min(bw / sig.w, bh / sig.h);
  return {
    scale,
    x: rect.x + inset + (bw - sig.w * scale) / 2,
    y: rect.y + inset + (bh - sig.h * scale) / 2,
    w: sig.w * scale,
    h: sig.h * scale,
  };
}
