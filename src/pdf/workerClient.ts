import type { WorkerRequest, WorkerResponse } from '../workers/pdf.worker';
import type { ExportMode, ExportResult } from '../core/exportPdf';
import type { ImportedForm } from '../core/acroform';
import type { Detected, DetectOptions } from '../core/detect';
import type { Field, PageInfo, Values } from '../core/types';
import { loadFontFiles } from './fontAssets';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export class WorkerError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/pdf.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data.result);
      else p.reject(new WorkerError(ev.data.error, ev.data.code));
    };
    worker.onerror = (ev) => {
      const err = new WorkerError(`Background processing failed: ${ev.message || 'unknown error'}`);
      pending.forEach((p) => p.reject(err));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function call<T>(req: DistributiveOmit<WorkerRequest, 'id'>, transfer: Transferable[] = []): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ ...req, id } as WorkerRequest, transfer);
  });
}

const copy = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;

export async function exportInWorker(pdf: Uint8Array, fields: Field[], values: Values, mode: ExportMode, expectedPages: PageInfo[]): Promise<ExportResult> {
  const fontFiles = await loadFontFiles();
  const buf = copy(pdf);
  return call<ExportResult>({ type: 'export', pdf: buf, fields, values, mode, fontFiles, expectedPages }, [buf]);
}

export function probeInWorker(pdf: Uint8Array) {
  const buf = copy(pdf);
  return call<{ encrypted: boolean; fieldCount: number; error?: string }>({ type: 'probe', pdf: buf }, [buf]);
}

export function importFormInWorker(pdf: Uint8Array) {
  const buf = copy(pdf);
  return call<ImportedForm>({ type: 'importForm', pdf: buf }, [buf]);
}

export function detectInWorker(img: ImageData, options: DetectOptions) {
  const pixels = img.data.buffer as ArrayBuffer;
  return call<Detected[]>({ type: 'detect', width: img.width, height: img.height, pixels, options }, [pixels]);
}
