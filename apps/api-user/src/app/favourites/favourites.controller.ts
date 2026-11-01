import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { PersonSessions } from '@heisreal/auth';
import {
  DatabaseQueryError,
  retryOnConflict,
  runQuery,
  WriteNotAppliedError,
} from '@heisreal/database';
import { ifNoneMatches, ProblemException, weakETag } from '@heisreal/http';
import { RequiresRole } from '@heisreal/roles';
import {
  MediaUrls,
  type StorySummary,
  SUMMARY_FIELDS,
  type SummaryRow,
  toSummary,
} from '@heisreal/story-cards';
import type { Request, Response } from 'express';
import {
  encodeCursor,
  type FavouritesQuery,
  parseFavouritesQuery,
  RECORD_ID,
} from './favourites.query';
import { agreementRefusalOf } from '../account/agreements';

/** The contract's page of `StorySummary` cards. */
export interface FavouritesPage {
  data: StorySummary[];
  nextCursor: string | null;
}

/**
 * The person's hearts (M2): `PUT`/`DELETE /v1/account/favourites/{storyId}` and
 * `GET /v1/account/favourites`, all in the person's own database session (D27), where the
 * `favourite` table shows them their own rows and nobody else's. Hearts are private (founder,
 * 2026-10-25): no counts anywhere here. The list reads `publicStory` (C15), so a story that is no
 * longer public drops out of it on its own; with `storyId` it answers "which of these are my
 * favourites?" for a page of cards, which web's browser asks (D83).
 */
@Controller('v1/account/favourites')
export class FavouritesController {
  constructor(
    private readonly people: PersonSessions,
    private readonly urls: MediaUrls,
  ) {}

  @Get()
  @RequiresRole('User')
  async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<FavouritesPage | undefined> {
    const parsed = parseFavouritesQuery(query);
    const page = await this.people.run(req, ({ session }) =>
      this.read(session, parsed),
    );
    const etag = weakETag(page);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', etag);
    if (ifNoneMatches(ifNoneMatch, etag)) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return page;
  }

  @Put(':storyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiresRole('User')
  async add(
    @Req() req: Request,
    @Param('storyId') storyId: string,
  ): Promise<void> {
    if (!RECORD_ID.test(storyId)) throw notPublic();
    await retryOnConflict(() =>
      this.people.run(req, async ({ session }) => {
        try {
          // Idempotent: a heart already there is left as it is (D28).
          const results = await runQuery(
            session,
            `LET $s = type::record('story', $id);
             IF (SELECT VALUE id FROM favourite WHERE person = $auth.id AND story = $s) = [] {
               CREATE favourite SET person = $auth.id, story = $s RETURN NONE;
             };
             SELECT VALUE id FROM favourite WHERE person = $auth.id AND story = $s;`,
            { id: storyId },
          );
          // A create the permissions refused is an empty result, not an error (D13 gotcha).
          if ((results.at(-1) as unknown[]).length !== 1)
            throw new WriteNotAppliedError('favourite');
        } catch (err) {
          // Two requests hearting the same story at once: the other one made it.
          if (
            err instanceof DatabaseQueryError &&
            err.message.includes('favourite_unique')
          )
            return;
          throw this.problemOf(err);
        }
      }),
    );
  }

  @Delete(':storyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiresRole('User')
  async remove(
    @Req() req: Request,
    @Param('storyId') storyId: string,
  ): Promise<void> {
    if (!RECORD_ID.test(storyId)) return; // can't be a heart: nothing to remove
    await retryOnConflict(() =>
      this.people.run(req, ({ session }) =>
        runQuery(
          session,
          `DELETE favourite WHERE person = $auth.id AND story = type::record('story', $id)`,
          { id: storyId },
        ),
      ),
    );
  }

  /** The hearts asked for, newest first, with their public cards in the same order. */
  private async read(
    session: Parameters<typeof runQuery>[0],
    query: FavouritesQuery,
  ): Promise<FavouritesPage> {
    const among = query.kind === 'among' ? query.storyIds : null;
    const after = query.kind === 'page' ? query.after : null;
    const take = query.kind === 'page' ? query.limit + 1 : among!.length;
    const results = await runQuery(
      session,
      `LET $among = IF $ids != NONE { $ids.map(|$i| type::record('story', $i)) };
       LET $at = IF $after != NONE { <datetime> $after.at };
       LET $afterId = IF $after != NONE { type::record('favourite', $after.id) };
       LET $hearts = SELECT record::id(id) AS id, record::id(story) AS story,
           <string> createdAt AS at, createdAt
         FROM favourite
         WHERE person = $auth.id
           AND ($among = NONE OR story IN $among)
           AND ($at = NONE OR createdAt < $at OR (createdAt = $at AND id < $afterId))
           AND record::exists(type::record('publicStory', record::id(story)))
         ORDER BY createdAt DESC, id DESC
         LIMIT $take;
       LET $refs = $hearts.slice(0, $show).map(|$h| type::record('publicStory', $h.story));
       RETURN {
         hearts: $hearts,
         cards: IF array::len($refs) > 0 { (SELECT ${SUMMARY_FIELDS} FROM $refs) } ELSE { [] },
       };`,
      {
        ids: among ?? undefined,
        after: after ?? undefined,
        take,
        show: query.kind === 'page' ? query.limit : take,
      },
    );
    const { hearts, cards } = results.at(-1) as {
      hearts: { id: string; story: string; at: string }[];
      cards: SummaryRow[];
    };
    const byId = new Map(cards.map((c) => [c.id, c]));
    const shown = query.kind === 'page' ? hearts.slice(0, query.limit) : hearts;
    const data = shown.flatMap((h) => {
      const card = byId.get(h.story);
      return card ? [toSummary(card, this.urls)] : [];
    });
    const last = shown.at(-1);
    return {
      data,
      nextCursor:
        query.kind === 'page' && hearts.length > query.limit && last
          ? encodeCursor(last.at, last.id)
          : null,
    };
  }

  /** The database's refusals as the contract's problems; anything else stays a 500. */
  private problemOf(err: unknown): unknown {
    if (!(err instanceof DatabaseQueryError)) return err;
    // Plan 4e: a heart needs the latest terms of use (403 terms_agreement_required).
    const refusal = agreementRefusalOf(err);
    if (refusal) return refusal;
    if (err.message.includes('favourite_not_published')) return notPublic();
    return err;
  }
}

const notPublic = () =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'story_not_found',
    'Not found',
    'Only a story that is public now can be hearted.',
  );

@Module({ controllers: [FavouritesController] })
export class FavouritesModule {}
