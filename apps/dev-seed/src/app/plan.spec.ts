import { DATASET } from './dataset';
import bunnyMedia from './bunny-media.json';
import {
  type BunnyMedia,
  CLIPS,
  type ClipId,
  DEFAULT_AUDIO_THUMBNAIL,
  IMAGES,
  type ImageId,
} from './media';
import { buildVars, datasetProblems } from './plan';

describe('the committed media record (bunny-media.json)', () => {
  it('covers every clip and image the dataset uses, as uploaded to the dev library', () => {
    expect(datasetProblems(DATASET, bunnyMedia as BunnyMedia)).toEqual([]);
    expect(() => buildVars(DATASET, bunnyMedia as BunnyMedia)).not.toThrow();
  });

  it('matches the media spec’s sizes and lengths (what Bunny reported)', () => {
    const media = bunnyMedia as BunnyMedia;
    for (const [id, clip] of Object.entries(CLIPS)) {
      const uploaded = media.clips[id as ClipId];
      expect(uploaded?.durationSeconds).toBe(clip.durationSeconds);
      if (clip.kind === 'video') {
        expect([uploaded?.width, uploaded?.height]).toEqual([
          clip.width,
          clip.height,
        ]);
      } else {
        // Audio: the site's default audio thumbnail and its size (Joel, 2026-10-24).
        expect(uploaded?.thumbnailPath).toMatch(/\/thumbnail_[0-9a-f]+\.jpg$/);
        expect([uploaded?.width, uploaded?.height]).toEqual([
          DEFAULT_AUDIO_THUMBNAIL.width,
          DEFAULT_AUDIO_THUMBNAIL.height,
        ]);
      }
    }
    for (const [id, image] of Object.entries(IMAGES)) {
      expect(media.images[id as ImageId]).toEqual({
        path: `dev-seed/${id}.webp`,
        width: image.width,
        height: image.height,
      });
    }
  });
});
