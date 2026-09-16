/**
 * **未認証で到達できる面**について、failClosed な鍵が未設定のときの応答とログの方針を
 * 1 か所に集める (#1123)。
 *
 * 🔴 **リポジトリ全体の方針ではない。** 実態は failClosed な鍵 5 件に対して **5 通り**:
 *
 * 1. 503 ＋ ラッチ付きログ（このモジュール。`CALL_ANSWER_SECRET` / `KIOSK_ENROLLMENT_SECRET`）
 * 2. 503 の inline（`kiosk/voice-transport/token/route.ts`。ログ無し・文言も別）
 * 3. **明示 500 JSON**（`/api/admin/login` の `ADMIN_PASSWORD`）
 * 4. **uncaught 500 ＋ スタックトレース**（`PLATFORM_ELEVATION_SECRET` の write ゲート経路）
 * 5. **沈黙して「非昇格」表示へ**（`src/app/platform/layout.tsx` の `readElevationView` が
 *    同じ `PLATFORM_ELEVATION_SECRET` の throw を `catch { return null }` で飲む）
 *
 * 3 と 4 を同じ「500」と数えると、**この増分が存在する理由（明示応答か墜落か）が消える**。
 * 5 は同じ鍵に 2 通りの扱いがある例で、**鍵ごとに 1 通りとも限らない**（4 通りと数えていたのを
 * レビュー 5 周目に訂正した）。揃えるかどうかは **#1127**。
 * ここが担うのは staff / kiosk の未認証面だけである。
 *
 * ## なぜ要るか
 *
 * #1021 で `serverSecret(..., { failClosed: true })` を増やした結果、**未認証で到達できる
 * route が throw しうる**ようになった。route が受けていないと Next の既定 500 になり:
 *
 * - **未認証の誰からでも**スタックトレースを 1 リクエストにつき 1 本生ませられる
 *   （CloudWatch の出力量が攻撃者の手に渡る）
 * - 正常時の 403 / 400 との差が「この環境は鍵を持っていない」のオラクルになる
 *
 * `src/proxy.ts` は `/api/staff/**` と `/api/kiosk/**` を admin と判定せず `passThrough`
 * するので、**でっち上げのトークンで到達する**（発行済みリンクも認証も要らない）。
 *
 * ## 方針
 *
 * 🔴 **503 へ写像する。** `src/app/api/kiosk/voice-transport/token/route.ts` の先例に揃える
 * （「一時障害であることをクライアントへ正しく伝える」）。これにより担当者 UI は
 * 「リンクの有効期限切れ」ではなく「サーバー側の問題」と伝えられる。
 *
 * 🔴 **先例にしたのは「503 へ写像する」ことだけである。** あちらの catch は
 * `resolveKioskScope`（device レジストリの I/O）と発行を丸ごと包んでおり、**下の
 * 「catch の射程」の規約には従っていない** —— 先例を読みに行った人が、禁じた形を見る。
 * あちらの実害はこちらより小さい（「鍵が未設定」という嘘のログを出さない）が、
 * **形をコピーしないこと**。揃えるかは #1127（レビュー 8 周目）。
 *
 * 🔴 **オラクルは閉じていない。** 正常時（403 / 400）との差は残る。403 に揃えれば閉じるが、
 * **区別不能にするのが目的なので担当者・運用者にも真実を伝えられなくなる** —— 両立しない。
 * どちらを採るかはリポジトリ全体で 1 度決める話なので **#1127** へ切り出した。
 *
 * 🔴 **本文に env 名・鍵名を出さない。** 未認証で到達できる面なので、内部の設定状態は
 * サーバログにだけ出す（`rules/pii-secret-minimization.md`）。
 *
 * ## 🔴 catch の射程は「鍵の解決」だけに絞る（呼び出し側の規約。ここに 1 度だけ書く）
 *
 * 呼び出し側は `try { get*Secret(); } catch { return secretUnavailableResponse(...) }` と書き、
 * **`readAnswerToken` / `readEnrollmentToken` を try の中へ入れない**。鍵は env の読み取りなので、
 * 先に 1 度解決してみるだけで判定できる。
 *
 * 広げると、それらの関数に I/O が入った日に**大声の失敗が沈黙の 503 ＋ 嘘のログ**へ変わる ——
 * 例えば `readEnrollmentToken` に jti 照合の DynamoDB 呼び出しが入れば、DynamoDB 障害が
 * 「`KIOSK_ENROLLMENT_SECRET` が未設定」として記録される。運用者は**存在しない鍵の設定漏れ**を
 * 疑い、しかも下のラッチが立つので**本物の鍵欠落は同一インスタンスで二度と記録されない**。
 * 画面の文言は正しいままなので、**症状からは辿れない**。
 *
 * 🔴 **散文は 4 route にコピーせず、ここに 1 度だけ置く**（コピーは drift する）。
 * 射程そのものは各 route テストの「鍵以外の throw は 503 に化けない」が縛る ——
 * **散文だけで守っていた間、4 箇所同時に catch を広げる変異が unit 8778 本を素通りした**
 * （レビュー 7 周目の実測）。
 */
