/**
 * 担当者の通話応答トークン (issue #4 increment 2c)。
 *
 * 担当者は通知（通知サブシステム）で受け取ったリンクに署名付きトークンを含む。
 * トークンは受付セッションにスコープし短命。担当者応答エンドポイントがこれを検証して
 * subscriber トークンを発行する。secret は server-only。
 */
import { signSession, verifySession } from '@/lib/auth/session';
import { serverSecret } from '@/lib/auth/server-secret';

/** 応答リンクの既定有効期限（10 分）。未応答リンクを長期間有効にしない。 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * 応答トークンの署名鍵。**deploy 環境で未設定なら throw する** (#1021 AC2)。
 *
 * 🔴 ここは `serverSecret()` を通していなかった。deploy で未設定でも
 * 警告すら出ず、公開ソース上の既知文字列で応答トークンを偽造できた。受け取り側は
 * subscriber トークンを発行して受付を `connected` に確定するので、**来訪者には
 * 「担当者が応答しました」と出る**（誰も出ていない）。
 *
 * 🔴 **`KIOSK_SESSION_SECRET` へのフォールバックも外した（信頼境界を共有しない）。**
 * 流用していると、kiosk セッション鍵を握った者が「担当者が応答した」を偽造できる。
 * 別の信頼境界には別の鍵を使う。
 *
 * 消費者は `/api/staff/calls/[id]/answer` と `.../respond` だけで、要求ごとに評価される
 * ので、failClosed にしても他の経路は壊れない。
 *
 * 🔴 **この増分は route 層まで閉じていない（#1123）。** 鍵未設定のデプロイでは、
 * トークン付きの未認証リクエストが **403 ではなく 500** になる。したがって
 * (a) 応答の差から「この環境は鍵を持っていない」が外から読め、(b) 未認証で例外と
 * スタックトレースを生ませられる。**一度「トークンが無いときだけ鍵を解決しない」
 * という早期 return を入れたが、撤回した** —— トークンを 1 文字付ければ両方そのまま
 * 通るので、片側しか塞がない機構でありながら「塞いだ」と読める doc を残してしまう。
 *
 * 🔴 **(c) 担当者の画面が原因を偽る。** `StaffCallView` / `StaffResponseActions` は
 * 非 ok を一括で error にし、「リンクの有効期限切れ、または別の端末で応答済みの
 * 可能性があります。」と出す。原因は**設定漏れ**なのに担当者には「リンク切れ」と伝わり、
 * 設定不備に到達しない。これは同じ増分が admin 側で見つけて `loginFailureForStatus` で
 * 直したものと**同型・同一原因**（この failClosed 化が 5xx を新設したこと）である。
 * 片方の下流だけ直して、もう片方が残っている。
 *
 * 塞ぐには route 層で応答を 403 へ寄せ、**その 403 を担当者にどう見せるかまで**
 * 決める必要がある（403 に寄せるだけだと、この嘘が設計として固定される）。#1123 で扱う。
 *
 * 🔴 **到達可能性を取り違えないこと。** `issueAnswerToken` の本番呼び出し元はゼロ
 * （走査 3 通りで確認）だが、それが効くのは **(c) 担当者 UI の嘘**だけである。
 * **(a) と (b) は、この増分をデプロイした時点で未認証の誰からでも開く** ——
 * `src/proxy.ts` は `/api/staff/**` を admin と判定せず `passThrough` するので、
 * でっち上げのトークンで `GET /api/staff/calls/x/respond?token=a` を投げるだけで
 * uncaught 例外＋スタックトレースが 1 リクエストにつき 1 本出る。発行済みリンクは要らない。
 * （`broken-deploy-reachability.test.ts` がまさにその形で実演している。）
 *
 * したがって #1123 は「通知ディスパッチの配線より前」ではなく、**この増分をデプロイする
 * より前**に閉じるべきものである。先例は `src/app/api/kiosk/voice-transport/token/route.ts`
 * ―― 同じ `serverSecret(failClosed)` の throw を try/catch で 503 に写像している。
 *
 * 🔴 **ここでその写像をしない**のは、規約「主修正とフォールバックを同じコミットで
 * 入れない」に従うため。fail-closed の throw を 503 へ変えるのは**大声の失敗を静かな
 * 失敗へ変換する**操作で、主修正（failClosed 化）を縛り終える前に入れると、主修正を
 * 元へ戻す変異が見えなくなる。
 */
export function getAnswerSecret(): string {
  return serverSecret('CALL_ANSWER_SECRET', 'dev-insecure-answer-secret', { failClosed: true });
}

/** 受付セッションに対する応答トークンを発行する（通知リンクに含める）。 */
export async function issueAnswerToken(receptionId: string, ttlMs: number = DEFAULT_TTL_MS): Promise<string> {
  return signSession({ role: 'call_answer', receptionId, exp: Date.now() + ttlMs }, getAnswerSecret());
}

/** 応答トークンを検証し receptionId を返す。無効/期限切れ/別用途なら null。 */
export async function readAnswerToken(token: string | undefined): Promise<{ receptionId: string } | null> {
  const payload = await verifySession(token, getAnswerSecret());
  if (!payload || payload.role !== 'call_answer') return null;
  const receptionId = payload.receptionId;
  return typeof receptionId === 'string' ? { receptionId } : null;
}
