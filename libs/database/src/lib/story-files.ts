/**
 * A story's files with their processing state, for those who read the whole storyFile row: the
 * story's owner (GetStory, "download my data") and api-admin (R12). `media`: its video or audio
 * file as one item, with Bunny's real length as `durationSeconds`; `image`: its picture.
 */
export const OWNER_FILE_FIELDS = `
  IF mediaFile != NONE {
    [object::extend(mediaFile.{ format, thumbnailPath, width, height, processing },
      { bunnyVideoId: record::id(mediaFile), durationSeconds: mediaFile.lengthSeconds })]
  } ELSE { [] } AS media,
  IF image != NONE {
    object::extend(image.file.{ width, height, processing },
      { path: record::id(image.file), alt: image.alt })
  } AS image`;
