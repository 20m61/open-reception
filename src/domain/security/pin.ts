/**
 * 受付端末 PIN の保存形式 (#1021 AC3)。
 *
 * ## なぜ 1 つのモジュールに閉じるか
 *
 * 保存された値は **旧レコードなら平文、新レコードならハッシュ**である。
 * 読み側が 2 箇所（`verifyPin` と `pinConfigured`）あるので、**解釈を 1 つに閉じないと
 * 片方だけが旧形式を知っている状態**になり、`pinConfigured` が嘘をつく側へ倒れる。
 *
 * ## 何を達成していて、何を達成していないか
 *
 * 🔴 **これは「平文で置かない」ための措置であって、総当たり耐性ではない。**
 * PIN は 4 桁＝10^4 なので、ハッシュが漏れれば手元で総当たりできる。
 * 総当たり対策は**試行回数制限**（#1021 AC4）の仕事であり、ここでは解決しない。
 * 達成しているのは「設定ストアのダンプ・バックアップ・API 応答に平文が出ない」こと。
 *
 * 🔴 **`crypto.subtle` を使う**（`node:crypto` ではなく）。このリポジトリの署名系
 * （`src/lib/auth/session.ts`）と同じ経路に揃える —— 実行環境（OpenNext / edge）で
 * 使える API を 1 つに保つため。Web Crypto に scrypt は無いので PBKDF2-SHA256 を使う。
 */

/** 組込みの既定 PIN。**公開値**なので、これと一致する間は「未設定」として扱う。 */
export const BUILTIN_DEFAULT_PIN = '0000';

const ALGORITHM = 'pbkdf2-sha256';
/**
 * 反復回数。
 *
 * 🔴 **210,000（OWASP 2023）から 10,000 へ下げた（レビュー 1 周目 MINOR 2 の実測を受けて）。**
 *
 * 判断の根拠は「どちらのリスクが**今日踏めるか**」である:
 *
 * - **オフライン**（記録が漏れた場合）… PIN は事実上 4 桁＝10^4 なので、210,000 回でも
 *   10,000 回でも**総当たりは現実的な時間で終わる**。上げてもほぼ何も買えていない
 * - **オンライン**（今日踏める側）… `POST /api/kiosk/authorize` は**未認証**で、
 *   **試行回数制限がまだ無い**（#1021 AC4 は未着手）。実測で 1 回 **約 104ms** だったので、
 *   叩くだけで Lambda の実行時間と同時実行を消費させられる ——
 *   **この増幅はこの増分が持ち込んだもの**（以前は文字列比較だった）
 *
 * 10,000 回なら実測 **約 5ms** で、増幅は 20 分の 1 になる。
 * AC4（試行回数制限）が入ったらここを上げ直す余地がある。
 */
const ITERATIONS = 10_000;

/** 記録側の反復回数の上限（MINOR 1）。 */
const MAX_ITERATIONS = 1_000_000;
const KEY_BITS = 256;

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    KEY_BITS,
  );
  return toBase64(new Uint8Array(bits));
}

/** ハッシュ記録を分解した結果。構造として成立していなければ `null`。 */
type ParsedHash = { iterations: number; salt: Uint8Array; hash: string };

/**
 * 保存された値をハッシュ記録として読む。**構造が揃っていなければ `null`**。
 *
 * 🔴 **接頭辞だけで判定してはいけない（レビュー指摘。実測で再現した）。**
 * 旧レコードの平文には**何でも入りうる** —— 管理 API は `pin` に数字も長さも
 * 要求していない（`o.pin.trim() !== ''` だけ）。そのため `'pbkdf2-sha256$office'` を
 * PIN にしていたサイトでは、接頭辞判定だと**ハッシュと誤認**して解析に失敗し、
 * **本人の PIN でも通らなくなる**（実測: `verifyPinCredential(v, v)` が false）。
 * 受付端末が authorize できなくなる＝**読み互換の約束を破る**形である。
 *
 * だから「うちの形式として**完全に読めるか**」で判定する。読めない値は平文として扱う。
 *
 * 🔴 **残る衝突**: 旧平文が偶然この構造を**完全に満たす**場合（例
 * `pbkdf2-sha256$210000$AAAA$BBBB`）は今も読めない。ここまで来ると平文と記録を
 * 区別する手段が無く、**記録側を壊さない**ことを優先した。
 */
