import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { SecretsService } from '@heisreal/secrets';
import {
  BUNNY_STREAM,
  type BunnyStream,
  createBunnyStream,
} from '@heisreal/story-cards/bunny-stream';
import { loadImagesZone } from '@heisreal/story-cards/images-zone';
import {
  DEFAULT_STORY_MEDIA_BUDGET_MS,
  discardDeletedStoryMedia,
  STORY_MEDIA_BUDGET_MS,
} from '@heisreal/story-cards/story-media';
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
 * picture folder in the images zone at once, as the owner's Delete does (OD-1), with the same
 * shared code and time budget (`discardDeletedStoryMedia`): never failing the Delete.
 */
@Injectable()
export class StoryMedia {
  private readonly logger = new Logger(StoryMedia.name);

  constructor(
    @Inject(BUNNY_STREAM) private readonly stream: BunnyStream | null,
    @Inject(STORY_FOLDERS) private readonly folders: StoryFolders | null,
    @Inject(STORY_MEDIA_BUDGET_MS) private readonly budgetMs: number,
  ) {}

  discardDeleted(storyId: string, videos: string[]): Promise<void> {
    return discardDeletedStoryMedia(
      {
        stream: this.stream,
        folders: this.folders,
        budgetMs: this.budgetMs,
        logger: this.logger,
      },
      storyId,
      videos,
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
    {
      provide: STORY_MEDIA_BUDGET_MS,
      useValue: DEFAULT_STORY_MEDIA_BUDGET_MS,
    },
    StoryMedia,
  ],
  exports: [StoryMedia],
})
export class StoryMediaModule {}
