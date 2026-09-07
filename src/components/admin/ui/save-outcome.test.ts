import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../../../domain/governance/fetch-failure-scan';
import { type SaveFailure, saveFailureMessage } from './save-outcome';

/**
 * 設定保存の失敗が**運用者に届く** (#973)。
 *
 * 由来: 設定系の `save` は `try { … } finally { setBusy(false) }` で **`catch` が無かった**。
 * `fetch` が reject する経路（オフライン・DNS 失敗・API 停止）では押しても何も起きず、
 * ボタンが戻るだけ。運用者は「保存できたのか、押せていないのか」を区別できない。
 *
 * 🔴 **`catch` を足すだけでは足りない。** 既定の `failure()`（「保存に失敗しました。」）は
 * **サーバが拒否した**ときの言い方で、届いていない場合に使うと嘘になる。ここで縛るのは
 * 「何か出ること」ではなく「**違う原因が違う文言になること**」と「**断定しないこと**」。
 */
describe('管理画面の保存失敗表示 (#973)', () => {
  it('原因ごとに違う文言を出す', () => {
    expect(saveFailureMessage('rejected')).not.toBe(saveFailureMessage('unreachable'));
  });

  it('🔴 届かなかったときに「保存されていない」と断定しない', () => {
    // reject は「応答を受け取れなかった」だけ。要求がサーバへ届いて適用された直後に
    // 接続が切れた可能性が残るので、成否を断定できない（「果たせない約束をしない」）。
    const message = saveFailureMessage('unreachable');
    expect(message).not.toContain('保存されていません');
    expect(message).not.toContain('保存に失敗しました');
  });

  it('🔴 届かなかったときは、確かめる行動を渡す', () => {
    // 「分からない」で終えると運用者は何もできない。次の行動まで書く。
    const message = saveFailureMessage('unreachable');
    expect(message).toContain('接続できませんでした');
    expect(message).toContain('確かめ');
  });

  it('サーバが拒否した側の文言は既存の既定と同じ（画面と e2e を変えない）', () => {
    expect(saveFailureMessage('rejected')).toBe('保存に失敗しました。');
  });

  it('どの失敗も空でない（空文字は画面にも読み上げにも出ない）', () => {
    for (const failure of ['rejected', 'unreachable'] satisfies SaveFailure[]) {
      expect(saveFailureMessage(failure).trim().length).toBeGreaterThan(0);
    }
  });

  /**
   * 🔴 **配線まで見る。** 純関数だけを縛ると、component が `catch` を落としても
   * この unit は全部通る（component テストは静的レンダリングで、送信を踏めない）。
   *
   * ここに名前が並んでいるファイルは `tests/config/admin-fetch-failure.test.ts` の台帳から
   * **この増分で減らした**ぶんである。台帳の数字と二重に縛ることで、
   * 「台帳から消したのに実際は直っていない」を落とす。
   *
   * ## この検査が見ていないもの（正直に書く）
   *
   * 🔴 **これは「呼び出しが在る」検査で、「呼ばれる」検査ではない。** 報告を条件で包む
   * 変異 —— たとえば `if (!isCurrentScope(startedWith)) failure(…)` —— は、呼び出しが
   * 綴りとして残るのでここも台帳も素通りする（変異 M13 で実測。当初この 2 ファイルには
   * 実際にスコープの門が入っていたので、外して当たり所そのものを消した）。
   * 条件まで踏めるのは、通信を落として画面を見る e2e だけである。
   */
  describe('設定保存への配線', () => {
    const WIRED = [
      'AiGuidanceManager.tsx',
      'BrandingManager.tsx',
      'LanguageSettingsManager.tsx',
      'OperatingHoursManager.tsx',
      'SecurityManager.tsx',
      'SignageManager.tsx',
      'VoiceManager.tsx',
    ] as const;

    // 🔴 コメントを外してから見る。実装コメントは「なぜその文言にしないか」を説明する
    // ために当の文言を引用するので、込みで探すと検査が空虚に通る（#960 で踏んだ型）。
    const sourceOf = (name: string): string =>
      stripComments(readFileSync(join(process.cwd(), 'src/components/admin', name), 'utf8'));

    it.each(WIRED)('%s は保存の catch で「届かなかった」を出す', (name) => {
      const source = sourceOf(name);
      expect(source).toMatch(/\}\s*catch\b/);
      expect(source).toContain("saveFailureMessage('unreachable')");
    });

    it.each(WIRED)('%s は文言を書き写していない（写しは必ずズレる）', (name) => {
      // 文言そのものを component へ貼ると、正本を直しても片方だけ残る。
      expect(sourceOf(name)).not.toContain('サーバーに接続できませんでした');
    });

    /**
     * 🔴 **下界。** 上の 2 本は「`catch` があること」しか見ておらず、`catch` が
     * `save` ではなく `load` の側に付いていても通る。**保存できる状態のまま止まらない**
     * ことまで縛るため、`busy` を戻す責務が `catch` の外（`finally`）に在ることを見る。
     */
    it.each(WIRED)('%s は失敗しても busy を戻す（押せないまま固まらない）', (name) => {
      const source = sourceOf(name);
      expect(source).toMatch(/\}\s*(?:catch\b[^{]*\{[\s\S]*?\}\s*)?finally\s*\{[\s\S]*?setBusy\(false\)/);
    });
  });
});
