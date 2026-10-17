import { DESKTOP } from '../desktop';
import { LEGACY_PROJECT_EXTS, PROJECT_FILE_EXT, type SaveTarget } from './persistence';

/**
 * Writing project files where the user wants them, like a desktop app:
 * "Save" overwrites the file the project came from (or was last saved to);
 * "Save as" asks for a new place. Uses the File System Access API (Edge, Chrome)
 * or, for files opened from Explorer in the desktop app, the local launcher.
 * Browsers without either fall back to downloading the file.
 */

type PickerWindow = Window & {
  showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (o: object) => Promise<FileSystemFileHandle[]>;
};
type PermissionHandle = FileSystemFileHandle & {
  queryPermission?: (o: object) => Promise<PermissionState>;
  requestPermission?: (o: object) => Promise<PermissionState>;
};

const w = () => window as PickerWindow;
export const canChooseFiles = () => typeof window !== 'undefined' && typeof w().showSaveFilePicker === 'function';

const PROJECT_TYPES = [
  {
    description: 'Fillmark project',
    accept: { 'application/x-fillmark-project': [PROJECT_FILE_EXT, ...LEGACY_PROJECT_EXTS] },
  },
];

export class SaveError extends Error {
  code: 'permission' | 'failed';
  constructor(code: SaveError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const isAbort = (e: unknown) => (e as { name?: string })?.name === 'AbortError';

/** Shows the Save dialog. Returns null when the user cancels. */
export async function chooseSaveTarget(suggestedName: string): Promise<SaveTarget | null> {
  try {
    const handle = await w().showSaveFilePicker!({ suggestedName, types: PROJECT_TYPES, id: 'fillmark-projects' });
    return { kind: 'handle', name: handle.name, handle };
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** Shows the Open dialog for project files. Returns null when the user cancels. */
export async function pickProjectFile(): Promise<{ file: File; target: SaveTarget } | null> {
  try {
    const [handle] = await w().showOpenFilePicker!({ types: PROJECT_TYPES, multiple: false, id: 'fillmark-projects' });
    if (!handle) return null;
    return { file: await handle.getFile(), target: { kind: 'handle', name: handle.name, handle } };
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** A project file dropped on the window, with write access when the browser offers it. */
export async function targetFromDrop(item: DataTransferItem | undefined): Promise<SaveTarget | null> {
  const get = (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })?.getAsFileSystemHandle;
  if (!get) return null;
  try {
    const h = await get.call(item);
    return h && h.kind === 'file' ? { kind: 'handle', name: h.name, handle: h as FileSystemFileHandle } : null;
  } catch {
    return null;
  }
}

export async function writeTarget(target: SaveTarget, blob: Blob): Promise<void> {
  if (target.kind === 'handle') {
    const h = target.handle as PermissionHandle;
    if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if (!h.requestPermission || (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        throw new SaveError('permission', 'permission');
      }
    }
    const out = await h.createWritable();
    try {
      await out.write(blob);
      await out.close();
    } catch (e) {
      await out.abort?.().catch(() => {});
      throw e;
    }
    return;
  }
  if (!DESKTOP) throw new SaveError('failed', 'This file can only be saved from the Fillmark desktop app.');
  const res = await fetch(`./__save?path=${encodeURIComponent(target.path)}`, {
    method: 'POST',
    headers: { 'X-Fillmark-Token': DESKTOP.token, 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  if (!res.ok) throw new SaveError(res.status === 403 ? 'permission' : 'failed', (await res.text().catch(() => '')) || `HTTP ${res.status}`);
}
