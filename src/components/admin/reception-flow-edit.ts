/**
 * 受付フロー管理 UI の純ロジック (issue #100, increment 2)。
 *
 * 並び替え（order 再採番）と入力項目フォームのドラフト生成を純関数に切り出し、
 * ReceptionFlowsManager（UI）を薄く保つ。検証はドメイン（custom-flow.ts の validateField）と
 * API（service 層）が行うため、ここでは「フォーム入力 → API へ渡す生ドラフト」への整形と、
 * 「並び替え後の order 差分」の計算だけを担う（I/O なし・純粋）。
 */
import type { FieldType, FlowField } from '@/domain/reception/custom-flow';

/** 並び替え結果: 新しい並びと、order が変わった項目の {id, order} だけ。 */
export type ReorderResult<T> = {
  items: T[];
  changed: Array<{ id: string; order: number }>;
};

/**
 * index の項目を dir（-1=上 / +1=下）方向の隣と入れ替え、order を 0..n で振り直す。
 *
 * - 端を越える移動は何もしない（items をそのまま・changed は空）。
 * - 戻り値の changed は「order が実際に変化した項目」のみ（無駄な PATCH を避ける）。
 * - 純粋・非破壊（入力配列は変更しない）。
 */
export function reorderBySwap<T extends { id: string; order: number }>(
  items: readonly T[],
  index: number,
  dir: -1 | 1,
): ReorderResult<T> {
  const target = index + dir;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) {
    return { items: [...items], changed: [] };
  }
  const next = [...items];
  const moved = next[index] as T;
  next[index] = next[target] as T;
  next[target] = moved;
  // order を 0..n で振り直し、元の order から変化した項目だけを changed に集める。
  const originalOrder = new Map(items.map((item) => [item.id, item.order]));
  const renumbered = next.map((item, i) => ({ ...item, order: i }));
  const changed = renumbered
    .filter((item) => originalOrder.get(item.id) !== item.order)
    .map((item) => ({ id: item.id, order: item.order }));
  return { items: renumbered, changed };
}

/**
 * select の選択肢入力（カンマ/改行区切り）を正規化する。
 * 空要素は捨て、前後空白を除く。重複は呼び出し側/検証側に委ねず保持する
 * （ドメイン検証で扱う）。
 */
export function parseOptionsInput(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** 入力項目フォームの生の値。 */
export type FieldFormInput = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** select のときのみ使う選択肢入力（カンマ/改行区切り）。 */
  optionsInput?: string;
};

/**
 * フォーム入力から API へ渡す FlowField ドラフトを組み立てる（検証は API 側）。
 * select 以外では options を付けない。key/label は trim する。
 */
export function buildFieldDraft(input: FieldFormInput): FlowField {
  const base = {
    key: input.key.trim(),
    label: input.label.trim(),
    type: input.type,
    required: input.required,
  };
  if (input.type === 'select') {
    return { ...base, options: parseOptionsInput(input.optionsInput ?? '') };
  }
  return base;
}

/** フォーム入力が最低限そろっているか（key/label 非空、select は選択肢あり）。送信ボタンの活性判定用。 */
export function isFieldFormReady(input: FieldFormInput): boolean {
  if (input.key.trim() === '' || input.label.trim() === '') return false;
  if (input.type === 'select' && parseOptionsInput(input.optionsInput ?? '').length === 0) {
    return false;
  }
  return true;
}
