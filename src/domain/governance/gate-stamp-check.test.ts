import { describe, expect, it } from 'vitest';
import { LOCAL_FAST_GATE_VALUES } from './delegation-prompt';
import {
  RECOVERY_ACTIONS,
  RECOVERY_TEXT,
  UNSATISFIED_CAUSE,
  checkLocalFastGateDeclaration,
  renderUnsatisfiedMessage,
  stampScopeMismatch,
  verdictFromExitCode,
  type ScopeFacts,
} from './gate-stamp-check';

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
    expect(r.verdict).toBe('unsatisfied');
  });

  /**
   * 🔴 **語彙ではなく構造で縛る。** 2 版とも語彙で縛って破られた:
   * 1 版目は旧文言の literal 1 本 → 言い換えで素通り。
   * 2 版目は `LOCAL_FAST_GATE_VALUES` の英字値を禁止 → **日本語での言い換え**
   * （「申告を『実行していない』へ書き換えて出し直しても構いません」）で素通り。
   * どちらもレビューの変異で実証された。「散文を lexical で縛って安心する」型が
   * 一段深くなっただけで、変異クラスは同じだった。
   *
   * そこで**自由文を無くした**。逃げ道（申告そのものを下げる）を名指しできるのは
   * 自由文だけなので、メッセージを `RECOVERY_ACTIONS` の描画だけから組み立て、
   * ここで「列挙の中身」と「メッセージが描画結果と完全一致すること」を縛る。
   * どんな言い換えも、型か列挙かこの等式のいずれかを壊さないと入らない。
   */
  it('🔴 提示できる回復手段は、ゲート再実行と spec の置き場所だけ', () => {
    expect([...RECOVERY_ACTIONS]).toEqual(['move-spec', 'rerun-gate']);
  });

  it('🔴 ブロック時の文面は原因＋回復手段の描画だけで出来ている（自由文を足せない）', () => {
    const r = checkLocalFastGateDeclaration('green', () => 'unsatisfied');
    expect(r.recovery).toEqual(RECOVERY_ACTIONS);
    // 🔴 **期待値を `renderUnsatisfiedMessage` から作らない。** 描画関数どうしを比べると、
    // 描画関数に一文足す変異では**両辺が同時に変わって通ってしまう**（実際に踏んだ:
    // レビューの言い換え変異が 17/17 PASS した）。部品から組み直して突き合わせる。
    const expected = `${UNSATISFIED_CAUSE}${RECOVERY_ACTIONS.map((a) => RECOVERY_TEXT[a]).join('')}(#711)`;
    expect(r.message).toBe(expected);
    expect(renderUnsatisfiedMessage(RECOVERY_ACTIONS)).toBe(expected);
  });

  it('回復手段の文面はゲートと spec の置き場所を指す（申告の書き換えを勧めない）', () => {
    expect(RECOVERY_TEXT['rerun-gate']).toContain('--fast');
    expect(RECOVERY_TEXT['move-spec']).toContain('.delegate-');
    const rendered = renderUnsatisfiedMessage(RECOVERY_ACTIONS);
    for (const value of LOCAL_FAST_GATE_VALUES) {
      if (value === 'green') continue;
      expect(rendered, `回復手段として ${value} を名指ししている`).not.toContain(value);
    }
    // 🔴 **英字の値名だけでは足りない。** 逃げ道は日本語でも名指しできる
    // （「申告を『実行していない』へ書き換えて出し直しても構いません」）。構造の縛りに
    // 加えて、意味の側からも塞ぐ —— 部品の中に書かれても落ちる。
    expect(rendered).not.toMatch(/申告[^。]{0,25}(直|書き換|変更|下げ|落と)/);
    expect(rendered).toContain('未追跡');
  });

  it('green と申告され記録もあれば通す', () => {
    expect(checkLocalFastGateDeclaration('green', () => 'satisfied')).toEqual({
      ok: true,
      verdict: 'satisfied',
    });
  });

  it('🔴 判定不能は通す（「測れなかった」を「嘘だった」に倒さない）', () => {
    // ここで落とすと、#705 とまさに同じ型の誤りを逆向きに作ることになる。
    const r = checkLocalFastGateDeclaration('green', () => 'unknown');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('裏取りできませんでした');
    // 🔴 **通した事実だけでなく、判定不能だったことを返す。** 呼び出し側が本文へ
    // 持ち込めないと、「裏取り済みの green」と同じ出力になる（#711 レビュー MAJOR-1）。
    expect(r.verdict).toBe('unknown');
  });

  it.each(['not-run', 'failed'] as const)('%s の申告は裏取りの対象にしない', (declared) => {
    // 「green ではない」と言っているだけなので、検証すべき主張が無い。
    for (const verdict of ['satisfied', 'unsatisfied', 'unknown'] as const) {
      // 🔴 **`unknown`（測ろうとしたが測れなかった）と同じ値にしない。** 同じにすると、
      // 後から `verdict` を集計する側が「該当なし」と「測れなかった」を混同する
      // （#726 が数えるために分けた区別と同じ）。
      expect(checkLocalFastGateDeclaration(declared, () => verdict)).toEqual({
        ok: true,
        verdict: 'not-checked',
      });
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

describe('stampScopeMismatch (#711)', () => {
  const HEAD = 'c70ea477deadbeefc70ea477deadbeefc70ea477';
  const OK: ScopeFacts = {
    head: HEAD,
    porcelain: '',
    callerToplevel: '/repo',
    scriptToplevel: '/repo',
    remoteHead: HEAD,
    headSha: HEAD.slice(0, 7),
    branch: 'fix/x',
  };

  it('コミット済み・clean・push 済み・同一ツリーなら名乗ってよい', () => {
    expect(stampScopeMismatch(OK)).toBeNull();
  });

  it.each([
    ['HEAD を読めない', { head: null }, 'HEAD'],
    ['headSha が違う', { headSha: 'deadbee' }, 'headSha'],
    ['ワークツリーを読めない', { porcelain: null }, 'ワークツリー'],
    ['未コミットの変更がある', { porcelain: ' M a.ts' }, '未コミット'],
    ['まだ push していない', { remoteHead: null }, 'push'],
    ['origin が古い', { remoteHead: 'a'.repeat(40) }, 'origin/fix/x'],
    ['呼び出し元の root を解決できない', { callerToplevel: null }, 'root'],
    ['スクリプト側の root を解決できない', { scriptToplevel: null }, 'root'],
    // 🔴 **この分岐はスクリプト内のクロージャだった間、テストが 1 件も無かった**
    // （レビュー Minor-9）。判定を純関数へ出したので分岐ごとに縛れる。
    ['別 worktree から呼ばれた', { callerToplevel: '/other' }, '違います'],
  ] as const)('%s なら名乗らない', (_name, patch, expected) => {
    const reason = stampScopeMismatch({ ...OK, ...patch });
    expect(reason).not.toBeNull();
    expect(reason).toContain(expected);
  });

  it('SHA の大文字小文字は一致とみなす（正直な運用を誤って格下げしない）', () => {
    expect(stampScopeMismatch({ ...OK, headSha: OK.headSha.toUpperCase() })).toBeNull();
    expect(stampScopeMismatch({ ...OK, remoteHead: HEAD.toUpperCase() })).toBeNull();
  });
});
