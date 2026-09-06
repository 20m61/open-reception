import { describe, expect, it } from 'vitest';
import {
  GATE_OPTIONAL_TOOLS,
  formatGateToolSessionReport,
  missingGateTools,
  missingToolTestPrerequisiteMessage,
  playwrightChromiumMissingReason,
  playwrightChromiumReady,
  presentGateTools,
  type GateToolObservation,
} from './gate-tooling';

const ALL_PRESENT: GateToolObservation = {
  gitleaks: true,
  semgrep: true,
  aws: true,
  playwrightChromium: true,
};

describe('gate-tooling (#838)', () => {
  it('全部揃っているときは missing が空', () => {
    expect(missingGateTools(ALL_PRESENT)).toEqual([]);
    expect(presentGateTools(ALL_PRESENT)).toEqual([...GATE_OPTIONAL_TOOLS]);
  });

  it('欠けている道具だけを安定順で名指しする', () => {
    expect(
      missingGateTools({
        gitleaks: false,
        semgrep: true,
        aws: false,
        playwrightChromium: true,
      }),
    ).toEqual(['gitleaks', 'aws']);
  });

  it('キー欠落も欠落扱い（判定不能を PASS に倒さない）', () => {
    expect(missingGateTools({})).toEqual([...GATE_OPTIONAL_TOOLS]);
    expect(missingGateTools({ gitleaks: true })).toEqual([
      'semgrep',
      'aws',
      'playwrightChromium',
    ]);
  });

  it('playwrightChromium が無いと e2e 非 ready', () => {
    expect(playwrightChromiumReady(ALL_PRESENT)).toBe(true);
    expect(playwrightChromiumReady({ ...ALL_PRESENT, playwrightChromium: false })).toBe(false);
    expect(playwrightChromiumReady({})).toBe(false);
  });

  it('SessionStart 報告は欠けを名指しし、gitleaks 欠落時は push 素通しを書く', () => {
    const lines = formatGateToolSessionReport({
      gitleaks: false,
      semgrep: true,
      aws: true,
      playwrightChromium: false,
    });
    expect(lines[0]).toContain('missing');
    expect(lines[0]).toContain('gitleaks');
    expect(lines[0]).toContain('playwrightChromium');
    expect(lines.join('\n')).toContain('gitleaks: MISSING');
    expect(lines.join('\n')).toContain('push-secret-guard will SKIP');
    expect(lines.join('\n')).toContain('npx playwright install chromium');
  });

  it('全部揃っている SessionStart 報告に MISSING を書かない', () => {
    const text = formatGateToolSessionReport(ALL_PRESENT).join('\n');
    expect(text).toContain('all optional tools present');
    expect(text).not.toContain('MISSING');
    expect(text).not.toContain('push-secret-guard will SKIP');
  });

  it('道具前提の失敗メッセージは道具名と無言化の原因を名指しする', () => {
    const message = missingToolTestPrerequisiteMessage('gitleaks');
    expect(message).toContain('gitleaks');
    // 「なぜ無言で欠けるのか」へ到達できること（cloud-setup.sh の `|| true`）。
    expect(message).toContain('cloud-setup.sh');
    expect(message).toContain('|| true');
    // 既に存在する SessionStart 報告へ辿れること。
    expect(message).toContain('gate-tooling');
  });

  it('道具名を差し替えるとメッセージも変わる（定数を返す変異を落とす）', () => {
    const forGitleaks = missingToolTestPrerequisiteMessage('gitleaks');
    const forSemgrep = missingToolTestPrerequisiteMessage('semgrep');
    expect(forGitleaks).not.toEqual(forSemgrep);
    // 下界: どちらも自分の道具名だけを名指しし、他方を混ぜない。
    expect(forSemgrep).toContain('semgrep');
    expect(forSemgrep).not.toContain('gitleaks');
    expect(forGitleaks).not.toContain('semgrep');
  });

  it('e2e 早期失敗の理由文はインストール手順を名指しする', () => {
    const reason = playwrightChromiumMissingReason();
    expect(reason).toContain('playwright chromium not installed');
    expect(reason).toContain('npx playwright install chromium');
  });

  it('欠けを報告しない変異を落とす（下界）', () => {
    // 全部 false なのに「揃っている」と偽る実装を許さない。
    const lines = formatGateToolSessionReport({
      gitleaks: false,
      semgrep: false,
      aws: false,
      playwrightChromium: false,
    });
    expect(lines.some((l) => l.includes('all optional tools present'))).toBe(false);
    expect(missingGateTools({
      gitleaks: false,
      semgrep: false,
      aws: false,
      playwrightChromium: false,
    })).toHaveLength(GATE_OPTIONAL_TOOLS.length);
  });
});
