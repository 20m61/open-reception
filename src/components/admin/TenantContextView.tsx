'use client';

/**
 * 対象テナント表示の共有部品 (#423「admin/platform で別実装の TenantSwitcher を共通契約へ統合」)。
 *
 * **意味は統合しない。** admin と platform の切替は別物で、統合すると壊れる:
 *
 * | | admin | platform |
 * | --- | --- | --- |
 * | 母集合 | actor の `accessibleTenants`（サーバが導出して注入） | developer 専用 read API `/api/platform/tenants` |
 * | 「未選択」 | 無い（常にちょうど 1 つが対象） | **有る**（「全テナント横断」） |
 * | 永続化 | server action `selectTenant` → Cookie | `PUT /api/platform/selected-tenant`（**監査に残す**） |
 * | 反映 | `router.refresh()` | フルリロード（platform の read は mount 時 fetch） |
 *
 * 「別語彙で完結した並行実装」と「壊れた実装」は区別する（ADR 0005 で確立した判断）。
 * 実際に重複していたのは**表示**だけ:
 *  - `AdminShell` の固定表示と admin `TenantSwitcher` の単一所属表示が、testid・inline style・
 *    文言まで逐語的に同じだった。**排他レンダリングなので片方を直しても誰も気づかない。**
 *  - `<select>` の inline style が 2 箇所に同じ値で置かれていた。
 *  - **両方が `data-testid="tenant-switcher"`** を使っていた（意味の違う 2 つが同じ testid だと、
 *    片方向けに書いた e2e がもう片方に当たって通る）。testid は呼び出し側が決める形にした。
 *
 * ここは表示だけを持つ（状態・永続化・認可は持たない）。越境拒否と最終認可はサーバが actor を
 * 正として検証する。PII・機密は扱わない（id / name のみ）。
 */

/** 「対象テナント」の見出し文言。3 箇所で同じ文字列を持たないよう 1 箇所に置く。 */
export const TENANT_CONTEXT_LABEL = '対象テナント';

/** 表示に必要な最小のテナント情報（機密・PII を含まない）。 */
export type TenantContextOption = {
  id: string;
  name: string;
};

const CHIP_STYLE: React.CSSProperties = {
  fontSize: '0.875rem',
  padding: '4px 10px',
  borderRadius: 999,
  background: 'var(--color-surface-2)',
};

const SELECT_STYLE: React.CSSProperties = {
  fontSize: '0.875rem',
  padding: '4px 10px',
  borderRadius: 999,
  background: 'var(--color-surface-2)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border-strong)',
};

/**
 * ヘッダの「いま何を対象にしているか」チップの共通表示 (#423)。
 *
 * テナント・拠点で別々に組むと、見た目も文言の形もずれる（実際にテナント側は
 * `AdminShell` と `TenantSwitcher` で逐語的に重複していた）。次元が増えても
 * ここ 1 箇所を直せば揃うようにする。
 */
export function ContextChip({
  testId,
  label,
  value,
  /** 対象が確認できないときの弱い見た目。値そのものは隠さない。 */
  muted = false,
  note,
  ...rest
}: {
  testId: string;
  label: string;
  value: string;
  muted?: boolean;
  /** 「（見つかりません）」等の補足。値の隣に小さく添える。 */
  note?: string;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <span
      data-testid={testId}
      style={muted ? { ...CHIP_STYLE, opacity: 0.7 } : CHIP_STYLE}
      {...rest}
    >
      {label}: <strong>{value}</strong>
      {note === undefined ? null : (
        <span style={{ marginLeft: 4, fontSize: '0.8125rem', opacity: 0.8 }}>{note}</span>
      )}
    </span>
  );
}

/**
 * 切り替えできない場合の固定表示。
 *
 * `data-testid="active-tenant"` は既存 e2e（`tests/e2e/admin-tenant-context.spec.ts`）が
 * 引いているので変えない。
 */
export function TenantContextChip({ tenantName }: { tenantName: string }) {
  return <ContextChip testId="active-tenant" label={TENANT_CONTEXT_LABEL} value={tenantName} />;
}

/**
 * 切り替え UI の表示。
 *
 * `nullOptionLabel` を渡したときだけ「未選択」を先頭に出す。**admin では渡さない** —
 * 単一テナント管理者に「全テナント横断」が見えると、存在しない権限があるように見える。
 */
export function TenantSelect({
  testId,
  options,
  value,
  nullOptionLabel,
  disabled = false,
  onSelect,
  trailing,
}: {
  /** 呼び出し側が決める。admin と platform で別の値にして取り違えを防ぐ。 */
  testId: string;
  options: readonly TenantContextOption[];
  /** 現在の選択。`null` は未選択（`nullOptionLabel` を渡した場合のみ意味を持つ）。 */
  value: string | null;
  nullOptionLabel?: string;
  disabled?: boolean;
  /** 選択された id。未選択を選んだ場合は `null`。 */
  onSelect: (id: string | null) => void;
  /** 末尾に添える要素（platform の「詳細」リンク等）。 */
  trailing?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
      <span style={{ fontSize: '0.875rem', opacity: 0.7 }}>{TENANT_CONTEXT_LABEL}</span>
      <select
        data-testid={testId}
        aria-label={`${TENANT_CONTEXT_LABEL}を選択`}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onSelect(e.target.value === '' ? null : e.target.value)}
        style={SELECT_STYLE}
      >
        {nullOptionLabel === undefined ? null : <option value="">{nullOptionLabel}</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      {trailing}
    </div>
  );
}
