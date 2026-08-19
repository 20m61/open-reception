/**
 * 委譲プロンプトの `localFastGate` 申告を、ゲートスタンプで裏取りする (#711)。
 *
 * ## なぜ要るか
 *
 * #705 で「ローカル `--fast` は green」という**無条件の断定**を呼び出し側の申告へ移した。
 * 断定を生成器から追い出した点で前進だが、**申告の誠実性に依存している** ——
 * spec.json に `"localFastGate": "green"` と書けば、#705 の事象（完走していないのに
 * green と書いて委譲先へ渡す）はそのまま再現し、出力は修正前と 1 バイトも変わらない。
 *
 * ゲートスタンプ（`scripts/lib/gate-stamp.sh`）は**実際に検査したツリーに紐づく**ので、
 * 「green と申告されたが、現ツリーに一致する記録が無い」を機械的に検出できる。
 *
 * ## 🔴 「測れなかった」を「嘘だった」に倒さない
 *
 * スタンプが読めない状況（git 外・記録がまだ無い・別 worktree）は**判定不能**であって
 * 「申告が嘘」ではない。そこで落とすと、**測れなかったものを FAIL にする**という
 * #705 とまさに同じ型の誤りを、逆向きに作ることになる。判定不能は通し、警告に留める。
 */
import type { LocalFastGate } from './delegation-prompt';

/** スタンプ照合の結果。`gate_stamp_satisfies` の終了コードに対応する。 */
export type StampVerdict = 'satisfied' | 'unsatisfied' | 'unknown';

/**
 * `gate_stamp_satisfies` の終了コードを判定へ翻訳する。
 *
 * 0 = 満たす / 1 = 満たさない / 2 = 判定不能（git 外）/ 3 = 記録がまだ無い。
 *
 * `gate_stamp_satisfies` 自身は 0 / 1 / 2 を返す（2 は `gate_stamp_file` や
 * `gate_tree_fingerprint` の失敗 = git 外。`scripts/lib/gate-stamp.sh`）。
 *
 * 🔴 **3 だけが呼び出し側の上乗せ。** `gate_stamp_satisfies` は「記録ファイルがまだ無い」も
 * 「記録はあるが現ツリーと一致しない（＝この worktree でゲートを通した後に編集した /
 * そもそも通していない）」も 1 に潰す。前者は**判定不能**（一度も走らせていない /
 * 別 worktree で走らせた）であって「申告が嘘」ではないので、呼び出し側がファイルの有無を
 * 先に見て 3 を返す（`scripts/delegate-gate-prompt.ts` の `readStampVerdict`）。
 *
 * **それ以外（起動失敗・シグナル・null）も判定不能**へ倒す —— 落とす側へ倒すと、
 * bash やライブラリが無いだけの環境で委譲が組み立てられなくなる。
 */
export function verdictFromExitCode(code: number | null): StampVerdict {
  if (code === 0) return 'satisfied';
  if (code === 1) return 'unsatisfied';
  return 'unknown';
}

export type DeclarationCheck = {
  /** プロンプトを組み立ててよいか。 */
  readonly ok: boolean;
  /** 人へ見せる理由（`ok` でも警告として出ることがある）。 */
  readonly message?: string;
  /**
   * 実際に得られた判定。**本文へ持ち込むために返す** —— 「裏取り済みの green」と
   * 「測れなかった green」が同じ出力になると、記録が無い環境で #705 の事象が無傷で通る。
   * 裏取りしない申告（`green` 以外）では読みに行かないので `'unknown'`。
   */
  readonly verdict: StampVerdict;
};

/**
 * 申告とスタンプを突き合わせる。
 *
 * **検証できるのは `green` の申告だけ。** `not-run` / `failed` は「green ではない」と
 * 言っているだけなので、裏取りする対象が無い（スタンプが在っても矛盾ではない ——
 * 手元で走らせた後にコミットした、等はふつうに起こる）。
 *
 * `readVerdict` を**遅延**で受けるのはそのため。裏取りしない申告でスタンプを読みに行くと、
 * 「green だけを検証する」という規則が呼び出し側にも複製され、片方だけ変わりうる。
 *
 * @param readVerdict スタンプを読む。**副作用あり**（bash を起動する）。`green` の申告でのみ、
 *   高々 1 回だけ呼ばれる。それ以外では**呼ばれない**（`gate-stamp-check.test.ts` が固定）。
 */
export function checkLocalFastGateDeclaration(
  declared: LocalFastGate,
  readVerdict: () => StampVerdict,
): DeclarationCheck {
  if (declared !== 'green') return { ok: true, verdict: 'unknown' };
  const verdict = readVerdict();
  if (verdict === 'satisfied') return { ok: true, verdict };
  if (verdict === 'unsatisfied') {
    return {
      ok: false,
      verdict,
      message:
        'localFastGate に green と申告されていますが、**現ツリーに一致するゲートの green 記録がありません**。' +
        '記録はゲートが実際に検査したツリーに紐づくので、ゲート後に 1 文字でも編集した場合のほか、' +
        '**spec などの未追跡（非 ignore）ファイルをリポジトリ内へ書いた**だけでも一致しなくなります。' +
        'spec はリポジトリ**直下**の `.delegate-*.json`（gitignore 済）かリポジトリ外へ置き、' +
        '`./scripts/quality-gate.sh --fast` を走らせ直してください。' +
        // 🔴 **回復手段としてゲート以外を名指ししない。** ゲートを通していない側の逃げ道
        // （申告そのものを下げる）をここで挙げると、ブロックされた側にとっては
        // 「再実行は分、申告の書き換えは秒」の選択になり、**嘘の申告を書かせる** ——
        // #705 と同じ病を逆向きに再生産する。条件節を付けても名指しは名指し。
        // `gate-stamp-check.test.ts` が「green 以外の申告値を本文に出さない」を機械で縛る。
        'ローカルで `--fast` を通していないなら記録が無いのは当然で、そのときは申告の方が事実に反しています —— ' +
        'ゲートを走らせてから出し直してください (#711)。',
    };
  }
  return {
    ok: true,
    verdict,
    message:
      'ゲートスタンプを読めないため、localFastGate の申告を裏取りできませんでした（git 外 / 記録なし / 別 worktree）。' +
      '**判定不能であって申告が嘘という意味ではない**ので、そのまま組み立てます (#711)。',
  };
}
