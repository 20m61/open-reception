/**
 * JIT 昇格 UX のクライアント用純ロジック (issue #83 §2 / inc4d)。
 *
 * 昇格 UI（ElevationStatus / NoticePublishForm）から使う、I/O を持たない純関数のみを置く。
 * ブラウザ bundle に含まれるため **secret・署名・検証ロジックは置かない**（署名検証・失効判定は
 * サーバ側 `elevation.ts` / `assertElevated` が本体。ここは表示整形とエラー文言のマップだけ）。
 */
import type { ElevationScope } from '@/domain/auth/elevation';

/** UI が保持する昇格ビュー（cookie の中身ではなく、サーバ応答/SSR から得た表示用スナップショット）。 */
export type ElevationView = {
  /** 失効時刻（epoch ms）。 */
  until: number;
  scope: ElevationScope;
  /** 昇格時に入力した操作理由（本人へのリマインド表示用）。 */
  reason: string;
};

/**
 * 残り時間を `m:ss` で整形する。期限切れは `0:00` に張り付く。
 * 端数ミリ秒は**切り上げ**（実際より早く 0:00 を見せて「もう失効した」と誤認させない）。
 */
export function formatRemaining(until: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 昇格スコープの表示ラベル（#83 §2「対象の明示」）。空スコープ = プラットフォーム全体。 */
export function elevationScopeLabel(scope: ElevationScope): string {
  const parts: string[] = [];
  if (scope.tenantId) parts.push(`テナント ${scope.tenantId}`);
  if (scope.siteId) parts.push(`拠点 ${scope.siteId}`);
  if (scope.deviceId) parts.push(`端末 ${scope.deviceId}`);
  return parts.length === 0 ? 'プラットフォーム全体' : parts.join(' / ');
}

type Built<P> = { ok: true; payload: P } | { ok: false; error: string };

/** `POST /api/platform/elevate` の payload。provider は mock 再認証（none）固定（実 MFA は #65）。 */
export type ElevatePayload = { reason: string; provider: 'none'; credential: string };

/** 昇格リクエストの組み立て。空入力はネットワークに出す前に弾く（サーバでも 400 になるが UX 短絡）。 */
export function buildElevateRequest(input: { reason: string; credential: string }): Built<ElevatePayload> {
  const reason = input.reason.trim();
  if (reason === '') return { ok: false, error: '操作理由を入力してください。' };
  if (input.credential === '') return { ok: false, error: '再認証コードを入力してください。' };
  return { ok: true, payload: { reason, provider: 'none', credential: input.credential } };
}

function bodyField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/** `/api/platform/elevate` のエラー応答 → ユーザー向け文言。 */
export function elevateErrorMessage(status: number, body: unknown): string {
  const error = bodyField(body, 'error');
  if (status === 400 && error === 'reason_required') return '操作理由を入力してください。';
  if (status === 401) return 'セッションが失効しています。管理コンソールへ再ログインしてください。';
  if (status === 403 && error === 'reauth_failed') {
    return bodyField(body, 'reason') === 'unsupported'
      ? 'この環境では再認証手段が構成されていないため昇格できません（実 MFA の導入待ち）。'
      : '再認証に失敗しました。再認証コードを確認してください。';
  }
  if (status === 403) return '昇格する権限がありません（developer ロールが必要です）。';
  return `昇格に失敗しました（HTTP ${status}）。`;
}

/** `POST /api/platform/notices` の payload（本増分の対象スコープは platform 全体固定）。 */
export type NoticePublishPayload = {
  scope: 'platform';
  level: string;
  title: string;
  body: string;
  /** 操作理由（監査 recordDangerAction に記録される。PII/機密値を書かない運用）。 */
  reason: string;
};

/**
 * お知らせ登録 payload の組み立て。サーバ（buildNotice）が正だが、必須欠落はネットワーク前に弾く。
 * 操作理由はサーバでは任意だが、#83 §2（理由必須の破壊的操作）に合わせ UI では必須にする。
 */
export function buildNoticePublishPayload(input: {
  level: string;
  title: string;
  body: string;
  reason: string;
}): Built<NoticePublishPayload> {
  const title = input.title.trim();
  const body = input.body.trim();
  const reason = input.reason.trim();
  if (title === '') return { ok: false, error: '件名を入力してください。' };
  if (body === '') return { ok: false, error: '本文を入力してください。' };
  if (reason === '') return { ok: false, error: '操作理由を入力してください（監査に記録されます）。' };
  return { ok: true, payload: { scope: 'platform', level: input.level, title, body, reason } };
}

/** 昇格つき write のエラー表示。needsElevation=true のとき UI は昇格導線へ誘導する。 */
export type ElevatedWriteError = { message: string; needsElevation: boolean };

/** `/api/platform/notices` のエラー応答 → ユーザー向け文言 + 昇格導線フラグ。 */
export function noticePublishError(status: number, body: unknown): ElevatedWriteError {
  const error = bodyField(body, 'error');
  if (status === 403 && error === 'elevation_required') {
    const reason = bodyField(body, 'reason');
    if (reason === 'expired') {
      return { needsElevation: true, message: '昇格の期限が切れています。再度昇格してから実行してください。' };
    }
    if (reason === 'revoked') {
      return { needsElevation: true, message: '昇格は終了済みです。再度昇格してから実行してください。' };
    }
    return { needsElevation: true, message: 'この操作には JIT 昇格が必要です。昇格してから実行してください。' };
  }
  if (status === 401) {
    return { needsElevation: false, message: 'セッションが失効しています。管理コンソールへ再ログインしてください。' };
  }
  if (status === 400 && error === 'invalid_input') {
    const message = bodyField(body, 'message') ?? '';
    return { needsElevation: false, message: `入力が不正です: ${message}` };
  }
  if (status === 403) {
    return { needsElevation: false, message: 'この操作を実行する権限がありません。' };
  }
  return { needsElevation: false, message: `お知らせの登録に失敗しました（HTTP ${status}）。` };
}
