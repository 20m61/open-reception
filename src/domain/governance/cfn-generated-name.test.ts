/**
 * #680 R1/R2/R3。**実在するロール名 2 本を ground truth にする。**
 *
 * この 2 本はアカウント上に実在する（`OpenReception-Web-dev` の cross-region
 * ExportWriter と S3 auto-delete provider）。論理 ID からの予測がこの 2 本を
 * 再現できなければ、carve-out の ARN パターンは机上の空論になる。
 */
import { describe, expect, it } from 'vitest';
import {
  CARVE_OUT_ACCOUNT_ID,
  CARVE_OUT_ROLE_ARN_PATTERN,
  CFN_GENERATED_NAME_SUFFIX_LENGTH,
  IAM_ROLE_NAME_MAX_LENGTH,
  cfnGeneratedNamePrefix,
  iamArnGlobMatches,
  iamArnGlobMatchesGeneratedName,
} from './cfn-generated-name';

/** アカウント上で実測した物理名（brief で提示され、長さ 64 であることをここで固定する）。 */
const REAL_NAMES = {
  crossRegionWriter: 'OpenReception-Web-dev-CustomCrossRegionExportWriter-mWjZeIPYdVgw',
  s3AutoDelete: 'OpenReception-Web-dev-CustomS3AutoDeleteObjectsCust-yIrNw85NvcWP',
  /**
   * 🔴 **2026-08-15 の実デプロイで観測（旧スタック名 `OpenReception-CfMonitoring-dev` のとき）。**
   *
   * それまでのモデル（スタック名は切られない）は
   * `OpenReception-CfMonitoring-dev-CustomCrossRegionExp-` を**予測していたが外れた**。
   * 実際は**スタック名も切られ**（30 → 25 文字）、`-dev` が消えた。この 1 本が
   * carve-out の欠落を暴いた ―― `iam:CreateRole` が Deny されスタック作成が失敗した。
   *
   * **この観測を受けてスタック名を `OpenReception-CfMon-dev`（23 文字）へ改名した。**
   * 実測値は歴史的事実なのでそのまま残し、切り詰め規則の ground truth として使う。
   */
  crossRegionReaderOldStackName: 'OpenReception-CfMonitorin-CustomCrossRegionExportRe-ox5R3SHQowPX',
} as const;

/** 改名前後のスタック名。切り詰めが起きる／起きないの境界を跨ぐ。 */
const STACK_NAMES = {
  /** 30 文字。25 文字へ切られ `-dev` が消えていた。 */
  cfMonitoringOld: 'OpenReception-CfMonitoring-dev',
  /** 23 文字。切られないので `-dev` が残り carve-out に一致する。 */
  cfMonNew: 'OpenReception-CfMon-dev',
} as const;

/** synth で実際に得られる論理 ID（`infra/test/claude-deploy-boundary.test.ts` と同じもの）。 */
const LOGICAL_IDS = {
  crossRegionWriter: 'CustomCrossRegionExportWriterCustomResourceProviderRoleC951B1E1',
  crossRegionReader: 'CustomCrossRegionExportReaderCustomResourceProviderRole10531BBD',
  s3AutoDelete: 'CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092',
} as const;

