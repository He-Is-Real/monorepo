import { createHash } from 'node:crypto';
import { apiPublicReadUrl } from '@/lib/config';

// Per request: the PDF comes from api-public-read each time (D51: nothing is cached in dev).
export const dynamic = 'force-dynamic';

/** D121: the two legal documents, and the name each one's PDF downloads as. */
const DOCUMENTS: Record<string, string> = {
  privacy: 'privacy-policy',
  terms: 'terms-of-use',
};
const FILE = /^([a-z0-9][a-z0-9_-]{0,63})\.pdf$/;
const TIMEOUT_MS = 30_000;

const notFound = () =>
  new Response('Not found\n', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

/**
 * /legal/{privacy|terms}/{version}.pdf: a legal document version's PDF of record (D121, D123),
 * from api-public-read on the server like every other public read (D32: the browser never calls
 * it), so "Download this version (PDF)" is a same-site link. Only a known document and a version
 * id reach api-public-read, and nothing from the visitor's request. The bytes go out as
 * api-public-read sent them, inline, under a fixed name, never sniffed.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ document: string; file: string }> },
): Promise<Response> {
  const { document, file } = await params;
  const version = FILE.exec(file)?.[1];
  const name = Object.hasOwn(DOCUMENTS, document) ? DOCUMENTS[document] : null;
  if (!name || !version) return notFound();
  let res: Response;
  try {
    res = await fetch(
      `${apiPublicReadUrl()}/v1/legal/documents/${document}/versions/${version}.pdf`,
      {
        headers: { accept: 'application/pdf' },
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch (err) {
    console.error(
      `api-public-read: ${document} ${version} PDF unavailable: ${err instanceof Error ? err.name : 'error'}`,
    );
    return new Response('Unavailable\n', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
  if (res.status === 404) return notFound();
  if (!res.ok) {
    return new Response('Unavailable\n', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="heisreal-${name}-${version}.pdf"`,
      'X-Content-Type-Options': 'nosniff',
      // The PDF's own hash, as api-public-read's ETag (computed here: web never reads an
      // upstream response's headers, D32's guardrail).
      ETag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
      'Cache-Control': 'no-store',
    },
  });
}
