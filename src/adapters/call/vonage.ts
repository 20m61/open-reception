/**
 * 本番 Vonage 呼び出し adapter のスキャフォールド (issue #4)。
 *
 * 実際の Vonage Video/Voice 接続（server-side token 発行・session 作成）は
 * インフラ DESIGN（docs/infrastructure-design.md）の通知サブシステム経由で実装する。
 * 本スキャフォールドは CallAdapter 境界（#20）への差し替え構造と secret 取り扱いを定める。
 */
import type { CallAdapter, CallRequest, CallResult } from './types';
import type { VonageConfig } from '@/lib/call/vonage-config';

export class VonageCallAdapter implements CallAdapter {
  constructor(private readonly config: VonageConfig) {}

  async call(_request: CallRequest): Promise<CallResult> {
    // server-side で短命トークンを発行し session を作成する実装をここに置く。
    // secret/private key はサーバ内に留め、クライアントへ渡さない。
    // 実連携は後続（通知サブシステム/Vonage SDK 接続）で実装する。
    return { status: 'failed', reason: 'vonage_not_implemented' };
  }
}
