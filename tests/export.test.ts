import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, degrees, rgb, PDFTextField, PDFCheckBox } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { exportPdf } from '../src/core/exportPdf';
import { createField } from '../src/core/fieldFactory';
import type { Field, Rect, Values } from '../src/core/types';
import { bboxOf, isBlue, isRed, loadForFontsOnce, rasterizeAt } from './exportHelpers';

const RED = '#ff0000';

/**
 * Test document: each page has a rotation / crop box. Reference rectangles are
 * drawn in BLUE at PDF coordinates computed with pdf.js (independently of our
 * transform code). Fields are placed at the same display rectangles. After
 * export, the RED marks/text rendered by poppler must sit inside the blue boxes.
 */
const PAGES = [
  { size: [595.32, 841.92], crop: null, rot: 0 },
  { size: [612, 792], crop: [30, 40, 500, 700], rot: 90 },
  { size: [842, 595], crop: [10, 20, 800, 560], rot: 180 },
  { size: [400, 600], crop: [5, 15, 380, 590], rot: 270 },
] as const;

const BOXES: Record<string, Rect> = {
  check: { x: 40, y: 50, w: 12, h: 12 },
  fill: { x: 70, y: 50, w: 10, h: 10 },
  text: { x: 40, y: 90, w: 200, h: 18 },
  multi: { x: 40, y: 130, w: 150, h: 60 },
  right: { x: 40, y: 210, w: 200, h: 16 },
};

async function buildTestPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const s of PAGES) {
    const p = doc.addPage([s.size[0], s.size[1]]);
    if (s.crop) p.setCropBox(s.crop[0], s.crop[1], s.crop[2] - s.crop[0], s.crop[3] - s.crop[1]);
    p.setRotation(degrees(s.rot));
  }
  // compute the PDF location of each display box with pdf.js
  const bytes0 = await doc.save();
  const task = pdfjs.getDocument({ data: bytes0.slice(), isEvalSupported: false });
  const pdf = await task.promise;
  for (let i = 0; i < PAGES.length; i++) {
    const page = await pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const p = doc.getPage(i);
    for (const b of Object.values(BOXES)) {
      const [ax, ay] = vp.convertToPdfPoint(b.x - 1.5, b.y - 1.5);
      const [bx, by] = vp.convertToPdfPoint(b.x + b.w + 1.5, b.y + b.h + 1.5);
      // 1pt blue frame drawn 1.5pt outside the box (so it never overlaps the red content)
      p.drawRectangle({
        x: Math.min(ax, bx),
        y: Math.min(ay, by),
        width: Math.abs(bx - ax),
        height: Math.abs(by - ay),
        borderColor: rgb(0, 0, 1),
        borderWidth: 1,
      });
    }
  }
  await task.destroy();
  return doc.save();
}

function makeFields(): { fields: Field[]; values: Values } {
  const fields: Field[] = [];
  const values: Values = {};
  PAGES.forEach((_, page) => {
    const check = createField('checkbox', page, BOXES.check, { name: `check${page}` });
    check.style.color = RED;
    const fill = createField('checkbox', page, BOXES.fill, { name: `fill${page}` });
    fill.style.color = RED;
    fill.style.checkStyle = 'fill';
    const text = createField('text', page, BOXES.text, { name: `text${page}` });
    text.style.color = RED;
    text.style.fontSize = 10;
    const multi = createField('multiline', page, BOXES.multi, { name: `multi${page}` });
    multi.style.color = RED;
    multi.style.fontSize = 9;
    const right = createField('text', page, BOXES.right, { name: `right${page}` });
    right.style.color = RED;
    right.style.align = 'right';
    right.style.fontSize = 10;
    right.style.fontFamily = 'helvetica';
    fields.push(check, fill, text, multi, right);
    values[check.id] = true;
    values[fill.id] = true;
    values[text.id] = 'Ñandú pingüino ÁÉÍÓÚ ¿qué?';
    values[multi.id] = 'Primera línea del paciente con bastante texto para que se divida en varias líneas dentro del recuadro.';
    values[right.id] = 'Señor Muñoz';
  });
  return { fields, values };
}

function within(inner: { x0: number; y0: number; x1: number; y1: number }, box: Rect, tol = 0.6) {
  expect(inner.x0).toBeGreaterThanOrEqual(box.x - tol);
  expect(inner.y0).toBeGreaterThanOrEqual(box.y - tol);
  expect(inner.x1).toBeLessThanOrEqual(box.x + box.w + tol);
  expect(inner.y1).toBeLessThanOrEqual(box.y + box.h + tol);
}

