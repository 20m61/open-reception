'use client';

import { useState } from 'react';
import {
  KANA_VOICE_IMPACT_NOTE,
  STAFF_KANA_POLICY,
  assessStaffKana,
  kanaFlagLabel,
  kanaIssueMessage,
  rejectsStaffKana,
  summarizeStaffKana,
  type StaffKanaPolicy,
} from '@/domain/staff/kana';
import { Button, Form } from '@/components/admin/ui';
import { color, font, space } from '@/components/admin/ui/tokens';

/**
 * 担当者の読み（よみがな）の案内 (#1287)。
 *
 * 方針（`STAFF_KANA_POLICY`）で振る舞いが変わる:
 * - `required`（案 A）… 必須の印を付け、正しくない読みでは送信できない
 * - `encouraged`（案 B）… 送信はできるが、警告を出し、一覧で印を付ける
 * どちらでも、一覧の印と「音声での自動確定が止まる」説明は出す。
 */

const SEPARATE_HINT = '姓と名を空白で区切る（例: さとう たろう）';

export type KanaFieldState = {
  label: string;
  /** 欄の下に出す案内。`encouraged` で問題があるときは、その警告に置き換わる。 */
  hint: string;
  /** `required` での問題（送信できない）。赤・`aria-invalid` で出す。 */
  error: string | undefined;
  /** `encouraged` での問題（送信はできる）。エラーの見た目にしない（#1287 m4）。 */
  warning: string | undefined;
  required: boolean;
  /** この入力のままでは送信しない（`required` で `ok` 以外）。 */
  blocksSubmit: boolean;
};

/** 読みの入力欄の表示と送信可否。 */
export function kanaFieldState(kana: string, policy: StaffKanaPolicy = STAFF_KANA_POLICY): KanaFieldState {
  const status = assessStaffKana(kana);
  const required = policy === 'required';
  // 空欄は文にしない（入力前から赤くしない）。required では送信だけ止める。
  const issue = status === 'missing' ? undefined : (kanaIssueMessage(status) ?? undefined);
  // encouraged では送信できるので、問題はエラーではなく警告として案内の位置に出す（#1287 m4）。
  const warning = required ? undefined : issue;
  return {
    label: required ? 'よみがな' : 'よみがな（推奨）',
    hint: warning ?? (required ? SEPARATE_HINT : `${SEPARATE_HINT}。無いと音声での自動確定が止まります`),
    error: required ? issue : undefined,
    warning,
    required,
    blocksSubmit: rejectsStaffKana(status, policy),
  };
}

/**
 * 「よみがなを直す」の欄に添える案内。`required` の問題はエラー（危険色）、`encouraged` の問題は
 * 警告（注意色・`role="status"`）として出す（#1287 m4）。問題が無ければ何も描画しない。
 */
export function KanaIssueText({ state, id }: { state: KanaFieldState; id?: string }) {
  if (state.error !== undefined) {
    return (
      <span id={id} data-testid="staff-kana-edit-error" style={{ fontSize: font.caption, color: color.danger }}>
        {state.error}
      </span>
    );
  }
  if (state.warning !== undefined) {
    return (
      <span
        id={id}
        role="status"
        data-testid="staff-kana-edit-warning"
        style={{ fontSize: font.caption, color: color.warning }}
      >
        {state.warning}
      </span>
    );
  }
  return null;
}

/** 一覧の行に付ける印。正しい読みなら何も描画しない。 */
export function StaffKanaFlag({ kana }: { kana: string | undefined }) {
  const label = kanaFlagLabel(assessStaffKana(kana));
  if (label === null) return null;
  return (
    <span
      data-testid="staff-kana-flag"
      style={{
        marginLeft: space.xs,
        padding: '0 6px',
        borderRadius: 4,
        border: `1px solid ${color.warning}`,
        color: color.warning,
        fontSize: font.caption,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

/** 一覧の上に出す、読みが足りない担当者の人数と音声への影響。全員が正しければ描画しない。 */
export function StaffKanaNotice({
  staff,
}: {
  staff: ReadonlyArray<{ readonly kana?: string; readonly enabled: boolean }>;
}) {
  const summary = summarizeStaffKana(staff);
  const parts = (
    [
      ['missing', summary.missing],
      ['unseparated', summary.unseparated],
      ['invalid', summary.invalid],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${kanaFlagLabel(status)}: ${n} 人`);
  if (parts.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="staff-kana-notice"
      style={{
        border: `1px solid ${color.warning}`,
        borderRadius: 8,
        padding: space.sm,
        margin: `${space.sm}px 0`,
        fontSize: font.small,
      }}
    >
      <strong style={{ color: color.warning }}>よみがなを確認してください（{parts.join(' / ')}）</strong>
      <p style={{ margin: `${space.xs}px 0 0` }}>{KANA_VOICE_IMPACT_NOTE}</p>
    </div>
  );
}

/** 一覧の行で読みを直す小さな編集欄。 */
export function StaffKanaEditor({
  staffId,
  kana,
  policy = STAFF_KANA_POLICY,
  onSave,
}: {
  staffId: string;
  kana: string | undefined;
  policy?: StaffKanaPolicy;
  onSave: (kana: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(kana ?? '');
  const [busy, setBusy] = useState(false);
  const state = kanaFieldState(value, policy);
  const inputId = `staff-${staffId}-kana-edit`;
  const issueId = `${inputId}-issue`;

  if (!open) {
    return (
      <Button
        data-testid="staff-kana-edit"
        onClick={() => {
          setValue(kana ?? '');
          setOpen(true);
        }}
      >
        よみがなを直す
      </Button>
    );
  }
  const save = async () => {
    if (busy || state.blocksSubmit) return;
    setBusy(true);
    try {
      if (await onSave(value.trim())) setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Form
      onSubmit={() => void save()}
      aria-label="よみがなを直す"
      style={{ display: 'inline-flex', gap: space.xs, alignItems: 'center', flexWrap: 'wrap' }}
    >
      <input
        id={inputId}
        data-testid="staff-kana-edit-input"
        aria-label="よみがな"
        aria-invalid={state.error !== undefined}
        aria-describedby={state.error !== undefined || state.warning !== undefined ? issueId : undefined}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="さとう たろう"
        style={{ minHeight: 36, padding: '4px 8px' }}
      />
      <Button
        variant="primary"
        type="submit"
        data-testid="staff-kana-edit-save"
        disabled={busy || state.blocksSubmit}
      >
        保存
      </Button>
      <Button data-testid="staff-kana-edit-cancel" onClick={() => setOpen(false)}>
        やめる
      </Button>
      <KanaIssueText state={state} id={issueId} />
    </Form>
  );
}
