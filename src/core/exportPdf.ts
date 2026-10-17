import {
  PDFDocument,
  EncryptedPDFError,
  LineCapStyle,
  TextAlignment,
  clip,
  degrees,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  adjustDimsForRotation,
  beginMarkedContent,
  endMarkedContent,
  drawEllipse as opEllipse,
  drawLine as opLine,
  drawRectangle as opRectangle,
  drawText as opText,
  reduceRotation,
  rotateInPlace,
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  type PDFOperator,
  type PDFWidgetAnnotation,
  type PDFFont,
  type PDFPage,
  type PDFForm,
  type RGB,
} from 'pdf-lib';
import { displayRectToPdf, displayToPdf, makePageInfo } from './coords';
import { embedFamily, measurerFromFonts, FONTS, FALLBACK_FONT, type FontFiles } from './fonts';
import { displayText, isChecked, isTextType, layoutText, markGeometry, valueKey, type TextLayout } from './layout';
import type { Field, FontFamily, PageInfo, Rect, Values } from './types';

export type ExportMode = 'flatten' | 'editable';

export interface ExportOptions {
  mode: ExportMode;
  fontFiles: FontFiles;
  /** page geometry the fields were authored against (from pdf.js); used to detect mismatches */
  expectedPages?: PageInfo[];
}

export interface ExportResult {
  bytes: Uint8Array;
  warnings: string[];
}

export class PdfLoadError extends Error {
  code: 'encrypted' | 'corrupt';
  constructor(code: 'encrypted' | 'corrupt', message: string) {
    super(message);
    this.code = code;
  }
}

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export async function loadForWrite(bytes: Uint8Array | ArrayBuffer): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError || /encrypt/i.test(String((e as Error)?.message))) {
      throw new PdfLoadError(
        'encrypted',
        'This PDF is encrypted (password-protected or with editing restrictions). It cannot be modified here. Remove the protection first (for example with “qpdf --decrypt in.pdf out.pdf”) and upload the unprotected copy.',
      );
    }
    throw new PdfLoadError('corrupt', `The PDF could not be read for export: ${(e as Error)?.message ?? e}`);
  }
}

/** Page geometry as pdf-lib sees it (CropBox ∩ MediaBox, /Rotate). */
export function pageInfoFromPdfLib(page: PDFPage): PageInfo {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const x0 = Math.max(media.x, crop.x);
  const y0 = Math.max(media.y, crop.y);
  const x1 = Math.min(media.x + media.width, crop.x + crop.width);
  const y1 = Math.min(media.y + media.height, crop.y + crop.height);
  const box: [number, number, number, number] = x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : [media.x, media.y, media.x + media.width, media.y + media.height];
  return makePageInfo(box, page.getRotation().angle);
}

