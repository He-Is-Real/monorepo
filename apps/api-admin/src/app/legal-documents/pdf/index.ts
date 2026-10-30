import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorkerReply } from './clean-worker';

/** The largest PDF an admin can upload. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export type PdfRefusal =
  | 'pdf_too_large'
  | 'pdf_not_a_pdf'
  | 'pdf_encrypted'
  | 'pdf_too_complex'
  | 'pdf_active_content';

/** A PDF that isn't accepted; `message` is short plain English for the admin. */
export class PdfRefused extends Error {
  constructor(
    readonly code: PdfRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'PdfRefused';
  }
}

export interface CleanedPdf {
  /** The copy to store, serve and bind in consent evidence. */
  cleaned: Buffer;
  /** What was stripped, in plain English (e.g. 'JavaScript actions'); empty if nothing. */
  removed: string[];
  pages: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
};
const WORKER_TAG = 'legal-pdf-clean';

/**
 * Where the worker is. In production webpack bundles `clean-worker.ts` as its own entry,
 * `legal-pdf-clean-worker.js`, next to `main.js` (see `webpack.config.js`), and `__dirname` is
 * dist. Under Vitest `__dirname` is this source folder and there is no `.js`, so the worker runs
 * the `.ts` source itself: Node 24 strips its types, which works because that file imports only
 * Node builtins and pdf-lib and uses only erasable TypeScript.
 */
const bundled = join(__dirname, 'legal-pdf-clean-worker.js');
const workerFile = existsSync(bundled)
  ? bundled
  : join(__dirname, 'clean-worker.ts');
// The source has ES imports in a package without "type": Node says it's reparsing it as ESM.
const workerArgv =
  workerFile === bundled
    ? undefined
    : [...process.execArgv, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'];

const tooComplex = () =>
  new PdfRefused(
    'pdf_too_complex',
    'The PDF is too large or complex to check. Please save it again as a plain PDF.',
  );

/**
 * Checks an uploaded PDF and returns the cleaned copy: scripts, automatic actions, embedded
 * files, attachments, media and XFA removed (see `clean-worker.ts`). Runs in a worker_thread
 * with memory limits and a time limit. Throws `PdfRefused` for a refused PDF, including a worker
 * that runs out of memory, crashes or times out (`pdf_too_complex`); a plain Error if the worker
 * fails for another reason.
 */
export async function cleanPdf(
  original: Buffer,
  options: { timeoutMs?: number } = {},
): Promise<CleanedPdf> {
  if (original.length > MAX_PDF_BYTES) {
    throw new PdfRefused('pdf_too_large', 'The PDF is larger than 10 MB.');
  }
  if (original.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new PdfRefused('pdf_not_a_pdf', 'The file isn’t a PDF.');
  }
  // A copy with its own ArrayBuffer, handed over to the worker rather than copied again.
  const bytes = new Uint8Array(original);
  const worker = new Worker(workerFile, {
    workerData: { tag: WORKER_TAG, bytes },
    transferList: [bytes.buffer],
    resourceLimits: RESOURCE_LIMITS,
    execArgv: workerArgv,
  });
  return new Promise<CleanedPdf>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
      void worker.terminate();
    };
    const timer = setTimeout(
      () => settle(() => reject(tooComplex())),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    worker.on('message', (reply: WorkerReply) =>
      settle(() => {
        if (reply.ok) {
          resolve({
            cleaned: Buffer.from(
              reply.cleaned.buffer,
              reply.cleaned.byteOffset,
              reply.cleaned.byteLength,
            ),
            removed: reply.removed,
            pages: reply.pages,
          });
        } else if (reply.code) {
          reject(new PdfRefused(reply.code, reply.message));
        } else {
          reject(new Error(`PDF cleaning failed: ${reply.message}`));
        }
      }),
    );
    worker.on('error', (err: Error & { code?: string }) =>
      settle(() =>
        reject(
          err.code === 'ERR_WORKER_OUT_OF_MEMORY' || err instanceof RangeError
            ? tooComplex()
            : new Error(`PDF cleaning failed: ${err.message}`, { cause: err }),
        ),
      ),
    );
    // Exiting without a reply or an error (killed by its limits): too much for the worker.
    worker.on('exit', () => settle(() => reject(tooComplex())));
  });
}
