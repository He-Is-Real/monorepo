import { deleteStoryFolder } from '@heisreal/story-cards/upload-signing';

/**
 * The images storage zone, as housekeeping sees it: delete a gone story's folder, for a queued
 * picture deletion (pendingDeletion `image`: an erasure's, or a draft deleted as abandoned) that
 * api-user didn't finish. The whole folder goes, the picture and any it replaced
 * (`deleteStoryFolder`). The zone's password (`bunny-storage-password`) goes to Bunny's storage
 * API only and is never logged.
 */
export interface ImageZone {
  /** Deletes the folder of the story that picture was on; one already gone is fine. */
  deleteFolder(imagePath: string): Promise<void>;
}

export class BunnyImageZone implements ImageZone {
  constructor(
    private readonly zone: { name: string; host: string; password: string },
  ) {}

  deleteFolder(imagePath: string): Promise<void> {
    return deleteStoryFolder(this.zone, imagePath);
  }
}
