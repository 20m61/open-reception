import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../../domain/governance/fetch-failure-scan';
import { type LoginFailure, loginFailureForStatus, loginFailureMessage } from './login-outcome';

/** 網羅を 1 か所に持つ（増えたときに全部の主張へ波及させる）。 */
const ALL_FAILURES = [
  'rejected',
  'unreachable',
  'server_error',
  'too_many_attempts',
] satisfies LoginFailure[];

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
    for (const failure of ALL_FAILURES) {
      expect(loginFailureMessage(failure).trim().length).toBeGreaterThan(0);
    }
  });

  it('原因ごとに文言が全部違う（2 つが同じなら区別した意味がない）', () => {
    const messages = ALL_FAILURES.map(loginFailureMessage);
    expect(new Set(messages).size).toBe(ALL_FAILURES.length);
  });
});

/**
 * 🔴 **状態コードから失敗の種類への写像 (#1021)。**
 *
 * #1021 で `ADMIN_PASSWORD` を `serverSecret(..., { failClosed: true })` へ寄せた結果、
 * `provider=none` のログインは **5xx を返しうるようになった**（それ以前は 200 と 401 だけ）。
 * `AdminPasswordLogin` は非 ok をすべて `'rejected'` にしていたので、**設定漏れのデプロイで
 * 「パスワードが正しくありません。」と嘘をついた** —— #973 が塞いだ嘘を、別の入口から
 * 踏み直していた。
 *
 * ここで縛る不変条件は 1 つだけ:
 *
 * > 「パスワードが正しくありません」と出してよいのは、**サーバがパスワードを検査した
 * > うえで拒否したとき（401）だけ**である。
 */
describe('状態コードから失敗の種類への写像 (#1021)', () => {
  it('🔴 401 のときだけ rejected（＝「正しくありません」と言ってよい）', () => {
    expect(loginFailureForStatus(401)).toBe('rejected');
  });

  /**
   * 🔴 **下界。** 「401 だけが rejected」は、**全部を server_error にすれば空虚に満たせる**。
   * 上の 1 本と合わせて、401 が確かに rejected 側に居ることまで縛る。
   */
  it.each([500, 502, 503, 409, 400, 403, 429])(
    '%i では rejected にならない（サーバはパスワードを見ていない）',
    (status) => {
      const failure = loginFailureForStatus(status);
      expect(failure).not.toBe('rejected');
      expect(loginFailureMessage(failure)).not.toContain('パスワードが正しくありません');
    },
  );

  /**
   * 🔴 **429 は「設定を疑わせない」（#1021 AC4 / Codex レビュー P2）。**
   *
   * `server_error` へ丸めると運用者は「サーバーの設定を確認してください」と読み、
   * **設定を疑って調べに行く** —— 実際にすべきことは「少し待って、もう一度」である。
   *
   * 🔴 これは #973 が塞ぎ、#1021 増分 1 が塞ぎ直し、#1123 が担当者画面で塞いだのと**同型**。
   * 同じ増分で kiosk 側には対策を入れておきながら、**admin 側に入れ忘れていた**。
   */
  it('🔴 429 は too_many_attempts（設定を疑わせない）', () => {
    expect(loginFailureForStatus(429)).toBe('too_many_attempts');
    const message = loginFailureMessage('too_many_attempts', 90);
    expect(message).not.toContain('設定を確認');
    expect(message).not.toContain('パスワードが正しくありません');
    // 下界: 待てば直ることと、待ち時間が分かるなら秒数を伝える。
    expect(message).toContain('90');
    expect(message).toContain('もう一度');
  });

  /** 🔴 待ち時間が壊れていても文言が壊れない（kiosk 側と同じ境界）。 */
  it.each<number | undefined>([undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -5])(
    '🔴 待ち時間が %s でも文言が壊れない',
    (value) => {
      const message = loginFailureMessage('too_many_attempts', value);
      expect(message).not.toContain('NaN');
      expect(message).not.toContain('undefined');
      expect(message).not.toContain('Infinity');
      expect(message).not.toContain('約 0 秒');
      expect(message).not.toContain('-5');
      expect(message).toContain('もう一度');
    },
  );

  /** 500 の文言は、正否を断定せず、かつ秘密の名前を漏らさない。 */
  it('🔴 server_error の文言が env 名を漏らさない（ログイン画面は未認証で見える）', () => {
    const message = loginFailureMessage('server_error');
    expect(message).not.toMatch(/ADMIN_PASSWORD|SECRET|serverSecret/);
    expect(message).toContain('確認されていません');
  });

  /**
   * 用語の統一。同じ `role="alert"` に出る 2 文が「サーバ」と「サーバー」で割れると、
   * 画面でも読み上げでも揺れる。管理画面の**表示文字列**は長音付きが既存規約
   * （`ui/save-outcome.ts` / `OperatingHoursManager` / `SecurityManager`）。
   */
  it.each(ALL_FAILURES)('%s の文言が「サーバー」表記（長音）で揃っている', (failure) => {
    expect(loginFailureMessage(failure)).not.toMatch(/サーバ(?!ー)/);
  });
});

describe('管理ログインの失敗表示 — 配線 (#973 / #1021)', () => {
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

    /**
     * 拒否側は状態コードの写像を通す。
     *
     * 🔴 **否定 grep（`not.toContain("setFailure('rejected')")`）は撤回した。**
     * それは「実装の書き方」を固定しているだけで、`if (res.status === 401)
     * setFailure('rejected')` という**正当な実装まで赤にする**。振る舞いの側は
     * `tests/e2e/admin-login-failure.spec.ts` が実ブラウザで縛っている（500 で
     * 「パスワードが正しくありません」と言わない）ので、ここは肯定側だけでよい。
     */
    it('拒否側は状態コードの写像を通す', () => {
      expect(source).toContain('loginFailureForStatus(res.status)');
    });

    it('失敗は読み上げに乗る（role="alert"）', () => {
      expect(source).toContain('role="alert"');
    });

    it('文言をコンポーネント側に書き写していない（写しは必ずズレる）', () => {
      expect(source).toContain('loginFailureMessage(failure, retryAfterSec)');
      expect(source).not.toContain('パスワードが正しくありません');
    });

    /**
     * 🔴 **待ち時間を読んでいる（#1021 AC4）。** 読まないと「しばらくしてから」しか
     * 出せず、運用者は**いつ直るのか分からない**（無言の拒否と区別できない）。
     */
    it('🔴 Retry-After ヘッダを読んで文言へ渡している', () => {
      expect(source).toContain("res.headers.get('retry-after')");
      expect(source).toContain('Number.isFinite(parsed)');
    });
  });
});
