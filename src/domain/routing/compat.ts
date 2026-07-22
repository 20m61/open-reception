/**
 * 既存 CallRoute（issue #88）→ ContactEndpoint + RoutingPolicy の compatibility reader (issue #374)。
 *
 * **加算的で非破壊**であることが契約:
 *   - `CallRoute` / `CallTargetGroup` / `CallTarget` の型・永続データを一切変更しない（読むだけ）。
 *   - 既存の call-route 管理 UI・API・サービスはそのまま生き続ける。本 reader は「既存ルートを
 *     新モデルとしても読める」ようにするだけで、移行の書き換えは行わない。
 *
 * 写像方針:
 *   - group を fallback 順、group 内 target を priority 昇順に並べ、その順で RoutingStep を作る
 *     （既存 CallRoute の評価順を保存する）。
 *   - **電話（phone）チャネルのみ** PSTN Endpoint（e164）へ写せる。email/slack/teams/webpush は
 *     取次（発話・通話）に載らないので step にせず `skipped` として返す（黙って落とさない）。
 *   - 値が E.164 でない電話ターゲットも `skipped`（invalid_address）にする（不正アドレスを取次へ持ち込まない）。
 *   - アドレス（電話番号）は Endpoint の `e164` にのみ入り、監査・トレースへは出ない。
 */
import type { CallRoute } from '@/domain/notification/call-route';
import { validateEndpoint, type ContactEndpoint } from './endpoint';
import type { RoutingPolicy, RoutingStep } from './policy';

export type CompatSkipReason = 'unsupported_channel' | 'invalid_address';

export type CompatSkippedTarget = {
  groupLabel: string;
  targetLabel: string;
  channel: string;
  reason: CompatSkipReason;
};

export type CallRouteCompatOptions = {
  /** 生成する Endpoint に付ける Provider 識別子。既定 'vonage'。 */
  providerKey?: string;
  /** 各 step の応答待ち秒数。既定 20。 */
  timeoutSeconds?: number;
};

export type CallRouteCompatResult = {
  endpoints: ContactEndpoint[];
  policy: RoutingPolicy;
  /** 取次へ写せなかったターゲット（運用で検知するため）。 */
  skipped: CompatSkippedTarget[];
};

/**
 * 既存 CallRoute 1 本を新ルーティングモデルとして読む。入力は変更しない。
 * phone 以外・不正アドレスの target は step にせず `skipped` で返す。
 */
export function routingFromCallRoute(
  route: CallRoute,
  options: CallRouteCompatOptions = {},
): CallRouteCompatResult {
  const providerKey = options.providerKey ?? 'vonage';
  const timeoutSeconds = options.timeoutSeconds ?? 20;

  const endpoints: ContactEndpoint[] = [];
  const steps: RoutingStep[] = [];
  const skipped: CompatSkippedTarget[] = [];

  route.groups.forEach((group, gi) => {
    const ordered = [...group.targets].sort((a, b) => a.priority - b.priority);
    ordered.forEach((target, ti) => {
      if (target.channel !== 'phone') {
        skipped.push({
          groupLabel: group.label,
          targetLabel: target.label,
          channel: target.channel,
          reason: 'unsupported_channel',
        });
        return;
      }

      const endpointId = `${route.id}:g${gi}:t${ti}`;
      const validated = validateEndpoint({
        id: endpointId,
        ownerType: 'system',
        ownerId: route.id,
        channel: 'pstn',
        e164: target.value,
        providerKey,
        enabled: true,
        label: target.label,
      });
      if (!validated.ok) {
        skipped.push({
          groupLabel: group.label,
          targetLabel: target.label,
          channel: target.channel,
          reason: 'invalid_address',
        });
        return;
      }

      endpoints.push(validated.value);
      steps.push({
        id: `${gi}-${ti}`,
        endpointId,
        action: 'notify',
        timeoutSeconds,
        nextOn: {},
      });
    });
  });

  const policy: RoutingPolicy = {
    id: `compat:${route.id}`,
    tenantId: route.tenantId as string,
    siteId: route.siteId as string,
    name: route.name,
    steps,
    enabled: route.enabled,
  };

  return { endpoints, policy, skipped };
}