describe('cfnGeneratedNamePrefix', () => {
  it('実在する 2 本はどちらもちょうど 64 文字（切り詰めの前提）', () => {
    expect(REAL_NAMES.crossRegionWriter).toHaveLength(IAM_ROLE_NAME_MAX_LENGTH);
    expect(REAL_NAMES.s3AutoDelete).toHaveLength(IAM_ROLE_NAME_MAX_LENGTH);
  });

  it('実在する cross-region ExportWriter の名前を再現する', () => {
    const prefix = cfnGeneratedNamePrefix('OpenReception-Web-dev', LOGICAL_IDS.crossRegionWriter);
    expect(prefix).toBe('OpenReception-Web-dev-CustomCrossRegionExportWriter-');
    expect(REAL_NAMES.crossRegionWriter.startsWith(prefix)).toBe(true);
    expect(REAL_NAMES.crossRegionWriter.slice(prefix.length)).toHaveLength(
      CFN_GENERATED_NAME_SUFFIX_LENGTH,
    );
  });

  it('実在する S3 auto-delete provider の名前を再現する', () => {
    const prefix = cfnGeneratedNamePrefix('OpenReception-Web-dev', LOGICAL_IDS.s3AutoDelete);
    expect(prefix).toBe('OpenReception-Web-dev-CustomS3AutoDeleteObjectsCust-');
    expect(REAL_NAMES.s3AutoDelete.startsWith(prefix)).toBe(true);
  });

  /**
   * 🔴 **スタック名も切られる（2026-08-15 の実測で判明）。**
   *
   * 旧モデルは「切られるのは論理 ID だけ」と仮定し
   * `OpenReception-CfMonitoring-dev-CustomCrossRegionExp-` を予測していたが、
   * 実際は `OpenReception-CfMonitorin-CustomCrossRegionExportRe-` だった。
   *
   * 規則: 予算 `maxLength - suffix - 2` を半分ずつに配り、**半分を超えた側だけ**切る。
   * 64 - 12 - 2 = 50 → 各 25。`OpenReception-Web-dev`(21) は無傷、
   * 旧 `OpenReception-CfMonitoring-dev`(30) は 25 へ切られる。
   */
  it('🔴 旧スタック名での実測を再現する（スタック名も切られる）', () => {
    const prefix = cfnGeneratedNamePrefix(STACK_NAMES.cfMonitoringOld, LOGICAL_IDS.crossRegionReader);
    expect(prefix).toBe('OpenReception-CfMonitorin-CustomCrossRegionExportRe-');
    expect(REAL_NAMES.crossRegionReaderOldStackName.startsWith(prefix)).toBe(true);
    expect(REAL_NAMES.crossRegionReaderOldStackName).toHaveLength(IAM_ROLE_NAME_MAX_LENGTH);
  });

  /**
   * 🔴 **改名の根拠。** 23 文字なら半分（25）を超えないので切られず、`-dev` が残る。
   * これが `OpenReception-*-dev-Custom*` の carve-out に一致する唯一の条件である。
   * ここが赤くなったら、スタック名がまた 25 文字を超えている。
   */
  it('🔴 新スタック名は切り詰められず -dev が残る', () => {
    expect(STACK_NAMES.cfMonNew.length).toBeLessThanOrEqual(25);
    const prefix = cfnGeneratedNamePrefix(STACK_NAMES.cfMonNew, LOGICAL_IDS.crossRegionReader);
    expect(prefix.startsWith('OpenReception-CfMon-dev-Custom')).toBe(true);
  });

  it('🔴 切り詰められた物理名が carve-out に一致する（一致しないと CreateRole が Deny される）', () => {
    for (const [stack, logicalId] of [
      ['OpenReception-Web-dev', LOGICAL_IDS.crossRegionWriter],
      ['OpenReception-Web-dev', LOGICAL_IDS.s3AutoDelete],
      [STACK_NAMES.cfMonNew, LOGICAL_IDS.crossRegionReader],
    ] as const) {
      const prefix = cfnGeneratedNamePrefix(stack, logicalId);
      const arn = `arn:aws:iam::${CARVE_OUT_ACCOUNT_ID}:role/${prefix}`;
      expect(
        iamArnGlobMatchesGeneratedName(CARVE_OUT_ROLE_ARN_PATTERN, arn),
        `carve-out に一致しない: ${prefix}`,
      ).toBe(true);
    }
  });

  it('論理 ID に含まれる CustomResourceProviderRole は物理名に残らない', () => {
    for (const [stack, logicalId] of [
      ['OpenReception-Web-dev', LOGICAL_IDS.crossRegionWriter],
      ['OpenReception-Web-dev', LOGICAL_IDS.s3AutoDelete],
      [STACK_NAMES.cfMonNew, LOGICAL_IDS.crossRegionReader],
    ] as const) {
      expect(logicalId).toContain('CustomResourceProviderRole');
      expect(cfnGeneratedNamePrefix(stack, logicalId)).not.toContain('CustomResourceProviderRole');
    }
  });

  /**
   * 旧モデルは「スタック名が長すぎると予算が尽きる」として throw していたが、
   * 実際の CloudFormation は**スタック名を切り詰めて必ず収める**（2026-08-15 の実測）。
   * したがって長いスタック名は throw せず、切り詰めた結果を返すのが正しい。
   */
  it('長いスタック名は throw せず切り詰める（実測の挙動）', () => {
    const prefix = cfnGeneratedNamePrefix('x'.repeat(52), 'CustomThing');
    expect(prefix.length).toBeLessThan(IAM_ROLE_NAME_MAX_LENGTH);
    // 論理 ID 側にも必ず 1 文字以上残る（空文字で素通りさせない）。
    expect(prefix).toMatch(/-C/);
  });

  it('極端に小さい予算では throw する（空文字で素通りさせない）', () => {
    expect(() =>
      cfnGeneratedNamePrefix('stack', 'CustomThing', { maxLength: 13, suffixLength: 12 }),
    ).toThrow(/予算/);
  });
});

