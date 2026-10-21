// Server-side configuration, read at request time from the environment that
// Terraform sets on the Cloud Run service (never baked into the image).
//
// D32: web server-renders from api-public-read only. It never calls api-user
// or api-admin, and holds no database access, secrets or tokens, so this is
// the only API address it gets. The story page that uses it is task 0.9.

export function apiPublicReadUrl(): string {
  const url = process.env['API_PUBLIC_READ_URL'];
  if (!url) {
    throw new Error(
      'API_PUBLIC_READ_URL is not set (the api-public-read base URL)',
    );
  }
  return url.replace(/\/+$/, '');
}
