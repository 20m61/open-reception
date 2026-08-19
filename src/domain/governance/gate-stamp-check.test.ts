import { describe, expect, it } from 'vitest';
import { checkLocalFastGateDeclaration, verdictFromExitCode } from './gate-stamp-check';

describe('verdictFromExitCode (#711)', () => {
  it.each([
    [0, 'satisfied'],
    [1, 'unsatisfied'],
    [2, 'unknown'],
  ] as const)('終了コード %i を %s と読む', (code, expected) => {
    expect(verdictFromExitCode(code)).toBe(expected);
  });

  it('🔴 3（記録がまだ無い）は判定不能へ倒す', () => {
    // 「記録が無い」と「別ツリーの記録しかない」は意味が違う。前者で落とすと
    // ゲートを一度も走らせていない環境で委譲が組み立てられなくなる。
    expect(verdictFromExitCode(3)).toBe('unknown');
  });

  it.each([null, 127, 137])('想定外の終了コード（%s）は判定不能へ倒す', (code) => {
    // 落とす側へ倒すと、bash やライブラリが無いだけの環境で委譲が組み立てられなくなる。
    expect(verdictFromExitCode(code)).toBe('unknown');
  });
});

describe('checkLocalFastGateDeclaration (#711)', () => {
  it('🔴 green と申告されたのに記録が無ければ通さない', () => {
    // これが #711 の本体。spec に green と書けば #705 の事象はそのまま再現する。
    const r = checkLocalFastGateDeclaration('green', () => 'unsatisfied');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('green 記録がありません');
    // 🔴 **申告の書き換えを勧めない。** ゲートは実際に green でも、後の編集や
    // repo 内への未追跡ファイル書き込みで指紋はずれる。そこで「not-run へ直せ」と
    // 言えば嘘の申告を書かせることになる（#705 と同じ病の逆向き）。
    expect(r.message).toContain('未追跡');
    expect(r.message).not.toContain('not-run / failed へ直して');
  });

  it('green と申告され記録もあれば通す', () => {
    expect(checkLocalFastGateDeclaration('green', () => 'satisfied')).toEqual({ ok: true });
  });

  it('🔴 判定不能は通す（「測れなかった」を「嘘だった」に倒さない）', () => {
    // ここで落とすと、#705 とまさに同じ型の誤りを逆向きに作ることになる。
    const r = checkLocalFastGateDeclaration('green', () => 'unknown');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('裏取りできませんでした');
  });

  it.each(['not-run', 'failed'] as const)('%s の申告は裏取りの対象にしない', (declared) => {
    // 「green ではない」と言っているだけなので、検証すべき主張が無い。
    for (const verdict of ['satisfied', 'unsatisfied', 'unknown'] as const) {
      expect(checkLocalFastGateDeclaration(declared, () => verdict).ok).toBe(true);
    }
  });

  it.each(['not-run', 'failed'] as const)('%s ではスタンプを読みに行かない', (declared) => {
    // 「green だけを検証する」規則を呼び出し側にも複製させないための遅延受け取り。
    // 読みに行かないことを縛らないと、遅延にした意味が静かに失われる。
    let calls = 0;
    checkLocalFastGateDeclaration(declared, () => {
      calls += 1;
      return 'unsatisfied';
    });
    expect(calls).toBe(0);
  });
});
