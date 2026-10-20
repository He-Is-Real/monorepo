-- dpa-sync.surql: runs after the data scripts on every migration, in one transaction (D20).
-- A DPA's text lives in libs/legal/dpa and Terraform passes each file's sha256, so the stored
-- contentHash can't drift from the text: a draft follows its file; a published version is
-- frozen, so a changed file fails the migration (publish a new version instead). A version whose
-- hash isn't passed (its file doesn't exist yet) or whose row isn't seeded yet is skipped.
FOR $d IN [[dpaVersion:v1, $dpa_v1_sha256], [dpaVersion:`legacy-squarespace`, $legacy_sha256]] {
  LET $row = (SELECT status, contentHash FROM ONLY $d[0]);
  IF $d[1] != NONE AND $row != NONE AND $row.contentHash != $d[1] {
    IF $row.status = 'draft' {
      UPDATE $d[0] SET contentHash = $d[1] RETURN NONE;
    } ELSE {
      THROW <string> $d[0] + ' is published, but its file in libs/legal/dpa has changed: publish a new version instead';
    };
  };
};
