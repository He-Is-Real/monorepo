/**
 * Cleans an uploaded legal-document PDF. This file is the worker_thread entry that `index.ts`
 * starts, and it must stay self-contained: it imports only Node builtins and `pdf-lib`, has no
 * relative imports and uses only erasable TypeScript, so Node 24 can run the `.ts` source directly
 * (under Vitest) as well as the webpack bundle of it (in production). See `index.ts`.
 *
 * Three steps, all inside the worker's memory and time limits:
 * 1. Pre-scan (`Scanner`): one forward pass over the bytes that follows pdf-lib's own parser
 *    step for step (same tokens, same stream boundaries, same "jibberish" skipping), so it sees
 *    exactly the object and xref streams pdf-lib will decompress. It counts objects and streams,
 *    refuses `/Encrypt`, and decompresses those streams itself with a hard output cap, before
 *    pdf-lib (whose decoder has no cap) touches them.
 * 2. Clean: load with pdf-lib, remove active content from every object it holds, drop objects
 *    nothing refers to, and save without object streams.
 * 3. Re-check the saved bytes: re-load and walk them, and scan their names outside streams.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { constants as zlibConstants, inflateRawSync } from 'node:zlib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** Indirect objects, counting those inside object streams. */
const MAX_OBJECTS = 20_000;
const MAX_STREAMS = 5_000;
/** Decompressed object/xref stream data: per stream and in all. */
const MAX_INFLATE_EACH = 8 * 1024 * 1024;
const MAX_INFLATE_TOTAL = 32 * 1024 * 1024;
/** Entries an xref stream may declare (pdf-lib builds one object per entry). */
const MAX_XREF_ENTRIES = 200_000;
/** Nesting of arrays and dictionaries. */
const MAX_DEPTH = 200;

export type PdfRefusalCode =
  | 'pdf_too_large'
  | 'pdf_not_a_pdf'
  | 'pdf_encrypted'
  | 'pdf_too_complex'
  | 'pdf_active_content';

