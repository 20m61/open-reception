/**
 * spec の自由文（`summary` / `extraVerification` / `extraProhibitions`）の検査 (#729)。
 *
 * ## なぜ要るか
 *
 * #710 で委譲プロンプト**生成器の散文**は縛れたが、**人が自由文を書く唯一の入口**である
 * spec.json は無検査だった。生成器がどれだけ「`gh pr create` は使わないこと」と書いても、
 * 呼び出し側が `extraVerification: ['gh pr create --fill で PR を作る']` と書けば、
 * そのまま本文に載って委譲先へ届く（#678 / #702 の損失と同じ経路）。
 */
import { describe, expect, it } from 'vitest';
import { inspectSpecFreeText } from './spec-free-text';

const OK = { summary: '説明。', extraVerification: [], extraProhibitions: [] };

describe('inspectSpecFreeText: 403 になる実行形 (#729)', () => {
  it('素の spec には所見が無い', () => {
    expect(inspectSpecFreeText(OK)).toEqual([]);
  });

  it.each([
    ['summary', { ...OK, summary: '`gh pr create --fill` で PR を作った。' }],
    ['extraVerification', { ...OK, extraVerification: ['`gh pr list` で PR を探す'] }],
    ['extraProhibitions', { ...OK, extraProhibitions: ['`gh pr merge 123` を使うのが早い'] }],
  ] as const)('🔴 %s に 403 になる実行形が入っていたら拒否する', (field, input) => {
    const findings = inspectSpecFreeText(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.field).toBe(field);
    expect(findings[0]?.severity).toBe('reject');
  });

  /**
   * 🔴 **「言及」を書けなくしない。** 生成器自身が「`gh pr create` は使わないこと」と
   * 書いているのだから、spec 側で同じ注意を書くのも正当。#710 で確立した
   * **文単位の役割規則**（禁じるか、観測を述べるときだけコマンドに触れてよい）を使う。
   */
  it.each([
    '`gh pr create` は使わないこと',
    '`gh pr merge` を使うな（REST スクリプトを使う）',
    '`gh pr list` は 403 になるので避ける',
    '2026-08-10 に `gh pr create` が 403 を返すのを実測した',
  ])('禁止・観測の文脈なら通す: %s', (text) => {
    expect(inspectSpecFreeText({ ...OK, summary: text })).toEqual([]);
  });

  /**
   * 🔴 **役割のしるしは「素の言及」しか救わない。** `403` や `使わない` を同じ文へ
   * 混ぜれば実行形が通る、では検査にならない（「`gh pr create --fill` で作る
   * （403 は無視してよい）」が素通りする）。**フラグや引数を伴う形は文脈によらず拒否**する。
   */
  it.each([
    '`gh pr create --fill` で作る（403 は無視してよい）',
    '`gh pr merge 123` を使う（使わないこと、と書いてあるが実際は通る）',
    '2026-08-10 に実測したので `gh pr view --json state` で確認する',
  ])('🔴 実行形は役割のしるしがあっても拒否する: %s', (text) => {
    const findings = inspectSpecFreeText({ ...OK, summary: text });
    expect(findings.map((f) => f.severity)).toContain('reject');
  });

  it('🔴 改行区切りの複数行を 1 文として扱わない', () => {
    // 🔴 **役割のしるしが行をまたいで効かないこと**を見る。`。` だけで割ると
    // 全体が 1 文になり、1 行目の「使わないこと」が 2 行目の配布を**救ってしまう**。
    // 単に複数行を渡すだけでは、割り方を変えても結果が同じで discriminate しない（実際に踏んだ）。
    const findings = inspectSpecFreeText({
      ...OK,
      extraVerification: ['`gh pr create` は使わないこと\n`gh pr list` で PR を探す'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('reject');
    expect(findings[0]?.sentence).toContain('gh pr list');
  });

  it('配列のどの要素かを返す', () => {
    const findings = inspectSpecFreeText({
      ...OK,
      extraVerification: ['正当な指示', '`gh pr view --json state` で確認'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.index).toBe(1);
  });
});

describe('inspectSpecFreeText: 緩和語彙 (#729)', () => {
  /**
   * 🔴 **reject ではなく警告。** 生成器側で使っている `可能なら|差し支え` の禁止を
   * 実 spec へそのまま広げると、**「`npm run x` を実行（可能なら 2 回）」のような
   * 正当な指示を弾く**（#710 のレビューで実測）。偽陽性の代償の方が大きい。
   */
  it('🔴 緩和語彙は warn どまりで、reject しない', () => {
    const findings = inspectSpecFreeText({
      ...OK,
      extraVerification: ['`npm run x` を実行（可能なら 2 回）'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warn');
  });

  it('禁止文を骨抜きにする緩和は警告として拾う', () => {
    const findings = inspectSpecFreeText({
      ...OK,
      extraProhibitions: ['通るならそのまま使ってもよい'],
    });
    expect(findings.map((f) => f.severity)).toEqual(['warn']);
  });

  it('緩和語彙が無ければ何も出さない', () => {
    expect(inspectSpecFreeText({ ...OK, summary: '手順どおりに実行する。' })).toEqual([]);
  });
});
