// GET /health, like the APIs' (libs/health) minus `db`: web has no database
// (D32). Cloud Run's startup probe only checks the port, as for the APIs. Answered per request
// (`connection()`), not saved at build time.
import { connection } from 'next/server';

export async function GET() {
  await connection();
  return Response.json(
    { status: 'ok', service: 'web' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
