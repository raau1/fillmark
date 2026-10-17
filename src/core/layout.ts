import { FALLBACK_FONT, sanitizeForFont, type Measurer } from './fonts';
import type { CheckStyle, DateFormat, Field, FieldValue, FontFamily, Rect, Values } from './types';

/**
 * Single source of truth for where text and marks go inside a field.
 * All coordinates are field-local display points (origin = field's top-left,
 * y down). The overlay renders these lines as SVG; the exporter draws exactly
 * the same lines into the PDF.
 */

export const MIN_FONT_SIZE = 4;
export const AUTO_MAX_SINGLE = 11;
export const AUTO_MAX_MULTI = 10;

export interface LaidLine {
  text: string;
  x: number;
  baseline: number;
  width: number;
}

export interface TextLayout {
  family: FontFamily;
  fontSize: number;
  lines: LaidLine[];
  /** lines that fit inside the box; lines beyond this are NOT drawn */
  visibleCount: number;
  /** true when the text does not fully fit (clipped horizontally or vertically) */
  overflow: boolean;
  fontSubstituted: boolean;
  charactersReplaced: boolean;
}

export function isMultilineType(t: Field['type']): boolean {
  return t === 'multiline' || t === 'label';
}

export function isTextType(t: Field['type']): boolean {
  return t === 'text' || t === 'multiline' || t === 'date' || t === 'number' || t === 'dropdown' || t === 'label';
}

export function padding(rect: Rect, multiline: boolean) {
  const px = Math.min(2, rect.w * 0.08);
  const py = multiline ? Math.min(2, rect.h * 0.08) : Math.min(1, rect.h * 0.06);
  return { px, py };
}

function wrapParagraph(m: Measurer, family: FontFamily, size: number, para: string, maxW: number): string[] {
  if (para === '') return [''];
  const tokens = para.split(/(\s+)/).filter((t) => t.length > 0);
  const lines: string[] = [];
  let cur = '';
  const pushLongWord = (word: string) => {
    // break a single word that is wider than the box, character by character
    let chunk = '';
    for (const ch of word) {
      if (chunk && m.width(family, chunk + ch, size) > maxW) {
        lines.push(chunk);
        chunk = ch;
      } else chunk += ch;
    }
    return chunk;
  };
  for (const tok of tokens) {
    const isSpace = /^\s+$/.test(tok);
    const candidate = cur + tok;
    if (m.width(family, candidate.trimEnd(), size) <= maxW) {
      cur = candidate;
      continue;
    }
    if (isSpace) {
      // spaces at a break are dropped
      lines.push(cur.trimEnd());
      cur = '';
      continue;
    }
    if (cur.trim()) lines.push(cur.trimEnd());
    cur = m.width(family, tok, size) > maxW ? pushLongWord(tok) : tok;
  }
  lines.push(cur.trimEnd());
  return lines;
}

function resolveFamily(m: Measurer, family: FontFamily, text: string) {
  if (m.has(family) && m.canEncode(family, text)) return { family, text, fontSubstituted: false, charactersReplaced: false };
  const fb = m.has(FALLBACK_FONT) ? FALLBACK_FONT : family;
  if (m.canEncode(fb, text)) return { family: fb, text, fontSubstituted: fb !== family, charactersReplaced: false };
  return { family: fb, text: sanitizeForFont(m, fb, text), fontSubstituted: fb !== family, charactersReplaced: true };
}

export function layoutText(
  field: Pick<Field, 'type' | 'rect' | 'style'>,
  rawText: string,
  m: Measurer,
): TextLayout {
  const { rect, style } = field;
  const multiline = isMultilineType(field.type);
  const src = multiline ? rawText.replace(/\r\n?/g, '\n') : rawText.replace(/[\r\n]+/g, ' ');
  const r = resolveFamily(m, style.fontFamily, src);
  const family = r.family;
  const text = r.text;
  const asc = m.ascent(family);
  const desc = m.descent(family);
  const { px, py } = padding(rect, multiline);
  const availW = Math.max(1, rect.w - 2 * px);
  const availH = Math.max(1, rect.h - 2 * py);
  const lhFactor = Math.max(0.8, style.lineHeight || 1.15);
  const auto = !style.fontSize || style.fontSize <= 0;
  const canShrink = auto || style.overflow === 'shrink';

  let size: number;
  if (auto) {
    size = multiline
      ? Math.min(AUTO_MAX_MULTI, availH / lhFactor)
      : Math.min(AUTO_MAX_SINGLE, availH / (asc + desc));
    size = Math.max(MIN_FONT_SIZE, Math.floor(size * 2) / 2);
  } else size = style.fontSize;

  const build = (fs: number) => {
    if (!multiline) {
      const w = m.width(family, text, fs);
      return { lineTexts: [text], fits: w <= availW + 0.01 && (asc + desc) * fs <= availH + 0.5 };
    }
    const lineTexts = text.split('\n').flatMap((p) => wrapParagraph(m, family, fs, p, availW));
    const lineH = fs * lhFactor;
    const totalH = (lineTexts.length - 1) * lineH + (asc + desc) * fs;
    const widthOk = lineTexts.every((l) => m.width(family, l, fs) <= availW + 0.01);
    return { lineTexts, fits: totalH <= availH + 0.5 && widthOk };
  };

  let res = build(size);
  if (!res.fits && canShrink && text.length > 0) {
    while (!res.fits && size > MIN_FONT_SIZE) {
      size = Math.max(MIN_FONT_SIZE, Math.round((size - 0.25) * 4) / 4);
      res = build(size);
    }
  }

  const lines: LaidLine[] = [];
  let visibleCount = 0;
  if (!multiline) {
    const t = res.lineTexts[0];
    const w = m.width(family, t, size);
    const contentH = (asc + desc) * size;
    const baseline = (rect.h - contentH) / 2 + asc * size;
    lines.push({ text: t, width: w, x: alignX(style.align, rect.w, px, w), baseline });
    visibleCount = 1;
  } else {
    const lineH = size * lhFactor;
    const first = py + (lineH - (asc + desc) * size) / 2 + asc * size;
    res.lineTexts.forEach((t, i) => {
      const w = m.width(family, t, size);
      const baseline = first + i * lineH;
      lines.push({ text: t, width: w, x: alignX(style.align, rect.w, px, w), baseline });
      if (baseline + desc * size <= rect.h - py + 0.75) visibleCount = i + 1;
    });
  }
  const overflowH = lines.some((l) => l.width > availW + 0.01);
  const overflow = text.length > 0 && (overflowH || visibleCount < lines.length || !res.fits);
  return {
    family,
    fontSize: size,
    lines,
    visibleCount,
    overflow,
    fontSubstituted: r.fontSubstituted,
    charactersReplaced: r.charactersReplaced,
  };
}

