import { describe, expect, it, beforeAll } from 'vitest';
import { createMeasurer, type Measurer } from '../src/core/fonts';
import { layoutText, markGeometry, formatDate, displayText, isChecked, valueKey } from '../src/core/layout';
import { createField } from '../src/core/fieldFactory';
import { loadForFontsOnce } from './exportHelpers';

let m: Measurer;
beforeAll(async () => {
  m = await createMeasurer(loadForFontsOnce());
});

describe('text layout', () => {
  it('single line auto size is vertically centred and fits', () => {
    const f = createField('text', 0, { x: 0, y: 0, w: 200, h: 16 });
    const l = layoutText(f, 'María José', m);
    expect(l.fontSize).toBeGreaterThan(8);
    expect(l.fontSize).toBeLessThanOrEqual(11);
    expect(l.overflow).toBe(false);
    const asc = m.ascent(l.family) * l.fontSize;
    const desc = m.descent(l.family) * l.fontSize;
    const top = l.lines[0].baseline - asc;
    const bottom = l.lines[0].baseline + desc;
    expect(top).toBeCloseTo(16 - bottom, 5);
  });

  it('shrinks long single-line text to fit, then reports overflow at the minimum size', () => {
    const f = createField('text', 0, { x: 0, y: 0, w: 60, h: 14 });
    f.style.fontSize = 10;
    const l = layoutText(f, 'Nombre del paciente', m);
    expect(l.fontSize).toBeLessThan(10);
    expect(l.overflow).toBe(false);
    expect(l.lines[0].width).toBeLessThanOrEqual(60);
    const tiny = layoutText({ ...f, rect: { x: 0, y: 0, w: 20, h: 14 } }, 'Nombre muy largo del paciente con apellidos', m);
    expect(tiny.overflow).toBe(true);
  });

  it('fixed mode keeps the size and flags overflow (never silently)', () => {
    const f = createField('text', 0, { x: 0, y: 0, w: 60, h: 14 });
    f.style.fontSize = 10;
    f.style.overflow = 'fixed';
    const l = layoutText(f, 'Nombre muy largo del paciente', m);
    expect(l.fontSize).toBe(10);
    expect(l.overflow).toBe(true);
  });

  it('wraps multiline text inside the box and respects explicit newlines', () => {
    const f = createField('multiline', 0, { x: 0, y: 0, w: 120, h: 80 });
    f.style.fontSize = 9;
    const l = layoutText(f, 'uno dos tres cuatro cinco seis siete ocho nueve diez once doce\nnueva línea', m);
    expect(l.lines.length).toBeGreaterThan(2);
    for (const ln of l.lines) expect(ln.x + ln.width).toBeLessThanOrEqual(120);
    expect(l.lines[l.lines.length - 1].text).toBe('nueva línea');
    expect(l.overflow).toBe(false);
  });

  it('multiline overflow hides lines beyond the box and flags it', () => {
    const f = createField('multiline', 0, { x: 0, y: 0, w: 80, h: 24 });
    f.style.fontSize = 10;
    f.style.overflow = 'fixed';
    const l = layoutText(f, 'a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(3), m);
    expect(l.visibleCount).toBeLessThan(l.lines.length);
    expect(l.overflow).toBe(true);
    for (const ln of l.lines.slice(0, l.visibleCount)) expect(ln.baseline).toBeLessThan(24);
  });

  it('breaks a single very long word', () => {
    const f = createField('multiline', 0, { x: 0, y: 0, w: 50, h: 200 });
    f.style.fontSize = 10;
    const l = layoutText(f, 'supercalifragilisticoespialidoso', m);
    expect(l.lines.length).toBeGreaterThan(1);
    for (const ln of l.lines) expect(ln.width).toBeLessThanOrEqual(50 - 2 * 2 + 0.01);
  });

  it('centre / right alignment', () => {
    const f = createField('text', 0, { x: 0, y: 0, w: 200, h: 16 });
    f.style.fontSize = 10;
    f.style.align = 'center';
    const c = layoutText(f, 'Hola', m).lines[0];
    expect(c.x + c.width / 2).toBeCloseTo(100, 5);
    f.style.align = 'right';
    const r = layoutText(f, 'Hola', m).lines[0];
    expect(r.x + r.width).toBeCloseTo(200 - 2, 5);
  });

  it('falls back to DejaVu for characters outside WinAnsi', () => {
    const f = createField('text', 0, { x: 0, y: 0, w: 200, h: 16 });
    f.style.fontFamily = 'helvetica';
    expect(layoutText(f, 'Muñoz Güell', m).family).toBe('helvetica');
    const l = layoutText(f, 'puntuación ≥ 6', m);
    expect(l.family).toBe('dejavu-sans');
    expect(l.fontSubstituted).toBe(true);
  });
});

describe('check marks', () => {
  it('every mark stays inside the box', () => {
    for (const style of ['check', 'cross', 'fill', 'dot'] as const) {
      for (const [w, h] of [[10, 10], [8, 12], [20, 9]]) {
        const g = markGeometry(style, w, h);
        if (g.kind === 'lines') {
          for (const [x1, y1, x2, y2] of g.segments) {
            for (const [x, y] of [[x1, y1], [x2, y2]]) {
              expect(x - g.stroke / 2).toBeGreaterThanOrEqual(0);
              expect(y - g.stroke / 2).toBeGreaterThanOrEqual(0);
              expect(x + g.stroke / 2).toBeLessThanOrEqual(w);
              expect(y + g.stroke / 2).toBeLessThanOrEqual(h);
            }
          }
        } else if (g.kind === 'rect') {
          expect(g.x).toBeGreaterThan(0);
          expect(g.x + g.w).toBeLessThan(w);
          expect(g.y + g.h).toBeLessThan(h);
        } else {
          expect(g.cx - g.r).toBeGreaterThan(0);
          expect(g.cy + g.r).toBeLessThan(h);
        }
      }
    }
  });
});

describe('values', () => {
  it('formats dates and resolves radio groups', () => {
    expect(formatDate('2026-10-14', 'DD/MM/YYYY')).toBe('14/10/2026');
    expect(formatDate('2026-10-14', 'MM/DD/YYYY')).toBe('10/14/2026');
    expect(formatDate('octubre 2026', 'DD/MM/YYYY')).toBe('octubre 2026');
    const d = createField('date', 0, { x: 0, y: 0, w: 80, h: 16 });
    expect(displayText(d, { [d.id]: '1990-02-03' })).toBe('03/02/1990');
    const a = createField('radio', 0, { x: 0, y: 0, w: 10, h: 10 }, { radioGroup: 'sexo', radioValue: 'H' });
    const b = createField('radio', 0, { x: 0, y: 0, w: 10, h: 10 }, { radioGroup: 'sexo', radioValue: 'M' });
    const vals = { [valueKey(a)]: 'M' };
    expect(valueKey(a)).toBe(valueKey(b));
    expect(isChecked(a, vals)).toBe(false);
    expect(isChecked(b, vals)).toBe(true);
  });
});