function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return null;
  const [, rawIterations, rawSalt, hash] = parts;
  if (!/^[0-9]+$/.test(rawIterations ?? '') || !hash) return null;
  const iterations = Number(rawIterations);
  const salt = rawSalt === undefined || rawSalt === '' ? null : fromBase64(rawSalt);
  // 🔴 **上限を持つ（レビュー 1 周目 MINOR 1）。** 記録側の値をそのまま信じると、
  //    壊れた/改竄された記録 1 つで照合が止まる —— 実測で `iterations=1e8` の記録は
  //    **1 回の照合に 52.7 秒**かかった（未認証エンドポイントから踏める）。
  //    上限を超える記録は「読めない」として扱う（平文へは落ちない。下の空判定が先に効く）。
  if (!Number.isInteger(iterations) || iterations <= 0 || iterations > MAX_ITERATIONS) return null;
  if (salt === null) return null;
  return { iterations, salt, hash };
}

/** 保存された値がハッシュ記録か（＝旧レコードの平文でないか）。 */
export function isHashedPin(stored: string): boolean {
  return parseHash(stored) !== null;
}

/** PIN を保存形式（ハッシュ）へ変換する。**毎回ランダムな salt を使う。** */
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, ITERATIONS);
  return `${ALGORITHM}$${ITERATIONS}$${toBase64(salt)}$${hash}`;
}

/**
 * 同じ長さの文字列を、内容に依らず一定時間で比べる（`src/lib/auth/session.ts` と同じ形）。
 *
 * 🔴 **「定数時間」と言い切らない（レビュー 1 周目 MINOR 3）。** 実態は次のとおり:
 *
 * - 長さが違えば**早期 return** する（旧平文レコードでは PIN の長さが漏れうる）
 * - ハッシュ経路と平文経路で**桁違いに時間が違う**（実測 5ms 前後 vs ほぼ 0ms）ので、
 *   未認証の攻撃者は応答時間で「このサイトは未移行か」を判別できる
 * - ハッシュ経路の比較対象は導出値なので、そもそもここの定数時間性が守るものは小さい
 *
 * それでも入れてあるのは**旧平文経路で内容を 1 文字ずつ漏らさない**ためである。
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 保存された値（平文 or ハッシュ）と入力を照合する。
 *
 * 🔴 **記録として読めたものは、平文へ落ちない。** 落とすと、**記録の文字列そのものが
 * PIN として通る**。読めなかったものだけが平文の照合へ行く（旧レコード互換）。
 */
export async function verifyPinCredential(stored: string, input: string): Promise<boolean> {
  // 🔴 **空は「資格情報が無い」であって「空の PIN」ではない（レビュー 1 周目 BLOCKER）。**
  //
  // 実測: `verifyPinCredential('', '')` が **true** を返していた。`.env.example` が配る
  // `KIOSK_PIN=`（空）のまま `pinRequired: true` にしたサイトでは、
  // `POST /api/kiosk/authorize` に **`pin` を入れずに投げるだけで** 30 日の kiosk
  // セッションが取れる（未認証の公開エンドポイント）。
  //
  // このモジュールは「読めない記録は fail closed」を謳っているのに、
  // `isPinConfigured('') === false`（未設定）と `verify('','') === true`（通す）が
  // **食い違っていた**。空は常に拒否する。
  if (stored === '') return false;
  const parsed = parseHash(stored);
  // 構造として読めない値は**旧レコードの平文**として扱う（上の `parseHash` の doc 参照）。
  if (parsed === null) return timingSafeEqual(stored, input);
  return timingSafeEqual(await derive(input, parsed.salt, parsed.iterations), parsed.hash);
}

/**
 * 運用者が PIN を決めたか。
 *
 * 🔴 以前は `pin !== ''` で判定しており、既定値が `'0000'` で入るため**常に true** だった
 * —— 運用者は `0000` のまま「設定済み」と読む（#1021 MAJOR-8）。
 *
 * 🔴 **保存形式からは判定しない（レビュー 1 周目 MAJOR 2）。** 一度は「ハッシュ＝決めた」
 * としていたが、**既定値も平文で永続化されてしまう**ことが実測で分かり
 * （`KIOSK_PIN` を入れたサイトで PIN と無関係な更新を 1 回すると、その平文が書かれる）、
 * 既定値も含めてハッシュ保存へ変えた。その結果「ハッシュ＝決めた」は成り立たない。
 * **明示フィールド**（`pinSetByOperator`）で持ち、旧レコードだけ従来の推定へ落とす。
 */
export function isPinConfigured(settings: {
  pin: string;
  pinSetByOperator?: boolean;
}): boolean {
  if (settings.pinSetByOperator !== undefined) return settings.pinSetByOperator;
  // 旧レコード（フラグが無い）: 平文が組込み既定と違えば運用者が決めたとみなす。
  if (settings.pin === '') return false;
  if (isHashedPin(settings.pin)) return true;
  return settings.pin !== BUILTIN_DEFAULT_PIN;
}
