import type { ReactNode } from 'react';

/**
 * プラットフォーム運用コンソール固有の表示プリミティブ (issue #90, increment 1)。
 *
 * トップレベル共有 UI（#92）はまだ無いため、ここでは platform エリアに閉じた最小の
 * 表示部品のみを置く。共有プリミティブが用意され次第そちらへ寄せる（重複定義しない）。
 * 表示のみで I/O・認可ロジックは持たない。
 */

/** 概況カード。指標 1 つ（または「未接続」プレースホルダ）を表示する。 */
export function MetricCard({
  label,
  value,
  pending,
  note,
}: {
  label: string;
  value?: ReactNode;
  /** 実データ未接続。値の代わりに「未接続」を明示する（#90 安全 UX: 偽の安心を与えない）。 */
  pending?: boolean;
  note?: string;
}) {
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        borderRadius: 12,
        padding: 'var(--space-md)',
        border: '1px solid rgba(255,255,255,0.1)',
        minWidth: 160,
      }}
    >
      <div style={{ fontSize: '0.8rem', opacity: 0.65 }}>{label}</div>
      {pending ? (
        <div style={{ fontSize: '0.95rem', opacity: 0.55, marginTop: 6 }} data-testid="metric-pending">
          未接続
        </div>
      ) : (
        <div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: 4 }}>{value}</div>
      )}
      {note ? <div style={{ fontSize: '0.75rem', opacity: 0.5, marginTop: 6 }}>{note}</div> : null}
    </div>
  );
}

/** ステータスバッジ（稼働中 / 停止中 等）。 */
export function StatusBadge({ status }: { status: 'active' | 'suspended' }) {
  const active = status === 'active';
  return (
    <span
      style={{
        fontSize: '0.75rem',
        padding: '2px 8px',
        borderRadius: 999,
        background: active ? 'rgba(80,200,120,0.18)' : 'rgba(200,120,80,0.18)',
        color: active ? '#7fe0a0' : '#e0a880',
      }}
    >
      {active ? '稼働中' : '停止中'}
    </span>
  );
}

/**
 * 破壊的操作のプレースホルダ。次増分で昇格・理由入力・確認・監査を伴って実装する導線を
 * 「確認/昇格が必要」と明示して無効化表示する（#83 安全方針の可視化）。
 */
export function DangerActionPlaceholder({ label }: { label: string }) {
  return (
    <div
      role="note"
      style={{
        border: '1px dashed rgba(224,168,128,0.5)',
        borderRadius: 10,
        padding: 'var(--space-md)',
        color: '#e0a880',
        fontSize: '0.85rem',
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
