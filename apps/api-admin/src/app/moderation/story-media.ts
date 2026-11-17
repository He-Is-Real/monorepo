import {
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Module,
} from '@nestjs/common';
import { ProblemException } from '@heisreal/http';
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

/** How long an approval waits for Bunny's answer about a video's picture (RE-2 B). */
export const PICTURE_CHECK_MS = Symbol('PICTURE_CHECK_MS');
export const DEFAULT_PICTURE_CHECK_MS = 10_000;

/** What a moderator reads when Bunny shows another picture than the one recorded (Joel, RE-2 B). */
export const PICTURE_CHANGED =
  'The picture changed at Bunny. Send it back so the person sends again.';

/** A person's video as the approval check reads it: its Bunny id and recorded thumbnail path. */
export interface RecordedVideo {
  id: string;
  thumbnailPath?: string | null;
}

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
    @Inject(PICTURE_CHECK_MS) private readonly pictureCheckMs: number,
  ) {}

  /**
   * RE-2 B (Joel, 2026-11-17): before a person's video story is approved (also "approve anyway"),
   * Bunny's current thumbnail file must be the one api-user recorded when the story was sent
   * (`thumbnailPath`, `<video id>/<file name>`). A picture that reached Bunny late (an earlier send
   * that timed out, or another tab) would otherwise be published unseen.
   * - recorded path missing, or Bunny names another file: `409 picture_changed_at_bunny`
   *   ({@link PICTURE_CHANGED});
   * - Bunny down, too slow ({@link DEFAULT_PICTURE_CHECK_MS}), refusing, or without the video:
   *   `502 bunny_unavailable` (the web's generic "try again"); never approved unchecked;
   * - Bunny Stream off here (no key: local runs and tests without Bunny): not checked, as the rest
   *   of api-admin's Bunny work is skipped when it is off (logged at start-up).
   */
  async confirmPicture(video: RecordedVideo): Promise<void> {
    if (!this.stream) return;
    const [folder, name, ...rest] = (video.thumbnailPath ?? '').split('/');
    if (folder !== video.id || !name || rest.length > 0) throw pictureChanged();
    let shown: string | null | undefined;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const found = await Promise.race([
        this.stream.video(video.id, abort.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error(`no answer within ${this.pictureCheckMs} ms`));
          }, this.pictureCheckMs);
        }),
      ]);
      if (!found) throw new Error('Bunny has no such video');
      shown = found.thumbnailFileName;
    } catch (err) {
      this.logger.warn(
        `Couldn’t check video ${video.id}’s picture at Bunny before approval: ${err instanceof Error ? err.message : 'error'}`,
      );
      throw bunnyUnavailable();
    } finally {
      clearTimeout(timer);
    }
    if (shown !== name) {
      this.logger.warn(
        `Video ${video.id}: Bunny shows another picture than the one recorded at send; approval refused`,
      );
      throw pictureChanged();
    }
  }

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

const pictureChanged = () =>
  new ConflictException({
    code: 'picture_changed_at_bunny',
    message: PICTURE_CHANGED,
  });

const bunnyUnavailable = () =>
  new ProblemException(
    HttpStatus.BAD_GATEWAY,
    'bunny_unavailable',
    'Bad gateway',
  );

/**
 * Bunny Stream and the images zone for an Admin's Delete (and Bunny Stream for the approval's
 * picture check): each null (off) without its `BUNNY_*` variables, when the story's files wait
 * for the nightly clean-up and the picture isn't checked.
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
    { provide: PICTURE_CHECK_MS, useValue: DEFAULT_PICTURE_CHECK_MS },
    StoryMedia,
  ],
  exports: [StoryMedia],
})
export class StoryMediaModule {}
