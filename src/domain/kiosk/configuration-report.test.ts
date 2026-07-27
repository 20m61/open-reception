/**
 * 端末の構成反映報告の単体テスト (issue #420 increment 5)。
 *
 * サーバ側（heartbeat の受け口・分類・画面）は第 19〜21 wave で在る。ここで固定するのは
 * **端末が何を報告するか**、特に「報告してはいけないもの」の境界。
 */
import { describe, expect, it } from 'vitest';
import {
  configurationReportParams,
  reportForConfiguration,
} from './configuration-report';

describe('reportForConfiguration', () => {
  it('版のスナップショットを読み込んでいれば版と内容指紋を報告する', () => {
    expect(
      reportForConfiguration({ status: 'ready', revision: 3, contentHash: 'sha256:abc' }),
    ).toEqual({ kind: 'loaded', revision: 3, contentHash: 'sha256:abc' });
  });

  it('内容指紋が無い構成は報告しない（版管理を使っていない拠点の live 配信）', () => {
    // LIVE_VERSION は revision 0・contentHash 無し。これを報告すると、管理側の突き合わせで
    // 常に「旧版で稼働(stale)」に分類され、実際には正常な端末を異常として並べてしまう。
    expect(reportForConfiguration({ status: 'ready', revision: 0 })).toEqual({ kind: 'none' });
    expect(
      reportForConfiguration({ status: 'ready', revision: 2, contentHash: '' }),
    ).toEqual({ kind: 'none' });
  });

  it('版が無い（revision 未取得）構成も報告しない', () => {
    expect(reportForConfiguration({ status: 'ready', contentHash: 'sha256:abc' })).toEqual({
      kind: 'none',
    });
  });

  it('取得失敗は HTTP ステータス付きの errorCode で報告する', () => {
    expect(reportForConfiguration({ status: 'error', httpStatus: 403 })).toEqual({
      kind: 'failed',
      errorCode: 'effective_config_403',
    });
    expect(reportForConfiguration({ status: 'error', httpStatus: 503 })).toEqual({
      kind: 'failed',
      errorCode: 'effective_config_503',
    });
  });

  it('通信断（ステータス不明）は到達不能として報告する', () => {
    expect(reportForConfiguration({ status: 'error' })).toEqual({
      kind: 'failed',
      errorCode: 'effective_config_unreachable',
    });
  });

  it('移行フラグ無効・取得中は報告しない（旧経路に版の概念が無い）', () => {
    expect(reportForConfiguration({ status: 'disabled' })).toEqual({ kind: 'none' });
    expect(reportForConfiguration({ status: 'loading' })).toEqual({ kind: 'none' });
  });

  it('errorCode はサーバの受理規則（英数と _ . - のみ・64 文字以内）を満たす', () => {
    for (const httpStatus of [400, 401, 403, 404, 500, 503]) {
      const report = reportForConfiguration({ status: 'error', httpStatus });
      expect(report.kind).toBe('failed');
      if (report.kind !== 'failed') return;
      expect(report.errorCode).toMatch(/^[a-z0-9_.-]+$/i);
      expect(report.errorCode.length).toBeLessThanOrEqual(64);
    }
  });
});

describe('configurationReportParams', () => {
  it('読込済みは loadedRevision / loadedConfigHash を載せる', () => {
    expect(
      configurationReportParams({ kind: 'loaded', revision: 7, contentHash: 'sha256:abc' }),
    ).toEqual({ loadedRevision: '7', loadedConfigHash: 'sha256:abc' });
  });

  it('失敗は errorCode のみを載せる（読込済みの版を上書きしない）', () => {
    // errorRevision は載せない: 取得自体が失敗した端末は「どの版の読込で失敗したか」を知り得ない。
    // 推測値を送ると desired と偶然一致したときに failed へ誤分類される。
    expect(configurationReportParams({ kind: 'failed', errorCode: 'effective_config_503' })).toEqual(
      { errorCode: 'effective_config_503' },
    );
  });

  it('報告なしは空（heartbeat に無用な書込を足さない）', () => {
    expect(configurationReportParams({ kind: 'none' })).toEqual({});
  });

  it('PII を載せない（載るのは版・指紋・エラー分類だけ）', () => {
    const params = configurationReportParams({
      kind: 'loaded',
      revision: 1,
      contentHash: 'sha256:abc',
    });
    expect(Object.keys(params).sort()).toEqual(['loadedConfigHash', 'loadedRevision']);
  });
});
