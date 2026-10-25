-- form-sync.surql: the consent forms' dpa-sync (D84). On every migration, checked read-only
-- before anything changes (once the form tables exist), then run after the data scripts and
-- dpa-sync, in one transaction. Every form version's text lives in
-- libs/legal/forms/<signup|testimony|social>/<id>.md; OpenTofu passes each file's sha256 as
-- $form_sha256 { signup: { <id>: hash }, testimony: { ... }, social: { ... } } and its words as
-- $form_text (same shape), so a version's textHash and text can't drift from its file:
--   * a draft follows its file;
--   * a published or retired version is frozen: a changed file fails the migration (publish a
--     new version instead);
--   * a version whose file is missing fails the migration: the words people agreed to stay in
--     the repo.
-- With $sync_check = true (the runner's check before the schema step) it only validates.
LET $signup = (SELECT id, status, textHash, text, 'signup' AS kind FROM signupFormVersion);
LET $testimony = (SELECT id, status, textHash, text, 'testimony' AS kind FROM testimonyFormVersion);
LET $social = (SELECT id, status, textHash, text, 'social' AS kind FROM socialSharingFormVersion);
LET $all = array::concat(array::concat($signup, $testimony), $social);
FOR $f IN $all {
  LET $h = $form_sha256[$f.kind][record::id($f.id)];
  LET $t = $form_text[$f.kind][record::id($f.id)];
  IF $h = NONE OR $t = NONE {
    THROW <string> $f.id + ' exists, but libs/legal/forms/' + $f.kind + '/' + record::id($f.id) + '.md does not: restore the file';
  };
  IF crypto::sha256($t) != $h {
    THROW <string> $f.id + ': the text OpenTofu passed doesn’t match its sha256 (encoding?)';
  };
  IF $h != $f.textHash OR $t != $f.text {
    IF $f.status = 'draft' {
      IF $sync_check != true { UPDATE $f.id SET textHash = $h, text = $t; };
    } ELSE {
      THROW <string> $f.id + ' is published, but its file in libs/legal/forms has changed: publish a new version instead';
    };
  };
};
