/**
 * diff gate のブロックに対する**人間の承認**を、差分に固定された値として表す（#680）。
 *
 * ## なぜ要るか
 *
 * `deploy-diff-gate.ts` は `resourceReplacement` / `resourceRemoval` などを見つけると
 * 必ず止まる。これは設計どおりの停止境界だが、**人間が差分を確認して承認したあと、
 * それを通す経路が存在しなかった**。実運用では wrapper の外で `cdk deploy` を直に
 * 叩くことになり、そうすると `scripts/aws-cloud-deploy.sh` の preflight
 * （資格情報の残時間・品質ゲート記録・ツリーの清潔さ・HEAD が push 済みか）と
 * negative security test 8 本が**まるごと省略される**。
 *
 * 要件は「gate を skip して deploy を成功させることは禁止」なので、抜け道を塞いだまま
 * 承認を**第一級の入力**にする。それがこのトークン。
 *
 * ## 何を保証するか / しないか
 *
 * - **保証する**: 承認は「人間が見たその findings 集合」に固定される。findings が
 *   1 件でも増減・変化すればトークンは変わり、古い承認は自動的に無効になる
 * - **保証しない**: トークンは秘密ではない（誰でも計算できる）。これは*認証*ではなく
 *   **取り違え防止**の仕組みで、「別の差分を承認済みとして流してしまう」事故を防ぐ。
 *   実行を止める力は IAM 境界（boundary / restriction ポリシー）が持っている
 */
import { createHash } from 'node:crypto';
import type { DeployBlock } from './deploy-diff-gate';

/**
 * 正規化文字列の区切り。
 *
 * `evidence` は CloudFormation の論理 ID・リソース型・action から作られるので制御文字を
 * 含まない。区切りに制御文字を使うことで、evidence 側から区切りを偽装して別の findings
 * 集合を同じトークンへ衝突させることができない。
 *
 * 🔴 **エスケープ表記で書く。** 生の制御文字をソースへ直接埋めると、diff・レビュー・
 * エディタの正規化で黙って壊れる（一度そう書いて `\0` 入りのファイルになった）。
 */
const FIELD_SEP = '\u0000';
const RECORD_SEP = '\u0001';
const STACK_SEP = '\u0002';

/**
 * findings 集合に対する承認トークン `<stack>:<16 hex>` を作る。
 *
 * 🔴 **`reason` だけでなく `evidence` も含める。** `evidence` には論理 ID・リソース型・
 * action が入っており、これを落とすと「同じ理由で別のリソースが置換される」差分が
 * 同じトークンになってしまう ―― つまり承認の使い回しを許してしまう。
 *
 * 並び順には依存しない（gate が findings を出す順は保証されていないので、順序で
 * 承認が無効化されると運用が壊れる）。
 */
export function approvalToken(stack: string, blocks: readonly DeployBlock[]): string {
  const normalized = blocks
    .map((block) => `${block.reason}${FIELD_SEP}${block.evidence}`)
    .slice()
    .sort()
    .join(RECORD_SEP);
  const hex = createHash('sha256')
    .update(`${stack}${STACK_SEP}${normalized}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `${stack}:${hex}`;
}

/**
 * `approvals`（カンマ区切りの複数トークン。3 スタックぶんを 1 つの環境変数で渡すため）に
 * この stack・この findings に対する承認が含まれているか。
 *
 * 🔴 **完全一致のみ。** 前方一致やワイルドカードを許すと、`*` ひとつで全差分を承認できる
 * ことになり、この仕組みの意味が無くなる。
 *
 * 🔴 **`blocks` が空なら常に false。** 「承認されたから通す」と「そもそも止まっていない」は
 * 別の状態で、呼び出し側が混同すると『承認ログが出ないまま承認扱いになる』
 * （あるいは逆に、ブロック 0 件の正常系に承認ログが出る）。ここで分けておく。
 */
export function isApproved(
  stack: string,
  blocks: readonly DeployBlock[],
  approvals: string | undefined,
): boolean {
  if (blocks.length === 0) return false;
  if (approvals === undefined) return false;
  const expected = approvalToken(stack, blocks);
  return approvals
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .includes(expected);
}
