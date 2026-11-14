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
 * DEL-1 (Joel, 2026-11-14): an Admin's Delete removes the story's videos at Bunny Stream and its
 * picture folder in the images zone at once, as the owner's Delete removes its videos. Only after
 * the delete has committed, and it never fails the Delete: a video or folder that couldn't go is
 * logged (internal ids only) and left to the nightly clean-up, the orphan sweep for videos and the
 * queued folder (pendingDeletion, story_picture_folder) for pictures (docs/media-runbook.md).
 */
@Injectable()
export class StoryMedia {
  private readonly logger = new Logger(StoryMedia.name);

  constructor(
    @Inject(BUNNY_STREAM) private readonly stream: BunnyStream | null,
    @Inject(STORY_FOLDERS) private readonly folders: StoryFolders | null,
  ) {}

  async discardDeleted(storyId: string, videos: string[]): Promise<void> {
    for (const id of videos) {
      if (!this.stream) {
        this.logger.warn(
          `Couldn’t delete the deleted story’s video ${id} (Bunny Stream is off here; an orphan until the sweep)`,
        );
        continue;
      }
      await this.stream
        .deleteVideo(id)
        .catch((e: unknown) =>
          this.logger.warn(
            `Couldn’t delete the deleted story’s video ${id} (an orphan until the sweep): ${e instanceof Error ? e.message : 'error'}`,
          ),
        );
    }
    const folder = `stories/${storyId}/`;
    if (!this.folders) {
      this.logger.warn(
        `Couldn’t delete ${folder} (the images zone is off here; housekeeping deletes it from the queue)`,
      );
      return;
    }
    await this.folders
      .deleteFolder(folder)
      .catch((e: unknown) =>
        this.logger.warn(
          `Couldn’t delete ${folder} (housekeeping deletes it from the queue): ${e instanceof Error ? e.message : 'error'}`,
        ),
      );
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
    StoryMedia,
  ],
  exports: [StoryMedia],
})
export class StoryMediaModule {}
