import type { INestApplication } from '@nestjs/common';
import { Contract } from '@heisreal/contracts/testing';
import type { NextFunction, Request, Response } from 'express';

/**
 * Every response the app sends in these tests is checked against api-public-read.yaml (T3):
 * web's e2e stub is checked against the same contract, so neither side can drift. Problems are
 * collected here and fail the test that caused them (contract-setup.ts).
 */
const contract = new Contract('api-public-read.yaml');
const problems: string[] = [];

export function checkResponsesAgainstContract(app: INestApplication): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const chunks: Buffer[] = [];
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    const end = res.end.bind(res) as (...args: unknown[]) => Response;
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (chunk) chunks.push(Buffer.from(chunk as Buffer));
      return write(chunk, ...rest);
    }) as Response['write'];
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (chunk && typeof chunk !== 'function')
        chunks.push(Buffer.from(chunk as Buffer));
      const text = Buffer.concat(chunks).toString('utf8');
      const contentType = res.getHeader('content-type');
      let body: unknown;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        body = text;
      }
      problems.push(
        ...contract.problems({
          method: req.method,
          path: req.path,
          status: res.statusCode,
          contentType: contentType === undefined ? null : String(contentType),
          body,
        }),
      );
      return end(chunk, ...rest);
    }) as Response['end'];
    next();
  });
}

/** The problems found since the last call. */
export function takeContractProblems(): string[] {
  return problems.splice(0);
}
