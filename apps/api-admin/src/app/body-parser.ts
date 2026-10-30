import type { NestExpressApplication } from '@nestjs/platform-express';
import { MAX_TEXT } from './legal-documents/legal-documents.controller';

/**
 * The largest JSON body api-admin reads: a legal document's longest text (D125) in the worst
 * JSON escaping (6 bytes, `\uXXXX`, per UTF-16 unit), and the command around it. Express's
 * default (100 KiB) would refuse long documents the editor allows with 413.
 */
export const JSON_BODY_LIMIT = MAX_TEXT * 6 + 1024;

/** Nest's own JSON body parser, with api-admin's bounded limit. */
export function useBodyParser(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
}
