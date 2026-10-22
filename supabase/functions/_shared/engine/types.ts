// Contracts shared by the browser app and the `extract` edge function.
// Pure TypeScript: no Deno/Node/DOM imports, so it runs in both runtimes and in vitest.

export type FieldKey =
  | 'first_name'
  | 'last_name'
  | 'national_id'
  | 'sender'
  | 'central_numbers'
  | 'received_date'
  | 'commitment_number';

/** One field as returned by the model. */
export interface RawField {
  value: string | null;
  confidence?: number;
  /** Verbatim text from the page the value was read from. */
  quote?: string | null;
}

/** The model's JSON for one page. */
export interface RawExtraction {
  is_commitment_form?: boolean;
  continuation_of_previous?: boolean;
  /** Clockwise degrees needed to make the page upright. */
  page_rotation?: number;
  form_type?: string | null;
  sender?: RawField;
  first_name?: RawField;
  last_name?: RawField;
  national_id?: RawField;
  central_numbers?: RawField[];
  received_date?: RawField;
  commitment_numbers?: RawField[];
  /** Approximate field location on the full page, [x0,y0,x1,y1] as 0..1 fractions. */
  regions?: Record<string, unknown>;
  notes?: string[];
}

export interface FieldMeta {
  confidence: number;
  quote: string | null;
  /** Value (or quote) found in the page's OCR text. */
  verified: boolean;
  /** Needs a human look (orange). */
  flagged: boolean;
  reasons: string[];
  edited?: boolean;
  /** Approximate location from the model (used for zoom re-read and as a crop fallback). */
  region?: [number, number, number, number];
  /** Value came from the focused zoom re-read. */
  zoomed?: boolean;
  /**
   * Unconfirmed handwritten reading. Shown to the reviewer as a hint only — the field
   * itself stays empty until a person accepts or types it (empty beats guessed).
   */
  suggestion?: string;
}

export interface BuiltCommitment {
  value: string | null;
  meta: FieldMeta;
}

export interface BuiltForm {
  is_commitment_form: boolean;
  continuation: boolean;
  form_type: string | null;
  first_name: string | null;
  last_name: string | null;
  national_id: string | null;
  sender: string | null;
  central_numbers: string[];
  /** ISO yyyy-mm-dd */
  received_date: string | null;
  field_meta: Partial<Record<Exclude<FieldKey, 'commitment_number'>, FieldMeta>>;
  commitments: BuiltCommitment[];
  /** Shown to the reviewer before approval. */
  warnings: string[];
}

export interface Sender {
  name: string;
  kind: 'kupa' | 'hospital' | 'other';
  aliases: string[];
}

/** Positional OCR of one page (pixel coordinates of the stored image). */
export interface OcrWord {
  t: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface OcrLayout {
  width: number;
  height: number;
  words: OcrWord[];
}

/** Normalised 0..1 box on the page + the words it covers. */
export interface Anchor {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  quote: string;
}

export interface RegexHints {
  senderGuess: string | null;
  commitmentCandidates: string[];
  centralCandidates: string[];
}
