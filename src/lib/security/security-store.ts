/**
 * セキュリティ設定のストア (issue #23, #29)。既定では PIN 不要（既存運用を壊さない）。
 * 永続化は data backend（memory / dynamodb）に委譲する (docs/persistence-design.md)。
 */
import {
  BUILTIN_DEFAULT_PIN,
  hashPin,
  isHashedPin,
  isPinConfigured,
  isUsablePinCredential,
  verifyPinCredential,
} from '@/domain/security/pin';
import type { SecuritySettings } from '@/domain/security/types';
import { getBackend } from '@/lib/data';

/** `KIOSK_PIN` を読む。**空文字は未設定**として扱う（`??` では弾けない）。 */
function envPin(): string | undefined {
  // 🔴 **判定と保存で同じ正規化を使う（レビュー 2 周目 MINOR 8）。** 以前は
  //    `trim()` で判定しながら**未 trim の値を保存**していたので、`KIOSK_PIN=" 4821 "`
  //    は「設定済み」と読まれるのに、端末では前後の空白ごと入力しないと通らない
  //    （iPad の numeric キーボードでは入力できない）。
  const value = process.env.KIOSK_PIN?.trim();
  return value !== undefined && value !== '' ? value : undefined;
}

function defaults(): SecuritySettings {
  return {
    pinRequired: false,
    // 🔴 **既定は組込み値のまま（#1021 AC3 では振る舞いを変えない）。**
    //    ここを空にすると `pinRequired: true` のサイトが**誰も authorize できなくなる**。
    //    「既定のままか」を運用者へ正しく伝えるのは `isPinConfigured` の仕事で、
    //    既定を拒否する（fail closed にする）かどうかは **PIN 制御の境界変更**なので別増分。
    //
    // 🔴 **空の env は「未設定」として扱う（レビュー 1 周目 BLOCKER）。** `??` は空文字を
    //    弾かないので、`.env.example` が配る `KIOSK_PIN=`（空）がそのまま資格情報になり、
    //    `pinRequired: true` のサイトで **PIN を送らない POST が通っていた**（実測）。
    //    このリポジトリは `${VAR:-test}` 型の取りこぼしを既に教訓化している
    //    （`.claude/rules/local-aws-development.md`）。空なら組込み既定へ落とす。
    pin: envPin() ?? BUILTIN_DEFAULT_PIN,
    pinSetByOperator: envPin() !== undefined && envPin() !== BUILTIN_DEFAULT_PIN,
    ipAllowlist: [],
    emergencyStop: false,
  };
}

// 🔴 **強い整合性で読む (#1158。fresh-context review M2)。** 版（`rev`）を読んで条件付きで書くので、
//    結果整合性の読みで古い版を掴むと、保存の直後の保存が 409 になり、緊急停止の当て直しも
//    古い版を読み続けて予算を使い切りうる。MiniStack は強整合なのでエミュレータでは差が出ない。
const security = () =>
  getBackend().singleton<SecuritySettings>('security', { default: defaults, consistentRead: true });

