// next-public-secret のフィクスチャ。`semgrep --test` がこの注釈と実際の検出を突き合わせる。
// 注釈と検出がずれたらルール側が壊れている（＝このルールは空虚ではない、の根拠）。

// ruleid: next-public-secret
const a = process.env.NEXT_PUBLIC_API_SECRET;
// ruleid: next-public-secret
const b = process.env.NEXT_PUBLIC_VONAGE_PRIVATE_KEY;
// ruleid: next-public-secret
const c = process.env['NEXT_PUBLIC_SESSION_TOKEN'];

// 🔴 下界: 実在する NEXT_PUBLIC_* を誤検出しないこと。ここが落ちると
// 「全部を機密とみなす」実装でも上の 3 件は通ってしまう。
// ok: next-public-secret
const d = process.env.NEXT_PUBLIC_APP_URL;
// ok: next-public-secret
const e = process.env.NEXT_PUBLIC_VONAGE_SDK_URL;
// ok: next-public-secret
const f = process.env.NEXT_PUBLIC_KIOSK_EFFECTIVE_CONFIG;
// サーバ専用なら接頭辞が付かないので対象外。
// ok: next-public-secret
const g = process.env.VONAGE_PRIVATE_KEY;

export const fixture = [a, b, c, d, e, f, g];
