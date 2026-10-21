import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * CORS for the browser's direct calls (D31): only the origins in `CORS_ALLOWED_ORIGINS`
 * (comma- or space-separated; Terraform sets `web`'s URL, `.env.example` localhost). Unset or
 * empty = no browser origin at all. No cookies or other credentials: api-user and api-admin take
 * the Clerk token in `Authorization`, api-public-read takes nothing.
 */
export function corsOptions(
  value = process.env['CORS_ALLOWED_ORIGINS'] ?? '',
): CorsOptions {
  const origins = value
    .split(/[\s,]+/)
    .map((o) => o.trim())
    .filter(Boolean);
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CORS_ALLOWED_ORIGINS: not an origin: ${origin}`);
    }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.origin !== origin || (url.protocol !== 'https:' && !local)) {
      throw new Error(
        `CORS_ALLOWED_ORIGINS takes origins (https, or http only for localhost): ${origin}`,
      );
    }
  }
  return {
    origin: origins.length ? origins : false,
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'If-Match',
      'If-None-Match',
      'Idempotency-Key',
    ],
    exposedHeaders: ['ETag', 'Location'],
    maxAge: 600,
  };
}
