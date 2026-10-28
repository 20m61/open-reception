/**
 * 🔴 **隔離の外への書き込みを、綴りではなく実行時に見る (#1154)。**
 *
 * #1136 で一時領域はテストファイルごとの `TMPDIR` に隔離された（`temp-isolation.ts`）。
 * 残った面は**絶対パスの直書き**で、`tests/config/temp-cleanup-guard.test.ts` の静的走査が
 * `'/tmp/'` と `'/var/folders'` の 2 綴りだけを見ていた —— `'/var/tmp/…'`・
 * `'/private/var/folders/…'`・変数で組んだパスは**素通りする**（fail-open）。
 * 綴りを足す対処はこのリポジトリが何度も撤回してきた「数え上げ」なので、
 * **書き込み API の側で、行き先を実行時に見る**。
 *
 * ## 判定は「許可する場所」の側だけを持つ（fail-closed）
 *
 * 漏れの綴り（`/tmp`・`/var/tmp`・…）は 1 つも持たない。持つのは**回収される場所**だけ:
 *
 * - 隔離の外枠（`OR_VITEST_RUN_ROOT`。ファイルごとの root はここに入り、setup が掃く）
 * - リポジトリ（`process.cwd()`。一時領域ではなく git が見える場所）
 *
 * 🔴 `/dev` は**許可していない**。当初は入れていたが、外してフル unit を回すと違反 0 件
 * （実測）—— 守るものが無い許可は置かない。要るテストが生えたら、そのとき測って足す。
 *
 * それ以外への書き込みはすべて違反として記録し、`temp-isolation.ts` の `afterAll` が
 * そのファイルで大声で落とす。**書き込み自体は止めない** —— 呼び出し元で throw すると
 * 被テストコードの `try/catch` に飲まれて黙る形があるので、観測と判定を分けている。
 *
 * ## 方式を選んだ根拠（#1154 の実測。3 案を同じ条件で比べた）
 *
 * | | 静的走査（現行） | fs の実行時ラップ（採用） | 前後の差分（残骸） |
 * |---|---|---|---|
 * | `/var/tmp` 直書き | ✗ | ✓ | ✓ |
 * | `/private/var/folders` 直書き | ✗ | ✓（呼び出しで見る） | ✗（linux に無い） |
 * | `/tmp` 直書き | ✓ | ✓ | ✓ |
 * | 変数で組んだパス（sync・名前空間・promises） | ✗ | ✓ | ✓ |
 * | 子プロセスの書き込み | ✗（`'/tmp/'` 綴りを子へ渡す形だけ ✓） | ✗ | ✓ |
 * | 実スイートの偽陽性 | 0（ただし抑止マーカー 6 件は全部「作らない参照」） | 試作 1×3 回 → 実装 0×6 回 | 0 / 0 / **7** |
 * | unit の実時間 | — | 無し 147.8s / 有り 148.5s（各 4 回平均、+0.5%） | 試作 3 回平均 160.9s（無し 149.5s） |
 * | 仕組み | 正規表現 1 本 | 書き込み API 11 系統・34 関数（fs の sync/callback と fs/promises）を包む。コード約 80 行 | 見張る dir（数え上げ）を前後 2 回 readdir（`/tmp` 6.9k 件で 1 回約 4ms） |
 *
 * 試作の偽陽性 1 件は「子 vitest が、親が渡した親の一時領域へ書く」形（`ISOLATION_PROBE_OUT`）で、
 * 外枠を env で子へ継がせて 0 にした（下の `RUN_ROOT_ENV`）。
 *
 * 差分方式を採らなかった理由: 見張る場所（`/tmp`・`/var/tmp`・…）を**数え上げる**必要があり、
 * しかも**同じ機械の別プロセス**が作ったもの（実測では他のツールの `*-claim-*`）を
 * 無関係な 7 ファイルのせいにした。並列ワーカーの間でも帰属できない。
 *
 * ## 射程の限界（塞がらないもの）
 *
 * 1. **子プロセスの書き込み**（`sh -c 'echo > /var/tmp/x'`）。プロセスの外は見えない。
 *    子は `TMPDIR` を継ぐので `mktemp` 等は隔離に落ちる。残るのは子が絶対パスを
 *    直書きする形だけで、静的走査（`'/tmp/'` 綴り）とゲートの「一時領域」節の件数が受ける。
 * 2. **fs を経由しないネイティブの書き込み**（アドオン等）。今日のテストには無い。
 * 3. **`afterAll` が走らないファイル**（skip 全滅・収集失敗）。`TMPDIR` の検査と同じ射程。
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 子プロセス（子 vitest 等）へ隔離の外枠を伝える env。親が渡したパスへの書き込みを通すため。 */
export const RUN_ROOT_ENV = 'OR_VITEST_RUN_ROOT';

