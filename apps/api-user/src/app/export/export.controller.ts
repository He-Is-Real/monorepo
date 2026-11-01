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
import { LINK_SECONDS, readHeld, toExport } from './my-data';

/**
 * "Download my data" (GDPR Art 15 and Art 20; M2 plan PR 12): `GET /v1/account/export`, the
 * profile's Your data. Everything the database holds about the person, read in their own session
 * (D27), so it can't include anyone else's rows; then what Clerk holds (D16, D81), read with
 * Clerk's secret key and never stored. Media never pass through here: each item is its Bunny id
 * and a link signed for one hour (D52's signer, `MediaUrls`), and the browser fetches nothing
 * through us. All or nothing: if Clerk can't answer, the person gets `503` and tries again,
 * never a file that silently misses their sign-in details.
 */
@Controller('v1/account/export')
export class ExportController {
  private readonly logger = new Logger(ExportController.name);

  constructor(
    private readonly people: PersonSessions,
    private readonly urls: MediaUrls,
    @Inject(CLERK_BACKEND) private readonly clerk: ClerkBackend,
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
    // Everything the person has, in one session (decision T): a fresh pass.
    const held = await this.people.run(
      req,
      ({ session }) => readHeld(session),
      'slow',
    );
    const signIn = await this.signInDetails(clerkUserId);
    const file = toExport(held, {
      role: role as string,
      signIn,
      urls: this.urls.expiringIn(LINK_SECONDS),
      generatedAt,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="he-is-real-my-data-${generatedAt.toISOString().slice(0, 10)}.json"`,
    );
    return file;
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
