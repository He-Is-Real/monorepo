-- dpa-sync.surql: on every migration, checked read-only before anything changes, then run
-- after the data scripts in one transaction (D20). Every DPA version's text lives in
-- libs/legal/dpa/<id>.md and Terraform passes each file's sha256 as $dpa_sha256 { <id>: hash },
-- so the stored contentHash can't drift from the text:
--   * a draft follows its file;
--   * a published version is frozen: a changed file fails the migration (publish a new version);
--   * a seeded version, draft or published, whose file is missing fails the migration: the text
--     consent was (or will be) given against must stay in the repo. Only a version that isn't
--     seeded yet may lack a file.
-- 3.2.4: FOR over a subquery fails ("Cannot execute statement using value"); over a LET works.
LET $versions = (SELECT id, status, contentHash FROM dpaVersion);
FOR $d IN $versions {
  LET $h = $dpa_sha256[record::id($d.id)];
  IF $h = NONE {
    THROW <string> $d.id + ' exists, but libs/legal/dpa/' + record::id($d.id) + '.md does not: restore the file';
  };
  IF $h != $d.contentHash {
    IF $d.status = 'draft' {
      UPDATE $d.id SET contentHash = $h;
    } ELSE {
      THROW <string> $d.id + ' is published, but its file in libs/legal/dpa has changed: publish a new version instead';
    };
  };
};
