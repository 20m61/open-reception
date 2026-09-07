import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments, tryCatchBlocks } from '../../../domain/governance/fetch-failure-scan';
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
    for (const failure of ['rejected', 'unreachable', 'unreadable'] satisfies SaveFailure[]) {
      expect(saveFailureMessage(failure).trim().length).toBeGreaterThan(0);
    }
  });

  /**
   * 🔴 **応答が届いた後の例外を `unreachable` に丸めない。** 200 で本文が壊れている
   * （プロキシによる切断・`Content-Length` 途中終了）ときサーバは保存できている可能性が
   * 高く、「通信状態を確かめてください」は運用者を**誤った方向へ調べに行かせる**。
   */
  describe('unreadable（届いたが読めなかった）', () => {
    it('3 つとも別の文言になる', () => {
      const all = (['rejected', 'unreachable', 'unreadable'] satisfies SaveFailure[]).map((f) =>
        saveFailureMessage(f),
      );
      expect(new Set(all).size).toBe(3);
    });

    it('通信を疑わせない（届いてはいる）', () => {
      expect(saveFailureMessage('unreadable')).not.toContain('接続できませんでした');
      expect(saveFailureMessage('unreadable')).not.toContain('通信状態');
    });

    it('保存の成否は断定しない', () => {
      expect(saveFailureMessage('unreadable')).toContain('分かりません');
    });
  });

  /**
   * 🔴 **宛先。** 拠点別の画面では、保存が飛行中に拠点を切り替えられる。宛先を書かないと
   * B を見ている運用者が A の失敗を自分の画面の話として読み、B を再読み込みして
   * 「問題なし」と結論する —— 断定を避けた文言が、宛先違いで**誤った安心**に変わる。
   */
  describe('about（どの対象の保存か）', () => {
    it('先頭に宛先が付く', () => {
      const withAbout = saveFailureMessage('unreachable', '本社受付');
      expect(withAbout.startsWith('本社受付')).toBe(true);
      expect(withAbout).toContain(saveFailureMessage('unreachable'));
    });

    it('宛先が無ければ何も足さない', () => {
      expect(saveFailureMessage('rejected', undefined)).toBe(saveFailureMessage('rejected'));
    });

    it('🔴 空・空白だけの宛先で見出しを作らない', () => {
      // `: ` だけが頭に付いた文言は、読み上げでも画面でも意味の無いノイズになる。
      expect(saveFailureMessage('rejected', '')).toBe(saveFailureMessage('rejected'));
      expect(saveFailureMessage('rejected', '   ')).toBe(saveFailureMessage('rejected'));
    });

    it('宛先を付けても断定しない不変条件は保たれる', () => {
      const withAbout = saveFailureMessage('unreachable', '本社受付');
      expect(withAbout).not.toContain('保存されていません');
      expect(withAbout).not.toContain('保存に失敗しました');
    });
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
   *
   * **踏めるのは e2e だけ**なので、`tests/e2e/admin-write-failure.spec.ts` に 7 画面ぶんの
   * 接続断ケースを置いた。同じ変異を当て直して **kill されることを実測済み**である
   * （`if (res.ok)` を反転して緊急停止で「有効にしました」と嘘をつく変異も同様）。
   * ここを読んで「静的検査で足りる」と結論しないこと —— 足りていない。
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

    /**
     * 🔴 **`catch` の中に在ることまで見る。** ファイル全体に対する `toContain` だと、
     * `save` の `catch` を消して `load` の `catch` へ同じ綴りを書いた変異が素通りする
     * （`Signage` / `OperatingHours` は `load` 側にも `try`/`catch` がある。独立レビューの
     * 指摘そのもの）。走査は台帳と同じ `fetch-failure-scan` を使い、写しを作らない。
     */
    const catchBodies = (source: string): string[] =>
      tryCatchBlocks(source).map((b) => source.slice(b.catchBody.start, b.catchBody.end));

    it.each(WIRED)('%s は catch の中で「届かなかった」を出す', (name) => {
      const source = sourceOf(name);
      const bodies = catchBodies(source);
      expect(bodies.length, 'catch が 1 つも無い').toBeGreaterThan(0);
      expect(
        bodies.some((b) => b.includes("saveFailureMessage(") && b.includes("'unreachable'")),
        '届かなかった側を出す catch が無い',
      ).toBe(true);
    });

    it.each(WIRED)('%s は文言を書き写していない（写しは必ずズレる）', (name) => {
      // 文言そのものを component へ貼ると、正本を直しても片方だけ残る。
      expect(sourceOf(name)).not.toContain('サーバーに接続できませんでした');
    });

    /**
     * 🔴 **下界。** 上の 2 本は報告のことしか見ておらず、**押せない状態のまま止まる**形を
     * 落とせない（`SignageManager` が実際にそれで、reject すると保存ボタンが固まった）。
     * `finally` の**中**に `setBusy(false)` が在ることまで見る —— 後ろのどこかに在れば
     * よい書き方にすると、`finally` を空にする変異が通る（独立レビュー MINOR）。
     */
    it.each(WIRED)('%s は失敗しても busy を戻す（押せないまま固まらない）', (name) => {
      expect(sourceOf(name)).toMatch(/finally\s*\{[^{}]*setBusy\(false\)/);
    });
  });
});
