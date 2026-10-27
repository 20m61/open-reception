import { describe, expect, it } from 'vitest';
import {
  parseAcceptedFlags,
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

describe('parseAcceptedFlags', () => {
  /**
   * 🔴 **由来: 2026-09-14。** `deploy-context.ts` の doc コメントが
   * `aws-issue-credentials.sh --with-context` と書いていたが、実装は `--no-context`
   * （オプトアウト）で、そんなフラグは存在しなかった。散文を実装で裏取りせずに
   * ユーザーへ案内し、`未知の引数: --with-context` を踏ませた。
   *
   * 実装から受け付けるフラグを取り出せれば、散文がそれを名乗っているかを機械で見られる。
   */
  it('case 節から受け付けるフラグを取り出す', () => {
    const source = [
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    --hours)',
      '      HOURS="${2:-}"',
      '      shift 2',
      '      ;;',
      '    --print)',
      '      PRINT=true',
      '      ;;',
      '    --no-context)',
      '      WITH_CONTEXT=false',
      '      ;;',
      '    *)',
      '      echo "未知の引数: $1" >&2',
      '      ;;',
      '  esac',
      'done',
    ].join('\n');
    expect(parseAcceptedFlags(source)).toEqual(['--hours', '--no-context', '--print']);
  });

  it('`|` で複数を並べた case 節も拾う', () => {
    expect(parseAcceptedFlags('    -h|--help)\n      usage\n      ;;')).toEqual(['--help']);
  });

  /**
   * 🔴 **旧版のこのテストは空虚だった。** 素材が
   * `# 使い方: script.sh [--with-ctx]` のような形で、行頭アンカーが無くても一致しない
   * ものだったため、前処理（コメント除去）を丸ごと外す変異が**生存した**（実測）。
   * 「行頭に `)` 付きで現れる」素材を置いて、アンカーそのものを縛る。
   */
  it('行頭の case 節だけを見る（アンカーを緩めると拾ってしまうもので縛る）', () => {
    const source = [
      '#    --commented-out)', // コメント行。アンカーが無いと拾われる
      '      echo "    --in-a-string)"', // 文字列の中。同上
      '    --print)',
      '      ;;',
    ].join('\n');
    expect(parseAcceptedFlags(source)).toEqual(['--print']);
  });

  it('case 節が無ければ空', () => {
    expect(parseAcceptedFlags('echo hi')).toEqual([]);
  });
});
