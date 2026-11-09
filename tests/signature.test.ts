import { describe, expect, it } from 'vitest';
import { encodeInk, fitInk, hasSignature, isImageValue, parseInk, strokePath } from '../src/core/signature';

describe('drawn signatures', () => {
  it('are trimmed to the ink with a pen-width margin', () => {
    const v = encodeInk([[{ x: 100, y: 50 }, { x: 160, y: 80 }]], 2)!;
    const s = parseInk(v)!;
    expect(s.w).toBeCloseTo(64, 5);
    expect(s.h).toBeCloseTo(34, 5);
    expect(s.d[0]).toBe('M 2 2 L 62 32');
  });

  it('a tap becomes a dot and long strokes become smooth curves', () => {
    expect(strokePath([{ x: 5, y: 5 }])).toMatch(/^M 5 5 L 5\.1 5$/);
    const d = strokePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }, { x: 30, y: 10 }]);
    expect(d).toBe('M 0 0 Q 10 0 15 5 Q 20 10 25 10 L 30 10');
  });

  it('nothing drawn gives no value', () => {
    expect(encodeInk([], 2)).toBeNull();
    expect(encodeInk([[]], 2)).toBeNull();
  });

  it('rejects damaged or foreign values', () => {
    expect(parseInk('sig:{bad json')).toBeNull();
    expect(parseInk('sig:' + JSON.stringify({ v: 1, w: 10, h: 10, lw: 2, d: ['M 0 0 Z <script>'] }))).toBeNull();
    expect(parseInk('data:image/png;base64,AAAA')).toBeNull();
    expect(hasSignature('')).toBe(false);
    expect(isImageValue('data:image/png;base64,AAAA')).toBe(true);
  });

  it('fits inside the box, centred, keeping its proportions', () => {
    const at = fitInk({ w: 200, h: 50 }, { x: 10, y: 20, w: 102, h: 52 });
    expect(at.scale).toBeCloseTo(0.5, 5);
    expect(at.x).toBeCloseTo(11, 5);
    expect(at.y + at.h / 2).toBeCloseTo(20 + 26, 5);
    expect(at.x + at.w).toBeLessThanOrEqual(10 + 102);
  });
});
