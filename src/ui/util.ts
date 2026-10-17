import type { Field } from '../core/types';

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function baseName(fileName: string) {
  return fileName.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document';
}

export function todayIso() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function sanitizeFileName(name: string, ext: string) {
  let n = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
  if (!n) n = 'document';
  if (!n.toLowerCase().endsWith(ext)) n += ext;
  return n;
}

/** Reading order: page, then rows (top to bottom, tolerance 4pt), then left to right. */
export function readingOrder(a: Field, b: Field) {
  if (a.page !== b.page) return a.page - b.page;
  const ay = a.rect.y + a.rect.h / 2;
  const by = b.rect.y + b.rect.h / 2;
  if (Math.abs(ay - by) > 4) return ay - by;
  return a.rect.x - b.rect.x;
}

export function isTypingTarget(el: EventTarget | null) {
  const e = el as HTMLElement | null;
  if (!e) return false;
  const tag = e.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.isContentEditable;
}

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}