function safeFieldName(base: string, used: Set<string>): string {
  let n = base.replace(/[.\s/\\()[\]<>{}%#]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'field';
  let k = n;
  let i = 2;
  while (used.has(k)) k = `${n}_${i++}`;
  used.add(k);
  return k;
}

/** Clip subsequent drawing to a display rect (axis-aligned in PDF space for 90° multiples). */
function withClip(page: PDFPage, info: PageInfo, r: Rect, draw: () => void) {
  const pr = displayRectToPdf(info, r);
  page.pushOperators(pushGraphicsState(), rectangle(pr.x, pr.y, pr.width, pr.height), clip(), endPath());
  try {
    draw();
  } finally {
    page.pushOperators(popGraphicsState());
  }
}

function drawDecoration(page: PDFPage, info: PageInfo, f: Field) {
  const { rect, style } = f;
  if (!style.background && !style.border) return;
  const a = displayToPdf(info, rect.x, rect.y + rect.h); // upright bottom-left corner
  page.drawRectangle({
    x: a.x,
    y: a.y,
    width: rect.w,
    height: rect.h,
    rotate: degrees(info.rotation),
    color: style.background ? hexToRgb(style.background) : undefined,
    opacity: style.background ? style.backgroundOpacity : undefined,
    borderColor: style.border ? hexToRgb(style.borderColor) : undefined,
    borderWidth: style.border ? style.borderWidth : 0,
  });
}

function drawMark(page: PDFPage, info: PageInfo, f: Field) {
  const g = markGeometry(f.style.checkStyle, f.rect.w, f.rect.h);
  const color = hexToRgb(f.style.color);
  const P = (u: number, v: number) => displayToPdf(info, f.rect.x + u, f.rect.y + v);
  if (g.kind === 'lines') {
    for (const [x1, y1, x2, y2] of g.segments) {
      page.drawLine({ start: P(x1, y1), end: P(x2, y2), thickness: g.stroke, color, lineCap: LineCapStyle.Round });
    }
  } else if (g.kind === 'rect') {
    const a = P(g.x, g.y + g.h);
    page.drawRectangle({ x: a.x, y: a.y, width: g.w, height: g.h, rotate: degrees(info.rotation), color });
  } else {
    const c = P(g.cx, g.cy);
    page.drawEllipse({ x: c.x, y: c.y, xScale: g.r, yScale: g.r, color });
  }
}

// ---------------------------------------------------------------------------
// Appearance streams for the editable (non-flattened) export. They use the same
// geometry as the flattened output so the editable PDF looks like the preview.

function widgetFrame(widget: PDFWidgetAnnotation) {
  const rect = widget.getRectangle();
  const rotation = reduceRotation(widget.getAppearanceCharacteristics()?.getRotation());
  const { width, height } = adjustDimsForRotation(rect, rotation);
  return { width, height, pre: rotateInPlace({ ...rect, rotation }) };
}

function markOperators(f: Field, width: number, height: number): PDFOperator[] {
  const g = markGeometry(f.style.checkStyle, width, height);
  const color = hexToRgb(f.style.color);
  // geometry is y-down; appearance space is y-up
  if (g.kind === 'lines') {
    return g.segments.flatMap(([x1, y1, x2, y2]) =>
      opLine({ start: { x: x1, y: height - y1 }, end: { x: x2, y: height - y2 }, thickness: g.stroke, color, lineCap: LineCapStyle.Round }),
    );
  }
  if (g.kind === 'rect') {
    return opRectangle({ x: g.x, y: height - g.y - g.h, width: g.w, height: g.h, color, borderColor: undefined, borderWidth: 0, rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0) });
  }
  return opEllipse({ x: g.cx, y: height - g.cy, xScale: g.r, yScale: g.r, color, borderColor: undefined, borderWidth: 0 });
}

function toggleAppearance(f: Field) {
  return (_field: unknown, widget: PDFWidgetAnnotation) => {
    const { width, height, pre } = widgetFrame(widget);
    return { normal: { on: [...pre, ...markOperators(f, width, height)], off: [...pre] } };
  };
}

function textAppearance(f: Field, lay: TextLayout) {
  return (_field: unknown, widget: PDFWidgetAnnotation, font: PDFFont) => {
    const { width, height, pre } = widgetFrame(widget);
    const color = hexToRgb(f.style.color);
    const ops: PDFOperator[] = [...pre, beginMarkedContent('Tx'), pushGraphicsState(), rectangle(0, 0, width, height), clip(), endPath()];
    for (const ln of lay.lines.slice(0, lay.visibleCount)) {
      if (!ln.text) continue;
      ops.push(
        ...opText(font.encodeText(ln.text), {
          x: ln.x,
          y: height - ln.baseline,
          font: font.name,
          size: lay.fontSize,
          color,
          rotate: degrees(0),
          xSkew: degrees(0),
          ySkew: degrees(0),
        }),
      );
    }
    ops.push(popGraphicsState(), endMarkedContent());
    return ops;
  };
}

function decodeDataUrl(url: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:(image\/(?:png|jpeg));base64,(.*)$/s.exec(url);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: m[1] };
}

async function drawSignature(doc: PDFDocument, page: PDFPage, info: PageInfo, f: Field, dataUrl: string, warnings: string[]) {
  const d = decodeDataUrl(dataUrl);
  if (!d) {
    warnings.push(`Signature “${f.name}” could not be decoded and was skipped.`);
    return;
  }
  const img = d.mime === 'image/png' ? await doc.embedPng(d.bytes) : await doc.embedJpg(d.bytes);
  const pad = 1;
  const bw = f.rect.w - 2 * pad, bh = f.rect.h - 2 * pad;
  const k = Math.min(bw / img.width, bh / img.height);
  const w = img.width * k, h = img.height * k;
  const u = f.rect.x + pad + (bw - w) / 2;
  const v = f.rect.y + pad + (bh - h) / 2;
  const a = displayToPdf(info, u, v + h);
  page.drawImage(img, { x: a.x, y: a.y, width: w, height: h, rotate: degrees(info.rotation) });
}

