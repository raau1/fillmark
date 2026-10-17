import { createStore, get, set, del, keys } from 'idb-keyval';
import { DEFAULT_STYLE } from '../core/fieldFactory';
import { FIELD_TYPES, type Field, type ProjectData, type ProjectMeta } from '../core/types';

/**
 * Projects are stored ONLY in this browser (IndexedDB). Nothing is uploaded.
 * Browser storage can be cleared by the user or the browser, so the UI also
 * offers a project file (.pffproj) that can be kept anywhere and re-imported.
 */
const store = createStore('pdf-form-filler', 'projects');
const PROJECT = (id: string) => `project:${id}`;
const PDF = (id: string) => `pdf:${id}`;
const TARGET = (id: string) => `target:${id}`;

export const PROJECT_FILE_EXT = '.fillmark';
/** project files saved by earlier test builds of this app (InkWell, Casilla) */
export const LEGACY_PROJECT_EXTS = ['.inkwell', '.casilla'];
export const isProjectFileName = (n: string) => [PROJECT_FILE_EXT, ...LEGACY_PROJECT_EXTS].some((e) => n.toLowerCase().endsWith(e));
const FORMAT = 'pdf-form-filler-project';

export async function listProjects(): Promise<ProjectMeta[]> {
  const all = (await keys(store)) as string[];
  const metas: ProjectMeta[] = [];
  for (const k of all) {
    if (!k.startsWith('project:')) continue;
    const p = (await get(k, store)) as ProjectData | undefined;
    if (p?.meta) metas.push(p.meta);
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveProject(data: ProjectData, pdf?: Uint8Array): Promise<void> {
  if (pdf) await set(PDF(data.meta.id), pdf, store);
  await set(PROJECT(data.meta.id), data, store);
}

export async function loadProject(id: string): Promise<{ data: ProjectData; pdf: Uint8Array }> {
  const data = (await get(PROJECT(id), store)) as ProjectData | undefined;
  const pdf = (await get(PDF(id), store)) as Uint8Array | ArrayBuffer | undefined;
  if (!data || !pdf) throw new Error('This project is no longer stored in this browser.');
  return { data: normalizeProject(data), pdf: pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf) };
}

export async function deleteProject(id: string): Promise<void> {
  await del(PROJECT(id), store);
  await del(PDF(id), store);
  await del(TARGET(id), store);
}

// ---------------------------------------------------------------------------
// The project file a project is saved to ("Save" writes there).
//  - handle:   a file chosen in a Save/Open dialog (File System Access API, Edge/Chrome)
//  - launcher: a file opened from Explorer in the desktop app; the launcher writes it

export type SaveTarget =
  | { kind: 'handle'; name: string; handle: FileSystemFileHandle; savedAt?: number }
  | { kind: 'launcher'; name: string; path: string; savedAt?: number };

export async function getSaveTarget(id: string): Promise<SaveTarget | null> {
  try {
    return ((await get(TARGET(id), store)) as SaveTarget | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Best effort: some handles cannot be stored (then Save still works until the app is closed). */
export async function setSaveTarget(id: string, target: SaveTarget | null): Promise<void> {
  try {
    if (target) await set(TARGET(id), target, store);
    else await del(TARGET(id), store);
  } catch {
    /* not storable */
  }
}

/** Ask the browser not to evict our storage automatically (best effort). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function projectFileBlob(data: ProjectData, pdf: Uint8Array): Blob {
  const payload = { format: FORMAT, version: 1, savedAt: new Date().toISOString(), project: data, pdf: toBase64(pdf) };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export async function parseProjectFile(file: Blob): Promise<{ data: ProjectData; pdf: Uint8Array }> {
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new Error('This file is not a valid project file.');
  }
  const j = json as { format?: string; version?: number; project?: ProjectData; pdf?: string };
  if (j?.format !== FORMAT || !j.project || typeof j.pdf !== 'string') {
    throw new Error('This file is not a PDF Form Filler project.');
  }
  if ((j.version ?? 1) > 1) throw new Error('This project was saved by a newer version of the app.');
  const pdf = fromBase64(j.pdf);
  return { data: normalizeProject(j.project), pdf };
}

/** Fill in defaults so projects from older versions (or hand-edited files) load safely. */
export function normalizeProject(p: ProjectData): ProjectData {
  const fields: Field[] = (Array.isArray(p.fields) ? p.fields : [])
    .filter((f) => f && FIELD_TYPES.includes(f.type) && f.rect && typeof f.page === 'number')
    .map((f) => ({
      ...f,
      name: String(f.name ?? ''),
      group: String(f.group ?? ''),
      required: Boolean(f.required),
      defaultValue: String(f.defaultValue ?? ''),
      options: Array.isArray(f.options) ? f.options.map(String) : [],
      radioGroup: String(f.radioGroup ?? ''),
      radioValue: String(f.radioValue ?? ''),
      source: f.source ?? 'manual',
      style: { ...DEFAULT_STYLE, ...(f.style ?? {}) },
    }));
  return {
    meta: p.meta,
    pages: p.pages ?? [],
    fields,
    values: p.values && typeof p.values === 'object' ? p.values : {},
    settings: { hideOriginalWidgets: Boolean(p.settings?.hideOriginalWidgets), exportFileName: String(p.settings?.exportFileName ?? '') },
  };
}
