/**
 * #680 R1/R2/R3。**実在するロール名 2 本を ground truth にする。**
 *
 * この 2 本はアカウント上に実在する（`OpenReception-Web-dev` の cross-region
 * ExportWriter と S3 auto-delete provider）。論理 ID からの予測がこの 2 本を
 * 再現できなければ、carve-out の ARN パターンは机上の空論になる。
 */
import { describe, expect, it } from 'vitest';
import {
  CFN_GENERATED_NAME_SUFFIX_LENGTH,
  IAM_ROLE_NAME_MAX_LENGTH,
  cfnGeneratedNamePrefix,
  iamArnGlobMatches,
} from './cfn-generated-name';

/** アカウント上で実測した物理名（brief で提示され、長さ 64 であることをここで固定する）。 */
const REAL_NAMES = {
  crossRegionWriter: 'OpenReception-Web-dev-CustomCrossRegionExportWriter-mWjZeIPYdVgw',
  s3AutoDelete: 'OpenReception-Web-dev-CustomS3AutoDeleteObjectsCust-yIrNw85NvcWP',
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
   * 🔴 **carve-out の設計を決める事実。** スタック名が 9 文字長くなると論理 ID の
   * 取り分が 9 文字減り、`...ExportWriter` どころか `...Export` すら残らない。
   * 「`CustomCrossRegionExport*`」のようなパターンを書くと us-east-1 側だけ一致せず、
   * ExportReader の `iam:CreateRole` が Deny される。
   */
  it('スタック名が長い CfMonitoring では ExportReader が Export の途中で切れる', () => {
    expect(cfnGeneratedNamePrefix('OpenReception-CfMonitoring-dev', LOGICAL_IDS.crossRegionReader)).toBe(
      'OpenReception-CfMonitoring-dev-CustomCrossRegionExp-',
    );
  });

  it('論理 ID に含まれる CustomResourceProviderRole は物理名に残らない', () => {
    for (const [stack, logicalId] of [
      ['OpenReception-Web-dev', LOGICAL_IDS.crossRegionWriter],
      ['OpenReception-Web-dev', LOGICAL_IDS.s3AutoDelete],
      ['OpenReception-CfMonitoring-dev', LOGICAL_IDS.crossRegionReader],
    ] as const) {
      expect(logicalId).toContain('CustomResourceProviderRole');
      expect(cfnGeneratedNamePrefix(stack, logicalId)).not.toContain('CustomResourceProviderRole');
    }
  });

  it('予算が残らないスタック名は throw する（空文字で素通りさせない）', () => {
    expect(() => cfnGeneratedNamePrefix('x'.repeat(52), 'CustomThing')).toThrow(/予算/);
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
});
