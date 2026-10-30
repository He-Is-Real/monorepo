import { constants, deflateRawSync, deflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
  StandardFonts,
} from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import { cleanPdf, MAX_PDF_BYTES, PdfRefused } from './index';

// ---------------------------------------------------------------------------------------------
// Fixtures, written as raw PDF bytes
// ---------------------------------------------------------------------------------------------

const latin = (text: string) => Buffer.from(text, 'latin1');
type Part = { num: number; body: string | Buffer } | string;

/**
 * A PDF (or, given `base`, an incremental update appended to one): the parts in order (a string
 * is written as is, between objects), an xref table for the objects and a trailer.
 */
function pdf(parts: Part[], trailer: string, base?: Buffer): Buffer {
  const chunks: Buffer[] = [base ?? latin('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  let length = chunks[0].length;
  const push = (data: string | Buffer) => {
    const buf = typeof data === 'string' ? latin(data) : data;
    chunks.push(buf);
    length += buf.length;
  };
  const offsets = new Map<number, number>();
  for (const part of parts) {
    if (typeof part === 'string') {
      push(part);
      continue;
    }
    offsets.set(part.num, length);
    push(`${part.num} 0 obj\n`);
    push(part.body);
    push('\nendobj\n');
  }
  const xref = length;
  push(base ? 'xref\n' : 'xref\n0 1\n0000000000 65535 f \n');
  const nums = [...offsets.keys()].sort((a, b) => a - b);
  for (const num of nums) {
    push(`${num} 1\n${String(offsets.get(num)).padStart(10, '0')} 00000 n \n`);
  }
  const prev = base
    ? ` /Prev ${/startxref\s+(\d+)\s+%%EOF\s*$/.exec(base.toString('latin1'))?.[1]}`
    : '';
  push(
    `trailer\n<< /Size ${Math.max(...nums) + 1} ${trailer}${prev} >>\nstartxref\n${xref}\n%%EOF\n`,
  );
  return Buffer.concat(chunks);
}

/** A stream object's text: `dict`, a direct /Length unless `length` is false, the data. */
function stream(
  dict: string,
  data: Buffer,
  { length = true, eol = '\r\n' } = {},
): Buffer {
  const len = length ? ` /Length ${data.length}` : '';
  return Buffer.concat([
    latin(`<< ${dict}${len} >>\nstream${eol}`),
    data,
    latin('\nendstream'),
  ]);
}

/** An object stream's data: the `num offset` header, then the objects. */
function objectStreamData(objects: [number, string][]): {
  data: Buffer;
  first: number;
} {
  let offset = 0;
  const header: string[] = [];
  const bodies: string[] = [];
  for (const [num, body] of objects) {
    header.push(`${num} ${offset}`);
    bodies.push(body);
    offset += body.length + 1;
  }
  const head = `${header.join(' ')}\n`;
  return { data: latin(head + bodies.join('\n') + '\n'), first: head.length };
}

/** Catalog 1, page tree 2, page 3, content 4. */
const basic = ({ catalog = '', page = '' } = {}): Part[] => [
  { num: 1, body: `<< /Type /Catalog /Pages 2 0 R${catalog} >>` },
  { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  {
    num: 3,
    body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >>${page} >>`,
  },
  { num: 4, body: stream('', latin('0 0 m 100 100 l S')) },
];

/**
 * zlib data that inflates to `total` zero bytes, built without allocating them: one
 * full-flushed (self-contained) deflate block of 16 MB of zeros, repeated.
 */
function zlibZeros(total: number): Buffer {
  const chunk = 16 * 1024 * 1024;
  const block = deflateRawSync(Buffer.alloc(chunk), {
    finishFlush: constants.Z_FULL_FLUSH,
  });
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE((((total % 65521) << 16) | 1) >>> 0);
  return Buffer.concat([
    Buffer.from([0x78, 0x9c]),
    ...Array<Buffer>(total / chunk).fill(block),
    deflateRawSync(Buffer.alloc(0)),
    adler,
  ]);
}

// ---------------------------------------------------------------------------------------------
// What a cleaned file must not have, checked independently of the cleaner
// ---------------------------------------------------------------------------------------------

const ACTIVE = new Set([
  'JavaScript',
  'JS',
  'AA',
  'Launch',
  'EmbeddedFile',
  'EmbeddedFiles',
  'EF',
  'XFA',
  'RichMedia',
  'FileAttachment',
  'GoToE',
  'GoToR',
  'SubmitForm',
  'ImportData',
]);
const decoded = (n: PDFName) =>
  n
    .asString()
    .slice(1)
    .replace(/#([\da-fA-F]{2})/g, (_, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );

async function activeContentIn(bytes: Buffer): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const found: string[] = [];
  const visit = (obj: PDFObject | undefined, depth = 0): void => {
    if (depth > 100 || obj === undefined) return;
    if (obj instanceof PDFName && ACTIVE.has(decoded(obj)))
      found.push(decoded(obj));
    if (obj instanceof PDFArray)
      obj.asArray().forEach((v) => visit(v, depth + 1));
    const dict =
      obj instanceof PDFDict
        ? obj
        : obj instanceof PDFStream
          ? obj.dict
          : undefined;
    for (const [key, value] of dict?.entries() ?? []) {
      if (ACTIVE.has(decoded(key))) found.push(decoded(key));
      const target =
        value instanceof PDFRef ? doc.context.lookup(value) : value;
      if (decoded(key) === 'OpenAction' && target instanceof PDFDict)
        found.push('OpenAction');
      visit(value, depth + 1);
    }
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) visit(obj);
  return found;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PdfRefused);
  return (err as PdfRefused).code;
}

const rootNumber = async (bytes: Buffer) =>
  (
    (await PDFDocument.load(bytes, { updateMetadata: false })).context
      .trailerInfo.Root as PDFRef
  ).objectNumber;

// ---------------------------------------------------------------------------------------------

describe('cleanPdf', () => {
  /** A visible catalog, a hidden one behind a `%stream` comment, then shadowing updates. */
  function shadowed(info = ''): Buffer {
    const original = pdf(
      [
        ...basic(),
        '%stream\n',
        { num: 5, body: '<< /S /JavaScript /JS (app.alert\\(1\\)) >>' },
        {
          num: 6,
          body: '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R /Names << /JavaScript << /Names [(a) 5 0 R] >> >> >>',
        },
        '%endstream\n',
        ...(info ? [{ num: 8, body: info }] : []),
      ],
      `/Root 6 0 R${info ? ' /Info 8 0 R' : ''}`,
    );
    return pdf(
      [
        {
          num: 1,
          body: '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (shadow) >> /AA << /WC << /S /JavaScript /JS (x) >> >> >>',
        },
        {
          num: 3,
          body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> /Annots [7 0 R] /AA << /O << /S /JavaScript /JS (y) >> >> >>',
        },
        {
          num: 7,
          body: '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /Launch /F (calc.exe) >> >>',
        },
      ],
      `/Root 1 0 R${info ? ' /Info 8 0 R' : ''}`,
      original,
    );
  }

  async function expectShadowedCleaned(input: Buffer) {
    const result = await cleanPdf(input);
    expect(await activeContentIn(result.cleaned)).toEqual([]);
    expect(result.cleaned.toString('latin1')).not.toMatch(
      /JavaScript|calc\.exe|app\.alert/,
    );
    expect(result.removed).toEqual(
      expect.arrayContaining([
        'JavaScript actions',
        'automatic actions (run when pages open or form fields are used)',
        'links that open programs or other files',
      ]),
    );
    // The cleaned file's catalog is the one pdf-lib resolved in the upload.
    expect(await rootNumber(result.cleaned)).toBe(await rootNumber(input));
    const out = await PDFDocument.load(result.cleaned);
    expect(out.getPageCount()).toBe(1);
    const annots = out.getPage(0).node.Annots();
    expect(annots?.size()).toBe(1);
    expect(
      out.context.lookup(annots?.get(0), PDFDict).get(PDFName.of('A')),
    ).toBeUndefined();
    return result;
  }

  it('p1: removes scripts from a file with a %stream comment and shadowing updates', async () => {
    await expectShadowedCleaned(shadowed());
  });

  it('p1b: the same with the word stream inside a string in the Info dictionary', async () => {
    const result = await expectShadowedCleaned(
      shadowed('<< /Title (a stream of words \\(endstream\\) stream) >>'),
    );
    const out = await PDFDocument.load(result.cleaned, {
      updateMetadata: false,
    });
    expect(out.getTitle()).toBe('a stream of words (endstream) stream');
  });

  it('p2: an untyped object stream with a scripted catalog and an xref stream into it', async () => {
    const { data, first } = objectStreamData([
      [11, '<< /Type /Catalog /Pages 2 0 R /OpenAction 12 0 R >>'],
      [12, '<< /S /JavaScript /JS (evil) >>'],
    ]);
    const head = latin('%PDF-1.7\n');
    const parts: [number, Buffer][] = [
      ...basic().map((p) => {
        const { num, body } = p as { num: number; body: string | Buffer };
        return [num, typeof body === 'string' ? latin(body) : body] as [
          number,
          Buffer,
        ];
      }),
      [10, stream(`/N 2 /First ${first}`, data)],
    ];
    const chunks: Buffer[] = [head];
    const offsets = new Map<number, number>();
    let length = head.length;
    for (const [num, body] of parts) {
      const obj = Buffer.concat([
        latin(`${num} 0 obj\n`),
        body,
        latin('\nendobj\n'),
      ]);
      offsets.set(num, length);
      chunks.push(obj);
      length += obj.length;
    }
    offsets.set(20, length);
    const entries = Buffer.alloc(21 * 7);
    for (let num = 0; num < 21; num++) {
      const at = num * 7;
      if (offsets.has(num)) {
        entries[at] = 1;
        entries.writeUInt32BE(offsets.get(num) as number, at + 1);
      } else if (num === 11 || num === 12) {
        entries[at] = 2;
        entries.writeUInt32BE(10, at + 1);
        entries.writeUInt16BE(num - 11, at + 5);
      }
    }
    const xref = deflateSync(entries);
    chunks.push(
      latin('20 0 obj\n'),
      stream(
        '/Type /XRef /Size 21 /W [1 4 2] /Root 11 0 R /Filter /FlateDecode',
        xref,
      ),
      latin(`\nendobj\nstartxref\n${length}\n%%EOF\n`),
    );
    const input = Buffer.concat(chunks);

    const result = await cleanPdf(input).catch((e: unknown) => e);
    if (result instanceof PdfRefused) return; // Refusing is acceptable too.
    const { cleaned } = result as { cleaned: Buffer };
    expect(await activeContentIn(cleaned)).toEqual([]);
    expect(cleaned.toString('latin1')).not.toMatch(
      /ObjStm|XRef|evil|JavaScript/,
    );
  });

  it('p2b: a /Type %comment /ObjStm object stream holding a Launch action', async () => {
    const { data, first } = objectStreamData([
      [11, '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A 12 0 R >>'],
      [12, '<< /S /Launch /F (calc.exe) >>'],
    ]);
    const input = pdf(
      [
        ...basic({ page: ' /Annots [11 0 R]' }),
        {
          num: 10,
          body: stream(
            `/Type %c\n/ObjStm /N 2 /First ${first} /Filter /FlateDecode`,
            deflateSync(data),
          ),
        },
      ],
      '/Root 1 0 R',
    );
    const result = await cleanPdf(input);
    expect(result.removed).toEqual(['links that open programs or other files']);
    expect(await activeContentIn(result.cleaned)).toEqual([]);
    expect(result.cleaned.toString('latin1')).not.toMatch(/ObjStm|calc\.exe/);
    const out = await PDFDocument.load(result.cleaned);
    expect(out.getPage(0).node.Annots()?.size()).toBe(1);
  });

  it('p2d: an object stream whose data begins with "stream\\r" keeps the scan in step', async () => {
    const bomb = zlibZeros(512 * 1024 * 1024);
    const bombStream = {
      num: 11,
      body: stream('/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode', bomb),
    };
    // With a direct /Length, the data is skipped exactly and the bomb after it is found.
    const withLength = pdf(
      [
        ...basic(),
        {
          num: 10,
          body: stream(
            '/Type /ObjStm /N 1 /First 6',
            latin('stream\r1 0 null'),
          ),
        },
        bombStream,
      ],
      '/Root 1 0 R',
    );
    expect(await refusal(cleanPdf(withLength))).toBe('pdf_too_complex');
    // Without one, pdf-lib's search for endstream counts the inner "stream" and never ends.
    const withoutLength = pdf(
      [
        ...basic(),
        {
          num: 10,
          body: stream(
            '/Type /ObjStm /N 1 /First 6',
            latin('stream\r1 0 null'),
            { length: false },
          ),
        },
        bombStream,
      ],
      '/Root 1 0 R',
    );
    expect(await refusal(cleanPdf(withoutLength))).toBe('pdf_not_a_pdf');
  });

  it('p3: removes a FileAttachment annotation that has no embedded file', async () => {
    const input = pdf(
      [
        ...basic({ page: ' /Annots [7 0 R 8 0 R]' }),
        {
          num: 7,
          body: '<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 10 10] /FS << /Type /Filespec /F (notes.txt) >> /Contents (notes) >>',
        },
        {
          num: 8,
          body: '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /URI /URI (https://heisreal.today) >> >>',
        },
      ],
      '/Root 1 0 R',
    );
    const result = await cleanPdf(input);
    expect(result.removed).toEqual(['file attachments']);
    expect(await activeContentIn(result.cleaned)).toEqual([]);
    const out = await PDFDocument.load(result.cleaned);
    const annots = out.getPage(0).node.Annots();
    expect(annots?.size()).toBe(1);
    const link = out.context.lookup(annots?.get(0), PDFDict);
    expect(link.get(PDFName.of('Subtype'))).toBe(PDFName.of('Link'));
    expect(result.cleaned.toString('latin1')).toContain(
      'https://heisreal.today',
    );
  });

  it('removes an embedded file whose stream says it is an image (security review)', async () => {
    const input = pdf(
      [
        ...basic({
          catalog:
            ' /Names << /EmbeddedFiles << /Names [(a) 5 0 R] >> >> /Outlines << /First 9 0 R >>',
        }),
        {
          num: 5,
          body: '<< /Type /Filespec /F (payload.exe) /EF << /F 6 0 R >> >>',
        },
        {
          num: 6,
          body: stream(
            '/Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray',
            latin('MZ-not-an-image'),
          ),
        },
        // The same Filespec reached from somewhere that isn't a name tree.
        { num: 9, body: '<< /Title (x) /Dest [3 0 R /Fit] /FS 5 0 R >>' },
      ],
      '/Root 1 0 R',
    );
    const result = await cleanPdf(input);
    expect(await activeContentIn(result.cleaned)).toEqual([]);
    expect(result.cleaned.toString('latin1')).not.toMatch(
      /MZ-not-an-image|\/EF\b/,
    );
    expect(result.removed).toContain('embedded files');
  });

  it('refuses an object stream that inflates to 512 MB', async () => {
    const input = pdf(
      [
        ...basic(),
        {
          num: 10,
          body: stream(
            '/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode',
            zlibZeros(512 * 1024 * 1024),
          ),
        },
      ],
      '/Root 1 0 R',
    );
    expect(input.length).toBeLessThan(1024 * 1024);
    expect(await refusal(cleanPdf(input))).toBe('pdf_too_complex');
  });

  it('refuses a double FlateDecode chain whose inner data would be 2 GB', async () => {
    const twice = deflateSync(zlibZeros(2 * 1024 * 1024 * 1024));
    expect(twice.length).toBeLessThan(1024 * 1024);
    for (const dict of [
      '/Type /ObjStm /N 1 /First 4 /Filter [/FlateDecode /FlateDecode]',
      '/Filter [/FlateDecode /FlateDecode]',
    ]) {
      const input = pdf(
        [...basic(), { num: 10, body: stream(dict, twice) }],
        '/Root 1 0 R',
      );
      expect(await refusal(cleanPdf(input))).toBe('pdf_too_complex');
    }
  });

  it('refuses 250,000 objects', async () => {
    const objects = Array.from(
      { length: 250_000 },
      (_, i) => `${i + 5} 0 obj null endobj\n`,
    );
    const input = Buffer.concat([
      pdf(basic(), '/Root 1 0 R'),
      latin(objects.join('')),
    ]);
    expect(input.length).toBeLessThan(MAX_PDF_BYTES);
    expect(await refusal(cleanPdf(input))).toBe('pdf_too_complex');
  });

  it('removes an /OpenAction that is only a destination, quietly', async () => {
    const input = pdf(
      basic({ catalog: ' /OpenAction [3 0 R /Fit]' }),
      '/Root 1 0 R',
    );
    const result = await cleanPdf(input);
    expect(result).toMatchObject({ removed: [], pages: 1 });
    const out = await PDFDocument.load(result.cleaned);
    expect(out.catalog.get(PDFName.of('OpenAction'))).toBeUndefined();
  });

  // Opus review round 1: a catalog written in the trailer itself was never cleaned.
  const scriptedCatalog =
    '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /URI /URI (https://x.example) >> /AA << /WC << /S /Named /N /Print >> >> >>';
  it.each([
    ['a catalog in the trailer', `/Root ${scriptedCatalog}`],
    ['an Info dictionary in the trailer', '/Root 1 0 R /Info << /Title (t) >>'],
  ])('refuses %s', async (_, trailer) => {
    const input = pdf(basic(), trailer);
    expect(await refusal(cleanPdf(input))).toBe('pdf_too_complex');
  });

  it('refuses a catalog in an xref stream dictionary', async () => {
    const head = latin('%PDF-1.7\n');
    const chunks: Buffer[] = [head];
    const offsets = new Map<number, number>();
    let length = head.length;
    for (const part of basic().slice(1)) {
      const { num, body } = part as { num: number; body: string | Buffer };
      const obj = Buffer.concat([
        latin(`${num} 0 obj\n`),
        typeof body === 'string' ? latin(body) : body,
        latin('\nendobj\n'),
      ]);
      offsets.set(num, length);
      chunks.push(obj);
      length += obj.length;
    }
    offsets.set(5, length);
    const entries = Buffer.alloc(6 * 5);
    for (const [num, at] of offsets) {
      entries[num * 5] = 1;
      entries.writeUInt32BE(at, num * 5 + 1);
    }
    chunks.push(
      latin('5 0 obj\n'),
      stream(
        `/Type /XRef /Size 6 /W [1 4 0] /Root ${scriptedCatalog}`,
        entries,
      ),
      latin(`\nendobj\nstartxref\n${length}\n%%EOF\n`),
    );
    expect(await refusal(cleanPdf(Buffer.concat(chunks)))).toBe(
      'pdf_too_complex',
    );
  });

  it('removes thread actions and links other than https and email', async () => {
    const links = [
      '<< /S /URI /URI (https://heisreal.today) >>',
      '<< /S /URI /URI (mailto:hello@heisreal.today) >>',
      '<< /S /URI /URI (file:///etc/passwd) >>',
      '<< /S /URI /URI (\\\\server\\share) >>',
      '<< /S /URI /URI (smb://server/share) >>',
      '<< /S /URI /URI (javascript:alert\\(1\\)) >>',
      '<< /S /URI /URI (http://heisreal.today) >>',
      '<< /S /Thread /F (other.pdf) /D 0 >>',
    ];
    const input = pdf(
      [
        ...basic({
          page: ` /Annots [${links.map((_, i) => `${i + 10} 0 R`).join(' ')}]`,
        }),
        ...links.map((a, i) => ({
          num: i + 10,
          body: `<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A ${a} >>`,
        })),
      ],
      '/Root 1 0 R',
    );
    const result = await cleanPdf(input);
    const text = result.cleaned.toString('latin1');
    expect(text).toContain('https://heisreal.today');
    expect(text).toContain('mailto:hello@heisreal.today');
    expect(text).not.toMatch(
      /file:|smb:|server|javascript|http:|Thread|other\.pdf/,
    );
    expect(result.removed).toEqual(
      expect.arrayContaining([
        'links that open programs or other files',
        'links to anything but https web pages and email',
      ]),
    );
    const twice = await cleanPdf(result.cleaned);
    expect(twice.removed).toEqual([]);
  });

  it('refuses a page tree that contains itself as too complex, not as "not a PDF"', async () => {
    // pdf-lib walks the page tree recursively and runs out of stack.
    const input = pdf(
      [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 9 9] >>' },
      ],
      '/Root 1 0 R',
    );
    expect(await refusal(cleanPdf(input))).toBe('pdf_too_complex');
  });

  async function generated(useObjectStreams: boolean): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage().drawText('Privacy policy', { x: 50, y: 700, font });
    doc.addPage().drawText('Page two', { x: 50, y: 700, font });
    return Buffer.from(await doc.save({ useObjectStreams }));
  }

  it('accepts plain pdf-lib PDFs, with and without object streams, removing nothing', async () => {
    for (const useObjectStreams of [false, true]) {
      const result = await cleanPdf(await generated(useObjectStreams));
      expect(result).toMatchObject({ removed: [], pages: 2 });
      expect(await activeContentIn(result.cleaned)).toEqual([]);
    }
  });

  it('is deterministic and idempotent', async () => {
    for (const input of [await generated(true), shadowed()]) {
      const once = await cleanPdf(input);
      const again = await cleanPdf(input);
      expect(again.cleaned.equals(once.cleaned)).toBe(true);
      const twice = await cleanPdf(once.cleaned);
      expect(twice.removed).toEqual([]);
      expect(twice.cleaned.equals(once.cleaned)).toBe(true);
    }
  });
});
