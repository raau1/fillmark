import type { PageInfo, Rect } from './types';

/**
 * Coordinate transforms between display space and PDF user space.
 *
 * Display space: points, origin top-left of the page as displayed (after /Rotate),
 *                y grows downward. Independent of zoom.
 * Screen space:  CSS pixels = display points × scale.
 * PDF space:     points, origin bottom-left of the unrotated page, y grows upward,
 *                same coordinates the page content stream uses.
 *
 * /Rotate is clockwise. Derivation (W,H = unrotated box size, [x0,y0,x1,y1] box):
 *   r=0:   u = x - x0,  v = y1 - y
 *   r=90:  u = y - y0,  v = x - x0
 *   r=180: u = x1 - x,  v = y - y0
 *   r=270: u = y1 - y,  v = x1 - x
 * These match pdf.js PageViewport.convertToViewportPoint at scale 1 (see tests).
 */

export type Rotation = 0 | 90 | 180 | 270;

export function normalizeRotation(r: number): Rotation {
  const n = ((Math.round(r / 90) * 90) % 360 + 360) % 360;
  return n as Rotation;
}

export function makePageInfo(box: [number, number, number, number], rotation: number): PageInfo {
  const [x0, y0, x1, y1] = box;
  const bx: [number, number, number, number] = [
    Math.min(x0, x1),
    Math.min(y0, y1),
    Math.max(x0, x1),
    Math.max(y0, y1),
  ];
  const r = normalizeRotation(rotation);
  const W = bx[2] - bx[0];
  const H = bx[3] - bx[1];
  const swap = r === 90 || r === 270;
  return { box: bx, rotation: r, width: swap ? H : W, height: swap ? W : H };
}

export interface Point {
  x: number;
  y: number;
}

/** display (u,v) → PDF (x,y) */
export function displayToPdf(page: PageInfo, u: number, v: number): Point {
  const [x0, y0, x1, y1] = page.box;
  switch (page.rotation) {
    case 0:
      return { x: x0 + u, y: y1 - v };
    case 90:
      return { x: x0 + v, y: y0 + u };
    case 180:
      return { x: x1 - u, y: y0 + v };
    case 270:
      return { x: x1 - v, y: y1 - u };
  }
}

/** PDF (x,y) → display (u,v) */
export function pdfToDisplay(page: PageInfo, x: number, y: number): Point {
  const [x0, y0, x1, y1] = page.box;
  switch (page.rotation) {
    case 0:
      return { x: x - x0, y: y1 - y };
    case 90:
      return { x: y - y0, y: x - x0 };
    case 180:
      return { x: x1 - x, y: y - y0 };
    case 270:
      return { x: y1 - y, y: x1 - x };
  }
}

/** Axis-aligned PDF rectangle (as stored in /Rect of widgets) → display rect. */
export function pdfRectToDisplay(page: PageInfo, r: { x: number; y: number; width: number; height: number }): Rect {
  const a = pdfToDisplay(page, r.x, r.y);
  const b = pdfToDisplay(page, r.x + r.width, r.y + r.height);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** Display rect → axis-aligned PDF rectangle (x,y = lower-left corner in PDF space). */
export function displayRectToPdf(page: PageInfo, r: Rect): { x: number; y: number; width: number; height: number } {
  const a = displayToPdf(page, r.x, r.y);
  const b = displayToPdf(page, r.x + r.w, r.y + r.h);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/**
 * Anchor for drawing upright content (text, rectangles, images) inside a display rect.
 * Returns the PDF-space position of the display point (u,v) and the counter-clockwise
 * rotation (degrees) that makes PDF content read upright on screen.
 * pdf-lib's `rotate` option is counter-clockwise around (x,y), so the rotation equals /Rotate.
 */
export function uprightAnchor(page: PageInfo, u: number, v: number): Point & { rotate: number } {
  const p = displayToPdf(page, u, v);
  return { ...p, rotate: page.rotation };
}

/** Screen (CSS px relative to page top-left) → display points */
export function screenToDisplay(px: number, py: number, scale: number): Point {
  return { x: px / scale, y: py / scale };
}

export function displayToScreen(u: number, v: number, scale: number): Point {
  return { x: u * scale, y: v * scale };
}

export function clampRectToPage(r: Rect, page: PageInfo, minSize = 4): Rect {
  const w = Math.max(minSize, Math.min(r.w, page.width));
  const h = Math.max(minSize, Math.min(r.h, page.height));
  const x = Math.min(Math.max(0, r.x), page.width - w);
  const y = Math.min(Math.max(0, r.y), page.height - h);
  return { x, y, w, h };
}
