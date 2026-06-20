/**
 * 本番 Vonage 呼び出し adapter (issue #4, docs/vonage-call-design.md §10)。
 *
 * increment 2: 受付セッションに対応する Vonage Video セッションを作成し、`calling`（応答待ち）
 * を返す。受付状態は calling のまま保持し、担当者の応答/未応答は後続イベント
 * （/connected, /timeout）で確定する。受付端末・担当者へのトークン配布は token API で行う。
 * secret/private key は server-only。クライアントへは短命トークンのみ（token API 経由）。
 */
import type { CallAdapter, CallRequest, CallResult } from './types';
import type { VonageConfig } from '@/lib/call/vonage-config';
import {
  RestVonageSessionService,
  type VonageSessionRef,
  type VonageSessionService,
} from './vonage-session';

export class VonageCallAdapter implements CallAdapter {
  private readonly service: VonageSessionService;

  constructor(config: VonageConfig, service?: VonageSessionService) {
    this.service = service ?? new RestVonageSessionService(config);
  }

  async call(request: CallRequest): Promise<CallResult> {
    try {
      const session: VonageSessionRef = await this.service.createSession(request.receptionId);
      // セッション確立 → 応答待ち。トークンは受付端末/担当者が token API から取得する。
      return { status: 'calling', sessionId: session.sessionId };
    } catch (err) {
      return { status: 'failed', reason: err instanceof Error ? err.message : 'vonage_call_failed' };
    }
  }
}
