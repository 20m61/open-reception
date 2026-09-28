import { describe, expect, it } from 'vitest';
import {
  GATE_EVIDENCE_MARKER,
  assessGateEvidence,
  parseGateEvidence,
  renderGateEvidenceComment,
  type GateEvidence,
} from './gate-evidence';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** `quality-gate.sh` が完走・全 PASS で書き出す形。各テストはここから 1 か所だけ崩す。 */
function greenText(overrides: Record<string, string | null> = {}, extra: string[] = []): string {
  const base: Record<string, string> = {
    version: '1',
    tier: 'full',
    exit: '0',
    stamped: '1',
    head_start: SHA,
    head_end: SHA,
    dirty_start: '0',
    dirty_end: '0',
    started_at: '2026-09-28T19:00:00Z',
    finished_at: '2026-09-28T19:25:00Z',
    'env.runner': 'claude-code-remote',
    'env.os': 'Linux 6.18 x86_64',
  };
  const lines: string[] = [];
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v !== null) lines.push(`${k}=${v}`);
  }
  lines.push(
    'summary=PASS  typecheck (tsc)  (40s)',
    'summary=PASS  loop halt / 変更量 (#424)',
    'summary=NOTE  change-scope  (code)',
    ...extra,
  );
  return `${lines.join('\n')}\n`;
}

function green(overrides: Record<string, string | null> = {}, extra: string[] = []): GateEvidence {
  return parseGateEvidence(greenText(overrides, extra));
}

describe('parseGateEvidence (#1195)', () => {
  it('summary 行を状態・ラベル・詳細に分け、NOTE は判定対象から外す', () => {
    const e = green();
    expect(e.steps).toEqual([
      { status: 'PASS', label: 'typecheck (tsc)', detail: '40s' },
      // ラベル自身の括弧を詳細と取り違えない
      { status: 'PASS', label: 'loop halt / 変更量 (#424)', detail: '' },
    ]);
    expect(e.notes).toEqual(['change-scope (code)']);
    expect(e.environment).toEqual([
      ['runner', 'claude-code-remote'],
      ['os', 'Linux 6.18 x86_64'],
    ]);
    expect(e).toMatchObject({ version: 1, tier: 'full', exitCode: 0, stamped: true });
  });

  it('SKIP の理由を詳細として読む', () => {
    const e = green({}, ['summary=SKIP  secrets (gitleaks)  (gitleaks not installed)']);
    expect(e.steps.at(-1)).toEqual({
      status: 'SKIP',
      label: 'secrets (gitleaks)',
      detail: 'gitleaks not installed',
    });
  });

  it('🔴 同じキーが 2 度あれば throw する（追記 1 行で判定を裏返させない）', () => {
    expect(() => parseGateEvidence(`${greenText()}exit=0\n`)).toThrow(/exit が 2 度/);
  });

  it('key=value でない行・読めない summary 行は throw する', () => {
    expect(() => parseGateEvidence(`${greenText()}garbage\n`)).toThrow(/読めません/);
    expect(() => parseGateEvidence(`${greenText()}summary=PASS\n`)).toThrow(/summary 行/);
  });

  it('欠けた値を「通す側」の既定で埋めない', () => {
    const e = parseGateEvidence('version=1\ntier=full\n');
    expect(e).toMatchObject({ exitCode: null, stamped: false, dirtyAtStart: null, dirtyAtEnd: null });
  });
});

