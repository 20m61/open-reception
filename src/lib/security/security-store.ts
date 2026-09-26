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
import { appendAuditLog } from '@/lib/data-stores/reception-log-store';

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

const security = () => getBackend().singleton<SecuritySettings>('security', { default: defaults });

/**
 * 読めない PIN 記録を見つけて PIN 認可を拒否側へ倒したことを、**このプロセスで既に監査へ出したか** (#1160)。
 *
 * 🔴 **読み出しごとに書かない。** `current()` は未認証の経路（`POST /api/kiosk/authorize`・
 *    `GET /api/kiosk/session-status` 等。authorize では試行予算の判定より前）から毎回呼ばれる
 *    ので、読み出しごとに監査を書くと**外部から監査の書き込み量を制御できる**
 *    （#1123 が staff / enroll のログで塞いだのと同じ脅威）。プロセスにつき 1 本に抑える。
 *
 * 🔴 **上界は「要求数」ではなく「実行環境の数」である（独立レビュー 1 周目 MAJOR）。**
 *    Lambda では実行環境ごとにモジュール状態が別なので、同時に叩かれれば**同時実行数ぶん**、
 *    時間をかければ**環境の入れ替わりぶん**だけ増える。要求数に比例しないことまでしか
 *    言えない。前提として**記録が既に壊れている**必要がある（現行コードは作らない）。
 *    環境を跨いで 1 本にするには永続側の冪等マーカーが要り、それは永続レコードと機構を
 *    足すことになるので、この増分ではやらない（`attempt-budget` が admin 側で同じ理由から
 *    機構を撤回した前例がある）。
 *
 * 🔴 **書き込みの前に立てる（失敗しても再試行しない）。** 監査ストアが落ちている間、
 *    未認証の要求 1 回ごとに失敗する書き込みを再試行させない。落ちたことはサーバログへ出す。
 *
 * 射程の限界: 同じプロセスの中で「一度直って、また壊れた」2 度目は監査に出ない
 *    （管理画面の表示 `storedPinUnreadable` は読み出しごとに判定するので、そちらには出る）。
 */
let unreadablePinReported = false;

