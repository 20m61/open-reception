/**
 * 接続トークンの提示から実接続許可までを結ぶ唯一の検証経路 (issue #369)。
 *
 * 実 WSS サーバ（AWS 上は API Gateway WebSocket API の `$connect` 相当。実配備は #65／
 * インフラ増分）が呼び出す想定の関数。ここでは:
 *  1. 署名・role・exp（`readVoiceTransportToken`）
 *  2. tenant/site/kiosk/reception への境界一致（`checkTokenBinding`）
 *  3. 同時接続上限（`streamLimiter`）
 *  4. 単回性・リプレイ拒否（`replayGuard`）
 * を **この順序**で検証する。順序を変えると、たとえば同時接続上限チェックの前にリプレイを
 * 消費してしまい、拒否されたはずの接続が token を無駄に消費する（正規の再試行が replayed
 * 扱いになる）ため、消費は最後にする。
 *
 * 同時接続上限の枠は「token の残存 TTL 分だけ確保」する（実ソケットがまだ無いため、
 * 明示 release の代わりに TTL 失効で自動解放する。実 WS 実装が入ったら close hook から
 * 明示 `release` を呼び、TTL より早く解放できるようにする）。
 */
import { readVoiceTransportToken } from './token';
import type { VoiceTransportReplayGuard } from './replay-guard';
import type { VoiceTransportStreamLimiter } from './stream-limiter';
import { checkTokenBinding } from '@/domain/voice-transport/token';
import type {
  VoiceTransportConnectionContext,
  VoiceTransportTokenClaims,
  VoiceTransportTokenRejectionReason,
} from '@/domain/voice-transport/types';

export type VoiceTransportAuthorizationReason =
  | VoiceTransportTokenRejectionReason
  | 'invalid_token'
  | 'replayed'
  | 'concurrency_limit';

export type VoiceTransportAuthorizationResult =
  | { ok: true; claims: VoiceTransportTokenClaims }
  | { ok: false; reason: VoiceTransportAuthorizationReason };

export type VoiceTransportAuthorizerDeps = {
  replayGuard: VoiceTransportReplayGuard;
  streamLimiter: VoiceTransportStreamLimiter;
  maxConcurrentStreamsPerKiosk: number;
  /** テスト用の時刻注入。既定 `Date.now`。 */
  now?: () => number;
};

/** 同時接続上限の枠を保持する既定の最大時間（token 自体の TTL とは独立。安全側の上限）。 */
const DEFAULT_SLOT_TTL_MS = 10 * 60 * 1000;

export async function authorizeVoiceTransportConnection(
  token: string | undefined,
  context: VoiceTransportConnectionContext,
  deps: VoiceTransportAuthorizerDeps,
): Promise<VoiceTransportAuthorizationResult> {
  const claims = await readVoiceTransportToken(token);
  if (!claims) return { ok: false, reason: 'invalid_token' };

  const bindingViolation = checkTokenBinding(claims, context);
  if (bindingViolation) return { ok: false, reason: bindingViolation };

  const now = (deps.now ?? Date.now)();
  const acquired = deps.streamLimiter.tryAcquire(
    claims.kioskId,
    claims.jti,
    deps.maxConcurrentStreamsPerKiosk,
    now + DEFAULT_SLOT_TTL_MS,
  );
  if (!acquired) return { ok: false, reason: 'concurrency_limit' };

  const firstUse = deps.replayGuard.consume(claims.jti, now + DEFAULT_SLOT_TTL_MS);
  if (!firstUse) {
    // ここで replay と判定される token は、jti が正規の初回接続で既に消費済みであることを意味する
    // ため、streamLimiter の枠も同じ jti で既に（初回接続時に）確保済みである。tryAcquire は
    // 同一 streamId の再取得を冪等に true とする設計なので、上の acquire はその既存の枠を
    // 再確認しただけで新規には取っていない —— よってここで release すると初回接続が正当に
    // 保持している枠を誤って解放してしまう（実際にこのバグを一度作り込みテストで検出した）。
    // リプレイ試行は枠を一切変更せず、素通りさせるだけでよい。
    return { ok: false, reason: 'replayed' };
  }

  return { ok: true, claims };
}