async function current(): Promise<SecuritySettings> {
  const s = (await security().get()) ?? defaults();
  // 🔴 **使えない資格情報は「未設定」＝組込み既定として読む。**
  //
  // 2 周目 MAJOR 1: `.env.example` の `KIOSK_PIN=`（空）を使っていたサイトが管理画面で
  // 1 度保存すると永続レコードは `pin: ''` になる。空を拒否した結果、そのサイトは
  // **通る入力が 1 つも無い**のに管理画面は「未設定（既定値が有効）」と表示していた。
  //
  // 🔴 3 周目 MAJOR 1 / MINOR 3: 同じ嘘が **`unusable`（うちの形式だが読めない記録）**の
  // 綴りで残っていた —— 空だけを正規化していたため。しかも `unusable` は昇格で
  // **平文として扱われ、記録文字列が生きた PIN になる**（実測）。
  // **読めない資格情報は 1 つの規則で「未設定」に倒す。**
  //
  // 🔴 **「族ごと閉じた」とは言えない（レビュー 4 周目 MINOR 2）。** `classify` の 1 段目
  //    （構造）で落ちる綴り —— `pbkdf2-sha256$abc$AAAA$BB` や hash 部が空のもの —— は
  //    **平文として扱われる**ので、ここは通らず**記録文字列がそのまま生きた PIN になる**。
  //    実害は旧平文と同等（ダンプを読めた者はどうせ 4 桁を総当たりできる）なので
  //    振る舞いは変えないが、閉じたのは**構造的に完全な記録だけ**である。
  const usable = isUsablePinCredential(s.pin);
  const pin = usable ? s.pin : BUILTIN_DEFAULT_PIN;
  // 読めない資格情報を「設定済み」と表示しない（表示と挙動を一致させる）。
  const pinSetByOperator = usable ? s.pinSetByOperator : false;
  // 🔴 **隣のフィールドでも 500 にしない（レビュー 3 周目 MINOR 6）。** `pin` について
  //    同じ理屈（「レコードが 1 つ在るだけで 500 になり、復旧導線ごと失われる」）を
  //    書いておきながら、**同じ式の隣**が素通りだった。
  const ipAllowlist = Array.isArray(s.ipAllowlist) ? [...s.ipAllowlist] : [];
  return { ...s, pin, pinSetByOperator, ipAllowlist };
}

export async function getSecuritySettings(): Promise<SecuritySettings> {
  return current();
}

/**
 * 同時更新で負けた (#1158)。**何も書いていない。** 呼び出し側は 409 にし、黙って勝たない。
 */
export class SecuritySettingsConflictError extends Error {
  constructor() {
    super('security settings were changed concurrently');
    this.name = 'SecuritySettingsConflictError';
  }
}

/** patch の `rev` が版の形をしていない (#1158)。**何も書いていない。** 呼び出し側は 400 にする。 */
export class SecuritySettingsInvalidError extends Error {
  constructor() {
    super('invalid security settings revision');
    this.name = 'SecuritySettingsInvalidError';
  }
}

/**
 * 版を付けずに、緊急停止以外を変えようとした (#1158)。**何も書いていない。** 呼び出し側は 428 にする。
 *
 * 版なしの更新は「読んだ後に誰が何を書いたか」を判定できず、後勝ちで他人の変更を黙って消す。
 * それを受け付けないのがこの issue の本題なので、版なしで受け付けるのは緊急停止のトグルだけにする。
 */
export class SecuritySettingsPreconditionRequiredError extends Error {
  constructor() {
    super('security settings revision (rev) is required');
    this.name = 'SecuritySettingsPreconditionRequiredError';
  }
}

/**
 * patch が**緊急停止のトグルだけ**か（`{ emergencyStop: boolean }` で、他のキーを持たない）。
 *
 * 🔴 **許可の列挙にする。** 「PIN 系のキーが無ければ版なしで通す」のような禁止の列挙にすると、
 *    将来フィールドが増えたときにそのフィールドが版なしで後勝ちになる。知らないキーが 1 つでも
 *    あれば版を要求する。
 */
function isEmergencyToggleOnly(patch: unknown): boolean {
  // 配列は `Object.keys` が添字になるので下の比較で落ちる（別の分岐は置かない。変異検証で等価）。
  if (typeof patch !== 'object' || patch === null) return false;
  const keys = Object.keys(patch);
  return keys.length === 1 && keys[0] === 'emergencyStop' && typeof (patch as { emergencyStop?: unknown }).emergencyStop === 'boolean';
}

/**
 * 版なしの patch を最新の記録へ当て直す上限 (#1158)。
 *
 * 当て直しは「押した緊急停止が他の保存に踏み潰されない」ための機構で、上限を超えたら
 * 黙って諦めず競合を返す（運用者はもう一度押せる）。管理者が同時に数人触る程度の競合を
 * 想定した値で、ここを大きくしても守れるものは増えない。
 */
