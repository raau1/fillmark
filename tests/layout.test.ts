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

  it('shrinks long single-line text to fit, wrapping in tiny boxes rather than cutting off', () => {
    const f = createField('text', 0, { x: 0, y: 0, w: 60, h: 14 });
    f.style.fontSize = 10;
    const l = layoutText(f, 'Nombre del paciente', m);
    expect(l.fontSize).toBeLessThan(10);
    expect(l.overflow).toBe(false);
    expect(l.lines[0].width).toBeLessThanOrEqual(60);
    // in a tiny one-line box the answer wraps onto several lines instead of being cut off
    const tiny = layoutText({ ...f, rect: { x: 0, y: 0, w: 20, h: 14 } }, 'Nombre muy largo del paciente con apellidos', m);
    expect(tiny.overflow).toBe(false);
    expect(tiny.lines.length).toBeGreaterThan(1);
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

describe('shrink keeps everything visible', () => {
  it('a long answer in a small notes box shrinks until all of it fits (nothing cut off)', () => {
    const f = createField('multiline', 0, { x: 0, y: 0, w: 225.5, h: 38.5 });
    const text = 'Refiere dificultades de atención desde la infancia, olvida citas y pierde objetos. '.repeat(14).trim();
    const l = layoutText(f, text, m);
    expect(l.overflow).toBe(false);
    expect(l.visibleCount).toBe(l.lines.length);
    expect(l.fontSize).toBeLessThan(4);
    expect(l.small).toBe(true);
    // every word is laid out, in order
    expect(l.lines.map((x) => x.text).join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
    // and the last line still sits inside the box
    const last = l.lines[l.lines.length - 1];
    expect(last.baseline + m.descent(l.family) * l.fontSize).toBeLessThanOrEqual(38.5);
  });

  it('a long one-line answer shrinks to the full width without being cut', () => {
    const f = createField('text', 0, { x: 0, y: 0, w: 403, h: 18 });
    const text = 'María del Carmen Fernández-Villaverde Rodríguez de la Fuente y Sánchez-Ñúñez, nacida en Santiago de Compostela el 3 de marzo';
    const l = layoutText(f, text, m);
    expect(l.overflow).toBe(false);
    expect(l.lines[0].width).toBeLessThanOrEqual(403 - 2 * 2 + 0.01);
    expect(l.lines[0].width).toBeGreaterThan(380); // uses the space: largest size that fits
  });

  it('normal answers are not marked as small', () => {
    const f = createField('text', 0, { x: 0, y: 0, w: 403, h: 18 });
    expect(layoutText(f, 'Ana López', m).small).toBe(false);
  });

  it('only impossible amounts of text (below 1 pt) still overflow', () => {
    const f = createField('multiline', 0, { x: 0, y: 0, w: 40, h: 12 });
    const l = layoutText(f, 'palabra '.repeat(2000), m);
    expect(l.overflow).toBe(true);
  });
});

describe('shrink never cuts text off (sweep)', () => {
  const words = 'cuando era pequeño intentaba esforzarme de alguna manera, sentía que no podía físicamente hacerlo a no ser que hubiera una sensación de urgencia'.split(' ');
  const textOf = (n: number) => Array.from({ length: n }, (_, i) => words[i % words.length]).join(' ');
  it('multi-line boxes of many shapes, line spacings and answer lengths', () => {
    const failures: string[] = [];
    for (const [w, h] of [[225.5, 38.5], [225.5, 33], [190, 30], [300, 50], [120, 60], [400, 18], [60, 80]]) {
      for (const lh of [1, 1.15, 1.5]) {
        for (let n = 1; n < 420; n += 7) {
          const f = createField('multiline', 0, { x: 0, y: 0, w, h });
          f.style.lineHeight = lh;
          const l = layoutText(f, textOf(n), m);
          if (l.overflow || l.visibleCount !== l.lines.length) failures.push(`${w}x${h} lh=${lh} words=${n} size=${l.fontSize}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
  it('one-line boxes', () => {
    const failures: string[] = [];
    for (const [w, h] of [[403, 18], [200, 14], [90, 16]]) {
      for (let n = 1; n < 120; n += 3) {
        const l = layoutText(createField('text', 0, { x: 0, y: 0, w, h }), textOf(n), m);
        if (l.overflow) failures.push(`${w}x${h} words=${n}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('one-line boxes wrap when that reads better', () => {
  it('a very long answer in the name box uses two bigger lines instead of one tiny line', () => {
    const f = createField('text', 0, { x: 0, y: 0, w: 403, h: 18 });
    const text = 'María del Carmen Fernández-Villaverde Rodríguez de la Fuente y Sánchez-Ñúñez, nacida en Santiago de Compostela el 3 de marzo de 1985, hija de Ana y Luis';
    const l = layoutText(f, text, m);
    expect(l.overflow).toBe(false);
    expect(l.lines.length).toBe(2);
    const oneLine = 403 - 4; // width available for a single line
    expect(m.width(l.family, text, l.fontSize)).toBeGreaterThan(oneLine); // would not have fitted on one line at this size
  });
  it('a normal answer stays on one line', () => {
    const l = layoutText(createField('text', 0, { x: 0, y: 0, w: 403, h: 18 }), 'José Ñúñez Güell', m);
    expect(l.lines.length).toBe(1);
  });
});
