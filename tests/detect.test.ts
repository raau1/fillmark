import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { choiceRows, clusterColumns, detectFormElements, iou, labelForBox, labelRightOf, type PixelImage } from '../src/core/detect';
import { rasterizeAt } from './exportHelpers';

const DPI = 216; // scale 3 px per pt, what the app uses
function toRGBA(r: ReturnType<typeof rasterizeAt>): PixelImage {
  const data = new Uint8ClampedArray(r.width * r.height * 4);
  for (let i = 0, j = 0; i < r.data.length; i += 3, j += 4) {
    data[j] = r.data[i];
    data[j + 1] = r.data[i + 1];
    data[j + 2] = r.data[i + 2];
    data[j + 3] = 255;
  }
  return { width: r.width, height: r.height, data };
}

async function syntheticForm() {
  const doc = await PDFDocument.create();
  const p = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const H = 842;
  // labelled text box (display y = 60)
  p.drawText('Nombre:', { x: 40, y: H - 74, size: 10, font });
  p.drawRectangle({ x: 100, y: H - 80, width: 300, height: 20, borderColor: rgb(0, 0.6, 0.85), borderWidth: 1 });
  // large notes box
  p.drawRectangle({ x: 40, y: H - 220, width: 400, height: 80, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  // column of 5 checkboxes with labels
  for (let i = 0; i < 5; i++) {
    p.drawRectangle({ x: 40, y: H - (260 + i * 16) - 8, width: 8, height: 8, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
    p.drawText(`Opción ${i + 1}`, { x: 54, y: H - (260 + i * 16) - 7, size: 9, font });
  }
  // a yes/no row
  p.drawText('Presente:', { x: 40, y: H - 377, size: 9, font });
  p.drawRectangle({ x: 90, y: H - 378, width: 8, height: 8, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  p.drawRectangle({ x: 130, y: H - 378, width: 8, height: 8, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  // radio circles
  p.drawEllipse({ x: 300, y: H - 374, xScale: 4.5, yScale: 4.5, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  // a blank line after a label
  p.drawText('Firma:', { x: 40, y: H - 452, size: 10, font });
  p.drawLine({ start: { x: 80, y: H - 452 }, end: { x: 300, y: H - 452 }, thickness: 0.8 });
  // big bold letters must NOT become fields
  p.drawText('DIVA O 0', { x: 40, y: H - 560, size: 48, font: await doc.embedFont(StandardFonts.HelveticaBold) });
  // solid filled banner with white text must NOT become a field
  p.drawRectangle({ x: 40, y: H - 640, width: 300, height: 30, color: rgb(0.9, 0.2, 0.2) });
  return doc.save();
}

describe('image-based detection', () => {
  it('finds boxes, checkboxes, radios and lines on a synthetic form, ignoring letters and banners', async () => {
    const pdf = await syntheticForm();
    const img = toRGBA(rasterizeAt(pdf, 0, DPI));
    const found = detectFormElements(img, { scale: DPI / 72 });
    const of = (k: string) => found.filter((f) => f.kind === k);
    const near = (r: { x: number; y: number; w: number; h: number }, x: number, y: number, w: number, h: number) =>
      Math.abs(r.x - x) < 1.5 && Math.abs(r.y - y) < 1.5 && Math.abs(r.w - w) < 2 && Math.abs(r.h - h) < 2;

    expect(of('box').some((f) => near(f.rect, 100.5, 60.5, 299, 19))).toBe(true);
    expect(of('multibox').some((f) => near(f.rect, 40.5, 140.5, 399, 79))).toBe(true);
    expect(of('checkbox').length).toBe(7);
    expect(of('radio').length).toBe(1);
    expect(of('line').length).toBe(1);
    expect(of('line')[0].rect.x).toBeCloseTo(80, 0);
    // nothing detected inside the large letters or the banner
    expect(found.filter((f) => f.rect.y > 480).length).toBe(0);
  });

  it('clusters checkbox columns and spots stand-alone choice rows', () => {
    const cb = (x: number, y: number) => ({ kind: 'checkbox' as const, rect: { x, y, w: 6, h: 6 } });
    const items = [cb(40, 100), cb(40, 114), cb(40, 128), cb(300, 100), cb(300, 114), cb(40, 300), cb(118, 500), cb(150, 500), cb(382, 500), cb(414, 500)];
    const g = clusterColumns(items);
    expect(g[0]).toBe(g[1]);
    expect(g[1]).toBe(g[2]);
    expect(g[3]).not.toBe(g[0]);
    expect(g[5]).not.toBe(g[0]); // big vertical gap → new list
    const rows = choiceRows(items);
    expect(rows).toEqual([
      [6, 7],
      [8, 9],
    ]);
  });

  it('labels from the text layer', () => {
    const items = [
      { str: 'Nombre del paciente:', rect: { x: 40, y: 52, w: 90, h: 10 } },
      { str: 'Comete errores', rect: { x: 52, y: 200, w: 60, h: 9 } },
      { str: 'por olvidos', rect: { x: 114, y: 200, w: 40, h: 9 } },
    ];
    expect(labelForBox({ x: 148, y: 49, w: 400, h: 18 }, items)).toBe('Nombre del paciente');
    expect(labelRightOf({ x: 43, y: 201, w: 6, h: 6 }, items)).toBe('Comete errores por olvidos');
  });

  it('iou', () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(1);
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toBe(0);
  });

  // optional: set FILLMARK_SAMPLE_PDF to the DIVA-5 questionnaire to run this check
  const DIVA = process.env.FILLMARK_SAMPLE_PDF ?? '';
  it.skipIf(!DIVA || !existsSync(DIVA))('DIVA-5 page 2: finds every printed box and checkbox', () => {
    const pdf = new Uint8Array(readFileSync(DIVA));
    const found = detectFormElements(toRGBA(rasterizeAt(pdf, 1, DPI)), { scale: DPI / 72 });
    const boxes = found.filter((f) => f.kind === 'box');
    const multi = found.filter((f) => f.kind === 'multibox');
    const checks = found.filter((f) => f.kind === 'checkbox');
    expect(boxes.length).toBe(5);
    expect(multi.length).toBe(2);
    expect(checks.length).toBe(25);
    expect(found.filter((f) => f.kind === 'radio' || f.kind === 'line')).toEqual([]);
    const name = boxes.find((b) => b.rect.y < 60)!;
    expect(name.rect.x).toBeCloseTo(148.5, 0);
    expect(name.rect.w).toBeCloseTo(403.3, 0);
    const rows = choiceRows(checks);
    expect(rows.length).toBe(3); // H/M, and two "Síntoma presente: Sí / No"
  });
});

import { buildFieldsFromDetections } from '../src/core/detectFields';
describe('turning detections into fields', () => {
  const naming = {
    page: (n: number) => `Page ${n}`,
    list: (p: number, n: number) => `Page ${p}, list ${n}`,
    checkbox: (n: number) => `Checkbox ${n}`,
    textBox: (n: number) => `Text ${n}`,
    longText: (n: number) => `Long text ${n}`,
    choice: (n: number) => `Choice ${n}`,
    option: (n: number) => `Option ${n}`,
  };
  const cb = (x: number, y: number) => ({ kind: 'checkbox' as const, rect: { x, y, w: 6, h: 6 }, confidence: 0.9 });
  const T = (str: string, x: number, y: number, w = 40) => ({ str, rect: { x, y, w, h: 8 } });
  it('groups a checklist with its notes box and its Sí/No row, labels from text, skips existing', () => {
    const det = [cb(43, 100), cb(43, 114), cb(43, 128), { kind: 'multibox' as const, rect: { x: 60, y: 145, w: 220, h: 38 }, confidence: 0.9 }, cb(118, 230), cb(150, 230), { kind: 'box' as const, rect: { x: 148, y: 49, w: 400, h: 18 }, confidence: 0.9 }];
    const text = [
      T('Ejemplos', 43, 85), T('adulta:', 85, 85),
      T('Comete', 52, 99), T('errores', 85, 99),
      T('Otros', 52, 127),
      T('Síntoma', 40, 229), T('presente:', 75, 229), T('Sí', 127, 229, 8), T('/', 137, 229, 3), T('No', 159, 229, 10),
      T('Nombre', 40, 54), T('del', 75, 54, 14), T('paciente:', 92, 54),
      T('[', 146, 50, 2),
    ];
    const fields = buildFieldsFromDetections(1, det, text, { choiceGroups: true, existing: [], naming });
    const by = (n: string) => fields.find((f) => f.name === n)!;
    expect(by('Comete errores')).toBeTruthy();
    expect(by('Nombre del paciente').type).toBe('text');
    const list = by('Comete errores').group;
    expect(list).toBe('Ejemplos adulta, page 2');
    expect(fields.find((f) => f.type === 'multiline')!.group).toBe(list);
    const yes = by('Síntoma presente: Sí');
    const no = by('Síntoma presente: No');
    expect(yes.type).toBe('radio');
    expect(yes.radioGroup).toBe(no.radioGroup);
    expect(yes.group).toBe(list);
    expect(fields.every((f) => f.source === 'detected' && f.reviewed === false)).toBe(true);
    // second run does not duplicate
    expect(buildFieldsFromDetections(1, det, text, { choiceGroups: true, existing: fields, naming })).toEqual([]);
  });
});
