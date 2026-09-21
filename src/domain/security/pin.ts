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
 * 反復回数。4 桁 PIN では総当たりを止められないので、**ここを上げても本質は変わらない**
 * （上の doc のとおり）。オンライン検証 1 回あたりの遅延が受付端末の体感に乗るので、
 * 「平文で置かない」という目的に対して十分な下限として 210,000 を採る（OWASP 2023 の
 * PBKDF2-SHA256 推奨値）。
 */
const ITERATIONS = 210_000;
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

/** 保存された値がハッシュ形式か（＝旧レコードの平文でないか）。 */
export function isHashedPin(stored: string): boolean {
  return stored.startsWith(`${ALGORITHM}$`);
}

/** PIN を保存形式（ハッシュ）へ変換する。**毎回ランダムな salt を使う。** */
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, ITERATIONS);
  return `${ALGORITHM}$${ITERATIONS}$${toBase64(salt)}$${hash}`;
}

/** 長さに依らず一定時間で比べる（`src/lib/auth/session.ts` と同じ形）。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 保存された値（平文 or ハッシュ）と入力を照合する。
 *
 * 🔴 **ハッシュ形式として壊れているものは、平文として照合しに行かない。**
 * 落とすと、壊れた値が**そのまま PIN として通る**（`stored === input`）。
 */
export async function verifyPinCredential(stored: string, input: string): Promise<boolean> {
  if (!isHashedPin(stored)) return timingSafeEqual(stored, input);
  const [, iterations, salt, hash] = stored.split('$');
  const rounds = Number(iterations);
  const saltBytes = salt === undefined || salt === '' ? null : fromBase64(salt);
  if (!Number.isInteger(rounds) || rounds <= 0 || saltBytes === null || !hash) return false;
  return timingSafeEqual(await derive(input, saltBytes, rounds), hash);
}

/**
 * 運用者が PIN を決めたか。
 *
 * 🔴 以前は `pin !== ''` で判定しており、既定値が `'0000'` で入るため**常に true** だった
 * —— 運用者は `0000` のまま「設定済み」と読む（#1021 MAJOR-8）。
 * ハッシュは中身を見られないので「決めた」として扱う（運用者が管理画面から入れた値）。
 */
export function isPinConfigured(stored: string): boolean {
  if (stored === '') return false;
  if (isHashedPin(stored)) return true;
  return stored !== BUILTIN_DEFAULT_PIN;
}