describe('iamArnGlobMatches', () => {
  it('* は 0 文字以上に一致する', () => {
    expect(iamArnGlobMatches('a*c', 'ac')).toBe(true);
    expect(iamArnGlobMatches('a*c', 'abbbc')).toBe(true);
    expect(iamArnGlobMatches('a*c', 'abd')).toBe(false);
  });

  it('? は 1 文字に一致する', () => {
    expect(iamArnGlobMatches('a?c', 'abc')).toBe(true);
    expect(iamArnGlobMatches('a?c', 'ac')).toBe(false);
  });

  it('大小文字を区別する', () => {
    expect(iamArnGlobMatches('arn:aws:iam::1:role/Custom*', 'arn:aws:iam::1:role/custom-x')).toBe(false);
  });

  it('. や + はリテラルとして扱う（正規表現に化けない）', () => {
    expect(iamArnGlobMatches('a.c', 'abc')).toBe(false);
    expect(iamArnGlobMatches('a.c', 'a.c')).toBe(true);
  });

  it('部分一致では真にならない（前後に錨を打つ）', () => {
    expect(iamArnGlobMatches('role/Custom', 'role/CustomThing')).toBe(false);
  });

  /**
   * 🔴 **これが `Path` 細工を捕まえられる理由。** IAM のリソース ARN グロブでは
   * `*` が `/` を跨ぐ。人間は `role/OpenReception-x-dev-Custom/Innocent` を見て
   * 「Custom で始まる名前ではない」と読むが、IAM はそう読まない。
   */
  it('* は / を跨ぐ（人間の直感と違う。Path 細工がここに掛かる）', () => {
    expect(
      iamArnGlobMatches(CARVE_OUT_ROLE_ARN_PATTERN, `arn:aws:iam::${CARVE_OUT_ACCOUNT_ID}:role/OpenReception-x-dev-Custom/Innocent`),
    ).toBe(true);
  });

  /**
   * 🔴 **NFA への一本化 (#680) が正規表現版と意味を変えた点。** JS の正規表現 `.` は
   * `s` フラグなしでは `\n` に一致しないが、ここでの `*` は改行を含む任意の 1 文字に
   * 一致する。安全な向きはこちら —— `iamArnGlobMatches` が真を返すと呼び出し元
   * （`resolvePolicyRoleTarget`, `deploy-diff-gate.ts`）は対象を `carveOut` に分類し、
   * `carveOutRoleShape` の追加検査（Permissions Boundary が掛からない分の埋め合わせ）を
   * 掛ける。false を返すと `outside` 扱いでこの追加検査を skip する。よって
   * 「一致すると判定されない」方が fail-open（見逃し）であり、`\n` を理由に不一致へ
   * 倒す（旧 RegExp の挙動）のは危険な向きだった。
   */
  it('* は改行を含む任意の 1 文字に一致する（旧 RegExp 版は不一致だった）', () => {
    expect(iamArnGlobMatches('a*c', 'a\nc')).toBe(true);
    expect(
      iamArnGlobMatches(
        CARVE_OUT_ROLE_ARN_PATTERN,
        `arn:aws:iam::${CARVE_OUT_ACCOUNT_ID}:role/OpenReception-\n-dev-Custom-x`,
      ),
    ).toBe(true);
  });
});

describe('iamArnGlobMatchesGeneratedName（末尾 12 文字が未確定）', () => {
  const arn = (name: string) => `arn:aws:iam::${CARVE_OUT_ACCOUNT_ID}:role/${name}`;

  it('carve-out に入る生成名の接頭辞に一致する', () => {
    expect(
      iamArnGlobMatchesGeneratedName(
        CARVE_OUT_ROLE_ARN_PATTERN,
        arn(cfnGeneratedNamePrefix('OpenReception-Web-dev', LOGICAL_IDS.crossRegionWriter)),
      ),
    ).toBe(true);
  });

  it('carve-out の外の生成名には一致しない', () => {
    expect(
      iamArnGlobMatchesGeneratedName(
        CARVE_OUT_ROLE_ARN_PATTERN,
        arn(cfnGeneratedNamePrefix('OpenReception-Web-dev', 'ServerFnServiceRole')),
      ),
    ).toBe(false);
  });

  /**
   * 🔴 **ダミーのサフィックスを 1 つ当てる実装との差が出るところ。**
   * パターン末尾が `*` でなければ、残りは固定長でなければならない。
   * 「接頭辞を食えたら一致しうる」と丸める実装はここで false を返せない。
   */
  it('パターン末尾が * でないとき、残りの長さが合わなければ一致しない', () => {
    // 未確定部分は 12 文字。パターン側の残りは `??` の 2 文字しか受け付けない。
    expect(iamArnGlobMatchesGeneratedName('role/abc??', 'role/abc')).toBe(false);
    expect(iamArnGlobMatchesGeneratedName('role/abc??', 'role/abc', 2)).toBe(true);
  });

  it('未確定部分は英数字なので、パターン側のリテラル記号には一致しない', () => {
    // `-` は乱数サフィックスに現れない。
    expect(iamArnGlobMatchesGeneratedName('role/abc-*', 'role/abc', 1)).toBe(false);
    expect(iamArnGlobMatchesGeneratedName('role/abc?*', 'role/abc', 1)).toBe(true);
  });
});

describe('carve-out パターンの定数', () => {
  it('アカウント ID はパターン自身から取り出している（二重管理しない）', () => {
    expect(CARVE_OUT_ROLE_ARN_PATTERN).toContain(`::${CARVE_OUT_ACCOUNT_ID}:`);
  });
});