describe('PDF export alignment (rasterised with poppler)', async () => {
  const fontFiles = loadForFontsOnce();
  const source = await buildTestPdf();
  const { fields, values } = makeFields();

  for (const mode of ['flatten', 'editable'] as const) {
    it(`${mode}: marks and text land inside their boxes on every rotation/crop`, async () => {
      const { bytes, warnings } = await exportPdf(source, fields, values, { mode, fontFiles });
      if (process.env.PFF_DUMP) writeFileSync(join(process.env.PFF_DUMP, `export-${mode}.pdf`), bytes);
      expect(warnings.filter((w) => !/notes/.test(w))).toEqual([]);
      for (let page = 0; page < PAGES.length; page++) {
        const r = rasterizeAt(bytes, page);
        // sanity: the blue reference frames are where display space says they are
        const blue = bboxOf(r, isBlue)!;
        expect(blue.x0).toBeCloseTo(BOXES.check.x - 2, 0);
        expect(blue.y0).toBeCloseTo(BOXES.check.y - 2, 0);

        for (const [key, box] of Object.entries(BOXES)) {
          const sub = bboxOf(r, isRed, box, 3)!;
          expect(sub, `${mode} page ${page} ${key}`).not.toBeNull();
          within(sub, box);
          if (key === 'fill') {
            // filled square is centred in the box
            expect((sub.x0 + sub.x1) / 2).toBeCloseTo(box.x + box.w / 2, 0);
            expect((sub.y0 + sub.y1) / 2).toBeCloseTo(box.y + box.h / 2, 0);
          }
          if (key === 'text') {
            // left aligned: ink starts within ~2pt padding of the left edge, vertically centred
            expect(sub.x0 - box.x).toBeGreaterThan(0.5);
            expect(sub.x0 - box.x).toBeLessThan(4);
            const mid = (sub.y0 + sub.y1) / 2;
            expect(Math.abs(mid - (box.y + box.h / 2))).toBeLessThan(2.5);
          }
          if (key === 'right') {
            expect(box.x + box.w - sub.x1).toBeLessThan(4);
            expect(box.x + box.w - sub.x1).toBeGreaterThan(0.5);
          }
          if (key === 'multi') {
            // wrapped onto several lines
            expect(sub.y1 - sub.y0).toBeGreaterThan(20);
          }
        }
      }
    });
  }

  it('flatten: Spanish characters are encoded as real Unicode text', async () => {
    const { bytes } = await exportPdf(source, fields, values, { mode: 'flatten', fontFiles });
    const dir = mkdtempSync(join(tmpdir(), 'pff-'));
    writeFileSync(join(dir, 'o.pdf'), bytes);
    const txt = execFileSync('pdftotext', ['-f', '1', '-l', '1', join(dir, 'o.pdf'), '-']).toString();
    expect(txt).toContain('Ñandú pingüino ÁÉÍÓÚ ¿qué?');
    expect(txt).toContain('Señor Muñoz');
    expect(txt).toContain('línea');
  });

  it('flatten: preserves page count, sizes and rotations', async () => {
    const { bytes } = await exportPdf(source, fields, values, { mode: 'flatten', fontFiles });
    const out = await PDFDocument.load(bytes);
    const inp = await PDFDocument.load(source);
    expect(out.getPageCount()).toBe(inp.getPageCount());
    out.getPages().forEach((p, i) => {
      const q = inp.getPage(i);
      expect(p.getRotation().angle).toBe(q.getRotation().angle);
      expect(p.getMediaBox()).toEqual(q.getMediaBox());
      expect(p.getCropBox()).toEqual(q.getCropBox());
    });
    expect(out.catalog.getAcroForm()).toBeUndefined();
  });

  it('editable: produces real form fields with the entered values', async () => {
    const { bytes } = await exportPdf(source, fields, values, { mode: 'editable', fontFiles });
    const out = await PDFDocument.load(bytes);
    const form = out.getForm();
    const tf = form.getField('text0') as PDFTextField;
    expect(tf).toBeInstanceOf(PDFTextField);
    expect(tf.getText()).toBe('Ñandú pingüino ÁÉÍÓÚ ¿qué?');
    const cb = form.getField('check1') as PDFCheckBox;
    expect(cb.isChecked()).toBe(true);
  });

  it('editable output looks the same as the flattened output', async () => {
    const a = await exportPdf(source, fields, values, { mode: 'flatten', fontFiles });
    const b = await exportPdf(source, fields, values, { mode: 'editable', fontFiles });
    for (let page = 0; page < PAGES.length; page++) {
      const ra = rasterizeAt(a.bytes, page, 144);
      const rb = rasterizeAt(b.bytes, page, 144);
      let diff = 0;
      for (let i = 0; i < ra.data.length; i += 3) {
        if (Math.abs(ra.data[i] - rb.data[i]) + Math.abs(ra.data[i + 1] - rb.data[i + 1]) + Math.abs(ra.data[i + 2] - rb.data[i + 2]) > 60) diff++;
      }
      expect(diff / (ra.width * ra.height)).toBeLessThan(0.0005);
    }
  });

  it('leaves everything outside the fields untouched', async () => {
    const empty = await exportPdf(source, fields, {}, { mode: 'flatten', fontFiles });
    for (let page = 0; page < PAGES.length; page++) {
      const a = rasterizeAt(source, page);
      const b = rasterizeAt(empty.bytes, page);
      expect(b.width).toBe(a.width);
      expect(b.height).toBe(a.height);
      let diff = 0;
      for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) diff++;
      expect(diff).toBe(0);
    }
  });
});