function alignX(align: Field['style']['align'], w: number, px: number, lineW: number) {
  if (align === 'center') return (w - lineW) / 2;
  if (align === 'right') return w - px - lineW;
  return px;
}

// ---------------------------------------------------------------------------
// Check marks

export type Mark =
  | { kind: 'lines'; segments: [number, number, number, number][]; stroke: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'circle'; cx: number; cy: number; r: number };

/** Geometry of a check mark, field-local display coordinates. Fits inside the box. */
export function markGeometry(style: CheckStyle, w: number, h: number): Mark {
  const s = Math.min(w, h);
  const ox = (w - s) / 2;
  const oy = (h - s) / 2;
  if (style === 'fill') {
    const inset = s * 0.18;
    return { kind: 'rect', x: ox + inset, y: oy + inset, w: s - 2 * inset, h: s - 2 * inset };
  }
  if (style === 'dot') {
    return { kind: 'circle', cx: w / 2, cy: h / 2, r: s * 0.28 };
  }
  const stroke = Math.max(0.6, s * (style === 'check' ? 0.14 : 0.12));
  const inset = s * 0.16 + stroke / 2;
  const q = s - 2 * inset;
  const P = (fx: number, fy: number): [number, number] => [ox + inset + fx * q, oy + inset + fy * q];
  if (style === 'cross') {
    const a = P(0, 0), b = P(1, 1), c = P(0, 1), d = P(1, 0);
    return { kind: 'lines', stroke, segments: [[...a, ...b], [...c, ...d]] };
  }
  const a = P(0.02, 0.55), b = P(0.38, 0.9), c = P(0.98, 0.08);
  return { kind: 'lines', stroke, segments: [[...a, ...b], [...b, ...c]] };
}

// ---------------------------------------------------------------------------
// Values

export function valueKey(f: Pick<Field, 'id' | 'type' | 'radioGroup'>): string {
  return f.type === 'radio' ? `radio:${f.radioGroup || f.id}` : f.id;
}

export function effectiveValue(f: Field, values: Values): FieldValue | undefined {
  const v = values[valueKey(f)];
  if (v !== undefined) return v;
  if (f.type === 'checkbox') return f.defaultValue === 'true';
  if (f.type === 'radio') return f.defaultValue === 'true' ? f.radioValue : undefined;
  return f.defaultValue || undefined;
}

export function isChecked(f: Field, values: Values): boolean {
  const v = effectiveValue(f, values);
  if (f.type === 'checkbox') return v === true;
  if (f.type === 'radio') return v !== undefined && v === f.radioValue;
  return false;
}

export function formatDate(iso: string, fmt: DateFormat): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso; // free text dates are kept as typed
  const [, Y, M, D] = m;
  switch (fmt) {
    case 'DD/MM/YYYY':
      return `${D}/${M}/${Y}`;
    case 'MM/DD/YYYY':
      return `${M}/${D}/${Y}`;
    case 'DD-MM-YYYY':
      return `${D}-${M}-${Y}`;
    case 'DD.MM.YYYY':
      return `${D}.${M}.${Y}`;
    default:
      return `${Y}-${M}-${D}`;
  }
}

/** The string that will be printed for a text-like field. */
export function displayText(f: Field, values: Values): string {
  if (f.type === 'label') return f.defaultValue;
  const v = effectiveValue(f, values);
  if (typeof v !== 'string') return '';
  if (f.type === 'date') return formatDate(v, f.style.dateFormat);
  return v;
}
