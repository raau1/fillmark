import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { importAcroForm, probeWritable } from '../src/core/acroform';
import { exportPdf } from '../src/core/exportPdf';
import { valueKey } from '../src/core/layout';
import { bboxOf, isRed, loadForFontsOnce, rasterizeAt } from './exportHelpers';

async function makeForm() {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([595, 842]);
  const p2 = doc.addPage([595, 842]);
  p2.setRotation(degrees(90));
  const form = doc.getForm();
  const name = form.createTextField('paciente.nombre');
  name.setText('Ana');
  name.addToPage(p1, { x: 100, y: 700, width: 200, height: 20, borderWidth: 0 });
  const sex = form.createRadioGroup('sexo');
  sex.addOptionToPage('H', p1, { x: 100, y: 650, width: 12, height: 12, borderWidth: 0 });
  sex.addOptionToPage('M', p1, { x: 140, y: 650, width: 12, height: 12, borderWidth: 0 });
  sex.select('M');
  const cb = form.createCheckBox('consentimiento');
  cb.addToPage(p1, { x: 100, y: 600, width: 12, height: 12, borderWidth: 0 });
  cb.check();
  const dd = form.createDropdown('centro');
  dd.addOptions(['Barcelona', 'Madrid']);
  dd.select('Madrid');
  dd.addToPage(p1, { x: 100, y: 550, width: 120, height: 18, borderWidth: 0 });
  const notes = form.createTextField('notas');
  notes.enableMultiline();
  notes.addToPage(p2, { x: 100, y: 100, width: 60, height: 300, borderWidth: 0 });
  return doc.save();
}

describe('AcroForm import', () => {
  it('imports fields, positions and values', async () => {
    const bytes = await makeForm();
    const probe = await probeWritable(bytes);
    expect(probe.fieldCount).toBe(5);
    expect(probe.encrypted).toBe(false);

    const { fields, values, skipped } = await importAcroForm(bytes);
    expect(skipped).toEqual([]);
    const byName = (n: string) => fields.filter((f) => f.sourceName === n);

    const name = byName('paciente.nombre')[0];
    expect(name.type).toBe('text');
    expect(name.name).toBe('nombre');
    // pdf y=700..720 on an 842pt page → display y = 122..142
    expect(name.rect.x).toBeCloseTo(100);
    expect(name.rect.y).toBeCloseTo(122);
    expect(name.rect.w).toBeCloseTo(200);
    expect(name.rect.h).toBeCloseTo(20);
    expect(values[name.id]).toBe('Ana');

    const radios = byName('sexo');
    expect(radios.map((r) => r.radioValue).sort()).toEqual(['H', 'M']);
    expect(values[valueKey(radios[0])]).toBe('M');

    expect(values[byName('consentimiento')[0].id]).toBe(true);
    const dd = byName('centro')[0];
    expect(dd.type).toBe('dropdown');
    expect(dd.options).toEqual(['Barcelona', 'Madrid']);
    expect(values[dd.id]).toBe('Madrid');

    // rotated page: a tall narrow PDF rect becomes wide & short on screen
    const notes = byName('notas')[0];
    expect(notes.type).toBe('multiline');
    expect(notes.page).toBe(1);
    expect(notes.rect.w).toBeCloseTo(300);
    expect(notes.rect.h).toBeCloseTo(60);
    expect(notes.rect.x).toBeCloseTo(100); // u = y - y0
    expect(notes.rect.y).toBeCloseTo(100); // v = x - x0
  });

  it('export replaces the original fields instead of duplicating them', async () => {
    const bytes = await makeForm();
    const { fields, values } = await importAcroForm(bytes);
    const notes = fields.find((f) => f.sourceName === 'notas')!;
    notes.style.color = '#ff0000';
    notes.style.fontSize = 10;
    values[notes.id] = 'Observación clínica';
    const fontFiles = loadForFontsOnce();

    const flat = await exportPdf(bytes, fields, values, { mode: 'flatten', fontFiles });
    if (process.env.PFF_DUMP) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(process.env.PFF_DUMP + '/acro-flat.pdf', flat.bytes);
      writeFileSync(process.env.PFF_DUMP + '/acro-src.pdf', bytes);
    }
    // no dangling references left behind by field removal (poppler reports them on stderr)
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
    const dir = mkdtempSync('/tmp/pff-');
    wf(dir + '/f.pdf', flat.bytes);
    expect(spawnSync('pdfinfo', [dir + '/f.pdf']).stderr.toString()).toBe('');
    const out = await PDFDocument.load(flat.bytes);
    expect(out.catalog.getAcroForm() ? out.getForm().getFields().length : 0).toBe(0);
    const r = rasterizeAt(flat.bytes, 1);
    const ink = bboxOf(r, isRed, notes.rect, 2)!;
    expect(ink).not.toBeNull();
    expect(ink.x0).toBeGreaterThanOrEqual(notes.rect.x);
    expect(ink.y0).toBeGreaterThanOrEqual(notes.rect.y);

    const ed = await exportPdf(bytes, fields, values, { mode: 'editable', fontFiles });
    const out2 = await PDFDocument.load(ed.bytes);
    const names = out2.getForm().getFields().map((f) => f.getName());
    expect(names.length).toBe(new Set(names).size);
    expect(names).not.toContain('paciente.nombre');
    expect(names.length).toBe(5);
  });
});