async function reportUnreadablePin(lockout: boolean): Promise<void> {
  if (unreadablePinReported) return;
  unreadablePinReported = true;
  try {
    // 🔴 **値は載せない**（`rules/pii-secret-minimization.md`）。保存されていた文字列も、
    //    その形（どの検査で落ちたか）も出さない —— 事実と時刻だけで足りる（#1160 AC1）。
    //    🔴 この経路は `appendAuditLog` を直接呼ぶので **`sanitizeAuditMetadata` を通らない**。
    //    metadata に載せてよいのは、ここに書いた**静的な列挙値だけ**である（保存値由来の
    //    文字列を足さない。後段で潰してくれる機構は無い）。
    //    `lockout` は検出時点で PIN 必須だったか（＝受付端末の締め出しが実際に起きているか）。
    await appendAuditLog({
      action: 'security.pin_credential_unreadable',
      actor: 'system',
      targetType: 'security',
      metadata: { reason: 'stored_record_unreadable', effect: 'deny_all', lockout: String(lockout) },
    });
  } catch (err) {
    // 監査の失敗で照合の答えを変えない（どのみち拒否側。ここで throw すると 500 になるだけ）。
    console.error('[security] failed to record audit', {
      action: 'security.pin_credential_unreadable',
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
}

type SecurityRead = {
  settings: SecuritySettings;
  /**
   * 保存レコードの PIN を資格情報として読めず、**PIN 認可を誰にも通さない状態**か (#1160)。
   * 管理画面が「保存されている PIN を読めません」を出すための事実。値は含まない。
   */
  storedPinUnreadable: boolean;
};

async function current(): Promise<SecuritySettings> {
  return (await read()).settings;
}

async function read(): Promise<SecurityRead> {
  const s = (await security().get()) ?? defaults();
  // 🔴 **読めない資格情報は fail closed —— 既定値へ倒さず、誰も通さない (#1160・ユーザー判断)。**
  //
  // 以前（#1021 AC3）は読めない資格情報を「未設定」とみなし、**公開されている組込み既定
  // `0000` で代用**していた。締め出しを避けるための判断だったが、倒れた先が公開値なので、
  // 誰も見ていなければ `0000` を知る未認証の攻撃者が 30 日の kiosk セッションを取れた。
  // #1160 AC3 のユーザー判断で「セキュリティ境界で既定の資格情報へ倒さない」を採った。
  //
  // 読めない記録は**生のまま**持ち回す（`verifyPinCredential` は空・非文字列・`unusable` を
  // 全部拒否する）。書き戻しでも昇格させない（`updateSecuritySettings`）ので、無関係な更新で
  // 元の記録が `hash('0000')` に置き換わって消えることもない。復旧は運用者が管理画面から
  // PIN を設定し直すこと（その経路は `pinFromOperator` で必ず昇格する）。
  //
  // 対象は**保存レコード**だけ。レコードが無い（`defaults()`）場合は組込み既定のまま
  // （そちらは #1021 AC3 の別判断で、本 issue の射程外）。
  //
  // 🔴 `classify` の 1 段目（構造）で落ちる綴り —— `pbkdf2-sha256$abc$AAAA$BB` や hash 部が
  //    空のもの —— は**平文として扱われる**ので、ここは通らず記録文字列がそのまま PIN になる
  //    （レビュー 4 周目 MINOR 2。振る舞いは #1021 AC3 のまま）。
  const usable = isUsablePinCredential(s.pin);
  // 読めない資格情報を「設定済み」と表示しない（表示は `storedPinUnreadable` が別に持つ）。
  const pinSetByOperator = usable ? s.pinSetByOperator : false;
  // 🔴 **隣のフィールドでも 500 にしない（レビュー 3 周目 MINOR 6）。**
  const ipAllowlist = Array.isArray(s.ipAllowlist) ? [...s.ipAllowlist] : [];
  // 🔴 **拒否側へ倒した事実を観測できるようにする (#1160 AC1)。** `pinRequired` なら受付端末は
  //    どの PIN でも許可されない（締め出し）。管理画面と監査の両方から分かるようにする。
  //    `defaults()` は必ず読める値を返すので、ここへ来るのは**保存レコード**だけである。
  if (!usable) await reportUnreadablePin(s.pinRequired === true);
  return { settings: { ...s, pinSetByOperator, ipAllowlist }, storedPinUnreadable: !usable };
}

export async function getSecuritySettings(): Promise<SecuritySettings> {
  return current();
}

/** 設定と、保存レコードの PIN を読めず拒否側へ倒しているかを 1 回の読み出しで返す (#1160 AC2)。 */
export async function readSecuritySettings(): Promise<SecurityRead> {
  return read();
}

export async function updateSecuritySettings(patch: unknown): Promise<SecuritySettings> {
  const settings = await current();
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
  // 🔴 **読めない記録は昇格させない (#1160 fail closed)。**
  //
  //    `current()` は読めない資格情報を**生のまま**返すので、ここで `!isHashedPin` だけを見て
  //    昇格すると、記録文字列（空・壊れた記録）が**そのまま生きた PIN になる**
  //    （レビュー 3 周目 MAJOR 1 で実測された形）。昇格するのは「読める平文（旧レコード・
  //    `defaults()`）」と「運用者の入力」だけにする。読めない記録は生のまま書き戻し、
  //    拒否状態と観測（`storedPinUnreadable`）を運用者が PIN を設定し直すまで保つ。
  //
  //    縛る不変条件:
  //
  //    > **保存された使えない資格情報は、決して生きた PIN にならず、既定値にも化けない。**
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
  if (pinFromOperator || (isUsablePinCredential(settings.pin) && !isHashedPin(settings.pin))) {
    settings.pin = await hashPin(settings.pin);
  }
  await security().put(settings);
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
  unreadablePinReported = false;
  await security().reset();
}