export interface WriteViolation {
  readonly api: string;
  readonly path: string;
}

/**
 * `path` が `roots` のどれかの中（または一致）か。
 *
 * 🔴 **区切りまで含めて比べる。** `startsWith(root)` だけだと
 * `<root>X/…`（兄弟のディレクトリ）を中と見なす。
 */
export function isInsideRoots(path: string, roots: ReadonlyArray<string>): boolean {
  return roots.some(
    (root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep),
  );
}

/** fs に渡される「パス」を絶対パスへ。fd（数値）は行き先が分からないので `undefined`。 */
function toAbsolutePath(target: unknown): string | undefined {
  if (typeof target === 'string') return resolve(target);
  if (target instanceof URL) return target.protocol === 'file:' ? fileURLToPath(target) : undefined;
  if (Buffer.isBuffer(target)) return resolve(target.toString());
  return undefined;
}

/** `open` 系のフラグが書き込み（作成）を伴うか。既定（未指定）は `'r'`。 */
function opensForWrite(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number') return flags !== 0; // O_RDONLY === 0
  return !/^(r|rs|sr)$/.test(String(flags));
}

/**
 * 包む API と、行き先を表す引数の位置。`open` 系だけはフラグが書き込みのときに見る。
 *
 * 🔴 **これは「漏れの綴り」の列挙ではない。** 対象は Node の書き込み API そのもので、
 * 抜けがあってもパスの綴りには依らない。同じ名前を `fs` と `fs/promises` の両方に当てる。
 */
const WRITE_APIS: ReadonlyArray<
  readonly [name: string, destArgs: readonly number[], flagArg?: number]
> = [
  ['writeFile', [0]],
  ['appendFile', [0]],
  ['mkdir', [0]],
  ['mkdtemp', [0]],
  ['copyFile', [1]],
  ['cp', [1]],
  ['rename', [1]],
  ['symlink', [1]],
  ['link', [1]],
  ['truncate', [0]],
  ['open', [0], 1],
];

const WRAPPED = Symbol.for('open-reception.write-guard.wrapped');

type AnyFn = ((...args: unknown[]) => unknown) & { [WRAPPED]?: true };

/**
 * `node:fs` と `node:fs/promises` の書き込み API を包み、`roots` の外への書き込みを
 * `violations` へ積む。ESM の named import（`import { writeFileSync } from 'node:fs'`）にも
 * 効くよう `syncBuiltinESMExports()` で反映する。
 *
 * 🔴 **再入を止める。** Node の `appendFileSync` は内部で公開の `writeFileSync` を呼ぶので、
 * 包むと 1 回の書き込みが 2 回数えられる（プロトタイプで実測）。外側の呼び出しだけを見る。
 */
export function installWriteGuard(
  roots: ReadonlyArray<string>,
  violations: WriteViolation[],
): void {
  const require = createRequire(import.meta.url);
  const targets: Array<[Record<string, unknown>, string, boolean]> = [
    [require('node:fs') as Record<string, unknown>, 'fs.', true],
    [require('node:fs/promises') as Record<string, unknown>, 'fs/promises.', false],
  ];
  let depth = 0;
  for (const [mod, prefix, hasSync] of targets) {
    for (const [base, destArgs, flagArg] of WRITE_APIS) {
      const names = hasSync ? [base, `${base}Sync`] : [base];
      if (hasSync && base === 'writeFile') names.push('createWriteStream');
      for (const name of names) {
        const original = mod[name] as AnyFn | undefined;
        if (typeof original !== 'function' || original[WRAPPED]) continue;
        const wrapped: AnyFn = function (this: unknown, ...args: unknown[]) {
          if (depth === 0 && (flagArg === undefined || opensForWrite(args[flagArg]))) {
            for (const index of destArgs) {
              const path = toAbsolutePath(args[index]);
              if (path !== undefined && !isInsideRoots(path, roots)) {
                violations.push({ api: `${prefix}${name}`, path });
              }
            }
          }
          depth += 1;
          try {
            return original.apply(this, args);
          } finally {
            depth -= 1;
          }
        };
        wrapped[WRAPPED] = true;
        mod[name] = wrapped;
      }
    }
  }
  syncBuiltinESMExports();
}