const MAX_UPDATE_ATTEMPTS = 3;

/**
 * 記録の版。**版を持たない旧レコード（と未作成）は 0**。形の壊れた版も 0 として読む
 * （壊れた版をそのまま画面へ返すと、画面が応答を拒否して**緊急停止ごと押せなくなる**）。
 * 管理 API が返す版はこれを通すこと。
 */
export function revisionOf(stored: unknown): number {
  // 🔴 **安全な整数に限る（fresh-context review L1）。** `2^53 + 1 === 2^53` なので、その外では
  //    版が進まず、同じ版を読んだ 2 つの保存が順に両方通る（ABA）。外れたものは壊れた版として 0 と読み、
  //    書けば 1 から進み直す（条件式には生の値を渡すので、壊れた版の記録も上書きできる）。
  return typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
}

/** patch が版を持っていればそれを返す。持っていなければ undefined。形が違えば拒否する。 */
function expectedRevisionOf(patch: unknown): number | undefined {
  if (typeof patch !== 'object' || patch === null || !('rev' in patch)) return undefined;
  const rev = (patch as { rev?: unknown }).rev;
  // 🔴 **不正な版を「版なし」として扱わない。** 無視すると、古い画面からの保存が
  //    最新の記録へ当て直されて**黙って勝つ**（この issue が消そうとしている形そのもの）。
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) {
    throw new SecuritySettingsInvalidError();
  }
  return rev;
}

/**
 * セキュリティ設定を更新する。
 *
 * 🔴 **read-modify-write を条件付き書き込みにする (#1158)。** 以前は読んで・当てて・
 *    **丸ごと put** していたので、2 つの更新が重なると後勝ちで片方の変更が消えた ——
 *    「別の運用者が PIN を保存中に、こちらが緊急停止を押す」と、相手の書き込みが
 *    **緊急停止を落とした状態**を書き戻し、画面は成功と言っていた。
 *
 * 守る不変条件（`security-store.concurrency.test.ts`）:
 *
 * > 成功を返した ⟹ その patch が書いたフィールドは、同時に成功した他の更新が同じ
 * > フィールドを書かない限り残っている。成功しなかった ⟹ 例外で、何も書いていない。
 *
 * - **版（`rev`）付きの patch** は「その版から見た変更」。読んだ版と違えば書かずに競合
 *   （管理画面の古い表示からの保存が、他人の変更を消さない。#1158 AC2）
 * - **版なしで受け付けるのは緊急停止のトグルだけ**（`{ emergencyStop }` のみ）。**投入**
 *   （`true`）は書き込みで負けたら最新の記録へ当て直す（上限つき。#1158 AC3「緊急停止の投入は
 *   競合しても落ちない」）。当てるのは `emergencyStop` 1 項目だけなので他人の項目を踏み潰さない。
 *   **解除**（`false`）は当て直さない（1 回負けたら競合。投入と交錯して停止が黙って外れないように）
 * - それ以外の版なしの patch は `SecuritySettingsPreconditionRequiredError`（428）。
 *   以前は受け付けて後勝ちにしていた（独立レビュー 1 周目 MAJOR・ユーザー判断で必須化）
 */
export async function updateSecuritySettings(patch: unknown): Promise<SecuritySettings> {
  const expectedRev = expectedRevisionOf(patch);
  if (expectedRev === undefined && !isEmergencyToggleOnly(patch)) {
    throw new SecuritySettingsPreconditionRequiredError();
  }
  // 🔴 **当て直すのは緊急停止の投入だけ (#1158 AC3。fresh-context review M1)。** 解除も当て直すと、
  //    投入と解除が交錯したとき**両方が成功と返り、停止が黙って外れる**（実測）。安全側は停止なので、
  //    解除は 1 回だけ試し、負けたら競合（「解除できませんでした」→ 運用者が押し直す）にする。
  const attempts =
    expectedRev === undefined && (patch as { emergencyStop?: unknown }).emergencyStop === true
      ? MAX_UPDATE_ATTEMPTS
      : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const written = await attemptUpdate(patch, expectedRev);
    if (written !== null) return written;
  }
  throw new SecuritySettingsConflictError();
}

