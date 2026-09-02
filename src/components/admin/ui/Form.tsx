import type { FormEvent, FormHTMLAttributes } from "react";

/**
 * 管理画面 共有フォーム枠 (#892 / 課題 13)。
 *
 * それまで admin の CRUD は `<div>` + `<Button onClick>` で組まれており、`<form>` は
 * ログイン 2 画面と platform の 3 箇所にしか無かった。結果として**入力欄で Enter を
 * 押しても何も起きない** —— キーボードだけで操作する運用者は、1 項目入力するたびに
 * Tab で送信ボタンまで移動して戻る必要があった。
 *
 * 設計上の約束が 3 つある。
 *
 * 1. **レイアウトを動かさない。** `<form>` の UA 既定 `margin-block-end: 1em` を打ち消す
 *    ため `margin: 0` を先頭に置く（呼び出し側が意図して上書きすることは妨げない）。
 *    変換元の `<div>` の style をそのまま渡せば、描画は画素単位で同一になる。
 * 2. **`noValidate`。** 検証は各画面が自前で持っており（`disabled` と保存時チェック）、
 *    ブラウザ既定の制約検証を後から足すと、`type="datetime-local"` や `type="url"` の
 *    入力が**変換前は通っていた送信を黙って止める**。挙動を変えないためここで切る。
 * 3. **`preventDefault` は枠の側で払う。** 各画面のハンドラは `onClick` 時代と同じ
 *    引数なしのままでよく、`e.preventDefault()` の書き忘れによるページ遷移が起きない。
 *
 * 送信ボタンは `type="submit"` を明示する。`Button` は既定 `type="button"` なので、
 * 変換後も「フォーム内の他のボタンが押すと送信される」という古典的な事故は起きない。
 */
export function Form({
  onSubmit,
  style,
  ...rest
}: Omit<FormHTMLAttributes<HTMLFormElement>, "onSubmit"> & {
  onSubmit: () => void;
}) {
  const handle = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <form
      data-testid="ui-form"
      noValidate
      onSubmit={handle}
      style={{ margin: 0, ...style }}
      {...rest}
    />
  );
}
