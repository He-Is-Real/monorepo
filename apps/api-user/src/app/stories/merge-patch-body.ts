import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** A story is at most ~10,000 characters of text plus a few short fields (A3). */
const MAX_BYTES = 100 * 1024;

/**
 * Parses an `application/merge-patch+json` body (D28: PATCH is JSON Merge Patch), which Nest's
 * built-in JSON parser doesn't read. `application/json` bodies are already parsed by Nest.
 */
export function mergePatchBody(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
  if (type !== 'application/merge-patch+json') return next();
  const chunks: Buffer[] = [];
  let size = 0;
  let failed = false;
  req.on('data', (chunk: Buffer) => {
    if (failed) return;
    size += chunk.length;
    if (size > MAX_BYTES) {
      failed = true;
      next(new PayloadTooLargeException());
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (failed) return;
    try {
      req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      next();
    } catch {
      next(
        new BadRequestException({
          code: 'validation_failed',
          message: 'The body isn’t JSON',
        }),
      );
    }
  });
  req.on('error', (err) => {
    if (!failed) next(err);
  });
}
