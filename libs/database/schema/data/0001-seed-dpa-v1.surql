-- data/0001-seed-dpa-v1.surql (runs once; recorded in _migration by the runner, in the same
-- transaction). D20: DPA v1 has no legal text yet, so it's seeded as a draft (the database
-- refuses consent against a draft). $dpa_sha256.v1 = filesha256("libs/legal/dpa/v1.md"),
-- computed by Terraform; dpa-sync.surql keeps it in step with the file while v1 is a draft.
CREATE dpaVersion:v1 CONTENT {
  status: 'draft', materiality: 'material', documentPath: 'libs/legal/dpa/v1.md',
  contentHash: $dpa_sha256.v1, changeSummary: 'Initial version'
};
