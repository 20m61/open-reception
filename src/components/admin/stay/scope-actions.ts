import { resolveScopeGate, type ScopeGateInput } from '../scope-gate';

/**
 * 在館状況画面の「いま何をしてよいか / 何を断定してよいか」(#554)。
 *
 * 判定そのものは拠点別画面に共通なので `resolveScopeGate` へ委譲し、ここは
 * **この画面固有の言い方**だけを持つ。画面ごとに判定を書き直すと必ずずれる
 * （それがこの repo で P1 になり続けた形）。
 *
 * ## この画面に固有の危険
 *
 * **空の在館者一覧は「誰も建物に居ない」と読める。** 拠点切替の途中や取得失敗で
 * 0 件・集計 0 を出すと、避難確認のような場面で嘘をつく。「まだ分かっていない」と
 * 「0 人だと分かっている」を必ず区別する。
 *
 * PII は扱わない（滞在は受付番号での識別のみ）。
 */
export type StayScopeInput = ScopeGateInput;

export type StayScopeActions = {
  /** 再取得してよいか。 */
  canRefresh: boolean;
  /** 退館・取消を実行してよいか。ハンドラと行のボタンが**同じこの値**を見る。 */
  canMutate: boolean;
  /** 集計（在館中◯人）を断定してよいか。 */
  showSummary: boolean;
  /** 一覧が空のときの文言。 */
  emptyMessage: string;
};

const UNAVAILABLE_MESSAGE = {
  'site-list-error': '拠点を確認できないため、在館状況を表示できません。',
  // 「拠点が無い」は障害ではなく未設定。次の行動（拠点の登録）へ誘導する。
  'no-site': 'このテナントにはまだ拠点がありません。拠点を登録すると在館状況を確認できます。',
  'load-failed': '在館状況を取得できませんでした。',
  loading: '読み込み中…',
} as const;

export function resolveStayScopeActions(input: StayScopeInput): StayScopeActions {
  const gate = resolveScopeGate(input);
  return {
    canRefresh: gate.canRefresh,
    canMutate: gate.canMutate,
    showSummary: gate.dataTrusted,
    emptyMessage:
      gate.unavailable === null ? '在館者はいません。' : UNAVAILABLE_MESSAGE[gate.unavailable],
  };
}
