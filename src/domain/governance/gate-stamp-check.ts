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
 * 🔴 **2 / 3 は `gate_stamp_satisfies` の戻り値ではなく、呼び出し側が被せる約束。**
 * `gate_stamp_satisfies` は 0 / 1 しか返さず、「記録ファイルが無い」も「記録はあるが
 * 現ツリーと一致しない（＝この worktree でゲートを通した後に編集した / そもそも
 * 通していない）」も 1 に潰す。前者は**判定不能**（一度も走らせていない / 別 worktree で
 * 走らせた）であって「申告が嘘」ではないので、呼び出し側がファイルの有無を先に見て
 * 3 を、`gate_stamp_file` 自体が失敗（git 外）したら 2 を返す
 * （`scripts/delegate-gate-prompt.ts` の `readStampVerdict`）。
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
 */
export function checkLocalFastGateDeclaration(
  declared: LocalFastGate,
  readVerdict: () => StampVerdict,
): DeclarationCheck {
  if (declared !== 'green') return { ok: true };
  const verdict = readVerdict();
  if (verdict === 'satisfied') return { ok: true };
  if (verdict === 'unsatisfied') {
    return {
      ok: false,
      message:
        'localFastGate に green と申告されていますが、**現ツリーに一致するゲートの green 記録がありません**。' +
        '記録はゲートが実際に検査したツリーに紐づくので、ゲート後に 1 文字でも編集した場合のほか、' +
        '**spec などの未追跡（非 ignore）ファイルをリポジトリ内へ書いた**だけでも一致しなくなります。' +
        'spec はリポジトリ外か `.delegate-*.json`（gitignore 済）へ置き、' +
        '`./scripts/quality-gate.sh --fast` を走らせ直してください。' +
        // 🔴 **ここで「申告を not-run / failed へ直せ」と言わない。** ゲートは実際に
        // green だったのに指紋がずれただけ、という状況が上の 2 通りで普通に起こる。
        // そこで申告の書き換えを勧めると**嘘の申告を書かせる** —— #705 と同じ病を逆向きに
        // 再生産する。申告が誤りであるケースは「事実の指摘」に留め、指示にしない。
        'なお、そもそもローカル `--fast` を通していなかったのであれば、直すべきは申告の方です (#711)。',
    };
  }
  return {
    ok: true,
    message:
      'ゲートスタンプを読めないため、localFastGate の申告を裏取りできませんでした（git 外 / 記録なし / 別 worktree）。' +
      '**判定不能であって申告が嘘という意味ではない**ので、そのまま組み立てます (#711)。',
  };
}
