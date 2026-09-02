import { describe, expect, it } from 'vitest';
import {
  stripBashComments,
  stripBashCommentsAndStrings,
  stripBashStringLiterals,
} from './bash-source';

describe('stripBashComments', () => {
  it('行頭 # の行を落とす', () => {
    expect(stripBashComments('# note\ncmd\n  # indented\n')).toBe('cmd\n');
  });

  it('行末コメントは落とさない（文字列中の # と区別できないため）', () => {
    expect(stripBashComments('cmd # note')).toBe('cmd # note');
  });

  it('コメントアウトされた呼び出しは消える（この関数の存在理由）', () => {
    expect(stripBashComments('# run_diff_gate "$s"')).not.toContain('run_diff_gate');
  });
});

describe('stripBashStringLiterals', () => {
  it('二重引用符の中身を空にし、引用符は残す', () => {
    expect(stripBashStringLiterals('ROLE="arn:aws:iam::1:role/Foo"')).toBe('ROLE=""');
  });

  it('単一引用符も同じ', () => {
    expect(stripBashStringLiterals("fmt='%(refname)'")).toBe("fmt=''");
  });

  it('引用符の外は残る（本物のコマンドは形を保つ）', () => {
    expect(stripBashStringLiterals('git -C "${ROOT}" branch -r --contains HEAD')).toBe(
      'git -C "" branch -r --contains HEAD',
    );
  });

  it('エラー文言に紛れ込んだ同じ語句は消える', () => {
    expect(stripBashStringLiterals('echo "git branch -r --contains HEAD に失敗" >&2')).toBe(
      'echo "" >&2',
    );
  });

  it('二重引用符の中のエスケープされた引用符で状態が壊れない', () => {
    expect(stripBashStringLiterals('echo "a\\"b" ; cmd')).toBe('echo "" ; cmd');
  });

  it('単一引用符の中ではバックスラッシュはエスケープにならない', () => {
    expect(stripBashStringLiterals("echo 'a\\' ; cmd")).toBe("echo '' ; cmd");
  });

  it('複数行文字列でも行数を保つ（行単位の走査を壊さない）', () => {
    expect(stripBashStringLiterals('echo "a\nb"\ncmd')).toBe('echo "\n"\ncmd');
  });

  /**
   * 🔴 実装中に踏んだ落とし穴。bash では**本物のコマンドが二重引用符の内側**にいる
   * （`x="$(cmd)"`）のが普通で、素朴に中身を落とすと本物まで消える。
   */
  it('二重引用符の中のコマンド置換はコードとして残す', () => {
    expect(
      stripBashStringLiterals(
        'refs="$(git -C "${ROOT}" branch -r --contains HEAD --format=\'%(refname)\')"',
      ),
    ).toBe('refs="$(git -C "" branch -r --contains HEAD --format=\'\')"');
  });

  it('コマンド置換の外にある同じ語句のエラー文言は消える', () => {
    const src = [
      'refs="$(git -C "${ROOT}" branch -r --contains HEAD)"',
      'echo "git branch -r --contains HEAD を実行できませんでした" >&2',
    ].join('\n');
    const stripped = stripBashStringLiterals(src);
    expect([...stripped.matchAll(/branch -r --contains HEAD/g)]).toHaveLength(1);
  });

  it('コマンド置換の入れ子でも閉じ位置を取り違えない', () => {
    expect(stripBashStringLiterals('a="$(f "$(g "x")" )" ; tail')).toBe(
      'a="$(f "$(g "")" )" ; tail',
    );
  });
});

describe('stripBashCommentsAndStrings', () => {
  it('コメント由来と文字列由来の両方の偽陽性を落とす', () => {
    const src = ['# --print を明示すると値を表示する', 'echo "--print を指定してください"', '    --print)'].join(
      '\n',
    );
    const stripped = stripBashCommentsAndStrings(src);
    expect(stripped).not.toContain('--print を');
    expect(stripped).toContain('--print)');
  });
});
