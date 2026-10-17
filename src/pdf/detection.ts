import type { Detected, DetectedKind, TextItem } from '../core/detect';
import { buildFieldsFromDetections, type Naming } from '../core/detectFields';
import type { Field, PageInfo, Rect } from '../core/types';
import { pdfjs, type PDFDocumentProxy } from './pdfjs';
import { detectInWorker } from './workerClient';
import { ocrWords, stopOcr } from './ocr';

export interface DetectionRequest {
  pages: number[];
  checkboxes: boolean;
  boxes: boolean;
  lines: boolean;
  choiceGroups: boolean;
  /** 'auto' = OCR only pages without selectable text */
  ocr: 'auto' | 'off';
  existing: Field[];
  naming: Naming;
  hideFormWidgets: boolean;
  onProgress(page: number, done: number, total: number, phase: 'render' | 'analyse' | 'read'): void;
  signal: { cancelled: boolean };
}

export interface DetectionResult {
  fields: Field[];
  snap: Record<number, Rect[]>;
  counts: Record<DetectedKind, number>;
  skippedExisting: number;
  labelSource: { text: number; ocr: number; none: number };
}

const RENDER_SCALE = 3; // 216 dpi: thin frames and 6 pt checkboxes are reliably visible
const MAX_PIXELS = 20_000_000;

async function textLayer(doc: PDFDocumentProxy, index: number): Promise<TextItem[]> {
  const page = await doc.getPage(index + 1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const out: TextItem[] = [];
  for (const it of tc.items) {
    if (!('str' in it) || !it.str.trim()) continue;
    const tx = pdfjs.Util.transform(vp.transform, it.transform);
    const fh = Math.hypot(tx[2], tx[3]) || 8;
    const rotated = Math.abs(tx[1]) > Math.abs(tx[0]);
    if (rotated) continue; // vertical text is not used for labels
    out.push({ str: it.str, rect: { x: tx[4], y: tx[5] - fh * 0.82, w: it.width, h: fh } });
  }
  return out;
}

export async function runDetection(doc: PDFDocumentProxy, infos: PageInfo[], req: DetectionRequest): Promise<DetectionResult> {
  const counts: Record<DetectedKind, number> = { checkbox: 0, radio: 0, box: 0, multibox: 0, line: 0 };
  const result: DetectionResult = { fields: [], snap: {}, counts, skippedExisting: 0, labelSource: { text: 0, ocr: 0, none: 0 } };
  const counters: Record<string, number> = {};
  try {
    for (let n = 0; n < req.pages.length; n++) {
      if (req.signal.cancelled) break;
      const i = req.pages[n];
      req.onProgress(i, n, req.pages.length, 'render');
      const page = await doc.getPage(i + 1);
      const info = infos[i];
      let scale = RENDER_SCALE;
      if (info.width * info.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (info.width * info.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      await page.render({
        canvas,
        canvasContext: ctx,
        viewport: vp,
        // existing interactive widgets are not "printed" boxes
        annotationMode: req.hideFormWidgets ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.DISABLE,
      }).promise;
      if (req.signal.cancelled) break;
      req.onProgress(i, n, req.pages.length, 'analyse');
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const k = canvas.width / info.width; // actual px per pt after rounding
      const found: Detected[] = await detectInWorker(img, { scale: k, checkboxes: req.checkboxes, boxes: req.boxes, lines: req.lines });
      result.snap[i] = found.map((d) => d.rect);

      let text = await textLayer(doc, i);
      let source: keyof DetectionResult['labelSource'] = text.length > 3 ? 'text' : 'none';
      if (source === 'none' && req.ocr === 'auto' && found.length && !req.signal.cancelled) {
        req.onProgress(i, n, req.pages.length, 'read');
        try {
          // hide the detected boxes so OCR does not read them as letters
          ctx.fillStyle = '#fff';
          // (boxes and their frames too: OCR reads frame lines as "[" or "|")
          for (const d of found) ctx.fillRect((d.rect.x - 2) * k, (d.rect.y - 2) * k, (d.rect.w + 4) * k, (d.rect.h + 4) * k);
          text = await ocrWords(canvas, k);
          if (text.length) source = 'ocr';
        } catch {
          text = [];
        }
      }
      const fields = buildFieldsFromDetections(i, found, text, {
        choiceGroups: req.choiceGroups,
        existing: [...req.existing, ...result.fields],
        naming: req.naming,
        counters,
      });
      result.skippedExisting += found.length - fields.length;
      for (const d of found) counts[d.kind]++;
      result.labelSource[source] += fields.length;
      result.fields.push(...fields);
      canvas.width = canvas.height = 0;
    }
  } finally {
    stopOcr();
  }
  return result;
}
