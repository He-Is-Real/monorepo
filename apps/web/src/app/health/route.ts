// GET /health, like the APIs' (libs/health) minus `db`: web has no database
// (D32). Cloud Run's startup probe only checks the port, as for the APIs.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    { status: 'ok', service: 'web' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
