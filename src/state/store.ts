import { useCallback, useMemo, useReducer } from 'react';
import type { Field, Values } from '../core/types';

/**
 * Editor document state with undo/redo. Fields and values share one history
 * so "undo" reverts whatever the user did last (move a box, tick a checkbox…).
 * Consecutive edits with the same `key` within a short window (typing in one
 * input, nudging with arrows) are merged into one undo step.
 */
interface Snapshot {
  fields: Field[];
  values: Values;
}

export interface DocState extends Snapshot {
  past: Snapshot[];
  future: Snapshot[];
  lastKey: string | null;
  lastTime: number;
  selection: string[];
  /** increments on every content change (drives autosave) */
  revision: number;
}

type Action =
  | { type: 'load'; fields: Field[]; values: Values }
  | { type: 'fields'; update: (f: Field[]) => Field[]; key?: string }
  | { type: 'values'; update: (v: Values) => Values; key?: string }
  | { type: 'both'; update: (s: Snapshot) => Snapshot; key?: string }
  | { type: 'select'; ids: string[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'checkpoint' };

const LIMIT = 300;
const MERGE_MS = 1200;

function commit(state: DocState, next: Snapshot, key: string | undefined): DocState {
  if (next.fields === state.fields && next.values === state.values) return state;
  const now = Date.now();
  const merge = key !== undefined && key === state.lastKey && now - state.lastTime < MERGE_MS;
  const past = merge ? state.past : [...state.past, { fields: state.fields, values: state.values }].slice(-LIMIT);
  const ids = new Set(next.fields.map((f) => f.id));
  return {
    ...state,
    ...next,
    past,
    future: [],
    lastKey: key ?? null,
    lastTime: now,
    selection: state.selection.filter((id) => ids.has(id)),
    revision: state.revision + 1,
  };
}

function reducer(state: DocState, a: Action): DocState {
  switch (a.type) {
    case 'load':
      return { fields: a.fields, values: a.values, past: [], future: [], lastKey: null, lastTime: 0, selection: [], revision: 0 };
    case 'fields':
      return commit(state, { fields: a.update(state.fields), values: state.values }, a.key);
    case 'values':
      return commit(state, { fields: state.fields, values: a.update(state.values) }, a.key);
    case 'both':
      return commit(state, a.update({ fields: state.fields, values: state.values }), a.key);
    case 'select':
      return { ...state, selection: a.ids };
    case 'checkpoint':
      return { ...state, lastKey: null };
    case 'undo': {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      const ids = new Set(prev.fields.map((f) => f.id));
      return {
        ...state,
        ...prev,
        past: state.past.slice(0, -1),
        future: [{ fields: state.fields, values: state.values }, ...state.future],
        lastKey: null,
        selection: state.selection.filter((id) => ids.has(id)),
        revision: state.revision + 1,
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      const ids = new Set(next.fields.map((f) => f.id));
      return {
        ...state,
        ...next,
        past: [...state.past, { fields: state.fields, values: state.values }],
        future: state.future.slice(1),
        lastKey: null,
        selection: state.selection.filter((id) => ids.has(id)),
        revision: state.revision + 1,
      };
    }
  }
}

export function useDocStore(initial?: Snapshot) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    fields: initial?.fields ?? [],
    values: initial?.values ?? {},
    past: [],
    future: [],
    lastKey: null,
    lastTime: 0,
    selection: [],
    revision: 0,
  }));

  const updateFields = useCallback((update: (f: Field[]) => Field[], key?: string) => dispatch({ type: 'fields', update, key }), []);
  const updateValues = useCallback((update: (v: Values) => Values, key?: string) => dispatch({ type: 'values', update, key }), []);
  const updateBoth = useCallback((update: (s: Snapshot) => Snapshot, key?: string) => dispatch({ type: 'both', update, key }), []);
  const select = useCallback((ids: string[]) => dispatch({ type: 'select', ids }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const load = useCallback((fields: Field[], values: Values) => dispatch({ type: 'load', fields, values }), []);
  const checkpoint = useCallback(() => dispatch({ type: 'checkpoint' }), []);

  const api = useMemo(
    () => ({ updateFields, updateValues, updateBoth, select, undo, redo, load, checkpoint }),
    [updateFields, updateValues, updateBoth, select, undo, redo, load, checkpoint],
  );
  return [state, api] as const;
}

export type DocApi = ReturnType<typeof useDocStore>[1];

/** Patch one field (helper for updateFields). */
export function patchField(fields: Field[], id: string, patch: Partial<Field> | ((f: Field) => Partial<Field>)): Field[] {
  return fields.map((f) => (f.id === id ? { ...f, ...(typeof patch === 'function' ? patch(f) : patch) } : f));
}
