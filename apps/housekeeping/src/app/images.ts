import { deleteStoryFolder } from '@heisreal/story-cards/upload-signing';

/**
 * The images storage zone, as housekeeping sees it: delete a deleted story's folder, queued by
 * the story's delete (pendingDeletion `image`: whoever deleted it), including the final pass after
 * a PUT link signed before the delete has expired. The whole folder goes, the picture and any it
 * replaced (`deleteStoryFolder`). The zone's password (`bunny-storage-password`) goes to Bunny's storage
 * API only and is never logged.
 */
export interface ImageZone {
  /** Deletes a deleted story's folder, `stories/<id>/`; one already gone is fine. */
  deleteFolder(folder: string): Promise<void>;
}

export class BunnyImageZone implements ImageZone {
  constructor(
    private readonly zone: { name: string; host: string; password: string },
  ) {}

  deleteFolder(folder: string): Promise<void> {
    return deleteStoryFolder(this.zone, folder);
  }
}
