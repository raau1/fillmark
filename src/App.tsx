import { useCallback, useEffect, useRef, useState } from 'react';
import type { Measurer } from './core/fonts';
import type { ProjectData } from './core/types';
import { uid } from './core/fieldFactory';
import { closePdf, openPdf, readPageInfos, validatePdfBytes, PdfOpenError, type PDFDocumentProxy } from './pdf/pdfjs';
import { loadMeasurer } from './pdf/fontAssets';
import { probeInWorker } from './pdf/workerClient';
import { isProjectFileName, loadProject, parseProjectFile, requestPersistentStorage, saveProject, setSaveTarget, type SaveTarget } from './state/persistence';
import { LangProvider, useT } from './i18n';
import { Home } from './ui/Home';
import { Editor } from './ui/Editor';
import { DESKTOP, startHeartbeat, takeLaunchFile } from './desktop';

interface Session {
  data: ProjectData;
  pdf: Uint8Array;
  doc: PDFDocumentProxy;
  formFieldCount: number;
}

export default function App() {
  return (
    <LangProvider>
      <Shell />
    </LangProvider>
  );
}

function Shell() {
  const t = useT();
  const [measurer, setMeasurer] = useState<Measurer | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadMeasurer()
      .then(setMeasurer)
      .catch((e) => setFatal(String(e?.message ?? e)));
    requestPersistentStorage();
  }, []);

  /** Opens bytes as a project; checks that pdf.js can render it and pdf-lib can write it. */
  const openBytes = useCallback(
    async (pdf: Uint8Array, existing: ProjectData | null, fileName: string, target?: SaveTarget | null) => {
      validatePdfBytes(pdf, fileName);
      const doc = await openPdf(pdf);
      const pages = await readPageInfos(doc);
      const probe = await probeInWorker(pdf);
      if (probe.error) {
        closePdf(doc);
        throw new Error(t('This PDF can be displayed but not modified ({msg}). Try saving it again with “Print to PDF” and open the new copy.', { msg: probe.error }));
      }
      if (probe.encrypted) {
        closePdf(doc);
        throw new Error(
          t('This PDF has security restrictions (encryption), so a completed copy cannot be written. Remove the restrictions in your PDF software (for example with “qpdf --decrypt in.pdf out.pdf”) and open the unprotected copy.'),
        );
      }
      const now = Date.now();
      const data: ProjectData = existing
        ? { ...existing, pages }
        : {
            meta: { id: uid('p'), name: fileName.replace(/\.pdf$/i, ''), fileName, pageCount: pages.length, createdAt: now, updatedAt: now },
            pages,
            fields: [],
            values: {},
            settings: { hideOriginalWidgets: false, exportFileName: '' },
          };
      if (existing && existing.pages.length && existing.pages.length !== pages.length) {
        throw new Error(t('The project does not match its PDF (different number of pages).'));
      }
      try {
        await saveProject(data, pdf);
      } catch {
        /* storage unavailable: the editor shows the save state and offers the project file */
      }
      // a project opened from a file saves back into that file
      if (target) await setSaveTarget(data.meta.id, { ...target, savedAt: Date.now() });
      setSession({ data, pdf, doc, formFieldCount: probe.fieldCount });
    },
    [t],
  );

  const guard = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      setError(null);
      try {
        await fn();
      } catch (e) {
        const msg = e instanceof PdfOpenError ? t(e.key, e.vars) : (e as Error)?.message ?? String(e);
        setError(msg);
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  const openPdfFile = useCallback(
    (file: File) =>
      guard(t('Opening {name}…', { name: file.name }), async () => {
        if (file.size === 0) throw new PdfOpenError('empty', 'The file is empty.');
        await openBytes(new Uint8Array(await file.arrayBuffer()), null, file.name);
      }),
    [guard, openBytes, t],
  );
  const openProjectFile = useCallback(
    (file: File, target?: SaveTarget | null) =>
      guard(t('Opening {name}…', { name: file.name }), async () => {
        const { data, pdf } = await parseProjectFile(file);
        await openBytes(pdf, data, data.meta.fileName, target ?? null);
      }),
    [guard, openBytes, t],
  );

  // Desktop app: open the file the window was started with (double-click / "Open with")
  const launched = useRef(false);
  useEffect(() => {
    if (!DESKTOP) return;
    startHeartbeat();
    if (launched.current || !measurer) return;
    launched.current = true;
    (async () => {
      try {
        const launch = await takeLaunchFile();
        if (!launch) return;
        const { file, path } = launch;
        if (isProjectFileName(file.name)) openProjectFile(file, path ? { kind: 'launcher', name: file.name, path } : null);
        else openPdfFile(file);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [measurer, openPdfFile, openProjectFile]);

  if (fatal) return <div className="fatal">{t('The app could not start: {msg}', { msg: fatal })}</div>;
  if (!measurer) return <div className="splash" aria-busy="true" />;

  if (session) {
    return (
      <Editor
        key={session.data.meta.id}
        initial={session.data}
        pdf={session.pdf}
        doc={session.doc}
        measurer={measurer}
        formFieldCount={session.formFieldCount}
        onClose={() => {
          closePdf(session.doc);
          setSession(null);
        }}
      />
    );
  }

  return (
    <Home
      busy={busy}
      error={error}
      onOpenPdf={openPdfFile}
      onOpenProjectFile={openProjectFile}
      onOpenStored={(id) =>
        guard(t('Opening project…'), async () => {
          const { data, pdf } = await loadProject(id);
          await openBytes(pdf, data, data.meta.fileName);
        })
      }
    />
  );
}
