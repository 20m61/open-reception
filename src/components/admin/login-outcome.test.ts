import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../../domain/governance/fetch-failure-scan';
import { type LoginFailure, loginFailureMessage } from './login-outcome';

/**
 * 管理ログインの失敗が**運用者に届く** (#973)。
 *
 * 由来: `AdminPasswordLogin` は `try { … } finally { setBusy(false) }` で **`catch` が
 * 無かった**。`fetch` が reject する経路（オフライン・DNS 失敗・API 停止）では押しても
 * 何も起きず、ボタンが戻るだけ。運用者は「パスワードが違うのか、押せていないのか」を
 * 区別できない。
 *
 * 🔴 **`catch` を足すだけでは足りない。** boolean の `error` に載せると、通信が届いて
 * いないのに「パスワードが正しくありません」と**嘘をつく**（サーバはパスワードを見て
 * すらいない）。ここで縛るのは「何か出ること」ではなく「**違う原因が違う文言になること**」。
 */
describe('管理ログインの失敗表示 (#973)', () => {
  it('原因ごとに違う文言を出す', () => {
    expect(loginFailureMessage('rejected')).not.toBe(loginFailureMessage('unreachable'));
  });

  it('🔴 届かなかったときに「パスワードが正しくありません」と言わない', () => {
    // これがこの増分の本体。サーバはパスワードを見ていないのだから、正否を断定できない。
    expect(loginFailureMessage('unreachable')).not.toContain('パスワード');
  });

  it('🔴 届かなかったときに原因を断定しない', () => {
    // 端末側がオフラインのことも、サーバが落ちていることもある。分かっているのは
    // 「届かなかった」ことだけ（「果たせない約束をしない」と同じ根）。
    const message = loginFailureMessage('unreachable');
    expect(message).not.toContain('サーバーが停止');
    expect(message).toContain('接続できませんでした');
  });

  it('どの失敗も空でない（空文字は画面にも読み上げにも出ない）', () => {
    // `role="alert"` の空の段落は、報告していないのと同じ（#968 レビュー m-2 と同型）。
    for (const failure of ['rejected', 'unreachable'] satisfies LoginFailure[]) {
      expect(loginFailureMessage(failure).trim().length).toBeGreaterThan(0);
    }
  });

  /**
   * 🔴 **配線まで見る。** 純関数だけを縛ると、component が `catch` を落としても
   * `setFailure('rejected')` へ書き換えても、この unit は全部通る（このリポジトリの
   * component テストは静的レンダリングで、送信の相互作用を踏めない）。
   */
  describe('AdminPasswordLogin への配線', () => {
    // 🔴 コメントを外してから見る。実装コメントは「なぜその文言にしないか」を説明する
    // ために当の文言を引用するので、込みで探すと検査が空虚に通る（#960 で踏んだ型）。
    const source = stripComments(
      readFileSync(join(process.cwd(), 'src/components/admin/AdminPasswordLogin.tsx'), 'utf8'),
    );

    it('🔴 送信に catch があり、届かなかった側の値を載せる', () => {
      expect(source).toMatch(/\}\s*catch\b/);
      expect(source).toContain("setFailure('unreachable')");
    });

    it('サーバが拒否した側は別の値を載せる', () => {
      expect(source).toContain("setFailure('rejected')");
    });

    it('失敗は読み上げに乗る（role="alert"）', () => {
      expect(source).toContain('role="alert"');
    });

    it('文言をコンポーネント側に書き写していない（写しは必ずズレる）', () => {
      expect(source).toContain('loginFailureMessage(failure)');
      expect(source).not.toContain('パスワードが正しくありません');
    });
  });
});
