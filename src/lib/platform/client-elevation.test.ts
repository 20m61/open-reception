import { describe, expect, it } from 'vitest';
import {
  buildElevateRequest,
  buildNoticePublishPayload,
  elevateErrorMessage,
  elevationScopeLabel,
  formatRemaining,
  noticePublishError,
  buildBreakGlassRequest,
  breakGlassErrorMessage,
  buildFeatureFlagUpdatePayload,
  featureFlagUpdateError,
} from './client-elevation';

describe('formatRemaining', () => {
  it('残り時間を m:ss で返す', () => {
    const now = 1_000_000;
    expect(formatRemaining(now + 30 * 60 * 1000, now)).toBe('30:00');
    expect(formatRemaining(now + 12 * 60 * 1000 + 34 * 1000, now)).toBe('12:34');
    expect(formatRemaining(now + 5 * 1000, now)).toBe('0:05');
  });

  it('期限切れ（until <= now）は 0:00 に張り付く（負値を出さない）', () => {
    expect(formatRemaining(1000, 1000)).toBe('0:00');
    expect(formatRemaining(1000, 99_999)).toBe('0:00');
  });

  it('端数ミリ秒は切り上げる（59.2 秒残りを 0:59 に丸めて早すぎる失効表示にしない）', () => {
    expect(formatRemaining(1_059_200, 1_000_000)).toBe('1:00');
  });
});

describe('elevationScopeLabel', () => {
  it('空スコープはプラットフォーム全体', () => {
    expect(elevationScopeLabel({})).toBe('プラットフォーム全体');
  });

  it('限定スコープは階層を列挙する', () => {
    expect(elevationScopeLabel({ tenantId: 't-1' })).toBe('テナント t-1');
    expect(elevationScopeLabel({ tenantId: 't-1', siteId: 's-1' })).toBe('テナント t-1 / 拠点 s-1');
    expect(elevationScopeLabel({ tenantId: 't-1', siteId: 's-1', deviceId: 'd-1' })).toBe(
      'テナント t-1 / 拠点 s-1 / 端末 d-1',
    );
  });
});

describe('buildElevateRequest', () => {
  it('理由と再認証コードから payload を組み立てる（provider は mock の none 固定）', () => {
    const built = buildElevateRequest({ reason: '  障害調査のため  ', credential: 'otp-123' });
    expect(built).toEqual({
      ok: true,
      payload: { reason: '障害調査のため', provider: 'none', credential: 'otp-123' },
    });
  });

  it('理由が空白のみなら送信せずエラー', () => {
    const built = buildElevateRequest({ reason: '   ', credential: 'otp' });
    expect(built).toEqual({ ok: false, error: '操作理由を入力してください。' });
  });

  it('再認証コードが空なら送信せずエラー', () => {
    const built = buildElevateRequest({ reason: '調査', credential: '' });
    expect(built).toEqual({ ok: false, error: '再認証コードを入力してください。' });
  });
});

describe('elevateErrorMessage', () => {
  it('400 reason_required', () => {
    expect(elevateErrorMessage(400, { error: 'reason_required' })).toBe('操作理由を入力してください。');
  });

  it('401 はセッション失効', () => {
    expect(elevateErrorMessage(401, { error: 'unauthorized' })).toContain('再ログイン');
  });

  it('403 reauth_failed は再認証理由別に案内する', () => {
    expect(elevateErrorMessage(403, { error: 'reauth_failed', reason: 'invalid_credential' })).toContain(
      '再認証に失敗',
    );
    expect(elevateErrorMessage(403, { error: 'reauth_failed', reason: 'unsupported' })).toContain(
      '再認証手段が構成されていない',
    );
  });

  it('403 forbidden は権限不足', () => {
    expect(elevateErrorMessage(403, { error: 'forbidden' })).toContain('権限がありません');
  });

  it('未知のエラーは HTTP status を含む汎用文言', () => {
    expect(elevateErrorMessage(500, {})).toBe('昇格に失敗しました（HTTP 500）。');
    // body が JSON でない場合（null）でも落ちない
    expect(elevateErrorMessage(502, null)).toBe('昇格に失敗しました（HTTP 502）。');
  });
});

describe('buildNoticePublishPayload', () => {
  it('trim 済みの payload を組み立てる（scope は本増分では platform 固定）', () => {
    const built = buildNoticePublishPayload({
      level: 'warning',
      title: ' メンテ予告 ',
      body: ' 深夜に停止します ',
      reason: ' 定期メンテ告知 ',
    });
    expect(built).toEqual({
      ok: true,
      payload: {
        scope: 'platform',
        level: 'warning',
        title: 'メンテ予告',
        body: '深夜に停止します',
        reason: '定期メンテ告知',
      },
    });
  });

  it('件名/本文/操作理由の欠落はエラー', () => {
    expect(buildNoticePublishPayload({ level: 'info', title: '', body: 'b', reason: 'r' })).toEqual({
      ok: false,
      error: '件名を入力してください。',
    });
    expect(buildNoticePublishPayload({ level: 'info', title: 't', body: ' ', reason: 'r' })).toEqual({
      ok: false,
      error: '本文を入力してください。',
    });
    expect(buildNoticePublishPayload({ level: 'info', title: 't', body: 'b', reason: '' })).toEqual({
      ok: false,
      error: '操作理由を入力してください（監査に記録されます）。',
    });
  });
});

