/**
 * ルーティングポリシーの文章化 (issue #374)。
 *
 * AC「非エンジニアが呼び出し順を文章として理解・編集できる」のうち **理解（読む）側**を担う
 * 純関数。step 列を日本語の手順文へ落とす。編集 UI（文章形式ルートビルダー）は残 increment。
 *
 * アドレス（e164/uri）は文章に出さない。Endpoint の `label`（PII を含まない表示名）だけを使い、
 * label が無い場合は endpointId で代替する（アドレスは決して露出しない）。
 */
import type { ContactEndpoint } from './endpoint';
import type { RouteAction, RouteResult, RoutingPolicy, RouteTransition } from './policy';

const ACTION_PHRASE: Record<RouteAction, string> = {
  notify: 'へ通知します',
  live_bridge: 'へ直接つなぎます',
  announce_and_bridge: 'へ読み上げてからつなぎます',
};

const RESULT_LABEL: Record<RouteResult, string> = {
  answered: '応答',
  accepted: '受付',
  staff_coming: '対応確定',
  busy: '話中',
  no_answer: '応答なし',
  declined: '拒否',
  failed: '接続失敗',
};

function endpointLabel(endpoints: ReadonlyMap<string, ContactEndpoint>, endpointId: string): string {
  const endpoint = endpoints.get(endpointId);
  if (endpoint === undefined) return `（未登録の接続先 ${endpointId}）`;
  return endpoint.label ?? endpointId;
}

function stepLabel(policy: RoutingPolicy, stepId: string, endpoints: ReadonlyMap<string, ContactEndpoint>): string {
  const step = policy.steps.find((s) => s.id === stepId);
  if (step === undefined) return `手順「${stepId}」`;
  return endpointLabel(endpoints, step.endpointId);
}

function transitionPhrase(
  policy: RoutingPolicy,
  transition: RouteTransition,
  endpoints: ReadonlyMap<string, ContactEndpoint>,
): string {
  switch (transition.kind) {
    case 'stop':
      return '取次を終了します';
    case 'goto_step':
      return `${stepLabel(policy, transition.stepId, endpoints)}へ進みます`;
    case 'fallback_policy':
      return `別ルート（${transition.policyId}）へ引き継ぎます`;
  }
}

/**
 * ポリシーを手順の文章（1 手 = 1 行）へ落とす。先頭は概要行。
 * 明示された結果別遷移（nextOn）があれば各手に補足する。
 */
export function describeRoutingPolicy(
  policy: RoutingPolicy,
  endpoints: ReadonlyArray<ContactEndpoint>,
): string[] {
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  const lines: string[] = [];
  lines.push(`「${policy.name}」の順で取り次ぎます。`);

  policy.steps.forEach((step, index) => {
    const label = endpointLabel(byId, step.endpointId);
    const position = index === 0 ? 'まず' : index === policy.steps.length - 1 ? '最後に' : '次に';
    let line = `${index + 1}. ${position} ${label}${ACTION_PHRASE[step.action]}（${step.timeoutSeconds}秒待つ）。`;

    const isLast = index === policy.steps.length - 1;
    if (isLast && policy.fallbackPolicyId === undefined) {
      line += 'ここまでで繋がらなければ取次を終了します。';
    } else {
      line += '繋がらなければ次へ進みます。';
    }

    // 既定と異なる結果別遷移だけを補足する（既定＝成功で終了／継続可能で次へ）。
    const overrides = (Object.entries(step.nextOn) as [RouteResult, RouteTransition][])
      .map(([result, transition]) => `${RESULT_LABEL[result]}のときは${transitionPhrase(policy, transition, byId)}`)
      .join('、');
    if (overrides !== '') line += `（${overrides}）`;

    lines.push(line);
  });

  return lines;
}

/** {@link describeRoutingPolicy} を 1 つの文字列（改行区切り）にする。 */
export function describeRoutingPolicyText(
  policy: RoutingPolicy,
  endpoints: ReadonlyArray<ContactEndpoint>,
): string {
  return describeRoutingPolicy(policy, endpoints).join('\n');
}
