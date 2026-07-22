/**
 * テスト・ローカル用のスクリプト化 ConnectionProvider (issue #374)。
 *
 * 実 Provider（Vonage 等）を持ち込まずに Orchestrator を検証するための mock。結果列を
 * 台本として与え、1 手ごとに一意な `providerEventId` を採番する。Provider 固有フィールドは
 * 一切外へ出さない（`ConnectionProvider` の契約どおり）。
 */
import type { RouteResult } from './policy';
import type { ConnectCommand, ConnectionProvider, ProviderConnectResult } from './provider';

export type ScriptedProviderOptions = {
  key: string;
  /**
   * 呼び出し順に返す結果列。使い切ったら `whenExhausted`（既定 'no_answer'）を返し続ける。
   * `resultFor` が与えられた場合はそちらを優先する。
   */
  results?: ReadonlyArray<RouteResult>;
  /** endpointId から結果を決める（`results` より優先）。未該当は `whenExhausted`。 */
  resultFor?: (endpointId: string) => RouteResult | undefined;
  /** 結果が尽きたときの既定。 */
  whenExhausted?: RouteResult;
  /**
   * providerEventId の採番を差し替える（テスト用）。既定は 1 手ごとに一意。
   * 意図的に重複 id を返させて Orchestrator の冪等境界を検証する用途に使う。
   */
  eventIdFor?: (n: number, command: ConnectCommand) => string;
};

/** 呼び出し記録（テストの検証用）。アドレスは EndpointRef に含まれないので記録しても機微値は残らない。 */
export type ScriptedProviderCall = {
  endpointId: string;
  action: ConnectCommand['action'];
};

export type ScriptedProvider = ConnectionProvider & {
  /** これまでの connect 呼び出し履歴。 */
  readonly calls: ReadonlyArray<ScriptedProviderCall>;
};

export function createScriptedProvider(options: ScriptedProviderOptions): ScriptedProvider {
  const whenExhausted = options.whenExhausted ?? 'no_answer';
  const results = options.results ?? [];
  const calls: ScriptedProviderCall[] = [];
  let n = 0;

  return {
    key: options.key,
    calls,
    async connect(command: ConnectCommand): Promise<ProviderConnectResult> {
      const index = n;
      n += 1;
      calls.push({ endpointId: command.endpoint.id, action: command.action });

      const result =
        options.resultFor?.(command.endpoint.id) ??
        results[index] ??
        whenExhausted;

      const providerEventId =
        options.eventIdFor?.(index, command) ?? `${options.key}:${command.callUuid}:${index}`;

      return { result, providerEventId };
    },
  };
}
