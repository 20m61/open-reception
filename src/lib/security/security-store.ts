/**
 * セキュリティ設定のストア (issue #23, #29)。既定では PIN 不要（既存運用を壊さない）。
 * 永続化は data backend（memory / dynamodb）に委譲する (docs/persistence-design.md)。
 */
import {
  BUILTIN_DEFAULT_PIN,
  hashPin,
  isLegacyPlaintextPin,
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

const security = () => getBackend().singleton<SecuritySettings>('security', { default: defaults });

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
  // **読めない資格情報は 1 つの規則で「未設定」に倒す**（族ごと閉じる）。
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

export async function updateSecuritySettings(patch: unknown): Promise<SecuritySettings> {
  const settings = await current();
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
  // 🔴 **昇格も 3 状態で判断する（レビュー 3 周目 MAJOR 1）。** `!isHashedPin(...)` は
  //    `unusable` を平文側へ落とすので、**記録文字列がそのまま PIN として封入**されていた。
  //    昇格してよいのは**旧レコードの平文だけ**である。
  if (isLegacyPlaintextPin(settings.pin)) {
    // 🔴 **昇格前の平文で「運用者が決めたか」を確定させる。**
    //    昇格すると形式からは判定できなくなるので、ここで決めないと
    //    旧レコードの `0000` が昇格の瞬間に「設定済み」へ化ける（#1021 MAJOR-8 の再発）。
    settings.pinSetByOperator = settings.pinSetByOperator ?? isPinConfigured(settings);
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
  await security().reset();
}
