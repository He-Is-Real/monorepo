'use client';

import { useEffect } from 'react';
import { setErrorReportsUrl } from '@/lib/error-reports';

/** Tells the error reports where api-user is (root layout; LG-1c, LG-9a). Renders nothing. */
export function ErrorReports({ apiUserUrl }: { apiUserUrl?: string }) {
  useEffect(() => setErrorReportsUrl(apiUserUrl), [apiUserUrl]);
  return null;
}