function removeImportedOriginals(form: PDFForm, fields: Field[], warnings: string[]) {
  const names = new Set(fields.filter((f) => f.sourceName).map((f) => f.sourceName!));
  for (const name of names) {
    try {
      const fld = form.getFieldMaybe(name);
      if (fld) form.removeField(fld);
    } catch (e) {
      warnings.push(`Original form field “${name}” could not be removed (${(e as Error).message}); it may appear twice.`);
    }
  }
}

/**
 * pdf-lib's removeField/flatten can leave references to deleted widget objects
 * in page /Annots and in /Kids arrays, which some viewers report as damage.
 * Remove every reference that no longer resolves.
 */
export function pruneDanglingRefs(doc: PDFDocument) {
  const ctx = doc.context;
  const dead = (o: unknown) => o instanceof PDFRef && ctx.lookup(o) === undefined;
  const pruneArray = (arr: PDFArray | undefined) => {
    if (!arr) return;
    for (let i = arr.size() - 1; i >= 0; i--) if (dead(arr.get(i))) arr.remove(i);
  };
  for (const page of doc.getPages()) {
    pruneArray(page.node.lookupMaybe(PDFName.of('Annots'), PDFArray));
  }
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acro) return;
  const seen = new Set<PDFDict>();
  const walk = (arr: PDFArray | undefined) => {
    if (!arr) return;
    pruneArray(arr);
    for (let i = 0; i < arr.size(); i++) {
      const d = arr.lookupMaybe(i, PDFDict);
      if (!d || seen.has(d)) continue;
      seen.add(d);
      walk(d.lookupMaybe(PDFName.of('Kids'), PDFArray));
    }
  };
  walk(acro.lookupMaybe(PDFName.of('Fields'), PDFArray));
}

