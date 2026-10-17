import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { FontFamily } from './types';

/**
 * Font registry. The DejaVu fonts are bundled with the app (no network), cover
 * Latin-1/Latin Extended (á é í ó ú ñ ü ç € ≥ …) and are embedded (subset) into
 * exported PDFs. The 14 standard PDF fonts only support WinAnsi; if a value
 * contains characters they cannot encode, layout falls back to DejaVu Sans and
 * reports it.
 */
export interface FontDef {
  id: FontFamily;
  label: string;
  standard?: StandardFonts;
  file?: 'DejaVuSans.ttf' | 'DejaVuSansCondensed.ttf' | 'DejaVuSerif.ttf';
  /** CSS font-family used for the on-screen overlay */
  css: string;
}

export const FONTS: Record<FontFamily, FontDef> = {
  'dejavu-sans': { id: 'dejavu-sans', label: 'Sans (DejaVu)', file: 'DejaVuSans.ttf', css: "'PFF DejaVu Sans', sans-serif" },
  'dejavu-sans-condensed': {
    id: 'dejavu-sans-condensed',
    label: 'Sans condensed (DejaVu)',
    file: 'DejaVuSansCondensed.ttf',
    css: "'PFF DejaVu Sans Condensed', sans-serif",
  },
  'dejavu-serif': { id: 'dejavu-serif', label: 'Serif (DejaVu)', file: 'DejaVuSerif.ttf', css: "'PFF DejaVu Serif', serif" },
  helvetica: { id: 'helvetica', label: 'Helvetica (PDF standard)', standard: StandardFonts.Helvetica, css: 'Helvetica, Arial, sans-serif' },
  times: { id: 'times', label: 'Times (PDF standard)', standard: StandardFonts.TimesRoman, css: "'Times New Roman', Times, serif" },
  courier: { id: 'courier', label: 'Courier (PDF standard)', standard: StandardFonts.Courier, css: "'Courier New', Courier, monospace" },
};

export const FONT_LIST: FontDef[] = Object.values(FONTS);
export const FALLBACK_FONT: FontFamily = 'dejavu-sans';

/** Raw bytes for the bundled TrueType fonts, keyed by file name. */
export type FontFiles = Partial<Record<NonNullable<FontDef['file']>, Uint8Array>>;

export async function embedFamily(doc: PDFDocument, family: FontFamily, files: FontFiles, subset: boolean): Promise<PDFFont> {
  const def = FONTS[family];
  if (def.standard) return doc.embedFont(def.standard);
  const bytes = def.file ? files[def.file] : undefined;
  if (!bytes) throw new Error(`Font file for "${def.label}" is not loaded`);
  doc.registerFontkit(fontkit);
  return doc.embedFont(bytes, { subset });
}

/**
 * Text measurement shared by the on-screen overlay and the PDF export, so
 * that line breaks, auto-sizing and alignment are identical in both.
 */
export interface Measurer {
  width(family: FontFamily, text: string, size: number): number;
  canEncode(family: FontFamily, text: string): boolean;
  /**
   * Cap height above the baseline, per 1pt of font size. Text is vertically
   * centred on the band [cap height, descender], which looks centred for every
   * font (font "ascent" values vary wildly, e.g. DejaVu reserves room for accents).
   */
  ascent(family: FontFamily): number;
  /** descender depth below the baseline (positive), per 1pt of font size */
  descent(family: FontFamily): number;
  has(family: FontFamily): boolean;
}

export function measurerFromFonts(fonts: Partial<Record<FontFamily, PDFFont>>): Measurer {
  const charsets = new Map<FontFamily, Set<number>>();
  const widthCache = new Map<string, number>();
  const get = (f: FontFamily) => {
    const font = fonts[f];
    if (!font) throw new Error(`Font ${f} not available`);
    return font;
  };
  const charset = (f: FontFamily) => {
    let s = charsets.get(f);
    if (!s) {
      s = new Set(get(f).getCharacterSet());
      charsets.set(f, s);
    }
    return s;
  };
  return {
    has: (f) => Boolean(fonts[f]),
    width(f, text, size) {
      if (!text) return 0;
      const key = f + '\u0000' + text;
      let w1 = widthCache.get(key);
      if (w1 === undefined) {
        w1 = get(f).widthOfTextAtSize(text, 1);
        if (widthCache.size > 20000) widthCache.clear();
        widthCache.set(key, w1);
      }
      return w1 * size;
    },
    canEncode(f, text) {
      const s = charset(f);
      for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (cp === 10 || cp === 13) continue;
        if (!s.has(cp)) return false;
      }
      return true;
    },
    ascent(f) {
      return fontMetrics(get(f)).capHeight;
    },
    descent(f) {
      return fontMetrics(get(f)).descent;
    },
  };
}

const metricsCache = new WeakMap<PDFFont, { capHeight: number; descent: number }>();
/** Reads cap height / descender from the underlying font program (pdf-lib internals, stable in 1.17). */
function fontMetrics(font: PDFFont): { capHeight: number; descent: number } {
  const hit = metricsCache.get(font);
  if (hit) return hit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = (font as any).embedder?.font;
  let capHeight = 0.72;
  let descent = 0.22;
  if (inner && typeof inner.unitsPerEm === 'number') {
    // fontkit font
    const upm = inner.unitsPerEm;
    capHeight = (inner.capHeight || inner['OS/2']?.capHeight || 0.72 * upm) / upm;
    descent = Math.abs(inner.descent ?? -0.22 * upm) / upm;
  } else if (inner && typeof inner.CapHeight === 'number') {
    // standard 14 font (AFM metrics, 1000 units)
    capHeight = inner.CapHeight / 1000;
    descent = Math.abs(inner.Descender ?? -220) / 1000;
  } else if (inner && typeof inner.Ascender === 'number') {
    capHeight = (inner.Ascender * 0.95) / 1000;
    descent = Math.abs(inner.Descender ?? -220) / 1000;
  }
  const r = { capHeight, descent };
  metricsCache.set(font, r);
  return r;
}

/** Builds a measurer backed by a throwaway in-memory PDF (used by the UI). */
export async function createMeasurer(files: FontFiles): Promise<Measurer> {
  const doc = await PDFDocument.create();
  const fonts: Partial<Record<FontFamily, PDFFont>> = {};
  for (const def of FONT_LIST) {
    if (def.file && !files[def.file]) continue;
    fonts[def.id] = await embedFamily(doc, def.id, files, false);
  }
  return measurerFromFonts(fonts);
}

/** Replace characters no available font can encode, so export never crashes. */
export function sanitizeForFont(m: Measurer, family: FontFamily, text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\n' || m.canEncode(family, ch)) out += ch;
    else out += '?';
  }
  return out;
}