import { NextResponse } from 'next/server';

/**
 * 既に記録したキー。**プロセスにつき 1 回**だけ出す。
 *
 * 🔴 **用途ごとに接頭辞で分ける。** 2 つの報告関数が同じ名前空間を使うと、
 * `reportIncompleteConfig('COGNITO_REGION', …)` のような自然な呼び方が
 * `reportSecretUnavailable('COGNITO_REGION')` を**黙って飲み込む**（レビュー 7 周目）。
 * guard を足すのではなく、衝突しえない形にする。
 */
const reported = new Set<string>();

/** テスト用にログ状態を初期化する（module scope なのでテスト順序に依存させない）。 */
export function __resetSecretUnavailableLog(): void {
  reported.clear();
}

/**
 * 設定不備を**プロセスにつき 1 度だけ**記録する。
 *
 * 🔴 **毎リクエスト出さない。** 対象の route は未認証で叩けるので、毎回出すと
 * **出力量を攻撃者が制御できる**。`src/proxy.ts` の `logOriginVerifyTransition` が
 * 同じ理由で同じ形を採っている (#630)。
 *
 * 向こうが**遷移**（復旧と再発の両方を残す）なのに対しここが**ラッチ**でよいのは、
 * これらが route handler ＝ `instrumentation.ts` の `register()` の後に走り、
 * 1 プロセス内で結果が変わらないため。**要らない機構は持たない。**
 *
 * 🔴 **「プロセスにつき 1 度」は「デプロイにつき 1 度」ではない。** Lambda では
 * ラッチは**実行環境インスタンス単位**なので、未認証の相手が同時実行数を押し上げれば
 * 出力量は O(同時インスタンス数) で増える。**脅威が閉じたとは読まないこと** ——
 * 減らしただけである（レビュー 6 周目）。
 *
 * 🔴 このログに対応する CloudWatch メトリクスフィルタはまだ無く、**閉め出しに気づく経路は
 * 人が試すことだけ**である（`ORIGIN_VERIFY_LOG_MARKERS` のような共有マーカーを持たない）。
 * ラッチにしたことでこの弱さは強まっている —— **1 度しか出ないログは、見に行かなければ
 * 存在しないのと同じ**。アラーム化は **#1131**。
 * （当初この残存リスクを #1125 の「AC7/AC8」へ預けていたが、**#1125 に AC7/AC8 は無い**
 * ―― AC1〜AC4 はすべて synth で空値キーを落とす話だった。預け先が無いまま「預けた」と
 * 書いていたので切り出した。レビュー 5 周目の指摘。）
 *
 * 🔴 **ラッチが効くのはこのモジュールを通る経路だけで、「未認証面のログ量」は閉じていない。**
 * `serverSecret()` の **warn-only 分岐**（failClosed でない鍵。`KIOSK_SESSION_SECRET` 等）は
 * ラッチを持たず **1 リクエスト 1 行**出る。壊れたデプロイでは `/api/kiosk/*` を叩くだけで
 * 未認証の相手が出力量を制御できる。根治は `serverSecret()` の中へラッチを移すことで、
 * それは #1128 で扱う。
 */
export function reportSecretUnavailable(envName: string): void {
  const key = `secret:${envName}`;
  if (reported.has(key)) return;
  reported.add(key);
  // 🔴 値は出さない。出すのは env 名だけ（rules/pii-secret-minimization.md）。
  console.error(
    `[security] ${envName} is not set in a deployed environment; refusing every request that needs it`,
  );
}

/**
 * 秘密の未設定ではなく**設定の不完全**を、同じラッチで 1 度だけ記録する。
 *
 * 🔴 未認証で叩ける点は同じなので出力量の扱いも同じにするが、**文面は別**にする ——
 * 「未設定」と「いずれかが欠けている」を同じ文で書くと、運用者が全部入れ直しにいく。
 */
export function reportIncompleteConfig(key: string, message: string): void {
  const k = `config:${key}`;
  if (reported.has(k)) return;
  reported.add(k);
  console.error(`[security] ${message}`);
}

/** 設定不備を記録し、**内部の設定状態を漏らさない** 503 を返す。 */
export function secretUnavailableResponse(envName: string): NextResponse {
  reportSecretUnavailable(envName);
  return NextResponse.json(
    // 「temporarily」と断定しない —— 設定を直すまで復旧しないので、期間を約束しない。
    { error: 'unavailable', message: 'unavailable' },
    { status: 503 },
  );
}
