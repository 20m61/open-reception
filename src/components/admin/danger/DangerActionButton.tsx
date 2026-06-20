'use client';

import { useState } from 'react';
import {
  canConfirm,
  normalizedReason,
  validateConfirm,
  EMPTY_INPUT,
  type ConfirmInput,
  type ConfirmIssue,
  type ConfirmRequirement,
} from './confirm-flow';

/**
 * 危険操作の **確認フロー** を担う振る舞いコンポーネント (issue #91, increment 1)。
 *
 * 責務はあくまで挙動（二段確認・影響範囲提示・理由入力・確認文言入力 → 実行可否）であり、
 * 見た目の器（DangerZone のレイアウト/トークン）は #92 の `components/admin/ui/` が作る。
 * 名前衝突を避けるため、ここは `DangerActionButton`（≠ DangerZone / ConfirmDialog）とする。
 *
 * 実行を許すのは confirm-flow の全要件を満たしたときのみ。`onConfirm` には正規化済み reason を
 * 渡し、呼び出し側が recordDangerAction 等で監査連携できるようにする（機微値は渡さない）。
 */
export function DangerActionButton({
  label,
  requirement,
  impactSummary,
  busy = false,
  onConfirm,
}: {
  /** 実行ボタンの文言（例「テナントを停止する」）。 */
  label: string;
  /** 確認フローの要件（影響範囲 ack / 理由 / 確認文言）。 */
  requirement: ConfirmRequirement;
  /** 影響範囲の説明（requireImpactAck 時に提示）。PII を含めない。 */
  impactSummary?: string;
  busy?: boolean;
  /** 全要件充足時に呼ばれる。reason は正規化済み（無ければ undefined）。 */
  onConfirm: (args: { reason?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState<ConfirmInput>(EMPTY_INPUT);

  const issues = validateConfirm(requirement, input);
  const ready = canConfirm(requirement, input);

  function reset() {
    setInput(EMPTY_INPUT);
    setOpen(false);
  }

  function handleConfirm() {
    if (!ready || busy) return;
    onConfirm({ reason: normalizedReason(requirement, input) ?? undefined });
    reset();
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="danger-open"
        onClick={() => setOpen(true)}
        disabled={busy}
        style={dangerGhost}
      >
        {label}
      </button>
    );
  }

  return (
    <div data-testid="danger-flow" style={panel}>
      {requirement.requireImpactAck ? (
        <label style={row}>
          <input
            type="checkbox"
            data-testid="danger-impact"
            checked={input.impactAcknowledged}
            onChange={(e) => setInput((p) => ({ ...p, impactAcknowledged: e.target.checked }))}
          />
          <span>{impactSummary ?? '影響範囲を理解しました'}</span>
        </label>
      ) : null}

      {requirement.requireReason ? (
        <label style={col}>
          <span>操作理由（必須）</span>
          <textarea
            data-testid="danger-reason"
            value={input.reason}
            onChange={(e) => setInput((p) => ({ ...p, reason: e.target.value }))}
            rows={2}
          />
        </label>
      ) : null}

      {requirement.confirmationPhrase !== undefined ? (
        <label style={col}>
          <span>
            確認のため <code>{requirement.confirmationPhrase}</code> と入力してください
          </span>
          <input
            type="text"
            data-testid="danger-phrase"
            value={input.typedPhrase}
            onChange={(e) => setInput((p) => ({ ...p, typedPhrase: e.target.value }))}
          />
        </label>
      ) : null}

      {issues.length > 0 ? (
        <ul data-testid="danger-issues" style={{ margin: 0, paddingLeft: 18, fontSize: '0.85rem' }}>
          {issues.map((i) => (
            <li key={i}>{ISSUE_LABELS[i]}</li>
          ))}
        </ul>
      ) : null}

      <div style={row}>
        <button
          type="button"
          data-testid="danger-confirm"
          onClick={handleConfirm}
          disabled={!ready || busy}
          style={dangerSolid}
        >
          {label}
        </button>
        <button type="button" data-testid="danger-cancel" onClick={reset} disabled={busy} style={ghost}>
          キャンセル
        </button>
      </div>
    </div>
  );
}

const ISSUE_LABELS: Record<ConfirmIssue, string> = {
  'impact-not-acknowledged': '影響範囲の確認が必要です',
  'reason-required': '操作理由を入力してください',
  'reason-too-short': '操作理由が短すぎます',
  'phrase-mismatch': '確認文言が一致しません',
};

const ghost: React.CSSProperties = {
  minHeight: 34,
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  cursor: 'pointer',
};
const dangerGhost: React.CSSProperties = {
  ...ghost,
  borderColor: 'var(--color-danger)',
  color: 'var(--color-danger)',
};
const dangerSolid: React.CSSProperties = {
  ...ghost,
  borderColor: 'var(--color-danger)',
  background: 'var(--color-danger)',
  color: '#fff',
};
const panel: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 12,
  borderRadius: 8,
  border: '1px solid var(--color-danger)',
  background: 'var(--color-surface)',
};
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const col: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
