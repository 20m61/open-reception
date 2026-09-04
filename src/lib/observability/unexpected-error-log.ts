/**
 * 未捕捉例外を「画面に出さないぶん、ログには残す」ための 1 行 (#736 Gate A)。
 *
 * 画面側 (`app/kiosk/error.tsx` / `app/global-error.tsx`) は例外の内容を来訪者へ出さない。
 * そのままだと「iPad が固まった」という通報に対して手掛かりがゼロになるので、
 * **Next が採番する `digest` だけ**をログへ残す。
 *
 * 🔴 **`message` / `stack` / `cause` は載せない。** 例外の本文には、来訪者の入力・
 * トークン・内部パスが混ざりうる（`docs`/`.claude/rules/pii-secret-minimization.md`）。
 * `digest` は Next がスタックのハッシュから作る不透明な識別子で、PII を含まない。
 *
 * `error.tsx` の中でこれを組み立てず**この関数に切り出してある**のは、
 * `useEffect` が SSR で走らずコンポーネント経由では性質を縛れないため
 * （`error.test.tsx` の変異検証で、コンポーネント越しのテストが本文を載せる変異を
 * 素通りさせることを実測した）。
 */

/**
 * どの境界が受けたか。切り分けにだけ使う固定語彙。
 *
 * `platform` は運用コンソール専用の境界 (#968)。これが無いあいだ `/platform` の例外は
 * `app`（`global-error.tsx`）まで上がり、**developer に来訪者向けの文言**が出ていた。
 */
export type UnexpectedErrorScope = 'kiosk' | 'app' | 'platform';

export type UnexpectedErrorLogLine = {
  readonly event: 'unexpected_error';
  readonly scope: UnexpectedErrorScope;
  /** Next が採番する識別子。無いこともある（開発ビルド等）ので `null` を許す。 */
  readonly digest: string | null;
};

/**
 * 受け取る形。`message` を型に含めてあるのは `Error` を素で渡せるようにするためだけで、
 * 🔴 **中身は読まない**（読んだら上の方針が壊れる。`error.test.tsx` が変異で縛っている）。
 */
type UnexpectedErrorLike = { readonly digest?: string; readonly message?: string };

export function unexpectedErrorLogLine(
  scope: UnexpectedErrorScope,
  error: UnexpectedErrorLike | undefined,
): UnexpectedErrorLogLine {
  const digest = error?.digest;
  return {
    event: 'unexpected_error',
    scope,
    // 空文字は「無い」と同じ扱いにする。`??` だと '' がそのまま載る。
    digest: digest === undefined || digest === '' ? null : digest,
  };
}
