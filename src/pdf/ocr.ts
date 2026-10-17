import { createWorker, type Worker } from 'tesseract.js';
import type { TextItem } from '../core/detect';

/**
 * Optional OCR used only to NAME detected fields on pages without a text layer
 * (scans, or PDFs whose text was converted to outlines). It runs entirely in
 * this browser: worker, engine and language data are served by the app
 * (public/ocr); the paths are always set explicitly, so the library's CDN
 * defaults are never used, and the production CSP blocks third-party requests.
 */
const asset = (p: string) => new URL(`ocr/${p}`, document.baseURI).href;

let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker(['spa', 'eng'], 1, {
      workerPath: asset('worker.min.js'),
      corePath: asset('core/'),
      langPath: asset('lang'),
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: false, // language data is shipped uncompressed (see scripts/copy-runtime-assets.mjs)
      logger: () => {},
      errorHandler: () => {},
    });
    workerPromise.catch(() => (workerPromise = null));
  }
  return workerPromise;
}

/** Words found on a rendered page, in display points (canvas px / scale). */
export async function ocrWords(canvas: HTMLCanvasElement, scale: number): Promise<TextItem[]> {
  const w = await getWorker();
  const { data } = await w.recognize(canvas, {}, { blocks: true, text: false });
  const out: TextItem[] = [];
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs)
      for (const l of p.lines)
        for (const word of l.words) {
          const s = word.text.trim();
          if (!s || word.confidence < 25) continue;
          const { x0, y0, x1, y1 } = word.bbox;
          out.push({ str: s, rect: { x: x0 / scale, y: y0 / scale, w: (x1 - x0) / scale, h: (y1 - y0) / scale } });
        }
  return out;
}

export async function stopOcr() {
  const w = workerPromise;
  workerPromise = null;
  if (w) (await w).terminate().catch(() => {});
}
