/**
 * 移行用の一時境界（#680 / 2026-08-15）。
 *
 * ## なぜ要るか
 *
 * `OpenReception-Web-dev` は**共有 bootstrap（`hnb659fds`）**でデプロイされたスタックで、
 * `orcloud01` の制限ロールで更新すると、失敗時のロールバックが**旧アセットを
 * `cdk-hnb659fds-assets-*` から取り直そうとし**、層 3（他プロジェクト遮断）がそれを Deny する。
 * 結果**ロールバックが原理的に完了できない**（2026-08-15 に実際に踏んだ）。
 *
 * そこで移行デプロイの**間だけ**、共有 assets の**オブジェクト読み取りだけ**を通す。
 * 成功後はスタックが `orcloud01` の assets を参照するので、通常の境界へ戻せる。
 *
 * ## ここで守ること
 *
 * 一時ポリシーが**黙って別物へ育つ**のが怖い。したがって
 * **「通常の境界と 1 箇所だけ違う」ことを機械で固定する**。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PolicyDocument, PolicyStatement } from './aws-policy-shape';

const load = (name: string): PolicyDocument =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'scripts/aws-policies', name), 'utf8'));

/**
 * 🔴 **境界と cfn-exec の両方に同じ穴を開ける。** 片方だけ開けても、もう片方の Deny が
 * 効いて通らない（2026-08-15 に実際に境界だけ開けて `explicitDeny` のままだった）。
 * 既存の `ESCALATION_SCOPED_POLICIES` が「両方に同じ性質を要求する」としているのと同じ理屈。
 */
const POLICY_PAIRS = [
  ["claude-boundary.json", "claude-boundary-migration.json"],
  ["claude-cfn-exec.json", "claude-cfn-exec-migration.json"],
] as const;

/** 移行ポリシーだけが持つ文の Sid。ここに挙がっていない差分は許さない。 */
const MIGRATION_ONLY_SID = 'AllowSharedAssetsReadDuringMigration';

const sidsOf = (doc: PolicyDocument): ReadonlyArray<string> =>
  doc.Statement.map((s) => s.Sid ?? '(sid なし)');
const bySid = (doc: PolicyDocument, sid: string): PolicyStatement | undefined =>
  doc.Statement.find((s) => s.Sid === sid);
const listOf = (v: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  typeof v === 'string' ? [v] : (v ?? []);

describe.each(POLICY_PAIRS)('%s → %s', (normalName, migrationName) => {
  const NORMAL = load(normalName);
  const MIGRATION = load(migrationName);

  it('🔴 通常の境界との差分は「1 文の追加」と「共有 assets オブジェクトの Deny 除外」だけ', () => {
    // 追加された Sid はちょうど 1 つ。
    const added = sidsOf(MIGRATION).filter((sid) => !sidsOf(NORMAL).includes(sid));
    expect(added).toEqual([MIGRATION_ONLY_SID]);

    // 消えた Sid は無い（Deny を丸ごと落として「通す」のは禁止）。
    const removed = sidsOf(NORMAL).filter((sid) => !sidsOf(MIGRATION).includes(sid));
    expect(removed).toEqual([]);

    // 共通の文はすべて**完全一致**。1 文だけ例外を認める。
    for (const normal of NORMAL.Statement) {
      const sid = normal.Sid ?? '(sid なし)';
      const migrated = bySid(MIGRATION, sid);
      expect(migrated, `${sid} が移行ポリシーに無い`).toBeDefined();
      if (sid === 'DenyForeignProjectData') continue; // 下で個別に検査する
      expect(migrated, `${sid} が改変されている`).toEqual(normal);
    }
  });

  it('🔴 共有 assets の「オブジェクト」だけを Deny から外している（バケット自体は Deny のまま）', () => {
    const normal = listOf(bySid(NORMAL, 'DenyForeignProjectData')?.Resource);
    const migrated = listOf(bySid(MIGRATION, 'DenyForeignProjectData')?.Resource);
    const dropped = normal.filter((r) => !migrated.includes(r));
    expect(dropped).toEqual(['arn:aws:s3:::cdk-hnb659fds-*/*']);
    // バケット ARN（ListBucket 等）は落としていない。
    expect(migrated).toContain('arn:aws:s3:::cdk-hnb659fds-*');
  });

  it('🔴 落とした穴は「GetObject 以外は Deny」で塞いである', () => {
    const stmt = bySid(MIGRATION, MIGRATION_ONLY_SID);
    expect(stmt).toBeDefined();
    expect(stmt?.Effect).toBe('Deny');
    // NotAction: GetObject 以外のすべてを Deny する（書き込み・削除は通さない）。
    expect(listOf(stmt?.NotAction)).toEqual(['s3:GetObject']);
    expect(listOf(stmt?.Resource)).toEqual(['arn:aws:s3:::cdk-hnb659fds-*/*']);
  });

  it('🔴 他プロジェクトのデータは移行中も一切通さない', () => {
    const migrated = listOf(bySid(MIGRATION, 'DenyForeignProjectData')?.Resource);
    for (const r of [
      'arn:aws:s3:::nodi-*',
      'arn:aws:s3:::nodi-*/*',
      'arn:aws:s3:::salon-loop-*',
      'arn:aws:s3:::salon-loop-*/*',
      'arn:aws:s3:::cdk-staging-*',
      'arn:aws:s3:::cdk-staging-*/*',
    ]) {
      expect(migrated, `${r} が Deny から外れている`).toContain(r);
    }
  });

  it('IAM の 6144 文字上限に収まる', () => {
    expect(JSON.stringify(MIGRATION).length).toBeLessThanOrEqual(6144);
  });

  it('IAM が受け取る資源パスになっている', () => {
    const iamArns = MIGRATION.Statement.flatMap((s) => [
      ...listOf(s.Resource),
      ...listOf(s.NotResource),
    ]).filter((arn) => arn.startsWith('arn:aws:iam:'));
    const VALID = ['user/', 'role/', 'group/', 'policy/', 'instance-profile/'];
    for (const arn of iamArns) {
      const path = arn.split(':').slice(5).join(':');
      const ok = path === '*' || path === 'root' || VALID.some((p) => path.startsWith(p));
      expect(ok, `IAM が受け取らない資源パス: ${arn}`).toBe(true);
    }
  });
});