describe('assessGateEvidence (#1195)', () => {
  it('完走・全 PASS・clean・head 一致なら PASS', () => {
    expect(assessGateEvidence(green(), SHA)).toEqual({ passed: true, reasons: [] });
  });

  // 🔴 各行は「green から 1 か所だけ崩すと PASS でなくなる」を縛る。
  // 1 つでも PASS のままなら、その規則は判定に効いていない。
  it.each<[string, Record<string, string | null>, string | null, RegExp]>([
    ['作業ツリーが dirty（開始時）', { dirty_start: '1' }, SHA, /開始時の作業ツリーが dirty/],
    ['作業ツリーが dirty（終了時）', { dirty_end: '1' }, SHA, /終了時の作業ツリーが dirty/],
    ['dirty を測れていない', { dirty_start: null }, SHA, /clean か測れていない/],
    ['dirty が不正値', { dirty_end: 'no' }, SHA, /終了時の作業ツリーが clean か測れていない/],
    ['証拠の SHA が PR の head と違う', {}, OTHER, /証拠が古い/],
    ['PR の head を読めなかった', {}, null, /PR の head を読めなかった/],
    ['HEAD を記録していない', { head_start: null }, SHA, /コミット（HEAD）が記録されていない/],
    ['HEAD が短縮 SHA', { head_start: SHA.slice(0, 12) }, SHA, /コミット（HEAD）が記録されていない/],
    ['実行中に HEAD が動いた', { head_end: OTHER }, SHA, /HEAD が動いた/],
    ['tier が pr', { tier: 'pr' }, SHA, /tier が pr/],
    ['完走していない', { exit: null }, SHA, /完走していない/],
    ['exit が 0 でない', { exit: '1' }, SHA, /exit 1/],
    ['スタンプを書いていない', { stamped: '0' }, SHA, /スタンプ/],
    ['版が違う', { version: '2' }, SHA, /版が 2/],
  ])('%s → PASS と書かない', (_name, overrides, head, reason) => {
    const a = assessGateEvidence(green(overrides), head);
    expect(a.passed).toBe(false);
    expect(a.reasons.join('\n')).toMatch(reason);
  });

  it.each([
    ['SKIP', 'summary=SKIP  sast (semgrep)  (semgrep not installed)', /SKIP: sast \(semgrep\)/],
    ['docs スコープの SKIP', 'summary=SKIP  e2e  (docs-scope: 入力が変わらない)', /SKIP: e2e/],
    ['FAIL', 'summary=FAIL  unit (vitest)  (43s)', /FAIL: unit \(vitest\)/],
    ['知らない状態', 'summary=WARN  lighthouse  (x)', /知らない状態 WARN/],
  ])('%s のステップがあれば PASS と書かない', (_name, line, reason) => {
    const a = assessGateEvidence(green({}, [line]), SHA);
    expect(a.passed).toBe(false);
    expect(a.reasons.join('\n')).toMatch(reason);
  });

  it('🔴 1 ステップも実行していなければ PASS と書かない（NOTE だけでは足りない）', () => {
    const text = greenText()
      .split('\n')
      .filter((l) => !l.startsWith('summary=PASS'))
      .join('\n');
    const a = assessGateEvidence(parseGateEvidence(text), SHA);
    expect(a.passed).toBe(false);
    expect(a.reasons.join('\n')).toMatch(/1 つも実行されていない/);
  });

  it('🔴 SKIP だけのゲートは「実行 0 件」と「SKIP」の両方を理由に挙げる', () => {
    const text = greenText()
      .split('\n')
      .filter((l) => !l.startsWith('summary=PASS'))
      .concat('summary=SKIP  secrets (gitleaks)  (x)')
      .join('\n');
    const reasons = assessGateEvidence(parseGateEvidence(text), SHA).reasons.join('\n');
    expect(reasons).toMatch(/1 つも実行されていない/);
    expect(reasons).toMatch(/SKIP: secrets/);
  });

  it('理由は打ち切らずに全部返す', () => {
    const a = assessGateEvidence(green({ dirty_start: '1', tier: 'pr' }), OTHER);
    expect(a.reasons).toHaveLength(3);
  });
});

describe('renderGateEvidenceComment (#1195)', () => {
  it('先頭に marker を置き、PASS なら SHA を見出しに出す', () => {
    const e = green();
    const body = renderGateEvidenceComment(e, assessGateEvidence(e, SHA), SHA);
    expect(body.startsWith(`${GATE_EVIDENCE_MARKER}\n`)).toBe(true);
    expect(body).toContain('✅ `--full` PASS');
    expect(body).toContain(SHA);
    expect(body).not.toContain('PASS と認めない理由');
    expect(body).toContain('claude-code-remote');
  });

  it('🔴 PASS でなければ「PASS」の見出しを出さず、理由を列挙する', () => {
    const e = green({ dirty_end: '1' });
    const body = renderGateEvidenceComment(e, assessGateEvidence(e, SHA), SHA);
    expect(body).not.toMatch(/✅ `--full` PASS/);
    expect(body).toContain('❌');
    expect(body).toContain('PASS と認めない理由');
    expect(body).toMatch(/終了時の作業ツリーが dirty/);
  });

  it('表のセルを `|` や改行で壊さない', () => {
    const e = green({}, ['summary=SKIP  a|b  (x|y)']);
    const body = renderGateEvidenceComment(e, assessGateEvidence(e, SHA), SHA);
    expect(body).toContain('a\\|b');
    expect(body).toContain('x\\|y');
  });
});
