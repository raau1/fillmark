import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ES } from './i18n.es';

export type Lang = 'en' | 'es';

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
}

const Ctx = createContext<LangCtx>({ lang: 'en', setLang: () => {} });

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('pff.lang');
    if (saved === 'en' || saved === 'es') return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('pff.lang', l);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = l;
  }, []);
  const v = useMemo(() => ({ lang, setLang }), [lang, setLang]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useLang() {
  return useContext(Ctx);
}

export type TFn = (s: string, vars?: Record<string, string | number>) => string;

/** English text is the key; Spanish comes from the dictionary (falls back to English). */
export function translate(lang: Lang, s: string, vars?: Record<string, string | number>): string {
  let out = lang === 'es' ? (ES[s] ?? s) : s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

export function useT(): TFn {
  const { lang } = useContext(Ctx);
  return useCallback((s, vars) => translate(lang, s, vars), [lang]);
}
