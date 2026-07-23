/**
 * 結果別遷移（nextOn）編集の純ロジック (issue #374, goto_step 遷移編集 UI)。
 *
 * 文章形式ルートビルダー（`RoutingPolicyManager`）の「結果別の遷移」プルダウンが扱う
 * 4 種の選択肢（既定 / 取次終了 / 別の手順へ / 別ルートへ引き継ぐ）と、選択値から
 * `RouteTransition` を組み立てる/読み解く純関数。DOM を持たない（テスト環境が node のため
 * 表示は薄い JSX に留め、意味のあるロジックはここで単体テストする）。
 *
 * goto_step は「同一ポリシー内の別の手順へ跳ぶ」遷移。これまで UI から編集できず（default /
 * stop / fallback_policy のみ）、seed / API 直叩きでしか設定できなかった。ここで選択肢に
 * 追加し、非エンジニアが「応答なし→次の手順へ」等を文章として組めるようにする。
 */
import type { RouteTransition } from '@/domain/routing/policy';

/** プルダウンの選択肢。'default' は nextOn 未設定（既定遷移）を表す UI 専用の擬似種別。 */
export type TransitionKind = 'default' | 'stop' | 'goto_step' | 'fallback_policy';

export const TRANSITION_KIND_OPTIONS: ReadonlyArray<{ value: TransitionKind; label: string }> = [
  { value: 'default', label: '既定（次の手順へ）' },
  { value: 'stop', label: '取次を終了' },
  { value: 'goto_step', label: '別の手順へ進む' },
  { value: 'fallback_policy', label: '別ルートへ引き継ぐ' },
];

/** 現在の遷移値から UI の選択種別を読み解く（未設定＝既定）。 */
export function transitionKindOf(transition: RouteTransition | undefined): TransitionKind {
  return transition?.kind ?? 'default';
}

/**
 * プルダウンの選択（種別 + 対象）から `RouteTransition` を組み立てる。
 * 'default' は「nextOn からキーを消す」意味なので `undefined` を返す。
 * goto_step / fallback_policy で対象未選択のときは空文字の対象を持つ遷移を返し、
 * 保存時に API 側の検証（unknown_goto_step / unknown_fallback_policy）で弾けるようにする。
 */
export function buildTransition(
  kind: TransitionKind,
  target: { stepId?: string; policyId?: string } = {},
): RouteTransition | undefined {
  switch (kind) {
    case 'default':
      return undefined;
    case 'stop':
      return { kind: 'stop' };
    case 'goto_step':
      return { kind: 'goto_step', stepId: target.stepId ?? '' };
    case 'fallback_policy':
      return { kind: 'fallback_policy', policyId: target.policyId ?? '' };
  }
}

/** goto_step の遷移先候補（同一ポリシーの手順）。表示は接続先ラベル（無ければ手順番号）。 */
export type GotoStepChoice = { stepId: string; label: string };

/**
 * goto_step の遷移先候補を作る。自分自身も候補に含める（応答なしで同じ相手へ再試行する運用が
 * あり得るため。無限ループは Orchestrator の hop 上限が防ぐ）。
 *
 * @param steps 対象ポリシーの手順（順序＝表示順）。
 * @param labelForEndpoint endpointId → 表示ラベルの解決（接続先一覧から）。
 */
export function gotoStepChoices(
  steps: ReadonlyArray<{ id: string; endpointId: string }>,
  labelForEndpoint: (endpointId: string) => string | undefined,
): GotoStepChoice[] {
  return steps.map((s, index) => {
    const epLabel = labelForEndpoint(s.endpointId);
    return { stepId: s.id, label: epLabel ?? `手順 ${index + 1}` };
  });
}
