import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Logger,
  Module,
  Req,
  Res,
} from '@nestjs/common';
import { NoConsentRequired, PersonSessions } from '@heisreal/consent';
import { ProblemException } from '@heisreal/http';
import { RequiresRole } from '@heisreal/roles';
import { MediaUrls } from '@heisreal/story-cards';
import type { Request, Response } from 'express';
import {
  CLERK_BACKEND,
  type ClerkBackend,
  type ClerkProfile,
} from '../erasure/clerk-backend';
import { BUNNY_STREAM, type BunnyStream } from '../stories/bunny-stream';
import { heldVideoIds, LINK_SECONDS, readHeld, toExport } from './my-data';

/**
 * "Download my data" (GDPR Art 15 and Art 20; M2 plan PR 12): `GET /v1/account/export`, the
 * profile's Your data. Everything the database holds about the person, read in their own session
 * (D27), so it can't include anyone else's rows; then what Clerk holds (D16, D81), read with
 * Clerk's secret key and never stored. Media never pass through here: each item is its Bunny id
 * and links signed for 7 days (D52's signer, `MediaUrls`): to watch it, and to download the file
 * as uploaded where Bunny kept it (O2 B; Bunny says which, `hasOriginal`). The browser fetches
 * nothing through us. All or nothing: if Clerk or Bunny can't answer, the person gets `503` and
 * tries again, never a file that silently misses their sign-in details or a download link.
 */
@Controller('v1/account/export')
export class ExportController {
  private readonly logger = new Logger(ExportController.name);

  constructor(
    private readonly people: PersonSessions,
    private readonly urls: MediaUrls,
    @Inject(CLERK_BACKEND) private readonly clerk: ClerkBackend,
    @Inject(BUNNY_STREAM) private readonly bunny: BunnyStream | null,
  ) {}

  @Get()
  @RequiresRole('User')
  @NoConsentRequired(
    'access to your own data is always possible, whatever your consent (Art 15, Art 20)',
  )
  async exportMyData(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { role, clerkUserId } = await this.people.authenticate(req);
    const generatedAt = new Date();
    // The database first: only a live person's session opens (401 otherwise), so Clerk is
    // never asked about an account that's gone.
    const held = await this.people.run(req, ({ session }) => readHeld(session));
    const signIn = await this.signInDetails(clerkUserId);
    const originals = await this.keptOriginals(heldVideoIds(held));
    const file = toExport(held, {
      role: role as string,
      signIn,
      urls: this.urls.expiringIn(LINK_SECONDS),
      originals,
      generatedAt,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="he-is-real-my-data-${generatedAt.toISOString().slice(0, 10)}.json"`,
    );
    return file;
  }

  /** Which of these videos Bunny kept the original of (none while uploads are off). */
  private async keptOriginals(videoIds: string[]): Promise<Set<string>> {
    const bunny = this.bunny;
    if (!bunny || videoIds.length === 0) return new Set();
    try {
      const videos = await Promise.all(videoIds.map((id) => bunny.video(id)));
      return new Set(videoIds.filter((_, i) => videos[i]?.hasOriginal));
    } catch (err) {
      this.logger.warn(
        `Bunny's video read failed: ${err instanceof Error ? err.message : 'error'}`,
      );
      throw new ProblemException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'export_unavailable',
        'Service unavailable',
        'We couldn’t read your videos’ details just now. Please try again in a moment.',
      );
    }
  }

  private async signInDetails(clerkUserId: string): Promise<ClerkProfile> {
    try {
      return await this.clerk.getUser(clerkUserId);
    } catch (err) {
      // The message names a status at most, never the person.
      this.logger.warn(
        `Clerk's user read failed: ${err instanceof Error ? err.message : 'error'}`,
      );
      throw new ProblemException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'export_unavailable',
        'Service unavailable',
        'We couldn’t read your sign-in details just now. Please try again in a moment.',
      );
    }
  }
}

@Module({ controllers: [ExportController] })
export class ExportModule {}
