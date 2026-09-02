import { NextResponse } from 'next/server';
import { STAGE2_CHOICES, resolveStage2Choice } from '@/domain/call/voice-announcement';
import { logWebhookRejection, rejectWebhook, verifyRequest } from '@/lib/routing/vonage-webhook-route';
import { denyIfProviderWebhooksDisabled } from '@/lib/routing/provider-webhook-switch';
import { resolveDialCallbackBaseUrl } from '@/lib/routing/webhook-base-url';
import { applyVoiceEventToCorrelation } from '@/lib/routing/voice-event';
import { createStageRecorder, stageTimingLog } from '@/domain/routing/stage-timing';

/**
 * POST /api/providers/vonage/choice — **第 2 段**（意思表示）の DTMF (issue #4 MVP 1)。
 *
 * 来訪者情報を案内した後の選択（来訪者と話す / まもなく向かう / 対応できない / 代理へ）。
 * ここは `/dtmf` と分けてある ── 同じ URL だと第 2 段の「1」が第 1 段として解釈され、
 * 来訪者情報を無限に読み上げる。
 *
 * **どの選択でも必ず音声で応答する。** 無応答で切ると、担当者は自分の入力が
 * 届いたのか分からないまま切ることになる。
 *
 * ## 選択を相関へ書く (#646)
 *
 * 🔴 **ここで書かないと、承諾が取次を止められない。** `applyVoiceEvent` は `answered` を
 * `awaiting_acceptance`（非 terminal）にし、通話終了の `completed` を**一律 `no_answer`**
 * へ畳む。選択が相関に残っていないと、担当者が「まもなく向かう」を押して電話を切った
 * 瞬間に**次の担当者が鳴る** ── 2 手目以降が実発信になった今、これは実際の電話連鎖になる。
 *
 * `staff_coming` / `answered` は `TERMINAL_SUCCESS_RESULTS` なので取次は `settled` で止まる。
 * `declined` / `delegate` は逆に**次の手へ進めたい**選択なので、そのまま dial 判断へ流す。
 *
 * 🔴 **第 1 段（`/dtmf` の `accept`）は書かない。** あちらの「1」は本人確認であって
 * 意思表示ではない。書くと `answered`＝終端成功として取次が止まり、担当者が第 2 段で
 * 「3 対応できない」を押しても代理へ進めなくなる。
 */
/** 選択を受け取ったことを担当者へ返す（PII を含めない定型文）。 */
function acknowledgement(text: string): NextResponse {
  return NextResponse.json([
    { action: 'talk', text, language: 'ja-JP', bargeIn: false },
  ]);
}

export async function POST(request: Request): Promise<NextResponse> {
  // 停止スイッチは署名検証より前（止めたい状況では検証の計算もさせない）。
  const disabled = denyIfProviderWebhooksDisabled();
  if (disabled) return disabled;
  const { verified, body } = await verifyRequest(request);
  if (!verified.ok) {
    logWebhookRejection('choice', verified.logOnly);
    return rejectWebhook();
  }

  const choice = resolveStage2Choice(body.dtmfDigits ?? '');
  if (choice === undefined) {
    // 誤入力・無入力。選択肢を読み直す（黙って切らない）。
    const options = STAGE2_CHOICES.map((c) => `${c.digit}、${c.label}。`).join('');
    return acknowledgement(`入力を確認できませんでした。${options}`);
  }

  // 🔴 **応答を先に返さない。** 承諾を書く前に返すと、担当者が切って `completed` が
  // 先に届いたときに取次が次の手へ進む。書いてから返す。
  //
  // 冪等キーは webhook の `jti`。at-least-once 配信で取次が余計に 1 手進むのを防ぐ。
  // 応答までの所要時間を段ごとに残す (#744)。順序（書いてから返す）は変えられないので、
  // **どこが遅いか**を実測できるようにしてから手を入れる。値・宛先・通話 ID は載せない。
  const recorder = createStageRecorder('choice');
  try {
    await recorder.measure('correlation_write', () =>
      applyVoiceEventToCorrelation(verified.correlation, { kind: 'dtmf', choice }, verified.jti, {
        webhookBaseUrl: resolveDialCallbackBaseUrl(request),
        regionUrl: body.regionUrl,
      }),
    );
  } catch {
    // 🔴 **担当者への応答を落とさない。** ここで投げると音声が返らず、担当者は自分の入力が
    // 届いたか分からないまま切る。書けなかったことはログに残し、応答は返す。
    console.warn(JSON.stringify({ event: 'vonage_choice_apply_failed', choice }));
  }

  console.info(stageTimingLog(recorder.finish()));

  const label = STAGE2_CHOICES.find((c) => c.choice === choice)?.label ?? '';
  return acknowledgement(`${label}、で承りました。`);
}
