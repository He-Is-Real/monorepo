import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { SecretsService } from '@heisreal/secrets';
import {
  BUNNY_STREAM,
  type BunnyStream,
  createBunnyStream,
} from '@heisreal/story-cards/bunny-stream';
import { loadImagesZone } from '@heisreal/story-cards/images-zone';
import { deleteStoryFolder } from '@heisreal/story-cards/upload-signing';

/**
 * A deleted story's picture folder in the images zone, `stories/<id>/` (null when the zone is
 * off here). A stand-in replaces it in the integration tests.
 */
export interface StoryFolders {
  deleteFolder(folder: string): Promise<void>;
}
export const STORY_FOLDERS = Symbol('STORY_FOLDERS');

/**
 * How long an Admin's Delete waits for Bunny, in milliseconds: all its deletions together,
 * comfortably below the browser's 30 s deadline (apps/web/src/lib/api-user.ts). A shorter one
 * replaces it in the integration tests.
 */
export const STORY_MEDIA_BUDGET_MS = Symbol('STORY_MEDIA_BUDGET_MS');
const BUDGET_MS = 8_000;

/**
 * DEL-1 (Joel, 2026-11-14): an Admin's Delete removes the story's videos at Bunny Stream and its
 * picture folder in the images zone at once, as the owner's Delete removes its videos. Only after
 * the delete has committed, and it never fails the Delete: the deletions run side by side under
 * one time budget, and a video or folder that couldn't go, or hadn't gone when the budget ran out,
 * is logged (internal ids only) and left to the nightly clean-up, the orphan sweep for videos and
 * the queued folder (pendingDeletion, story_picture_folder) for pictures (docs/media-runbook.md).
 */
@Injectable()
export class StoryMedia {
  private readonly logger = new Logger(StoryMedia.name);

  constructor(
    @Inject(BUNNY_STREAM) private readonly stream: BunnyStream | null,
    @Inject(STORY_FOLDERS) private readonly folders: StoryFolders | null,
    @Inject(STORY_MEDIA_BUDGET_MS) private readonly budgetMs: number,
  ) {}

  async discardDeleted(storyId: string, videos: string[]): Promise<void> {
    const folder = `stories/${storyId}/`;
    const unfinished = new Set<string>();
    const track = (what: string, work: Promise<void>) => {
      unfinished.add(what);
      return work.finally(() => unfinished.delete(what));
    };
    const stream = this.stream;
    const folders = this.folders;
    const work: Promise<void>[] = videos.map((id) => {
      if (!stream) {
        this.logger.warn(
          `Couldn’t delete the deleted story’s video ${id} (Bunny Stream is off here; an orphan until the sweep)`,
        );
        return Promise.resolve();
      }
      return track(
        `the deleted story’s video ${id} (an orphan until the sweep)`,
        stream
          .deleteVideo(id)
          .catch((e: unknown) =>
            this.logger.warn(
              `Couldn’t delete the deleted story’s video ${id} (an orphan until the sweep): ${e instanceof Error ? e.message : 'error'}`,
            ),
          ),
      );
    });
    if (!folders) {
      this.logger.warn(
        `Couldn’t delete ${folder} (the images zone is off here; housekeeping deletes it from the queue)`,
      );
    } else {
      work.push(
        track(
          `${folder} (housekeeping deletes it from the queue)`,
          folders
            .deleteFolder(folder)
            .catch((e: unknown) =>
              this.logger.warn(
                `Couldn’t delete ${folder} (housekeeping deletes it from the queue): ${e instanceof Error ? e.message : 'error'}`,
              ),
            ),
        ),
      );
    }
    let timer: NodeJS.Timeout | undefined;
    const outOfTime = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), this.budgetMs);
    });
    const result = await Promise.race([
      Promise.all(work).then(() => 'done' as const),
      outOfTime,
    ]);
    clearTimeout(timer);
    if (result === 'late') {
      for (const what of unfinished) {
        this.logger.warn(
          `Couldn’t delete ${what}: Bunny hadn’t answered within ${this.budgetMs / 1000} s`,
        );
      }
    }
  }
}

/**
 * Bunny Stream and the images zone for an Admin's Delete: each null (off) without its
 * `BUNNY_*` variables, when the story's files wait for the nightly clean-up.
 */
@Module({
  providers: [
    {
      provide: BUNNY_STREAM,
      inject: [SecretsService],
      useFactory: (secrets: SecretsService) =>
        createBunnyStream(
          secrets,
          process.env,
          'Bunny Stream is off (no BUNNY_STREAM_API_KEY_SECRET): deleted stories’ videos wait for the nightly sweep',
        ),
    },
    {
      provide: STORY_FOLDERS,
      inject: [SecretsService],
      useFactory: async (
        secrets: SecretsService,
      ): Promise<StoryFolders | null> => {
        const zone = await loadImagesZone(secrets);
        if (!zone) {
          new Logger('StoryFolders').warn(
            'The images zone is off (no BUNNY_STORAGE_PASSWORD_SECRET): deleted stories’ folders wait for housekeeping',
          );
          return null;
        }
        return { deleteFolder: (folder) => deleteStoryFolder(zone, folder) };
      },
    },
    { provide: STORY_MEDIA_BUDGET_MS, useValue: BUDGET_MS },
    StoryMedia,
  ],
  exports: [StoryMedia],
})
export class StoryMediaModule {}
