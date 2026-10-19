-- data/0001-seed-dpa-v1.surql (runs once; recorded in _migration)
-- ${dpa_v1_sha256} is filled in by Terraform: filesha256("libs/legal/dpa/v1.md").
BEGIN TRANSACTION;
IF !record::exists(_migration:`0001-seed-dpa-v1`) {
  CREATE dpaVersion:v1 CONTENT {
    status: 'draft', materiality: 'material', documentPath: 'libs/legal/dpa/v1.md',
    contentHash: '${dpa_v1_sha256}', changeSummary: 'Initial version'
  };
  CREATE _migration:`0001-seed-dpa-v1`;
};
COMMIT TRANSACTION;

