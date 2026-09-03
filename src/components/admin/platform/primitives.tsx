import type { ReactNode } from 'react';
import { font } from '@/components/admin/ui/tokens';
import { resolveAdminReadState } from '../read-state';

/**
 * プラットフォーム運用コンソール固有の表示プリミティブ (issue #90, increment 1)。
 *
 * 表示のみで I/O・認可ロジックは持たない。
 *
 * 🔴 **ここに置いてよいのは platform でしか意味を持たない部品だけ (#895 / 課題 07)。**
 * かつては `MetricCard` と `StatusBadge` を独自に持っており、共有版（#92）と
 * **角丸が 12/999 対 14/9999** で食い違っていた。この冒頭注記自身が「共有プリミティブが
 * 用意され次第そちらへ寄せる（重複定義しない）」と宣言していたのに、共有版が出来た後も
 * 移行されていなかった —— 宣言は機械が読まないので守られない。
 * `tests/config/platform-shared-primitives.test.ts` が再発を止める。
 */

/**
 * 破壊的操作のプレースホルダ。次増分で昇格・理由入力・確認・監査を伴って実装する導線を
 * 「確認/昇格が必要」と明示して無効化表示する（#83 安全方針の可視化）。
 */
export function DangerActionPlaceholder({ label }: { label: string }) {
  return (
    <div
      role="note"
      style={{
        border: '1px dashed color-mix(in srgb, var(--color-platform-warn) 50%, transparent)',
        borderRadius: 10,
        padding: 'var(--space-md)',
        color: 'var(--color-platform-warn)',
        fontSize: font.small,
      }}
    >
      <strong>{label}</strong>
      <div style={{ opacity: 0.85, marginTop: 4 }}>
        破壊的操作です。実行には昇格・操作理由の入力・確認文言・影響範囲の表示と監査記録が
        必要なため、本増分では無効化しています（次増分で実装）。
      </div>
    </div>
  );
}

/** read 中心スケルトン用の節見出し + 説明。 */
export function ReadOnlySection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section>
      <h1 style={{ marginTop: 0 }}>{title}</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>{description}</p>
      <p style={{ opacity: 0.6, maxWidth: 760, fontSize: '0.8rem' }}>
        本エリアは developer 専用・読み取り中心です。対象テナントは画面上部に常時明示し、
        破壊的操作は確認・昇格・監査を伴う導線に隔離します。
      </p>
      {children}
    </section>
  );
}

/**
 * 表の中の「読み込み中 / 失敗 / 0 件」 (#896 / 課題 06)。
 *
 * platform の一覧は `(data?.tenants ?? []).map(...)` で `<tbody>` を描いており、
 * **`data` が `null`（読み込み中）でも空配列（0 件）でも `<tbody>` が空になるだけ**だった。
 * 失敗しても `data` は `null` のままなので、`read-state.ts` が警告している
 * 「**失敗が『読み込み中』に化ける**」がそのまま起きていた。
 *
 * 状態の決め方は `resolveAdminReadState` を使う —— #886 の `AdminReadGate` と
 * **同じ 3 状態の語彙**にして、画面ごとに別の判断を書かせない。
 *
 * 失敗の**理由**は表の外の `role="alert"` が伝える（そちらが正本）。ここは表が
 * 黙って空になるのを防ぐ役で、理由を二重に書かない。
 */
export function TableBodyState({
  loaded,
  failed,
  rowCount,
  columns,
  emptyMessage,
  testId,
}: {
  /** 対象のデータが載っているか。 */
  readonly loaded: boolean;
  /** 直近の読み取りが失敗したか。 */
  readonly failed: boolean;
  /** いま描いている行数。 */
  readonly rowCount: number;
  /** 表の列数（`colSpan` に使う。合っていないと行が崩れる）。 */
  readonly columns: number;
  /** 0 件のときの文言。一覧ごとに「何が」無いのかを書く。 */
  readonly emptyMessage: string;
  /** e2e が一覧ごとに引けるようにする接頭辞。 */
  readonly testId: string;
}) {
  const state = resolveAdminReadState({ loaded, failed });
  // 下界: 行が在るなら何も足さない（常に何か出すと一覧に余計な行が居座る）。
  if (state === 'loaded' && rowCount > 0) return null;

  const { suffix, label } =
    state === 'loading'
      ? { suffix: 'loading', label: '読み込み中…' }
      : state === 'failed'
        ? { suffix: 'failed', label: '読み込めませんでした。' }
        : { suffix: 'empty', label: emptyMessage };

  return (
    <tr>
      <td
        data-testid={`${testId}-${suffix}`}
        colSpan={columns}
        style={{ padding: 'var(--space-md)', color: 'var(--color-muted)', textAlign: 'center' }}
      >
        {label}
      </td>
    </tr>
  );
}
