-- data/0003-dev-seed-story.surql (runs once; recorded in _migration by the runner, in the same
-- transaction). M0 task 0.9: one obviously fake, published story for the walking skeleton, in
-- development only. $seed_dev_story is true only in live/dev/cluster (Terraform's default is
-- false), so everywhere else this records itself as applied and writes nothing.
--
-- Everything is test content: no real testimony, no real person. It goes through the real
-- rules, so the schema's events check it like any other story: a published DPA version
-- (`kind: 'legacy'`, so api-user never treats it as the version in force), the submitter's
-- consent (migrator-only legacy consent), an approved story and its mirrored read model.
-- The submitter has no Clerk account, so nobody can sign in as them.
IF $seed_dev_story = true {
  CREATE dpaVersion:dev_seed CONTENT {
    kind: 'legacy', status: 'published', materiality: 'minor',
    documentPath: 'libs/legal/dpa/dev_seed.md', contentHash: $dpa_sha256.dev_seed,
    changeSummary: 'Development fixture for the walking skeleton (task 0.9); not an agreement'
  };
  CREATE user:dev_seed CONTENT {};
  FOR $type IN ['special_category_religious', 'publish', 'age_18plus'] {
    CREATE consent CONTENT {
      subject: user:dev_seed, type: $type, dpaVersion: dpaVersion:dev_seed, event: 'granted',
      mechanism: 'legacy_import', evidenceHash: crypto::sha256('dev seed fixture ' + $type)
    };
  };
  LET $s = (CREATE ONLY story:dev_seed CONTENT {
    submitter: user:dev_seed, slug: 'test-story-walking-skeleton',
    title: 'Test story: the walking skeleton',
    description: 'Placeholder content for the development site. This is not a real testimony.',
    body: 'This is test text, written to check that a published story travels from the database through api-public-read to the page. Nobody shared this story and nothing in it happened. Real stories arrive with the first submissions.',
    bylineName: 'Test Person', primaryFormat: 'written', tagRefs: [], media: [],
    status: 'approved', approvedAt: time::now()
  });
  CREATE publicStory:dev_seed CONTENT {
    version: $s.version, slug: $s.slug, title: $s.title, description: $s.description,
    body: $s.body, bylineName: $s.bylineName, primaryFormat: $s.primaryFormat,
    tagRefs: [], media: [], publishedAt: time::now()
  };
};
