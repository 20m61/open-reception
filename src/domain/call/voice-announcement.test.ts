import { describe, expect, it } from 'vitest';
import {
  DTMF_CHOICES,
  buildConfirmationNcco,
  buildDetailsNcco,
  resolveStaffChoice,
  staffChoiceToRouteResult,
  type VisitorAnnouncement,
} from './voice-announcement';

/** テスト用の来訪者情報。実在しそうな値は使わない（rules/pii-secret-minimization.md）。 */
const VISITOR: VisitorAnnouncement = {
  visitorName: 'TEST-来訪者',
  companyName: 'TEST-商事',
  purpose: 'TEST-用件',
};

const EVENT_URL = 'https://example.test/api/providers/vonage/dtmf';

/** NCCO 内の全テキストを 1 本に連結する（どのアクションに紛れても検出できるように）。 */
function allText(ncco: readonly unknown[]): string {
  return JSON.stringify(ncco);
}

describe('buildConfirmationNcco — 第 1 段（DTMF 確認前） (#4)', () => {
  const ncco = buildConfirmationNcco({ eventUrl: EVENT_URL, timeoutSeconds: 20 });

  // 🔴 これが #4 の最重要要件。留守番電話・第三者・同僚が出た場合に来訪者情報が流れる。
  it('来訪者の氏名・会社名・用件を一切含まない', () => {
    const text = allText(ncco);
    expect(text).not.toContain(VISITOR.visitorName);
    expect(text).not.toContain(VISITOR.companyName);
    expect(text).not.toContain(VISITOR.purpose);
  });

  it('第 1 段は来訪者情報を引数として受け取れない（型と実装の両方で閉じる）', () => {
    // 引数に来訪者情報を渡す口が無いこと。渡せる形にすると、うっかり第 1 段へ載せられる。
    expect(buildConfirmationNcco.length).toBe(1);
  });

  it('「受付からの電話」であることは伝える', () => {
    expect(allText(ncco)).toContain('受付');
  });

  it('DTMF 入力を要求し、応答先 URL を指定する', () => {
    const input = ncco.find((a) => a.action === 'input');
    expect(input).toBeDefined();
    expect(input).toMatchObject({ eventUrl: [EVENT_URL] });
  });

  it('確認は 1 桁だけ受け付け、猶予は指定どおり（担当者の入力時間を勝手に縮めない）', () => {
    const input = ncco.find((a) => a.action === 'input');
    expect(input).toMatchObject({ dtmf: { maxDigits: 1, timeOut: 20 } });
  });

  it('案内の読み上げ中も押せる（bargeIn）', () => {
    const talk = ncco.find((a) => a.action === 'talk');
    expect(talk).toMatchObject({ bargeIn: true });
  });
});

describe('buildDetailsNcco — 第 2 段（DTMF 確認後） (#4)', () => {
  const ncco = buildDetailsNcco({ visitor: VISITOR, eventUrl: EVENT_URL, timeoutSeconds: 20 });

  it('来訪者情報を案内する', () => {
    const text = allText(ncco);
    expect(text).toContain(VISITOR.visitorName);
    expect(text).toContain(VISITOR.companyName);
  });

  it('選択肢（向かう / 対応不可 / 代理へ）を案内する', () => {
    const text = allText(ncco);
    for (const choice of DTMF_CHOICES) {
      expect(text).toContain(choice.digit);
    }
  });

  it('選択のための DTMF 入力を要求する', () => {
    expect(ncco.find((a) => a.action === 'input')).toMatchObject({
      eventUrl: [EVENT_URL],
      dtmf: { maxDigits: 1 },
    });
  });

  it('用件は任意（未設定でも組み立てられる）', () => {
    const withoutPurpose = buildDetailsNcco({
      visitor: { visitorName: 'TEST-来訪者', companyName: 'TEST-商事' },
      eventUrl: EVENT_URL,
      timeoutSeconds: 20,
    });
    expect(allText(withoutPurpose)).toContain('TEST-来訪者');
  });
});

describe('resolveStaffChoice — DTMF の写像 (#4)', () => {
  it.each([
    ['1', 'accept'],
    ['2', 'coming'],
    ['3', 'declined'],
    ['4', 'delegate'],
  ])('%s → %s', (digit, expected) => {
    expect(resolveStaffChoice(digit)).toBe(expected);
  });

  it.each(['', '0', '5', '9', '#', '*', '11', 'abc'])('未定義の入力 %s は undefined', (digit) => {
    expect(resolveStaffChoice(digit)).toBeUndefined();
  });

  // 🔴 digit↔choice だけを見ると、**label の入れ替え**が素通りする
  // （「1、対応できない」と案内されて 1 を押すと accept になる）。
  // 実装から導出せず、意図をテスト側にハードコードして突き合わせる。
  it.each([
    ['1', '来訪者と話す'],
    ['2', 'まもなく向かう'],
    ['3', '対応できない'],
    ['4', '代理担当へ'],
  ])('%s の案内文が %s であること', (digit, label) => {
    expect(DTMF_CHOICES.find((c) => c.digit === digit)?.label).toBe(label);
  });

  it('DTMF_CHOICES と resolveStaffChoice が同じ表から導かれている', () => {
    // 片方だけ増やすと案内は流れるのに押しても効かない（またはその逆）になる。
    for (const choice of DTMF_CHOICES) {
      expect(resolveStaffChoice(choice.digit)).toBe(choice.choice);
    }
  });
});

describe('staffChoiceToRouteResult — 取次語彙への写像 (#4)', () => {
  it('accept は人へ繋がった（終端成功）', () => {
    expect(staffChoiceToRouteResult('accept')).toBe('answered');
  });

  it('coming は「向かう」＝ 終端成功（取次を止める）', () => {
    expect(staffChoiceToRouteResult('coming')).toBe('staff_coming');
  });

  it.each(['declined', 'delegate'] as const)('%s は次の手へ進む（continuable）', (choice) => {
    // 「対応不可」と「代理へ」は取次語彙では同じ declined。次に誰へ行くかは RoutingPolicy が決める
    // （Provider が代理先を選ばない＝ fallback の判断は Orchestrator の責務。#4 設計方針）。
    expect(staffChoiceToRouteResult(choice)).toBe('declined');
  });
});
