/**
 * 接続 Provider の境界 (issue #374)。
 *
 * 受付ドメインは「どの Endpoint へ・どの動作で繋ぐか」だけを Provider へ渡し、Provider 固有の
 * フィールド（Vonage の conversation/leg id 等）を**受付ドメインへ漏らさない**。Vonage 以外の
 * Provider を足すときは、この interface を実装した adapter を差し替えるだけで済む
 * （受付ドメイン＝ RoutingPolicy / Orchestrator は無改変）＝ AC「Vonage 以外の Provider 追加時に
 * 受付ドメインを変更しない」。
 *
 * 冪等境界: 1 通話は `callUuid`、Provider が返す各イベントは `providerEventId` で識別する。
 * Orchestrator と Provider webhook はこの 2 値の組を境界に分離する（`./ledger.ts`）。
 */
import type { EndpointRef } from './endpoint';
import type { RouteAction, RouteResult } from './policy';

/** Provider へ渡す接続指示。アドレス（e164/uri）は adapter が `providerKey`＋`endpoint.id` で解決する。 */
export type ConnectCommand = {
  /** 通話の冪等キー（受付ドメインが採番）。 */
  callUuid: string;
  /** 接続先の**非機微**参照。adapter 内部で実アドレスへ解決する。 */
  endpoint: EndpointRef;
  action: RouteAction;
  timeoutSeconds: number;
  /**
   * 読み上げ文（announce_and_bridge / notify 用）。PII を最小化した定型文のみ。
   * live_bridge では未使用。
   */
  announceText?: string;
};

/** Provider が返す接続結果（受付ドメイン語彙へ正規化済み）。Provider 固有フィールドを含めない。 */
export type ProviderConnectResult = {
  /** 受付ドメインの結果語彙。Provider 固有ステータスは adapter がここへ写像する。 */
  result: RouteResult;
  /** このイベントの Provider 側識別子。冪等判定（重複配信の無視）に使う。 */
  providerEventId: string;
};

/**
 * 接続 Provider。1 メソッドの狭い境界に保つ（受付ドメインが Provider の内部状態機械に依存しない）。
 * 本番 Vonage adapter・テスト用 mock（`./mock-provider.ts`）がこれを実装する。
 */
export interface ConnectionProvider {
  /** Provider 識別子。ContactEndpoint.providerKey と突合する。 */
  readonly key: string;
  /** 指定 Endpoint へ 1 手接続し、正規化済みの結果を返す。 */
  connect(command: ConnectCommand): Promise<ProviderConnectResult>;
}
