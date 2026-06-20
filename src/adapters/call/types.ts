/**
 * 呼び出し adapter の境界 (issue #4, #20)。
 * 本番 Vonage adapter はこの interface を実装して差し替える。
 */
export type CallRequest = {
  receptionId: string;
  targetType: 'staff' | 'department';
  targetId: string;
};

/**
 * 'calling' は非同期 adapter（Vonage）専用: セッションは確立したが応答待ち。
 * 受付状態は calling のままとし、応答/未応答は後続イベントで確定する（issue #4 increment 2）。
 * 同期 adapter（Mock）は connected/timeout/failed のみを返す。
 */
export type CallResultStatus = 'connected' | 'timeout' | 'failed' | 'calling';

export type CallResult = {
  status: CallResultStatus;
  /** failed/timeout 時の理由（ログ・代替導線の判断に使う）。 */
  reason?: string;
  /** 'calling' 時に確立した通話セッション ID（受付に紐づけ、トークン発行に使う）。 */
  sessionId?: string;
};

export interface CallAdapter {
  call(request: CallRequest): Promise<CallResult>;
}