/** 1 回だけ読んで当てて条件付きで書く。書き込みで負けたら null（何も書いていない）。 */
async function attemptUpdate(
  patch: unknown,
  expectedRev: number | undefined,
): Promise<SecuritySettings | null> {
  const settings = await current();
  /** 読んだ記録の版の**生の値**。条件式はこれと比べる（形が壊れていても一致で判定できる）。 */
  const storedRev = settings.rev;
  const rev = revisionOf(storedRev);
  if (expectedRev !== undefined && expectedRev !== rev) throw new SecuritySettingsConflictError();
  /** この更新で**運用者が PIN 欄に入力したか**。入力は定義上つねに平文である。 */
  let pinFromOperator = false;
  if (typeof patch === 'object' && patch !== null) {
    const o = patch as Record<string, unknown>;
    if (typeof o.pinRequired === 'boolean') settings.pinRequired = o.pinRequired;
    // 🔴 **保存はハッシュ (#1021 AC3)。** 設定ストアのダンプ・バックアップ・
    //    監査経路に平文 PIN を残さない。読み側（`verifyPin`）は旧レコードの平文も読める。
    // 🔴 **ここではハッシュ化しない（レビュー 2 周目 MINOR 5 で撤回）。**
    //    下の昇格が必ず拾うので、両方でハッシュ化すると**主修正の変異をフォールバックが
    //    飲み込む**（実測で等価変異になっていた）。`CLAUDE.md` が記録している
    //    「主修正とフォールバックを同じコミットで入れない」型そのものなので、1 本に寄せる。
    //    ここが持つのは**「運用者が決めた」という事実**だけ。
    if (typeof o.pin === 'string' && o.pin.trim() !== '') {
      settings.pin = o.pin.trim();
      // 🔴 **運用者の入力は、綴りが何であっても平文である（レビュー 4 周目 MAJOR 1）。**
      //    保存形式の判定（`isHashedPin`）を**入力にも当てていた**ため、運用者が
      //    `pbkdf2-sha256$…` の形をした文字列を PIN 欄へ入れると「もうハッシュ済み」と
      //    見なされ、**昇格せずそのまま保存**されていた。結果:
      //      - その文字列でも `0000` でも通らない ＝ **通る入力が 1 つも無い**
      //      - なのに `pinConfigured` は true（画面は「設定済み」と言う）
      //      - 入力文字列が**平文のまま永続層に残る**（本増分の本旨に反する）
      //      - `iterations` を仕込めるので、**未認証の** `authorize` 1 回の CPU を
      //        5ms → 478ms へ引き上げられる（実測。`MAX_ITERATIONS` の doc の前提も崩れる）
      //    ここは**判定を増やす場所ではなく、書き側が既に知っている事実を使う場所**である。
      pinFromOperator = true;
      // 🔴 **既定値と同じなら「設定済み」と言わない（レビュー 3 周目 MAJOR 2）。**
      //    この PR 自身が `.env.example` で「0000 なら未設定と表示される」と約束している。
      //    運用者が `0000` と入力した場合にだけその約束が破れていた —— しかも保存値は
      //    ハッシュなので、**後から見た誰も 0000 だと気づけない**（#1021 MAJOR-8 より悪い）。
      settings.pinSetByOperator = settings.pin !== BUILTIN_DEFAULT_PIN;
    }
    if (Array.isArray(o.ipAllowlist)) {
      settings.ipAllowlist = o.ipAllowlist.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    }
    if (typeof o.emergencyStop === 'boolean') settings.emergencyStop = o.emergencyStop;
  }
  // 🔴 **平文のまま書き戻さない（レビュー 1 周目 MAJOR 2）。**
  //
  // 実測: `KIOSK_PIN` を入れたサイトで **PIN と無関係な更新を 1 回する**だけで、
  // `defaults()` 由来の**平文がそのまま永続化**されていた（DynamoDB backend は
  // `default` を使わないので実デプロイでも起きる）。旧レコードの平文も、ここを通れば昇格する。
  // 「運用者が決めたか」は形式からではなく `pinSetByOperator` が持つので、
  // 昇格させても #1021 MAJOR-8 は再発しない。
  // 🔴 **昇格の述語は `!isHashedPin` のままでよい（レビュー 3 周目 MAJOR 1 の対処を撤回）。**
  //
  //    3 周目は「`unusable` な記録が平文として昇格し、**記録文字列がそのまま PIN**になる」
  //    に対し、**読み側の正規化と書き側の述語を両方**入れた。**機構が 1 つ余っていた** ——
  //    ここへ届く `settings` は必ず `current()` を通っており、`unusable` は既に
  //    `BUILTIN_DEFAULT_PIN` へ倒れている。変異検証で `isLegacyPlaintextPin` へ戻す変異が
  //    **生存した**（守るものが無い）ので撤回した。`CLAUDE.md`「まず撤回を検討する」。
  //
  //    不変条件は読み側が 1 箇所で持つ:
  //
  //    > **保存された使えない資格情報は、決して生きた PIN にならない。**
  //
  //    （`current()` の `isUsablePinCredential`。end-to-end の下界は
  //    「読めない記録は、別項目の更新後もその文字列で authorize できない」が縛る。）
  //
  //    ここを通る `unusable` は**運用者が PIN 欄へ入力した文字列**だけで、それは
  //    昇格して本人の PIN にするのが正しい（入力を黙って捨てて既定値へ戻すと、
  //    「保存した」と言いながら効かない**沈黙の誤動作**になる）。
  //    縛る不変条件（値ごとの期待値ではなく）:
  //
  //    > **運用者が PIN 欄へ入力した文字列は、`classify` の結果が何であっても、
  //    > その文字列で authorize できる。**
  // 🔴 **フラグは必ず埋めてから書く（レビュー 4 周目 MINOR 3）。** 以前この行は
  //    昇格ブロックの**内側**に在ったので、`pin` が既にハッシュのレコードでは
  //    **永久に `undefined` のまま**だった（`types.ts` が「無い場合は旧レコードとして
  //    判定する」と書いている前提を、機構が強制していなかった）。
  //
  // 🔴 **昇格より前に決める。** 昇格すると形式からは判定できなくなるので、ここで
  //    決めないと旧レコードの `0000` が昇格の瞬間に「設定済み」へ化ける
  //    （#1021 MAJOR-8 の再発）。順序が逆になった機構は片側しか塞がない。
  settings.pinSetByOperator = settings.pinSetByOperator ?? isPinConfigured(settings);
  if (pinFromOperator || !isHashedPin(settings.pin)) {
    settings.pin = await hashPin(settings.pin);
  }
  settings.rev = rev + 1;
  // 版が無い（旧レコード・未作成）なら「版が無いこと」を条件にする（`putIf` の契約）。
  const written = await security().putIf(settings, { rev: storedRev });
  if (!written) return null;
  return { ...settings, ipAllowlist: [...settings.ipAllowlist] };
}

/**
 * PIN を照合する。
 *
 * 🔴 **保存値は平文（旧レコード）かハッシュ（新レコード）のどちらでもありうる。**
 * 解釈は `@/domain/security/pin` の 1 箇所に閉じてある —— 読み側が 2 つ（ここと
 * `pinConfigured`）あるので、片方だけが旧形式を知っている状態を作らない。
 *
 * 🔴 比較は**定数時間**（以前は `===` だった。#1021 MAJOR-8）。
 */
export async function verifyPin(pin: string): Promise<boolean> {
  const settings = await current();
  return !settings.pinRequired || (await verifyPinCredential(settings.pin, pin));
}

/** テスト用: 既定へ戻す。 */
export async function __resetSecurity(): Promise<void> {
  await security().reset();
}