describe('noticePublishError', () => {
  it('403 elevation_required は昇格導線へ誘導する', () => {
    const e = noticePublishError(403, { error: 'elevation_required', reason: 'not_elevated' });
    expect(e.needsElevation).toBe(true);
    expect(e.message).toContain('昇格');
  });

  it('昇格の期限切れ/失効は再昇格を促す', () => {
    expect(noticePublishError(403, { error: 'elevation_required', reason: 'expired' })).toEqual({
      needsElevation: true,
      message: '昇格の期限が切れています。再度昇格してから実行してください。',
    });
    expect(noticePublishError(403, { error: 'elevation_required', reason: 'revoked' })).toEqual({
      needsElevation: true,
      message: '昇格は終了済みです。再度昇格してから実行してください。',
    });
  });

  it('400 invalid_input はサーバの検証メッセージを表示する', () => {
    const e = noticePublishError(400, { error: 'invalid_input', message: 'title too long (max 200)' });
    expect(e.needsElevation).toBe(false);
    expect(e.message).toBe('入力が不正です: title too long (max 200)');
  });

  it('401 / 403 forbidden / その他', () => {
    expect(noticePublishError(401, { error: 'unauthorized' }).message).toContain('再ログイン');
    expect(noticePublishError(403, { error: 'forbidden' }).message).toContain('権限がありません');
    expect(noticePublishError(500, { error: 'store_failed' }).message).toBe(
      'お知らせの登録に失敗しました（HTTP 500）。',
    );
    expect(noticePublishError(502, null).message).toBe('お知らせの登録に失敗しました（HTTP 502）。');
  });
});

describe('buildBreakGlassRequest (#83 §3)', () => {
  const ok = { reason: '本番障害の緊急対応', credential: 'otp', acknowledged: true };

  it('理由・再認証コード・緊急確認が揃えば acknowledge:true 付き payload を返す', () => {
    const built = buildBreakGlassRequest(ok);
    expect(built).toEqual({
      ok: true,
      payload: { reason: '本番障害の緊急対応', provider: 'none', credential: 'otp', acknowledge: true },
    });
  });

  it('緊急確認（解錠ステップ）が無ければ弾く', () => {
    const built = buildBreakGlassRequest({ ...ok, acknowledged: false });
    expect(built.ok).toBe(false);
  });

  it('理由/再認証コードの空は弾く', () => {
    expect(buildBreakGlassRequest({ ...ok, reason: '  ' }).ok).toBe(false);
    expect(buildBreakGlassRequest({ ...ok, credential: '' }).ok).toBe(false);
  });
});

describe('breakGlassErrorMessage (#83 §3)', () => {
  it('acknowledge_required は緊急確認を促す', () => {
    expect(breakGlassErrorMessage(400, { error: 'acknowledge_required' })).toContain('緊急');
  });
  it('それ以外は通常昇格のエラー文言に委譲する', () => {
    expect(breakGlassErrorMessage(400, { error: 'reason_required' })).toBe(
      elevateErrorMessage(400, { error: 'reason_required' }),
    );
    expect(breakGlassErrorMessage(401, null)).toBe(elevateErrorMessage(401, null));
  });
});

describe('buildFeatureFlagUpdatePayload (#83 inc5a)', () => {
  it('フラグキー + 有効/無効 + 操作理由から PATCH payload を組み立てる', () => {
    const built = buildFeatureFlagUpdatePayload({
      key: 'voiceSynthesis',
      enable: false,
      reason: ' PoC プランのため ',
    });
    expect(built).toEqual({
      ok: true,
      payload: { flags: { voiceSynthesis: false }, reason: 'PoC プランのため' },
    });
  });

  it('操作理由の空はネットワークに出す前に弾く（#83 §2 理由必須）', () => {
    expect(buildFeatureFlagUpdatePayload({ key: 'voiceSynthesis', enable: false, reason: '  ' })).toEqual({
      ok: false,
      error: '操作理由を入力してください（監査に記録されます）。',
    });
  });
});

describe('featureFlagUpdateError (#83 inc5a)', () => {
  it('未昇格 403 は昇格導線つきエラー（notice と同じ汎用マップ）', () => {
    const e = featureFlagUpdateError(403, { error: 'elevation_required', reason: 'not_elevated' });
    expect(e.needsElevation).toBe(true);
    expect(e.message).toContain('昇格');
  });

  it('昇格スコープ外（scope）も昇格導線つきエラーにする（対象テナントの明示昇格が要る）', () => {
    const e = featureFlagUpdateError(403, { error: 'elevation_required', reason: 'scope' });
    expect(e.needsElevation).toBe(true);
  });

  it('404 は対象テナント不存在の文言', () => {
    const e = featureFlagUpdateError(404, { error: 'not_found' });
    expect(e.needsElevation).toBe(false);
    expect(e.message).toContain('見つかりません');
  });

  it('その他は操作名入りの汎用文言', () => {
    expect(featureFlagUpdateError(500, { error: 'store_failed' }).message).toBe(
      '機能フラグの変更に失敗しました（HTTP 500）。',
    );
  });
});
