/**
 * 呼び出し adapter の境界 (issue #4, #20)。
 * 本番 Vonage adapter はこの interface を実装して差し替える。
 */
export type CallRequest = {
  receptionId: string;
  targetType: 'staff' | 'department';
  targetId: string;
};

export type CallResultStatus = 'connected' | 'timeout' | 'failed';

export type CallResult = {
  status: CallResultStatus;
  /** failed/timeout 時の理由（ログ・代替導線の判断に使う）。 */
  reason?: string;
};

export interface CallAdapter {
  call(request: CallRequest): Promise<CallResult>;
}
