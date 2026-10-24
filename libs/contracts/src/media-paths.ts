/**
 * Which Bunny thumbnail paths a published story may carry: the cases both sides of the rule are
 * tested against, so they can't drift (Codex, #79). api-public-read signs a thumbnail only as
 * `<videoId>/<file>` (MediaUrls.thumbnailUrl, bunny-tokens.ts safePath): at most 500
 * characters, each segment only `A-Z a-z 0-9 . _ -`, no `.` or `..` segment. The database
 * refuses to approve or publish an audio story whose thumbnail breaks the same rule
 * (fn::media::own_thumbnail in libs/database/schema/schema.surql), so a published audio story
 * always has a picture the API can sign.
 */
export interface ThumbnailPathCase {
  why: string;
  videoId: string;
  path: string;
  /** Signed by api-public-read, and accepted for approval by the database. */
  ok: boolean;
}

const V = 'b8a77258-abfd-469d-ba63-9b89b62fcce6';
const OTHER = '229dbd44-d1a2-4044-be13-bee63c2a0cc1';
/** The signer's limit on a whole path. */
export const MAX_MEDIA_PATH = 500;
const fill = (total: number) =>
  `${V}/${'a'.repeat(total - V.length - 1 - '.jpg'.length)}.jpg`;

export const THUMBNAIL_PATH_CASES: ThumbnailPathCase[] = [
  {
    why: 'the default frame',
    videoId: V,
    path: `${V}/thumbnail.jpg`,
    ok: true,
  },
  {
    why: 'a custom upload',
    videoId: V,
    path: `${V}/thumbnail_0a1b2c3d.jpg`,
    ok: true,
  },
  {
    why: 'every allowed character',
    videoId: V,
    path: `${V}/A-z_0.9.jpg`,
    ok: true,
  },
  {
    why: 'a leading dot in the name',
    videoId: V,
    path: `${V}/.thumb.jpg`,
    ok: true,
  },
  {
    why: 'exactly 500 characters',
    videoId: V,
    path: fill(MAX_MEDIA_PATH),
    ok: true,
  },
  {
    why: '501 characters',
    videoId: V,
    path: fill(MAX_MEDIA_PATH + 1),
    ok: false,
  },
  { why: 'empty', videoId: V, path: '', ok: false },
  { why: 'the folder alone', videoId: V, path: `${V}/`, ok: false },
  { why: 'a dot segment', videoId: V, path: `${V}/.`, ok: false },
  { why: 'a dot-dot segment', videoId: V, path: `${V}/..`, ok: false },
  {
    why: 'climbing out',
    videoId: V,
    path: `${V}/../${OTHER}/thumbnail.jpg`,
    ok: false,
  },
  { why: 'a space', videoId: V, path: `${V}/bad name.jpg`, ok: false },
  {
    why: 'percent-encoding',
    videoId: V,
    path: `${V}/thumb%20nail.jpg`,
    ok: false,
  },
  {
    why: 'an encoded slash',
    videoId: V,
    path: `${V}/..%2f${OTHER}%2fx.jpg`,
    ok: false,
  },
  { why: 'a non-ASCII letter', videoId: V, path: `${V}/thumbé.jpg`, ok: false },
  { why: 'a sub-folder', videoId: V, path: `${V}/a/b.jpg`, ok: false },
  {
    why: 'another video’s folder',
    videoId: V,
    path: `${OTHER}/thumbnail.jpg`,
    ok: false,
  },
  {
    why: 'a longer folder name',
    videoId: V,
    path: `${V}x/thumbnail.jpg`,
    ok: false,
  },
  { why: 'no folder', videoId: V, path: 'thumbnail.jpg', ok: false },
  {
    why: 'a leading slash',
    videoId: V,
    path: `/${V}/thumbnail.jpg`,
    ok: false,
  },
];
