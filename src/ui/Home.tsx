import { useEffect, useRef, useState } from 'react';
import { FileUp, FolderOpen, LoaderCircle, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import type { ProjectMeta } from '../core/types';
import { deleteProject, isProjectFileName, listProjects, LEGACY_PROJECT_EXTS, PROJECT_FILE_EXT, type SaveTarget } from '../state/persistence';
import { canChooseFiles, pickProjectFile, targetFromDrop } from '../state/fileSave';
import { useLang, useT } from '../i18n';
import { cx } from './util';

interface Props {
  busy: string | null;
  error: string | null;
  onOpenPdf(file: File): void;
  onOpenProjectFile(file: File, target?: SaveTarget | null): void;
  onOpenStored(id: string): void;
}

export function Home(p: Props) {
  const t = useT();
  const { lang, setLang } = useLang();
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const pdfInput = useRef<HTMLInputElement>(null);
  const projInput = useRef<HTMLInputElement>(null);

  const refresh = () =>
    listProjects()
      .then(setProjects)
      .catch(() => {
        setProjects([]);
        setStorageError(true);
      });
  useEffect(() => {
    refresh();
  }, []);

  const handleFiles = (files: FileList | null, target?: SaveTarget | null) => {
    const f = files?.[0];
    if (!f) return;
    if (isProjectFileName(f.name) || f.type === 'application/json') p.onOpenProjectFile(f, target);
    else p.onOpenPdf(f);
  };

  // project files opened through the system dialog can be saved back to (Save)
  const openProjectDialog = async () => {
    if (!canChooseFiles()) return projInput.current?.click();
    try {
      const picked = await pickProjectFile();
      if (picked) p.onOpenProjectFile(picked.file, picked.target);
    } catch {
      projInput.current?.click();
    }
  };

  const fmt = new Intl.DateTimeFormat(lang === 'es' ? 'es-ES' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div
      className={cx('home', dragOver && 'drag-over')}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = e.dataTransfer.files;
        const item = e.dataTransfer.items?.[0];
        const name = files[0]?.name ?? '';
        // ask for the file's handle synchronously (the drop data is gone after this event)
        const handle = isProjectFileName(name) ? targetFromDrop(item) : Promise.resolve(null);
        handle.then((t) => handleFiles(files, t));
      }}
    >
      <header className="home-top">
        <span className="brand">
          <BrandMark /> Fillmark
        </span>
        <button className="lang-btn" onClick={() => setLang(lang === 'es' ? 'en' : 'es')}>
          {lang === 'es' ? 'English' : 'Español'}
        </button>
      </header>

      <main className="home-main">
        <section className="intro">
          <h1>{t('Fill in PDF forms without changing how they look.')}</h1>
          <p className="lede">{t('Open a questionnaire or intake form, mark the boxes, type the answers, and download a completed copy of the original PDF.')}</p>
        </section>

        <section
          className="dropzone"
          role="button"
          tabIndex={0}
          onClick={() => !p.busy && pdfInput.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !p.busy && pdfInput.current?.click()}
          aria-label={t('Choose a PDF file')}
          aria-busy={Boolean(p.busy)}
        >
          {p.busy ? (
            <>
              <LoaderCircle size={30} className="spin" />
              <strong>{p.busy}</strong>
            </>
          ) : (
            <>
              <FileUp size={30} />
              <strong>{t('Drop a PDF here or choose a file')}</strong>
              <span className="muted">{t('PDF up to 150 MB. Scanned documents work too: you place the fields by hand.')}</span>
            </>
          )}
          <input ref={pdfInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => (handleFiles(e.target.files), (e.target.value = ''))} />
        </section>

        {p.error && (
          <div className="alert" role="alert">
            <TriangleAlert size={18} />
            <span>{p.error}</span>
          </div>
        )}

        <section className="projects">
          <div className="projects-head">
            <h2>{t('Saved in this browser')}</h2>
            <button className="btn ghost" onClick={openProjectDialog}>
              <FolderOpen size={16} /> {t('Open a project file…')}
            </button>
            <input ref={projInput} type="file" accept={[PROJECT_FILE_EXT, ...LEGACY_PROJECT_EXTS, 'application/json'].join(',')} hidden onChange={(e) => (handleFiles(e.target.files), (e.target.value = ''))} />
          </div>
          {storageError && <p className="note">{t('Browser storage is not available (private window?). Use project files to keep your work.')}</p>}
          {projects === null ? (
            <p className="muted">…</p>
          ) : projects.length === 0 ? (
            <p className="muted">{t('Nothing yet. Projects you open are kept here automatically until the browser data is cleared.')}</p>
          ) : (
            <ul className="project-list">
              {projects.map((m) => (
                <li key={m.id}>
                  <button className="project-open" onClick={() => p.onOpenStored(m.id)}>
                    <strong>{m.name}</strong>
                    <span className="muted">
                      {m.fileName}, {t('{n} pages', { n: m.pageCount })}
                    </span>
                    <span className="muted small">{t('Edited {date}', { date: fmt.format(m.updatedAt) })}</span>
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={t('Delete “{name}” from this browser', { name: m.name })}
                    title={t('Delete from this browser')}
                    onClick={async () => {
                      if (!confirm(t('Delete “{name}” and its answers from this browser? This cannot be undone.', { name: m.name }))) return;
                      await deleteProject(m.id);
                      refresh();
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="privacy">
          <ShieldCheck size={20} />
          <div>
            <h2>{t('Your documents stay on this computer')}</h2>
            <p>
              {t(
                'PDFs and answers are processed in this browser and are never uploaded, logged or sent to any service. Projects are kept in this browser’s storage, which can be erased when browsing data is cleared; download a project file to keep a copy. This app has not been assessed for compliance with any health-data regulation: follow your organisation’s rules for patient information.',
              )}
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

export function BrandMark() {
  const tick = 'M9.6 17.9 L14.1 22.4 L26.2 7';
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true" className="brand-mark">
      <rect x="1.3" y="1.3" width="29.4" height="29.4" rx="7" fill="var(--ink)" />
      <rect x="7.8" y="11" width="13.3" height="13.3" rx="1.6" fill="none" stroke="#fff" strokeWidth="2.7" />
      <path d={tick} fill="none" stroke="var(--ink)" strokeWidth="5.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d={tick} fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
