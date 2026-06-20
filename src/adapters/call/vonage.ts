/**
 * 本番 Vonage 呼び出し adapter (issue #4, docs/vonage-call-design.md §10)。
 *
 * increment 1: 受付セッションに対応する Vonage Video セッションを作成し、受付端末向けの
 * publisher 短命トークンを発行する（server-only。secret/private key はクライアントへ渡さない）。
 * 本 increment の `connected` は「通話セッション確立」を意味する暫定セマンティクス。
 * 担当者の実応答（answer/timeout）の非同期検知とクライアント動画 UI は increment 2。
 */
import type { CallAdapter, CallRequest, CallResult } from './types';
import type { VonageConfig } from '@/lib/call/vonage-config';
import {
  RestVonageSessionService,
  type ShortLivedToken,
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
      // 受付端末（publisher）向けの短命トークンを発行する。配布 API は increment 2。
      const _kioskToken: ShortLivedToken = await this.service.issueToken(session, 'publisher');
      void _kioskToken;
      return { status: 'connected' };
    } catch (err) {
      return { status: 'failed', reason: err instanceof Error ? err.message : 'vonage_call_failed' };
    }
  }
}