export class PdfRefusal extends Error {
  readonly code: PdfRefusalCode;
  constructor(code: PdfRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

const refuse = {
  tooLarge: () =>
    new PdfRefusal('pdf_too_large', 'The PDF is larger than 10 MB.'),
  notPdf: () => new PdfRefusal('pdf_not_a_pdf', 'The file isn’t a PDF.'),
  unreadable: () =>
    new PdfRefusal('pdf_not_a_pdf', 'The file can’t be read as a PDF.'),
  damaged: () =>
    new PdfRefusal(
      'pdf_not_a_pdf',
      'Part of the PDF is damaged and can’t be read.',
    ),
  noPages: () => new PdfRefusal('pdf_not_a_pdf', 'The PDF has no pages.'),
  encrypted: () =>
    new PdfRefusal(
      'pdf_encrypted',
      'The PDF is encrypted or password-protected. Please upload an unprotected copy.',
    ),
  tooComplex: () =>
    new PdfRefusal(
      'pdf_too_complex',
      'The PDF is too large or complex to check. Please save it again as a plain PDF.',
    ),
  unchecked: () =>
    new PdfRefusal(
      'pdf_too_complex',
      'The PDF has a part that can’t be checked. Please save it again as a plain PDF.',
    ),
  active: (what: string) =>
    new PdfRefusal(
      'pdf_active_content',
      `The PDF still contained ${what} after cleaning, so it wasn’t accepted.`,
    ),
};

// ---------------------------------------------------------------------------------------------
// 1. Pre-scan
// ---------------------------------------------------------------------------------------------

const bytesOf = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const KW = {
  header: bytesOf('%PDF-'),
  obj: bytesOf('obj'),
  endobj: bytesOf('endobj'),
  xref: bytesOf('xref'),
  trailer: bytesOf('trailer'),
  startxref: bytesOf('startxref'),
  eof: bytesOf('%%EOF'),
  true: bytesOf('true'),
  false: bytesOf('false'),
  null: bytesOf('null'),
  stream: bytesOf('stream'),
  endstream: bytesOf('endstream'),
  // What pdf-lib accepts after `stream`, in its order (a bare `stream` last).
  streamEols: [
    bytesOf('stream \r\n'),
    bytesOf('stream\r\n'),
    bytesOf('stream\r'),
    bytesOf('stream\n'),
    bytesOf('stream'),
  ],
  // What ends a stream when it has no usable /Length.
  endstreams: [
    bytesOf('\r\nendstream'),
    bytesOf('\rendstream'),
    bytesOf('\nendstream'),
    bytesOf('endstream'),
  ],
};

const table = (chars: number[]) => {
  const t = new Uint8Array(256);
  for (const c of chars) t[c] = 1;
  return t;
};
const WHITESPACE = table([0, 9, 10, 12, 13, 32]);
const DELIMITER = table([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
const DIGIT = table([...'0123456789'].map((c) => c.charCodeAt(0)));
const NUMERIC = table([...'0123456789+-.'].map((c) => c.charCodeAt(0)));
const [
  LF,
  CR,
  PERCENT,
  PERIOD,
  LT,
  GT,
  LPAREN,
  RPAREN,
  BACKSLASH,
  SLASH,
  LBRACKET,
  RBRACKET,
] = [...'\n\r%.<>()\\/[]'].map((c) => c.charCodeAt(0));
const LOWER_N = 0x6e;
const LOWER_F = 0x66;
const UPPER_R = 0x52;

/** pdf-lib decodes `#xx` in names with upper-case hex only; the scan must agree with it. */
const pdfLibName = (raw: string) =>
  raw.includes('#')
    ? raw.replace(/#([\dABCDEF]{2})/g, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
    : raw;
/** Other PDF readers take either case: the safety checks look for both. */
const anyCaseName = (raw: string) =>
  raw.includes('#')
    ? raw.replace(/#([\da-fA-F]{2})/g, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
    : raw;

/** A parsed value, keeping only what the pre-scan needs (strings and booleans are `other`). */
type Val =
  | { t: 'name'; v: string }
  | { t: 'num'; v: number }
  | { t: 'ref' }
  | { t: 'null' }
  | { t: 'other' }
  | { t: 'arr'; items: Val[]; size: number }
  | { t: 'dict'; map: Map<string, Val> }
  | { t: 'stream'; map: Map<string, Val>; start: number; end: number };
type StreamVal = {
  t: 'stream';
  map: Map<string, Val>;
  start: number;
  end: number;
};
const REF: Val = { t: 'ref' };
const NULL: Val = { t: 'null' };
const OTHER: Val = { t: 'other' };
/** Array items kept per array (the rest are only counted). */
const ARRAY_ITEMS_KEPT = 1024;

/**
 * pdf-lib's parser (PDFParser / PDFObjectParser / BaseParser in 1.17), restated over raw bytes
 * without building its objects. Any input pdf-lib would refuse (with `throwOnInvalidObject`) is
 * refused here too, so on every input that gets through, both walk the same tokens: in
 * particular the same streams, whose data both skip by a direct /Length followed by
 * `endstream`, else by pdf-lib's forward search for `endstream` (which counts nested `stream`
 * keywords). Comments, strings, hex strings and escaped names are all handled as pdf-lib does.
 */
class Scanner {
  readonly b: Buffer;
  readonly n: number;
  readonly onName: ((name: string) => void) | undefined;
  pos = 0;
  depth = 0;
  objects = 0;
  streams = 0;
  inflated = 0;
  /** Bytes looked at while skipping junk between objects (which retries at every byte). */
  work = 0;
  readonly workBudget: number;

  constructor(bytes: Buffer, onName?: (name: string) => void) {
    this.b = bytes;
    this.n = bytes.length;
    this.onName = onName;
    this.workBudget = 16 * bytes.length + 1_000_000;
  }

  run(): void {
    if (!this.match(KW.header)) throw refuse.notPdf();
    this.rawInt();
    if (this.b[this.pos] !== PERIOD) throw refuse.unreadable();
    this.pos++;
    this.rawInt();
    // pdf-lib's skipBinaryHeaderComment: on failure it carries on from where the header failed.
    this.skipWsc();
    const start = this.pos;
    if (this.objectHeader()) this.pos = start;
    else {
      this.pos++;
      this.skipWsc();
    }
    let previous = -1;
    while (this.pos < this.n) {
      this.section();
      if (this.pos === previous) throw refuse.unreadable();
      previous = this.pos;
    }
  }

  private section(): void {
    this.skipWsc();
    while (this.pos < this.n && DIGIT[this.b[this.pos]]) {
      this.indirectObject();
      this.skipWsc();
      this.skipJibberish();
    }
    this.skipWsc();
    if (this.match(KW.xref)) {
      this.skipWsc();
      while (this.pos < this.n && DIGIT[this.b[this.pos]]) {
        this.rawInt();
        this.skipWsc();
        this.rawInt();
        this.skipWsc();
        const c = this.b[this.pos];
        if (c === LOWER_N || c === LOWER_F) this.pos++;
        this.skipWsc();
      }
    }
    this.skipWsc();
    if (this.match(KW.trailer)) {
      this.skipWsc();
      if (this.dict().has('Encrypt')) throw refuse.encrypted();
    }
    this.skipWsc();
    if (this.match(KW.startxref)) {
      this.skipWsc();
      this.rawInt();
      this.skipWs();
      this.match(KW.eof);
      this.skipWsc();
      this.match(KW.eof);
      this.skipWsc();
    }
    this.skipJibberish();
  }

  private indirectObject(): void {
    if (!this.objectHeader()) throw refuse.unreadable();
    if (++this.objects > MAX_OBJECTS) throw refuse.tooComplex();
    this.skipWsc();
    const value = this.object();
    this.skipWsc();
    this.match(KW.endobj);
    if (value.t !== 'stream') return;
    const type = value.map.get('Type');
    // pdf-lib resolves an indirect /Type against what it has parsed so far: can't be followed.
    if (type?.t === 'ref') throw refuse.unchecked();
    if (type?.t !== 'name') return;
    if (type.v === 'ObjStm') this.objectStream(value);
    else if (type.v === 'XRef') this.xrefStream(value);
  }

  /** pdf-lib's skipJibberish: up to the next `xref`, `trailer`, `startxref` or `N G obj`. */
  private skipJibberish(): void {
    this.skipWsc();
    while (this.pos < this.n) {
      const start = this.pos;
      const c = this.b[start];
      if (c >= 0x20 && c <= 0x7e) {
        const found =
          this.match(KW.xref) ||
          this.match(KW.trailer) ||
          this.match(KW.startxref) ||
          this.objectHeader();
        this.work += Math.max(this.pos - start, 0) + 1;
        if (this.work > this.workBudget) throw refuse.tooComplex();
        this.pos = start;
        if (found) return;
      }
      this.pos++;
    }
  }

  /** `N G obj`, leaving the position where it stopped (pdf-lib doesn't always rewind). */
  private objectHeader(): boolean {
    this.skipWsc();
    if (Number.isNaN(this.tryRawInt())) return false;
    this.skipWsc();
    if (Number.isNaN(this.tryRawInt())) return false;
    this.skipWsc();
    return this.match(KW.obj);
  }

  private object(): Val {
    this.skipWsc();
    if (this.match(KW.true) || this.match(KW.false)) return OTHER;
    if (this.match(KW.null)) return NULL;
    if (this.pos >= this.n) throw refuse.unreadable();
    const c = this.b[this.pos];
    if (c === LT && this.b[this.pos + 1] === LT) return this.dictOrStream();
    if (c === LT) return this.hexString();
    if (c === LPAREN) return this.literalString();
    if (c === SLASH) return { t: 'name', v: this.name() };
    if (c === LBRACKET) return this.array();
    if (NUMERIC[c]) return this.numberOrRef();
    throw refuse.unreadable();
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw refuse.tooComplex();
  }

  private dict(): Map<string, Val> {
    if (this.b[this.pos] !== LT || this.b[this.pos + 1] !== LT)
      throw refuse.unreadable();
    this.enter();
    this.pos += 2;
    this.skipWsc();
    const map = new Map<string, Val>();
    // pdf-lib's loop condition, quirk included (it stops when either of the next two is `>`).
    while (
      this.pos < this.n &&
      this.b[this.pos] !== GT &&
      this.b[this.pos + 1] !== GT
    ) {
      if (this.b[this.pos] !== SLASH) throw refuse.unreadable();
      const key = this.name();
      map.set(key, this.object());
      this.skipWsc();
    }
    this.skipWsc();
    if (this.b[this.pos] !== GT || this.b[this.pos + 1] !== GT)
      throw refuse.unreadable();
    this.pos += 2;
    this.depth--;
    return map;
  }

  private dictOrStream(): Val {
    const map = this.dict();
    this.skipWsc();
    if (!KW.streamEols.some((kw) => this.match(kw))) return { t: 'dict', map };
    if (++this.streams > MAX_STREAMS) throw refuse.tooComplex();
    const start = this.pos;
    let end: number;
    const length = map.get('Length');
    if (length?.t === 'num') {
      // pdf-lib would jump backwards (or to a fraction) here: refuse instead of following it.
      if (!Number.isInteger(length.v) || length.v < 0)
        throw refuse.unreadable();
      end = start + length.v;
      this.pos = end;
      this.skipWsc();
      if (!this.match(KW.endstream)) {
        this.pos = start;
        end = this.endOfStream();
      }
    } else {
      end = this.endOfStream();
    }
    const stream: StreamVal = { t: 'stream', map, start, end };
    this.filters(stream);
    return stream;
  }

  /** pdf-lib's findEndOfStreamFallback: `endstream`, counting any `stream` met on the way. */
  private endOfStream(): number {
    let nesting = 1;
    let end = this.pos;
    while (this.pos < this.n) {
      end = this.pos;
      if (this.match(KW.stream)) nesting++;
      else if (KW.endstreams.some((kw) => this.match(kw))) nesting--;
      else this.pos++;
      if (nesting === 0) return end;
    }
    throw refuse.unreadable();
  }

  private hexString(): Val {
    this.pos++;
    while (this.pos < this.n && this.b[this.pos] !== GT) this.pos++;
    if (this.pos >= this.n) throw refuse.unreadable();
    this.pos++;
    return OTHER;
  }

  private literalString(): Val {
    let nesting = 0;
    let escaped = false;
    while (this.pos < this.n) {
      const c = this.b[this.pos++];
      if (!escaped) {
        if (c === LPAREN) nesting++;
        if (c === RPAREN) nesting--;
      }
      if (c === BACKSLASH) escaped = !escaped;
      else if (escaped) escaped = false;
      if (nesting === 0) return OTHER;
    }
    throw refuse.unreadable();
  }

  private name(): string {
    const start = ++this.pos;
    while (this.pos < this.n) {
      const c = this.b[this.pos];
      if (WHITESPACE[c] || DELIMITER[c]) break;
      this.pos++;
    }
    const raw = this.b.toString('latin1', start, this.pos);
    this.onName?.(raw);
    return pdfLibName(raw);
  }

  private array(): Val {
    this.enter();
    this.pos++;
    this.skipWsc();
    const items: Val[] = [];
    let size = 0;
    while (this.b[this.pos] !== RBRACKET) {
      const item = this.object();
      if (size < ARRAY_ITEMS_KEPT) items.push(item);
      size++;
      this.skipWsc();
    }
    this.pos++;
    this.depth--;
    return { t: 'arr', items, size };
  }

  private numberOrRef(): Val {
    const first = this.rawNumber();
    this.skipWsc();
    const lookahead = this.pos;
    if (DIGIT[this.b[this.pos]]) {
      this.rawNumber();
      this.skipWsc();
      if (this.b[this.pos] === UPPER_R) {
        this.pos++;
        return REF;
      }
    }
    this.pos = lookahead;
    return { t: 'num', v: first };
  }

  private rawNumber(): number {
    const start = this.pos;
    while (this.pos < this.n) {
      const c = this.b[this.pos];
      if (!NUMERIC[c]) break;
      this.pos++;
      if (c === PERIOD) break;
    }
    while (this.pos < this.n && DIGIT[this.b[this.pos]]) this.pos++;
    const text = this.b.toString('latin1', start, this.pos);
    const value = Number(text);
    if (!text || !Number.isFinite(value)) throw refuse.unreadable();
    return value;
  }

  private tryRawInt(): number {
    const start = this.pos;
    while (this.pos < this.n && DIGIT[this.b[this.pos]]) this.pos++;
    if (this.pos === start) return NaN;
    const value = Number(this.b.toString('latin1', start, this.pos));
    return Number.isFinite(value) ? value : NaN;
  }

  private rawInt(): number {
    const value = this.tryRawInt();
    if (Number.isNaN(value)) throw refuse.unreadable();
    return value;
  }

  private skipWs(): void {
    while (this.pos < this.n && WHITESPACE[this.b[this.pos]]) this.pos++;
  }

  private skipWsc(): void {
    this.skipWs();
    while (this.b[this.pos] === PERCENT) {
      while (
        this.pos < this.n &&
        this.b[this.pos] !== LF &&
        this.b[this.pos] !== CR
      )
        this.pos++;
      this.skipWs();
    }
  }

  private match(keyword: Uint8Array): boolean {
    const { b, pos } = this;
    if (pos + keyword.length > this.n) return false;
    for (let i = 0; i < keyword.length; i++)
      if (b[pos + i] !== keyword[i]) return false;
    this.pos = pos + keyword.length;
    return true;
  }

  /**
   * The stream's filter chain: at most two filters and one FlateDecode, written directly. Only
   * object and xref streams are decoded while loading, but no stream needs more than this.
   */
  private filters(stream: StreamVal): string[] {
    const filter = stream.map.get('Filter');
    let names: string[];
    if (filter === undefined || filter.t === 'null') names = [];
    else if (filter.t === 'name') names = [filter.v];
    else if (
      filter.t === 'arr' &&
      filter.items.every((item) => item.t === 'name')
    ) {
      names = filter.items.map((item) => (item as { v: string }).v);
      if (filter.size !== names.length) throw refuse.tooComplex();
    } else throw refuse.unchecked();
    if (names.length > 2) throw refuse.tooComplex();
    if (
      names.filter((name) => name === 'FlateDecode' || name === 'Fl').length > 1
    ) {
      throw refuse.tooComplex();
    }
    return names;
  }

  /** Plain or FlateDecode only, no /DecodeParms; /N and /First direct. */
  private objectStream(stream: StreamVal): void {
    const names = this.filters(stream);
    if (
      names.length > 1 ||
      (names.length === 1 && names[0] !== 'FlateDecode')
    ) {
      throw refuse.unchecked();
    }
    const parms = stream.map.get('DecodeParms');
    if (parms !== undefined && parms.t !== 'null') throw refuse.unchecked();
    const count = stream.map.get('N');
    const first = stream.map.get('First');
    if (!isCount(count) || !isCount(first)) throw refuse.unchecked();
    this.objects += count.v;
    if (this.objects > MAX_OBJECTS) throw refuse.tooComplex();
    this.inflate(stream, names);
  }

  /** As an object stream, but /DecodeParms may set a (bounded) PNG predictor; sizes bounded. */
  private xrefStream(stream: StreamVal): void {
    if (stream.map.has('Encrypt')) throw refuse.encrypted();
    const names = this.filters(stream);
    if (
      names.length > 1 ||
      (names.length === 1 && names[0] !== 'FlateDecode')
    ) {
      throw refuse.unchecked();
    }
    let parms = stream.map.get('DecodeParms');
    if (parms?.t === 'arr' && parms.size === 1) parms = parms.items[0];
    if (parms !== undefined && parms.t !== 'null') {
      if (parms.t !== 'dict') throw refuse.unchecked();
      for (const [key, value] of parms.map) {
        const allowed = XREF_PARMS[key];
        if (!allowed || value.t !== 'num' || !allowed(value.v))
          throw refuse.unchecked();
      }
    }
    const size = stream.map.get('Size');
    if (!isCount(size) || size.v > MAX_XREF_ENTRIES) throw refuse.unchecked();
    const index = stream.map.get('Index');
    if (index !== undefined) {
      if (
        index.t !== 'arr' ||
        index.size !== index.items.length ||
        index.size % 2
      ) {
        throw refuse.unchecked();
      }
      let entries = 0;
      for (let i = 0; i < index.items.length; i += 2) {
        const [from, length] = [index.items[i], index.items[i + 1]];
        if (!isCount(from) || !isCount(length)) throw refuse.unchecked();
        entries += length.v;
      }
      if (entries > MAX_XREF_ENTRIES) throw refuse.unchecked();
    }
    const widths = stream.map.get('W');
    if (
      widths !== undefined &&
      (widths.t !== 'arr' ||
        widths.size !== 3 ||
        !widths.items.every((w) => isCount(w) && w.v <= 8))
    ) {
      throw refuse.unchecked();
    }
    this.inflate(stream, names);
  }

  /** Decompresses with a cap, as pdf-lib's FlateStream would (no Adler-32 check, as there). */
  private inflate(stream: StreamVal, names: string[]): void {
    if (names.length === 0) return;
    const data = this.b.subarray(stream.start, stream.end);
    const [cmf, flg] = [data[0], data[1]];
    if (
      data.length < 2 ||
      (cmf & 0x0f) !== 8 ||
      ((cmf << 8) + flg) % 31 !== 0 ||
      flg & 0x20
    ) {
      throw refuse.damaged();
    }
    const room = MAX_INFLATE_TOTAL - this.inflated;
    if (room <= 0) throw refuse.tooComplex();
    let out: Buffer;
    try {
      out = inflateRawSync(data.subarray(2), {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
        maxOutputLength: Math.min(MAX_INFLATE_EACH, room),
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
        throw refuse.tooComplex();
      throw refuse.damaged();
    }
    this.inflated += out.length;
  }
}

const isCount = (v: Val | undefined): v is { t: 'num'; v: number } =>
  v?.t === 'num' && Number.isInteger(v.v) && v.v >= 0;

const XREF_PARMS: Record<string, ((v: number) => boolean) | undefined> = {
  Predictor: (v) => v === 1 || v === 2 || (v >= 10 && v <= 15),
  Columns: (v) => Number.isInteger(v) && v >= 1 && v <= 64,
  Colors: (v) => Number.isInteger(v) && v >= 1 && v <= 4,
  BitsPerComponent: (v) => [1, 2, 4, 8, 16].includes(v),
};

// ---------------------------------------------------------------------------------------------
// 2. Clean
// ---------------------------------------------------------------------------------------------

const name = (n: string) => PDFName.of(n);
const N = {
  S: name('S'),
  Subtype: name('Subtype'),
  Type: name('Type'),
  Next: name('Next'),
  OpenAction: name('OpenAction'),
  Font: name('Font'),
  Image: name('Image'),
  Form: name('Form'),
  EmbeddedFile: name('EmbeddedFile'),
};

const LABEL = {
  js: 'JavaScript actions',
  auto: 'automatic actions (run when pages open or form fields are used)',
  open: 'an action that runs when the PDF opens',
  files: 'embedded files',
  attachments: 'file attachments',
  media: 'sound, video and 3D content',
  xfa: 'XFA form data',
  launch: 'links that open programs or other files',
  submit: 'actions that send or import form data',
};

const byName = (entries: [string, string][]) =>
  new Map(entries.map(([key, label]) => [name(key), label]));
/** Action types (`/S`) that are removed; GoTo and URI (and other harmless ones) stay. */
const FORBIDDEN_ACTIONS = byName([
  ['JavaScript', LABEL.js],
  ['Launch', LABEL.launch],
  ['GoToE', LABEL.launch],
  ['GoToR', LABEL.launch],
  ['SubmitForm', LABEL.submit],
  ['ImportData', LABEL.submit],
  ['Rendition', LABEL.media],
  ['Movie', LABEL.media],
  ['Sound', LABEL.media],
  ['3D', LABEL.media],
]);
/** Annotation (and media object) subtypes that are removed. */
const FORBIDDEN_SUBTYPES = byName([
  ['FileAttachment', LABEL.attachments],
  ['Sound', LABEL.media],
  ['Movie', LABEL.media],
  ['Screen', LABEL.media],
  ['RichMedia', LABEL.media],
  ['3D', LABEL.media],
]);
/** Keys removed from any dictionary: additional actions, scripts, embedded files, XFA. */
const STRIPPED_KEYS = byName([
  ['AA', LABEL.auto],
  ['JS', LABEL.js],
  ['JavaScript', LABEL.js],
  ['EF', LABEL.files],
  ['EmbeddedFiles', LABEL.files],
  ['XFA', LABEL.xfa],
]);
const dictOf = (obj: PDFObject | undefined): PDFDict | undefined =>
  obj instanceof PDFDict
    ? obj
    : obj instanceof PDFStream
      ? obj.dict
      : undefined;
const resolve = (ctx: PDFContext, obj: PDFObject | undefined) =>
  obj instanceof PDFRef ? ctx.lookup(obj) : obj;

/** Why this object must go, if it must: a forbidden action or annotation, or an embedded file. */
function forbidden(
  ctx: PDFContext,
  obj: PDFObject | undefined,
): string | undefined {
  const dict = dictOf(obj);
  if (!dict) return undefined;
  const s = resolve(ctx, dict.get(N.S));
  if (s instanceof PDFName && FORBIDDEN_ACTIONS.has(s))
    return FORBIDDEN_ACTIONS.get(s);
  const subtype = resolve(ctx, dict.get(N.Subtype));
  if (subtype instanceof PDFName && FORBIDDEN_SUBTYPES.has(subtype)) {
    return FORBIDDEN_SUBTYPES.get(subtype);
  }
  if (
    obj instanceof PDFStream &&
    resolve(ctx, dict.get(N.Type)) === N.EmbeddedFile
  ) {
    return LABEL.files;
  }
  return undefined;
}

// No exception for a resource that happens to be named /AA, /JS or /EF (security review): the
// key is always removed, whatever its value says it is, and what only it referred to is then
// collected as garbage. At worst a font or image so named goes missing from the copy.

class Cleaner {
  readonly ctx: PDFContext;
  readonly removed = new Set<string>();
  constructor(ctx: PDFContext) {
    this.ctx = ctx;
  }

  /** Every object pdf-lib holds, reachable or not; then drops what nothing refers to. */
  run(): string[] {
    const doomed: PDFRef[] = [];
    for (const [ref, obj] of this.ctx.enumerateIndirectObjects()) {
      this.clean(obj);
      const label = forbidden(this.ctx, obj);
      if (label) {
        doomed.push(ref);
        this.removed.add(label);
      }
    }
    for (const ref of doomed) this.ctx.delete(ref);
    collectGarbage(this.ctx);
    return [...this.removed];
  }

  private clean(obj: PDFObject): void {
    const dict = dictOf(obj);
    if (dict) this.cleanDict(dict);
    else if (obj instanceof PDFArray) this.cleanArray(obj);
  }

  private cleanDict(dict: PDFDict): void {
    for (const [key, value] of dict.entries()) {
      const target = resolve(this.ctx, value);
      const stripped = STRIPPED_KEYS.get(key);
      if (stripped) {
        dict.delete(key);
        this.removed.add(stripped);
        continue;
      }
      if (key === N.OpenAction && dictOf(target)) {
        // An action (`<< /S … >>`); a destination (array, name or string) stays.
        dict.delete(key);
        this.removed.add(forbidden(this.ctx, target) ?? LABEL.open);
        continue;
      }
      if (key === N.Next) {
        this.spliceNext(dict);
        const next = dict.get(N.Next);
        if (next && !(next instanceof PDFRef)) this.clean(next);
        continue;
      }
      const label = forbidden(this.ctx, target);
      if (label) {
        dict.delete(key);
        this.removed.add(label);
        continue;
      }
      if (!(value instanceof PDFRef)) this.clean(value);
    }
  }

  private cleanArray(array: PDFArray): void {
    for (let i = array.size() - 1; i >= 0; i--) {
      const value = array.get(i);
      const label = forbidden(this.ctx, resolve(this.ctx, value));
      if (label) {
        array.remove(i);
        this.removed.add(label);
      } else if (!(value instanceof PDFRef)) this.clean(value);
    }
  }

  /** Takes forbidden actions out of a `/Next` chain, keeping the ones after them. */
  private spliceNext(dict: PDFDict): void {
    for (let hops = 0; hops < 64; hops++) {
      const target = resolve(this.ctx, dict.get(N.Next));
      const label = forbidden(this.ctx, target);
      if (!label) return;
      this.removed.add(label);
      const after = dictOf(target)?.get(N.Next);
      if (after) dict.set(N.Next, after);
      else dict.delete(N.Next);
    }
    dict.delete(N.Next);
  }
}

/** Deletes objects not reachable from the trailer, so the saved file holds only what is used. */
function collectGarbage(ctx: PDFContext): void {
  const keep = new Set<PDFRef>();
  const stack: PDFObject[] = [];
  const { Root, Info } = ctx.trailerInfo;
  if (Root) stack.push(Root);
  if (Info) stack.push(Info);
  while (stack.length > 0) {
    const obj = stack.pop() as PDFObject;
    if (obj instanceof PDFRef) {
      if (keep.has(obj)) continue;
      keep.add(obj);
      const target = ctx.lookup(obj);
      if (target) stack.push(target);
      continue;
    }
    const dict = dictOf(obj);
    if (dict) stack.push(...dict.values());
    else if (obj instanceof PDFArray) stack.push(...obj.asArray());
  }
  let largest = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!keep.has(ref)) ctx.delete(ref);
    else largest = Math.max(largest, ref.objectNumber);
  }
  // The trailer's /Size follows the objects kept, so cleaning a cleaned file changes nothing.
  ctx.largestObjectNumber = largest;
}

// ---------------------------------------------------------------------------------------------
// 3. Re-check
// ---------------------------------------------------------------------------------------------

/** Names that mean active content wherever they appear in the saved file, outside streams. */
const ACTIVE_NAMES = new Set([
  'JavaScript',
  'EmbeddedFile',
  'EmbeddedFiles',
  'XFA',
  'RichMedia',
  'FileAttachment',
  'Launch',
  'GoToE',
  'GoToR',
  'SubmitForm',
  'ImportData',
  'Rendition',
]);
const ACTIVE_KEYS = new Set([
  'JavaScript',
  'JS',
  'AA',
  'EF',
  'EmbeddedFiles',
  'XFA',
]);
const FORBIDDEN_S = new Set(
  [...FORBIDDEN_ACTIONS.keys()].map((n) => n.decodeText()),
);
const FORBIDDEN_SUBTYPE_NAMES = new Set(
  [...FORBIDDEN_SUBTYPES.keys()].map((n) => n.decodeText()),
);
const nameText = (n: PDFName) => anyCaseName(n.asString().slice(1));

function findActive(ctx: PDFContext): string | undefined {
  const seen = new Set<PDFObject>();
  const stack: PDFObject[] = ctx
    .enumerateIndirectObjects()
    .map(([, obj]) => obj);
  while (stack.length > 0) {
    const obj = stack.pop() as PDFObject;
    if (seen.has(obj)) continue;
    seen.add(obj);
    if (obj instanceof PDFName) {
      if (ACTIVE_NAMES.has(nameText(obj))) return `/${nameText(obj)}`;
      continue;
    }
    if (obj instanceof PDFArray) {
      stack.push(...obj.asArray());
      continue;
    }
    const dict = dictOf(obj);
    if (!dict) continue;
    for (const [key, value] of dict.entries()) {
      const k = nameText(key);
      const target = resolve(ctx, value);
      if (ACTIVE_KEYS.has(k)) return `/${k}`;
      if (k === 'OpenAction' && dictOf(target)) return 'an /OpenAction action';
      if (value instanceof PDFName) {
        if (k === 'S' && FORBIDDEN_S.has(nameText(value)))
          return `/${nameText(value)}`;
        if (k === 'Subtype' && FORBIDDEN_SUBTYPE_NAMES.has(nameText(value))) {
          return `/${nameText(value)}`;
        }
      }
      if (!(value instanceof PDFRef)) stack.push(value);
    }
  }
  return undefined;
}

async function load(
  bytes: Uint8Array,
): Promise<{ doc: PDFDocument; pages: number }> {
  try {
    const doc = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    // A missing catalog or page tree fails here rather than in load().
    return { doc, pages: doc.getPageCount() };
  } catch (err) {
    // pdf-lib 1.17 throws a plain Error for encryption.
    if (/\bis encrypted\b/.test(String((err as Error | undefined)?.message))) {
      throw refuse.encrypted();
    }
    throw refuse.unreadable();
  }
}

export interface CleanResult {
  cleaned: Uint8Array;
  removed: string[];
  pages: number;
}

/** Steps 1–3 on the calling thread (`cleanPdf` in `index.ts` runs this inside the worker). */
export async function cleanPdfBytes(input: Uint8Array): Promise<CleanResult> {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > MAX_PDF_BYTES) throw refuse.tooLarge();
  new Scanner(bytes).run();
  const { doc, pages } = await load(bytes);
  if (doc.isEncrypted) throw refuse.encrypted();
  if (pages === 0) throw refuse.noPages();
  const removed = new Cleaner(doc.context).run();
  const cleaned = await doc.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });

  // The saved file: names outside streams (its streams all have exact lengths now) …
  let raw: string | undefined;
  new Scanner(
    Buffer.from(cleaned.buffer, cleaned.byteOffset, cleaned.byteLength),
    (n) => {
      raw ??= ACTIVE_NAMES.has(anyCaseName(n))
        ? `/${anyCaseName(n)}`
        : undefined;
    },
  ).run();
  if (raw) throw refuse.active(raw);
  // … and every object of it, as pdf-lib reads it back.
  const check = await load(cleaned);
  const found = findActive(check.doc.context);
  if (found) throw refuse.active(found);
  return { cleaned, removed, pages };
}

// ---------------------------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------------------------

export const WORKER_TAG = 'legal-pdf-clean';

export type WorkerReply =
  | { ok: true; cleaned: Uint8Array; removed: string[]; pages: number }
  | { ok: false; code: PdfRefusalCode; message: string }
  | { ok: false; code?: undefined; message: string };

const data = workerData as { tag?: string; bytes?: Uint8Array } | null;
if (parentPort && data?.tag === WORKER_TAG && data.bytes) {
  const port = parentPort;
  cleanPdfBytes(data.bytes).then(
    (result) => {
      const reply: WorkerReply = { ok: true, ...result };
      port.postMessage(reply, [result.cleaned.buffer as ArrayBuffer]);
    },
    (err: unknown) => {
      let reply: WorkerReply;
      if (err instanceof PdfRefusal)
        reply = { ok: false, code: err.code, message: err.message };
      // Out of stack or array/string space: the input is too big for the limits.
      else if (err instanceof RangeError) {
        const refusal = refuse.tooComplex();
        reply = { ok: false, code: refusal.code, message: refusal.message };
      } else
        reply = {
          ok: false,
          message: String((err as Error | undefined)?.message ?? err),
        };
      port.postMessage(reply);
    },
  );
}
