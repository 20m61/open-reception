/**
 * IAM actions that DynamoDB accepts in a **table** resource-based policy.
 *
 * Source: "DynamoDB API operations supported by resource-based policies"
 * (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/rbac-iam-actions.html),
 * every row whose "Resource-based policy support" is Yes, read 2026-10-06. The page lists API
 * names; they equal the IAM action names except PartiQL, whose three APIs (ExecuteStatement /
 * BatchExecuteStatement / ExecuteTransaction) are authorized by the four `PartiQL*` actions
 * (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-iam.html).
 *
 * DynamoDB validates the action names when the policy is attached (CreateTable / PutResourcePolicy)
 * and rejects the whole table on one bad name: `dynamodb:RestoreTableFromBackup` (its resource is
 * the backup, "No" on that page) failed the broker stack's first create on 2026-10-06 with
 * `Invalid policy document: The following action names are invalid`. The local emulators do not
 * check it (measured 2026-10-06, MiniStack 1.5.11 / Moto 5.2.3): PutResourcePolicy stores even
 * `dynamodb:TotallyBogusAction`, and CreateTable silently drops its ResourcePolicy. A local green
 * therefore proves nothing here; only this allowlist (pinned by test) catches it before real AWS.
 *
 * Stream-only actions (DescribeStream / GetRecords / GetShardIterator) belong to a stream's
 * policy, not a table's, and are deliberately absent.
 */
export const DYNAMODB_TABLE_RESOURCE_POLICY_ACTIONS = [
  // Data plane
  'dynamodb:DeleteItem',
  'dynamodb:GetItem',
  'dynamodb:PutItem',
  'dynamodb:Query',
  'dynamodb:Scan',
  'dynamodb:UpdateItem',
  'dynamodb:TransactGetItems',
  'dynamodb:TransactWriteItems',
  'dynamodb:BatchGetItem',
  'dynamodb:BatchWriteItem',
  // PartiQL
  'dynamodb:PartiQLSelect',
  'dynamodb:PartiQLInsert',
  'dynamodb:PartiQLUpdate',
  'dynamodb:PartiQLDelete',
  // Control plane
  'dynamodb:DeleteTable',
  'dynamodb:DescribeTable',
  'dynamodb:UpdateTable',
  // Global tables (2019.11.21)
  'dynamodb:DescribeTableReplicaAutoScaling',
  'dynamodb:UpdateTableReplicaAutoScaling',
  // Tags
  'dynamodb:ListTagsOfResource',
  'dynamodb:TagResource',
  'dynamodb:UntagResource',
  // Backup (only CreateBackup acts on the table; restore / describe / delete act on the backup)
  'dynamodb:CreateBackup',
  // Continuous backups (PITR)
  'dynamodb:DescribeContinuousBackups',
  'dynamodb:RestoreTableToPointInTime',
  'dynamodb:UpdateContinuousBackups',
  // Contributor Insights
  'dynamodb:DescribeContributorInsights',
  'dynamodb:UpdateContributorInsights',
  // Export
  'dynamodb:ExportTableToPointInTime',
  // Kinesis Data Streams
  'dynamodb:DescribeKinesisStreamingDestination',
  'dynamodb:DisableKinesisStreamingDestination',
  'dynamodb:EnableKinesisStreamingDestination',
  'dynamodb:UpdateKinesisStreamingDestination',
  // Resource-based policy
  'dynamodb:GetResourcePolicy',
  'dynamodb:PutResourcePolicy',
  'dynamodb:DeleteResourcePolicy',
  // TTL
  'dynamodb:DescribeTimeToLive',
  'dynamodb:UpdateTimeToLive',
] as const;

/** Actions AWS has been observed to reject in a table resource policy (negative control). */
export const DYNAMODB_TABLE_RESOURCE_POLICY_REJECTED = ['dynamodb:RestoreTableFromBackup'] as const;
