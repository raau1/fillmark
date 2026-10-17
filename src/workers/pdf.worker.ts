/// <reference lib="webworker" />
import { exportPdf, PdfLoadError, type ExportMode } from '../core/exportPdf';
import { importAcroForm, probeWritable } from '../core/acroform';
import { detectFormElements, type DetectOptions } from '../core/detect';
import type { FontFiles } from '../core/fonts';
import type { Field, PageInfo, Values } from '../core/types';

/**
 * Heavy PDF work (export, form import) runs here so the interface never freezes.
 * Everything stays in this browser tab: the worker has no network code.
 */
export type WorkerRequest =
  | { id: number; type: 'export'; pdf: ArrayBuffer; fields: Field[]; values: Values; mode: ExportMode; fontFiles: FontFiles; expectedPages: PageInfo[] }
  | { id: number; type: 'probe'; pdf: ArrayBuffer }
  | { id: number; type: 'importForm'; pdf: ArrayBuffer }
  | { id: number; type: 'detect'; width: number; height: number; pixels: ArrayBuffer; options: DetectOptions };

export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string; code?: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    let result: unknown;
    if (req.type === 'export') {
      const r = await exportPdf(req.pdf, req.fields, req.values, {
        mode: req.mode,
        fontFiles: req.fontFiles,
        expectedPages: req.expectedPages,
      });
      ctx.postMessage({ id: req.id, ok: true, result: r } satisfies WorkerResponse, [r.bytes.buffer]);
      return;
    } else if (req.type === 'probe') {
      result = await probeWritable(req.pdf);
    } else if (req.type === 'importForm') {
      result = await importAcroForm(req.pdf);
    } else if (req.type === 'detect') {
      result = detectFormElements({ width: req.width, height: req.height, data: new Uint8ClampedArray(req.pixels) }, req.options);
    }
    ctx.postMessage({ id: req.id, ok: true, result } satisfies WorkerResponse);
  } catch (e) {
    const err = e as Error;
    ctx.postMessage({
      id: req.id,
      ok: false,
      error: err?.message ?? String(e),
      code: e instanceof PdfLoadError ? e.code : undefined,
    } satisfies WorkerResponse);
  }
};
