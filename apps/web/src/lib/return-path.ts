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
  if (url.origin !== 'https://site.invalid') return '/';
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