export async function exportPdf(
  pdfBytes: Uint8Array | ArrayBuffer,
  fields: Field[],
  values: Values,
  opts: ExportOptions,
): Promise<ExportResult> {
  const warnings: string[] = [];
  const doc = await loadForWrite(pdfBytes);
  const pages = doc.getPages();
  const infos = pages.map(pageInfoFromPdfLib);

  if (opts.expectedPages) {
    opts.expectedPages.forEach((e, i) => {
      const a = infos[i];
      if (!a) return;
      const off = Math.max(...e.box.map((v, k) => Math.abs(v - a.box[k])));
      if (off > 0.5 || e.rotation !== a.rotation) {
        warnings.push(`Page ${i + 1}: page geometry differs between renderer and writer (offset ${off.toFixed(1)} pt). Positions on this page may be inaccurate.`);
      }
    });
  }

  // Existing AcroForm handling
  const hasAcroForm = Boolean(doc.catalog.getAcroForm());
  if (hasAcroForm) {
    const form = doc.getForm();
    removeImportedOriginals(form, fields, warnings);
    if (opts.mode === 'flatten') {
      try {
        if (form.getFields().length) form.flatten({ updateFieldAppearances: false });
      } catch (e) {
        warnings.push(`Some original interactive fields could not be flattened (${(e as Error).message}). They are left interactive.`);
      }
    }
  }

  // Fonts actually needed
  const valid = fields.filter((f) => {
    if (f.page < 0 || f.page >= pages.length) {
      warnings.push(`Field “${f.name}” refers to page ${f.page + 1}, which does not exist; skipped.`);
      return false;
    }
    return true;
  });
  const families = new Set<FontFamily>([FALLBACK_FONT]);
  for (const f of valid) if (isTextType(f.type)) families.add(f.style.fontFamily);
  const fonts: Partial<Record<FontFamily, PDFFont>> = {};
  for (const fam of families) {
    try {
      fonts[fam] = await embedFamily(doc, fam, opts.fontFiles, true);
    } catch (e) {
      warnings.push(`Font “${FONTS[fam].label}” could not be embedded (${(e as Error).message}).`);
    }
  }
  const m = measurerFromFonts(fonts);

  const form = opts.mode === 'editable' ? doc.getForm() : null;
  const usedNames = new Set<string>(form ? form.getFields().map((f) => f.getName()) : []);
  const radioGroups = new Map<string, ReturnType<PDFForm['createRadioGroup']>>();

  for (const f of valid) {
    const page = pages[f.page];
    const info = infos[f.page];
    drawDecoration(page, info, f);

    const editableHere = form && f.type !== 'label' && f.type !== 'signature';

    if (isTextType(f.type)) {
      const text = displayText(f, values);
      const fam = m.has(f.style.fontFamily) ? f.style.fontFamily : FALLBACK_FONT;
      const lay = layoutText({ ...f, style: { ...f.style, fontFamily: fam } }, text, m);
      if (text && lay.overflow) warnings.push(`“${f.name}” (page ${f.page + 1}): text does not fit in the box; ${lay.visibleCount < lay.lines.length ? `${lay.lines.length - lay.visibleCount} line(s) are cut off` : 'the end is cut off'}.`);
      if (lay.fontSubstituted) warnings.push(`“${f.name}”: ${FONTS[f.style.fontFamily].label} cannot show some characters; DejaVu Sans was used instead.`);
      if (lay.charactersReplaced) warnings.push(`“${f.name}”: some characters are not supported by the embedded font and were replaced with “?”.`);
      const font = fonts[lay.family]!;
      const color = hexToRgb(f.style.color);

      if (editableHere && form) {
        const pr = displayToPdf(info, f.rect.x, f.rect.y + f.rect.h);
        const common = {
          x: pr.x,
          y: pr.y,
          width: f.rect.w,
          height: f.rect.h,
          rotate: degrees(info.rotation),
          borderWidth: 0,
          backgroundColor: undefined,
          borderColor: undefined,
          textColor: color,
          font,
        };
        const name = safeFieldName(f.name || f.id, usedNames);
        if (f.type === 'dropdown') {
          const dd = form.createDropdown(name);
          const opts2 = f.options.length ? f.options : [];
          if (opts2.length) dd.addOptions(opts2);
          dd.enableEditing();
          if (text) dd.select(text, !opts2.includes(text));
          dd.addToPage(page, common);
          dd.setFontSize(lay.fontSize);
          dd.updateAppearances(font, textAppearance(f, lay));
        } else {
          const tf = form.createTextField(name);
          if (f.type === 'multiline' || lay.lines.length > 1) tf.enableMultiline();
          tf.setAlignment(f.style.align === 'center' ? TextAlignment.Center : f.style.align === 'right' ? TextAlignment.Right : TextAlignment.Left);
          if (text) tf.setText(text);
          if (f.required) tf.enableRequired();
          tf.addToPage(page, common);
          tf.setFontSize(lay.fontSize);
          tf.updateAppearances(font, textAppearance(f, lay));
        }
        continue;
      }

      withClip(page, info, f.rect, () => {
        lay.lines.slice(0, lay.visibleCount).forEach((ln) => {
          if (!ln.text) return;
          const a = displayToPdf(info, f.rect.x + ln.x, f.rect.y + ln.baseline);
          page.drawText(ln.text, { x: a.x, y: a.y, size: lay.fontSize, font, color, rotate: degrees(info.rotation) });
        });
      });
      continue;
    }

    if (f.type === 'checkbox' || f.type === 'radio') {
      const checked = isChecked(f, values);
      if (editableHere && form) {
        const pr = displayToPdf(info, f.rect.x, f.rect.y + f.rect.h);
        const common = {
          x: pr.x,
          y: pr.y,
          width: f.rect.w,
          height: f.rect.h,
          rotate: degrees(info.rotation),
          borderWidth: 0,
          backgroundColor: undefined,
          borderColor: undefined,
          textColor: hexToRgb(f.style.color),
        };
        if (f.type === 'checkbox') {
          const cb = form.createCheckBox(safeFieldName(f.name || f.id, usedNames));
          cb.addToPage(page, common);
          if (checked) cb.check();
          cb.updateAppearances(toggleAppearance(f));
        } else {
          const gname = f.radioGroup || f.id;
          let rg = radioGroups.get(gname);
          if (!rg) {
            rg = form.createRadioGroup(safeFieldName(gname, usedNames));
            radioGroups.set(gname, rg);
          }
          const optValue = f.radioValue || f.id;
          rg.addOptionToPage(optValue, page, common);
          if (checked) rg.select(optValue);
          rg.updateAppearances(toggleAppearance(f));
        }
        continue;
      }
      if (checked) drawMark(page, info, f);
      continue;
    }

    if (f.type === 'signature') {
      const v = values[valueKey(f)];
      if (typeof v === 'string' && v.startsWith('data:')) await drawSignature(doc, page, info, f, v, warnings);
    }
  }

  if (opts.mode === 'editable' && valid.some((f) => f.type === 'signature' || f.type === 'label')) {
    warnings.push('Signatures and notes are always printed onto the page (not editable fields).');
  }

  pruneDanglingRefs(doc);
  const bytes = await doc.save({ updateFieldAppearances: false });
  return { bytes, warnings: Array.from(new Set(warnings)) };
}
