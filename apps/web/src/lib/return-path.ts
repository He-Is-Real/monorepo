/** The sign-in page. */
export const SIGN_IN_PATH = '/sign-in';

/**
 * Where to send someone after signing in: the page they came from (`/sign-in?redirect_url=…`),
 * if it is a path on this site; otherwise home. Only a same-site path (starting with one `/`,
 * no scheme, host, backslash or control characters) is kept, so the parameter can't send people
 * to another site, and never the sign-in page itself.
 */
export function safeReturnPath(
  raw: string | string[] | null | undefined,
): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (
    !value ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    // eslint-disable-next-line no-control-regex -- refusing control characters is the point
    /[\\\u0000-\u001f\u007f]/.test(value)
  ) {
    return '/';
  }
  let url: URL;
  try {
    url = new URL(value, 'https://site.invalid');
  } catch {
    return '/';
  }
  // Checked after parsing too: dot segments normalise `/.//evil.example` to `//evil.example`,
  // which a browser reads as another site.
  if (url.origin !== 'https://site.invalid' || url.pathname.startsWith('//'))
    return '/';
  if (
    url.pathname === SIGN_IN_PATH ||
    url.pathname.startsWith(`${SIGN_IN_PATH}/`)
  )
    return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign-in page's address, returning to `path` afterwards. */
export function signInHref(path: string): string {
  const back = safeReturnPath(path);
  return back === '/'
    ? SIGN_IN_PATH
    : `${SIGN_IN_PATH}?redirect_url=${encodeURIComponent(back)}`;
}

/**
 * Where to go after an agreement step (/consent/terms, /consent/testimony): the page the person
 * came from (`redirect_url`, a path on this site), but never a step itself, which would only send
 * them round again.
 */
export function consentReturnPath(
  raw: string | string[] | null | undefined,
): string {
  const path = safeReturnPath(raw);
  return isConsentStep(path) ? '/' : path;
}

/** Whether `path` (a same-site path, as from {@link safeReturnPath}) is an agreement step. */
function isConsentStep(path: string): boolean {
  const { pathname } = new URL(path, 'https://site.invalid');
  return pathname === '/consent' || pathname.startsWith('/consent/');
}

/**
 * Where an agreement step should return to, for someone who is `here` now: this page, or, if they
 * are already on a step, the page that step returns to. So a second step (or the same one, asked
 * twice) keeps the page the person started from, and never returns to a step.
 */
export function stepReturnPath(here: string): string {
  const path = safeReturnPath(here);
  if (!isConsentStep(path)) return path;
  const { searchParams } = new URL(path, 'https://site.invalid');
  return consentReturnPath(searchParams.get('redirect_url'));
}
