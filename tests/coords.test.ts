import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  displayRectToPdf,
  displayToPdf,
  makePageInfo,
  normalizeRotation,
  pdfRectToDisplay,
  pdfToDisplay,
} from '../src/core/coords';
import { pageInfoFromPdfLib } from '../src/core/exportPdf';

/** Builds a PDF with odd crop boxes and every rotation (including negative / >360 values). */
export async function makeGeometryPdf() {
  const doc = await PDFDocument.create();
  const specs = [
    { size: [595, 842], crop: null, rot: 0 },
    { size: [612, 792], crop: [30, 40, 500, 700], rot: 90 },
    { size: [842, 595], crop: [10, 20, 800, 560], rot: 180 },
    { size: [400, 600], crop: [5, 15, 380, 590], rot: 270 },
    { size: [500, 300], crop: null, rot: -90 },
    { size: [500, 300], crop: null, rot: 450 },
  ] as const;
  for (const s of specs) {
    const p = doc.addPage([s.size[0], s.size[1]]);
    if (s.crop) p.setCropBox(s.crop[0], s.crop[1], s.crop[2] - s.crop[0], s.crop[3] - s.crop[1]);
    p.setRotation(degrees(s.rot));
  }
  return { bytes: await doc.save(), specs };
}

describe('rotation normalisation', () => {
  it('normalises arbitrary multiples of 90', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(720)).toBe(0);
    expect(normalizeRotation(-180)).toBe(180);
  });
});

describe('display ↔ PDF transforms', () => {
  it('round-trips points for every rotation', () => {
    for (const rot of [0, 90, 180, 270]) {
      const info = makePageInfo([12, 34, 512, 734], rot);
      for (const [u, v] of [[0, 0], [10, 20], [info.width, info.height], [123.4, 567.8]]) {
        const p = displayToPdf(info, u, v);
        const back = pdfToDisplay(info, p.x, p.y);
        expect(back.x).toBeCloseTo(u, 9);
        expect(back.y).toBeCloseTo(v, 9);
      }
    }
  });

  it('round-trips rectangles and swaps size for 90/270', () => {
    const r = { x: 50, y: 60, w: 100, h: 20 };
    for (const rot of [0, 90, 180, 270]) {
      const info = makePageInfo([0, 0, 600, 800], rot);
      const pr = displayRectToPdf(info, r);
      if (rot % 180) {
        expect(pr.width).toBeCloseTo(20);
        expect(pr.height).toBeCloseTo(100);
      } else {
        expect(pr.width).toBeCloseTo(100);
        expect(pr.height).toBeCloseTo(20);
      }
      const back = pdfRectToDisplay(info, pr);
      expect(back).toEqual({ x: expect.closeTo(50), y: expect.closeTo(60), w: expect.closeTo(100), h: expect.closeTo(20) });
    }
  });

  it('display top-left of an unrotated page is the PDF top-left corner', () => {
    const info = makePageInfo([0, 0, 595.32, 841.92], 0);
    expect(displayToPdf(info, 0, 0)).toEqual({ x: 0, y: 841.92 });
    expect(displayToPdf(info, 100, 41.92)).toEqual({ x: 100, y: 800 });
  });

  it('matches pdf.js viewport transforms (scale 1 and 2.5) for crop boxes and all rotations', async () => {
    const { bytes } = await makeGeometryPdf();
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
    const pdf = await task.promise;
    const writer = await PDFDocument.load(bytes);
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      const view = page.view as [number, number, number, number];
      const info = makePageInfo(view, page.rotate);
      // pdf-lib (export side) agrees with pdf.js (render side)
      const fromWriter = pageInfoFromPdfLib(writer.getPage(i));
      expect(fromWriter.rotation).toBe(info.rotation);
      fromWriter.box.forEach((v, k) => expect(v).toBeCloseTo(info.box[k], 6));

      for (const scale of [1, 2.5]) {
        const vp = page.getViewport({ scale });
        expect(vp.width).toBeCloseTo(info.width * scale, 6);
        expect(vp.height).toBeCloseTo(info.height * scale, 6);
        for (const [x, y] of [[view[0], view[1]], [view[2], view[3]], [view[0] + 37.5, view[1] + 91.25]]) {
          const [sx, sy] = vp.convertToViewportPoint(x, y);
          const d = pdfToDisplay(info, x, y);
          expect(d.x * scale).toBeCloseTo(sx, 6);
          expect(d.y * scale).toBeCloseTo(sy, 6);
          const [px, py] = vp.convertToPdfPoint(sx, sy);
          const p = displayToPdf(info, sx / scale, sy / scale);
          expect(p.x).toBeCloseTo(px, 6);
          expect(p.y).toBeCloseTo(py, 6);
        }
      }
    }
    await task.destroy();
  });
});
