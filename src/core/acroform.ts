import {
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  PDFDocument,
  PDFRef,
  PDFName,
  PDFDict,
  type PDFField,
  type PDFWidgetAnnotation,
} from 'pdf-lib';
import { pdfRectToDisplay } from './coords';
import { createField } from './fieldFactory';
import { pageInfoFromPdfLib } from './exportPdf';
import { valueKey } from './layout';
import type { Field, FieldType, Values } from './types';

export interface ImportedForm {
  fields: Field[];
  values: Values;
  /** fields we could not represent (push buttons, XFA, etc.) */
  skipped: string[];
}

function humanize(name: string): string {
  const last = name.split('.').pop() ?? name;
  return last
    .replace(/[_]+/g, ' ')
    .replace(/([a-záéíóúñ])([A-ZÁÉÍÓÚÑ])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim() || name;
}

function fontSizeFromDA(field: PDFField): number {
  try {
    const da = field.acroField.getDefaultAppearance() ?? '';
    const m = /(\d*\.?\d+)\s+Tf/.exec(da);
    const n = m ? Number(m[1]) : 0;
    return isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function widgetPageIndex(doc: PDFDocument, widget: PDFWidgetAnnotation, pageRefs: PDFRef[]): number {
  const p = widget.P();
  if (p) {
    const i = pageRefs.findIndex((r) => r === p || r.toString() === p.toString());
    if (i >= 0) return i;
  }
  // fall back: search each page's /Annots for this widget
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const annots = pages[i].node.Annots();
    if (!annots) continue;
    for (let k = 0; k < annots.size(); k++) {
      const a = annots.lookup(k);
      if (a instanceof PDFDict && a === widget.dict) return i;
    }
  }
  return -1;
}

export async function importAcroForm(bytes: Uint8Array | ArrayBuffer): Promise<ImportedForm> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const result: ImportedForm = { fields: [], values: {}, skipped: [] };
  if (!doc.catalog.getAcroForm()) return result;
  const form = doc.getForm();
  const pages = doc.getPages();
  const infos = pages.map(pageInfoFromPdfLib);
  const pageRefs = pages.map((p) => p.ref);

  for (const pf of form.getFields()) {
    const fullName = pf.getName();
    let type: FieldType | null = null;
    if (pf instanceof PDFTextField) type = pf.isMultiline() ? 'multiline' : 'text';
    else if (pf instanceof PDFCheckBox) type = 'checkbox';
    else if (pf instanceof PDFRadioGroup) type = 'radio';
    else if (pf instanceof PDFDropdown || pf instanceof PDFOptionList) type = 'dropdown';
    else if (pf instanceof PDFSignature) type = 'signature';
    if (!type) {
      result.skipped.push(fullName);
      continue;
    }
    const widgets = pf.acroField.getWidgets();
    const fontSize = fontSizeFromDA(pf);
    let options: string[] = [];
    if (pf instanceof PDFDropdown || pf instanceof PDFOptionList || pf instanceof PDFRadioGroup) {
      try {
        options = pf.getOptions();
      } catch {
        options = [];
      }
    }
    widgets.forEach((w, wi) => {
      const pi = widgetPageIndex(doc, w, pageRefs);
      if (pi < 0) return;
      const r = w.getRectangle();
      const rect = pdfRectToDisplay(infos[pi], r);
      if (rect.w < 1 || rect.h < 1) return;
      let radioValue = '';
      if (type === 'radio') {
        // with /Opt, widget on-states are indices and the export values live in /Opt
        const on = w.getOnValue();
        radioValue = options[wi] ?? (on ? decodeName(on) : `option${wi + 1}`);
      }
      const f = createField(type!, pi, rect, {
        name: type === 'radio' ? `${humanize(fullName)}: ${radioValue}` : humanize(fullName),
        group: `Form fields`,
        source: 'imported',
        sourceName: fullName,
        options: type === 'radio' ? [] : options,
        radioGroup: type === 'radio' ? fullName : '',
        radioValue,
      });
      f.style.fontSize = fontSize;
      try {
        if (pf.isRequired()) f.required = true;
      } catch {
        /* ignore */
      }
      result.fields.push(f);
    });

    // current values
    const any = result.fields.filter((f) => f.sourceName === fullName);
    if (!any.length) continue;
    try {
      if (pf instanceof PDFTextField) {
        const t = pf.getText();
        if (t) any.forEach((f) => (result.values[valueKey(f)] = t));
      } else if (pf instanceof PDFCheckBox) {
        if (pf.isChecked()) any.forEach((f) => (result.values[valueKey(f)] = true));
      } else if (pf instanceof PDFRadioGroup) {
        const s = pf.getSelected();
        if (s) result.values[valueKey(any[0])] = s;
      } else if (pf instanceof PDFDropdown || pf instanceof PDFOptionList) {
        const s = pf.getSelected()[0];
        if (s) any.forEach((f) => (result.values[valueKey(f)] = s));
      }
    } catch {
      /* unreadable value: leave empty */
    }
  }
  return result;
}

function decodeName(n: PDFName): string {
  return n.decodeText ? n.decodeText() : n.toString().replace(/^\//, '');
}

/** Lightweight probe used right after upload. */
export async function probeWritable(bytes: Uint8Array | ArrayBuffer): Promise<{ encrypted: boolean; fieldCount: number; error?: string }> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    const encrypted = doc.isEncrypted;
    let fieldCount = 0;
    if (doc.catalog.getAcroForm()) {
      try {
        fieldCount = doc.getForm().getFields().length;
      } catch {
        fieldCount = 0;
      }
    }
    return { encrypted, fieldCount };
  } catch (e) {
    return { encrypted: false, fieldCount: 0, error: (e as Error).message };
  }
}
