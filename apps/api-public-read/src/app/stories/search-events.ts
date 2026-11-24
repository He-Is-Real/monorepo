import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { searchEvent } from '@heisreal/http';
import type { Outcome } from '@heisreal/logging/event';
import type { Request, Response } from 'express';
import { type Observable, tap } from 'rxjs';
import { representationOf } from '../public-cache';
import { type BrowseQuery, parseBrowseQuery } from './browse.query';

const SEARCHES = Symbol('searches stories');

/** Marks the browse route: a request with words or themes is a search (LG-2g A). */
export const SearchesStories = () => SetMetadata(SEARCHES, true);

/**
 * The separate search event (LG-2g A) for every search, however it was answered. Registered
 * before PublicCacheInterceptor, so it wraps it: a search answered from memory (or as the
 * restart fallback) is still a search someone made, and gets its own event from the final
 * answer. The terms go there only, never on the request's event; whoever searched only as
 * search-key hashes. A request that isn't a search (no words, no themes, `ids`) or that is
 * refused before it runs (a bad parameter, a rate limit) writes none.
 */
@Injectable()
export class SearchEventInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.get<boolean>(SEARCHES, context.getHandler()))
      return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    let browse: BrowseQuery;
    try {
      browse = parseBrowseQuery(req.query as Record<string, unknown>);
    } catch {
      return next.handle();
    }
    if (browse.ids || (!browse.q && !browse.themes.length))
      return next.handle();
    const write = (outcome: Outcome, body?: unknown) =>
      searchEvent(req, {
        outcome,
        search: {
          q: browse.q ?? undefined,
          tags: browse.themes.length ? browse.themes : undefined,
          filters: { format: browse.format ?? undefined, sort: browse.sort },
          result_count: (body as { data?: unknown[] } | undefined)?.data
            ?.length,
        },
      });
    return next.handle().pipe(
      tap({
        // A 304 (If-None-Match) has no body: count the answer it stands for.
        next: (body) => write('ok', body ?? representationOf(res)),
        error: () => write('error'),
      }),
    );
  }
}
