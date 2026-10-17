/**
 * Core data model.
 *
 * COORDINATE CONVENTION (important):
 * Every field rectangle is stored in "display space": PDF points (1/72 inch),
 * origin at the TOP-LEFT of the page *as the user sees it* (i.e. after the
 * page's /Rotate has been applied and relative to the visible CropBox), with
 * y growing downwards. This is zoom-independent. Conversion to the PDF's own
 * user space (bottom-left origin, unrotated) happens only in core/coords.ts.
 */

export type FieldType =
  | 'text'
  | 'multiline'
  | 'checkbox'
  | 'radio'
  | 'date'
  | 'number'
  | 'dropdown'
  | 'signature'
  | 'label';

export const FIELD_TYPES: FieldType[] = [
  'text',
  'multiline',
  'checkbox',
  'radio',
  'date',
  'number',
  'dropdown',
  'signature',
  'label',
];

export type FontFamily = 'dejavu-sans' | 'dejavu-sans-condensed' | 'dejavu-serif' | 'helvetica' | 'times' | 'courier';
export type Align = 'left' | 'center' | 'right';
export type CheckStyle = 'check' | 'cross' | 'fill' | 'dot';
/** What to do when text does not fit: shrink the font (down to a minimum) or keep the size. Either way overflow is reported. */
export type OverflowMode = 'shrink' | 'fixed';
export type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD-MM-YYYY' | 'DD.MM.YYYY';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FieldStyle {
  fontFamily: FontFamily;
  /** 0 = automatic size (fits box height, max 12pt). */
  fontSize: number;
  color: string; // #rrggbb
  align: Align;
  lineHeight: number; // multiple of font size
  border: boolean;
  borderColor: string;
  borderWidth: number;
  /** null = transparent */
  background: string | null;
  backgroundOpacity: number; // 0..1
  overflow: OverflowMode;
  checkStyle: CheckStyle;
  dateFormat: DateFormat;
}

export type FieldSource = 'manual' | 'detected' | 'imported';

export interface Field {
  id: string;
  type: FieldType;
  /** 0-based page index */
  page: number;
  rect: Rect;
  /** Human label shown in Fill mode */
  name: string;
  /** Section heading used to group fields in Fill mode */
  group: string;
  style: FieldStyle;
  required: boolean;
  defaultValue: string;
  /** dropdown options */
  options: string[];
  /** radio buttons: fields with the same radioGroup are mutually exclusive */
  radioGroup: string;
  /** radio buttons: value stored when this button is selected */
  radioValue: string;
  source: FieldSource;
  /** detection confidence 0..1 (detected fields only) */
  confidence?: number;
  /** detected fields stay "unreviewed" until the user accepts them */
  reviewed?: boolean;
  /** name of the original AcroForm field this was imported from */
  sourceName?: string;
}

/** Text-ish values are strings; checkboxes booleans; radio groups store the selected radioValue. */
export type FieldValue = string | boolean;
export type Values = Record<string, FieldValue>;

export interface PageInfo {
  /** Visible box in PDF user space [x0, y0, x1, y1] (CropBox ∩ MediaBox) */
  box: [number, number, number, number];
  /** Page rotation, normalised to 0 | 90 | 180 | 270 (clockwise, as in /Rotate) */
  rotation: 0 | 90 | 180 | 270;
  /** Display size in points (width/height swapped for 90/270) */
  width: number;
  height: number;
}

export interface ProjectSettings {
  /** Hide the original interactive widgets when fields were imported into the editor */
  hideOriginalWidgets: boolean;
  exportFileName: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  fileName: string;
  pageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectData {
  meta: ProjectMeta;
  pages: PageInfo[];
  fields: Field[];
  values: Values;
  settings: ProjectSettings;
}
