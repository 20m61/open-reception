/**
 * シェルスクリプト本文を「検査可能な形」に落とす純関数 (#680 R5)。
 *
 * 🔴 **なぜ要るか。** `scripts/aws-*.sh` の性質は「ソースを読んでマーカーを探す」
 * テストで固定している。ところがこれらのスクリプトは**コメントが本文より長く**、
 * さらに日本語のエラーメッセージが本文とほぼ同じ文字列を含む。素の `indexOf` は
 *
 *  - `# ... run_diff_gate ...`（解説コメント）
 *  - `echo "git branch -r --contains HEAD を実行できませんでした" >&2`（エラー文言）
 *
 * のどちらにも一致するので、**本物の呼び出しを削除しても緑のまま**になる。
 * 本ブランチはこの型の欠陥を 4 回踏んでいる（Critical 2 M1 / Important 6 /
 * R5 の 4 アサーション）。検査の前に落とす。
 *
 * **限界を明記する**（実装した以上を主張しない）:
 *  - `stripBashComments` は**行頭 `#` の行だけ**を落とす。行末コメント
 *    （`cmd # note`）は残る ―― 行末の `#` は文字列中の `#` と区別できないため。
 *  - ヒアドキュメントの内側に行頭 `#` の行があると、それも落ちる。
 *  - `stripBashStringLiterals` は引用符の**中身**だけを空にする。引用符自体は残すので
 *    `ROLE_ARN="..."` のような代入は形が保たれる。コマンド置換 `$( … )` の中身は
 *    コードとして残す（本物のコマンドはしばしばそこにいる）。**バッククォート形式の
 *    コマンド置換は扱わない** ―― 本リポジトリのスクリプトは使っていない。
 */

/** 行頭 `#` のコメント行を落とす。 */
export function stripBashComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * `'...'` / `"..."` の**中身**を空にする（引用符は残す）。
 *
 * エラーメッセージ・usage 文字列の中に本物のコマンドとそっくりな文言があるとき、
 * 「本物の方だけ」を探すために使う。逆に本物が文字列の中にある場合
 * （`ROLE_ARN="arn:...:role/Foo"` など）にはこれを使ってはいけない ―― その用途では
 * `stripBashComments` だけを掛ける。
 */
export function stripBashStringLiterals(source: string): string {
  /**
   * 🔴 **コマンド置換 `"$( … )"` の中はコードとして残す。**
   * `remote_refs="$(git -C "${ROOT}" branch -r --contains HEAD)"` のように、
   * **本物のコマンドが二重引用符の内側にいる**のが bash では普通である。
   * 素朴に「二重引用符の中身を落とす」と本物まで消え、検査が
   * 「マーカーが 0 件」になって（＝落ちて）くれるうちは良いが、
   * 探し方を緩めれば黙って穴になる。
   */
  type Context = 'code' | 'sub' | 'sq' | 'dq';
  const stack: Context[] = ['code'];
  const top = (): Context => stack[stack.length - 1]!;
  let out = '';

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const ctx = top();

    if (ctx === 'code' || ctx === 'sub') {
      out += ch;
      if (ch === "'") stack.push('sq');
      else if (ch === '"') stack.push('dq');
      else if (ch === '$' && source[i + 1] === '(') {
        out += '(';
        i += 1;
        stack.push('sub');
      } else if (ch === ')' && ctx === 'sub') stack.pop();
      continue;
    }

    if (ctx === 'sq') {
      if (ch === "'") {
        out += ch;
        stack.pop();
      } else if (ch === '\n') out += '\n';
      continue;
    }

    // ctx === 'dq'
    if (ch === '\\') {
      i += 1; // エスケープされた 1 文字ごと落とす
      continue;
    }
    if (ch === '"') {
      out += ch;
      stack.pop();
      continue;
    }
    if (ch === '$' && source[i + 1] === '(') {
      out += '$(';
      i += 1;
      stack.push('sub');
      continue;
    }
    // 中身は落とす。ただし改行は残す（行番号と行単位の走査を保つ）。
    if (ch === '\n') out += '\n';
  }
  return out;
}

/** コメントを落としてから文字列の中身を空にする。 */
export function stripBashCommentsAndStrings(source: string): string {
  return stripBashStringLiterals(stripBashComments(source));
}
