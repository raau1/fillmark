import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { makePageInfo } from '../core/coords';
import type { PageInfo } from '../core/types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy };

function assetUrl(path: string) {
  return new URL(`pdfjs/${path}`, document.baseURI).href;
}

export const MAX_FILE_BYTES = 150 * 1024 * 1024;

export class PdfOpenError extends Error {
  code: 'not-pdf' | 'too-large' | 'password' | 'corrupt' | 'empty';
  /** message is an English UI string (translation key); vars fill its {placeholders} */
  vars?: Record<string, string | number>;
  constructor(code: PdfOpenError['code'], message: string, vars?: Record<string, string | number>) {
    super(vars ? Object.entries(vars).reduce((m, [k, v]) => m.split(`{${k}}`).join(String(v)), message) : message);
    this.code = code;
    this.key = message;
    this.vars = vars;
  }
  key: string;
}

/** Quick validation before handing bytes to pdf.js. */
export function validatePdfBytes(bytes: Uint8Array, fileName = ''): void {
  if (bytes.byteLength === 0) throw new PdfOpenError('empty', 'The file is empty.');
  if (bytes.byteLength > MAX_FILE_BYTES) throw new PdfOpenError('too-large', 'The file is larger than {mb} MB.', { mb: MAX_FILE_BYTES / 1024 / 1024 });
  // "%PDF-" may be preceded by a little junk; the spec allows it within the first 1024 bytes
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!head.includes('%PDF-')) {
    throw new PdfOpenError('not-pdf', '“{name}” is not a PDF document.', { name: fileName || 'file' });
  }
}

export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({
    // pdf.js transfers (detaches) the buffer it receives, so give it a copy
    data: bytes.slice(),
    password,
    enableXfa: false,
    // the whole file is already in memory: no range requests or streaming
    disableAutoFetch: true,
    disableStream: true,
    // auxiliary data served by this app (copied from pdfjs-dist by scripts/copy-runtime-assets.mjs)
    cMapUrl: assetUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts/'),
    wasmUrl: assetUrl('wasm/'),
    iccUrl: assetUrl('iccs/'),
  });
  try {
    return await task.promise;
  } catch (e) {
    const err = e as { name?: string; message?: string };
    if (err?.name === 'PasswordException') {
      throw new PdfOpenError('password', 'This PDF is password-protected. Remove the password with your PDF software and upload the unprotected copy.');
    }
    if (err?.name === 'InvalidPDFException') {
      throw new PdfOpenError('corrupt', 'The PDF appears to be damaged or incomplete and could not be opened.');
    }
    throw new PdfOpenError('corrupt', 'The PDF could not be opened: {msg}', { msg: err?.message ?? String(e) });
  }
}

export async function readPageInfos(doc: PDFDocumentProxy): Promise<PageInfo[]> {
  const out: PageInfo[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    out.push(makePageInfo(p.view as [number, number, number, number], p.rotate));
  }
  return out;
}

/** True when pdf.js reports an encryption dictionary (even without a user password). */
export async function isEncrypted(doc: PDFDocumentProxy): Promise<boolean> {
  try {
    const md = await doc.getMetadata();
    const info = md.info as Record<string, unknown>;
    return Boolean(info?.IsEncrypted ?? false);
  } catch {
    return false;
  }
}

/** Releases a document and its worker-side resources. */
export function closePdf(doc: PDFDocumentProxy | null | undefined) {
  doc?.loadingTask.destroy().catch(() => {});
}
