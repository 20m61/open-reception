/**
 * 2 手目以降の実発信 (#646)。
 *
 * 1 手目は `runVoiceRoutedCall`（受付端末の HTTP リクエストの中）が撃つ。2 手目からは
 * **webhook の中**で撃つことになる ── 1 手目の結果（未応答・話中・辞退）が webhook で
 * 届いて初めて「次の手へ進む」と分かるため。この差だけを持つのがここ。
 *
 * ## 1 手目と決定的に違うこと: 相関レコードが**入れ替わる**
 *
 * 相関のキーは provider の通話 ID（`call-correlation.ts`）。2 手目は新しい通話 ID を持つので
 * **新しいレコード**になる。よって撃つだけでは足りず、次の 3 つを揃えて初めて取次が繋がる:
 *
 *   1. 1 手目の相関を**確定させる**（遅れて届く webhook で取次が二重に進まないように）
 *   2. 2 手目の相関を作り、位置・台帳・イベント数を**引き継ぐ**
 *   3. 受付の `providerCallId` を**付け替える**
 *
 * 3 を落とすと `/status` は 1 手目（`no_answer` で確定済み）を読み続け、**2 手目が鳴って
 * いる最中に来訪者へ「応答が得られませんでした」と表示する**。
 *
 * ## 順序: 撃つ権利を atomic に取ってから撃つ
 *
 * 🔴 **撃ってから台帳を書かない。** webhook は at-least-once。同一 `jti` の再配信が発信の
 * 最中に届くと、台帳がまだ書かれていないぶん `duplicate` 判定を抜けて**二重発信**になる。
 *
 * 🔴 **しかも台帳だけでは足りない。** Vonage は不応答の 1 通話に対し `unanswered` と
 * `completed` を**別 `jti`・ほぼ同時**に送る。Lambda では別インスタンスで並行実行され、
 * どちらも `in_flight` を読んでから書くので `jti` の duplicate 判定に掛からない。よって
 * 予約は **compare-and-set**（`CallCorrelationRepository.reserve`）で行い、負けた側は
 * 撃たず・保存もしない。
 *
 * 逆側の損（予約できて撃てなかった）は、その通話の再配信が無視されるだけで、呼出予算
 * （`dialExpiresAt`）が timeout へ倒して代替導線に出る。**二重発信より軽い。**
 *
 * ## 予約では通話状態を進めない
 *
 * 🔴 **予約で terminal な `voiceState`（`no_answer` 等）を書くと、撃っている最中に
 * 来訪者へ「応答が得られませんでした」と出る。** 受付の `providerCallId` はまだ 1 手目を
 * 指しており、`resolveCallResolution` は**呼出予算より先に `voiceState` を見る**ので、
 * 3 秒ポーリングがこの窓に当たると受付が終端してしまう。
 *
 * よって予約では台帳と `status` だけを確定させ、呼出予算は次の手のぶんへ**引き直す**
 * （引き直さないと 1 手目の期限切れで同じことが起きる）。terminal な状態を書くのは
 * **撃てなかったと分かってから** ── そのときは即座に代替導線へ倒したい。
 *
 * ## 例外を投げない
 *
 * 🔴 呼び出し元は webhook ルート。投げると Vonage へ 5xx が返り再送が走る ── その再送が
 * また撃つ。失敗は結果として返し、呼び出し側でログにする。
 */
import { dialExpiresAtFrom } from '@/domain/routing/dial-budget';
import { endpointRef } from '@/domain/routing/endpoint';
import type { RoutingStep } from '@/domain/routing/policy';
import type { VoiceCallInitiator } from '@/domain/routing/voice-initiator';
import { withEventBudget } from '@/domain/routing/hop-event-budget';
import type { CallProgress } from '@/domain/routing/webhook-advance';
import { KIOSK_ANNOUNCE_TEXT } from './call-execution';
import type { StoredCallCorrelation } from './call-correlation';
import type { StoredContactEndpoint } from './types';

export type DialNextHopDeps = {
  /** 1 手目（＝いま webhook が届いた通話）の相関。 */
  readonly correlation: StoredCallCorrelation;
  /** `advanceFromWebhook` が返した dial 判断の `next`。位置は既に次の手へ進んでいる。 */
  readonly next: CallProgress;
  /** 次に撃つ手。 */
  readonly step: RoutingStep;
  readonly endpoints: ReadonlyArray<StoredContactEndpoint>;
  /** **null は「実発信しない」**（停止スイッチ / テナント未設定）。呼び出し側が従来の保存へ倒す。 */
  readonly initiator: VoiceCallInitiator | null;
  readonly saveCorrelation: (correlation: StoredCallCorrelation) => Promise<void>;
  /**
   * 撃つ権利の atomic な取得。`false` は「別の配信が先に取った」。
   * `status: 'in_flight'` かつ `updatedAt` が読んだ値のままのときだけ true。
   */
  readonly updateIfUnchanged: (
    providerCallId: string,
    changes: Partial<StoredCallCorrelation>,
    expectedUpdatedAt: string,
  ) => Promise<boolean>;
  readonly repointReception: (receptionId: string, providerCallId: string) => Promise<void>;
  /**
   * 受付がまだ呼び出し中か。**撃つ前に見る** ── 来訪者がキャンセルした後や、
   * 既に終端した受付のために社内の電話を鳴らさない（#646 レビュー M1）。
   */
  readonly isReceptionCalling: (receptionId: string) => Promise<boolean>;
  readonly now?: () => Date;
};

export type DialNextHopResult =
  /** 実発信経路ではない。呼び出し側が従来どおり「位置を進めずに保存」する。 */
  | { readonly kind: 'not_wired' }
  /** 接続先が引けない／無効。撃たないので呼び出し側が従来どおり保存する。 */
  | { readonly kind: 'endpoint_unavailable' }
  /** 受付がもう呼び出し中でない（キャンセル・確定済み）。撃たない。 */
  | { readonly kind: 'reception_closed' }
  /** 予約を書けなかった。**撃っていない**ので呼び出し側が従来どおり保存する。 */
  | { readonly kind: 'reserve_failed' }
  /** 別の配信が先に撃つ権利を取った。**何もしない**（保存もしない）。 */
  | { readonly kind: 'reserve_lost' }
  /** 撃てなかった。1 手目は確定済みなので `/status` が呼出予算で倒す。 */
  | { readonly kind: 'dial_failed' }
  /** 撃てて、引き継ぎも済んだ。 */
  | { readonly kind: 'dialed'; readonly providerCallId: string }
  /** 撃てたが記録が途中で途切れた。**撃った事実は隠さない**（再発信させない）。 */
  | { readonly kind: 'handoff_incomplete'; readonly providerCallId: string };

export async function dialNextHop(deps: DialNextHopDeps): Promise<DialNextHopResult> {
  const { correlation, next, step, initiator } = deps;
  if (initiator === null) return { kind: 'not_wired' };

  // 接続先が引けない／無効／PSTN でないなら撃たない。握り潰して撃つと誤った宛先へ繋がる
  // 余地が出るし、番号を引けない接続先を撃とうとすると発信が例外になって取次がそこで終わる。
  const contact = deps.endpoints.find((e) => e.id === step.endpointId);
  if (contact === undefined || !contact.enabled || contact.channel !== 'pstn') {
    return { kind: 'endpoint_unavailable' };
  }

  // 🔴 **受付がまだ呼び出し中のときだけ撃つ。** 来訪者がキャンセルした後や既に確定した
  // 受付のために社内の電話を鳴らさない（居ない人のために最大 10 段鳴りうる）。
  if (!(await deps.isReceptionCalling(correlation.receptionId))) {
    return { kind: 'reception_closed' };
  }

  const reservedAt = deps.now?.() ?? new Date();

  // ── 1. 予約。撃つ権利を atomic に 1 つの配信だけへ渡す（上の doc コメント参照）。
  //    位置は進めない（このレコードは 1 手目のものであり続ける）。**通話状態も進めない**
  //    ── 進めると撃っている最中に `/status` が来訪者を代替導線へ倒す。
  //    呼出予算は次の手のぶんへ引き直す（1 手目の期限切れでも同じことが起きるため）。
  let reserved: boolean;
  try {
    reserved = await deps.updateIfUnchanged(
      correlation.providerCallId,
      {
        position: withEventBudget(
          { ...correlation.position, ledger: next.position.ledger },
          next.eventCount,
        ),
        eventCount: next.eventCount,
        status: 'settled',
        dialExpiresAt: dialExpiresAtFrom(reservedAt, step.timeoutSeconds),
        updatedAt: reservedAt.toISOString(),
      },
      correlation.updatedAt,
    );
  } catch {
    return { kind: 'reserve_failed' };
  }
  // 負けた＝別の配信が既に撃った（か撃とうとしている）。**何もしない。**
  if (!reserved) return { kind: 'reserve_lost' };

  /**
   * 撃てなかったときの後始末。予約で保留にした通話状態をここで terminal にして、
   * `/status` が待ち続けずに代替導線へ倒せるようにする。**失敗を握り潰さない。**
   */
  const settleAsUnreached = async (): Promise<void> => {
    try {
      await deps.saveCorrelation({
        ...correlation,
        position: withEventBudget(
          { ...correlation.position, ledger: next.position.ledger },
          next.eventCount,
        ),
        voiceState: next.voiceState,
        eventCount: next.eventCount,
        status: 'settled',
        dialExpiresAt: correlation.dialExpiresAt,
        updatedAt: (deps.now?.() ?? new Date()).toISOString(),
      });
    } catch {
      // 書けなくても、引き直した呼出予算が経過すれば `/status` が倒す（遅れるだけ）。
      console.warn(JSON.stringify({ event: 'next_hop_settle_failed' }));
    }
  };

  // ── 2. 発信。
  let providerCallId: string;
  try {
    const initiation = await initiator.initiate({
      callUuid: correlation.receptionId,
      endpoint: endpointRef(contact),
      action: step.action,
      timeoutSeconds: step.timeoutSeconds,
      announceText: KIOSK_ANNOUNCE_TEXT,
    });
    providerCallId = initiation.providerCallId;
  } catch {
    // 例外の中身は載せない（宛先・URL・資格情報が混ざりうる）。
    await settleAsUnreached();
    return { kind: 'dial_failed' };
  }

  // ── 3. 2 手目の相関。呼出予算は**この手のために引き直す**（1 手目の期限を持ち込むと
  //    鳴り始めた瞬間に打ち切られる）。通話状態も `queued` から始める。
  const dialedAt = deps.now?.() ?? new Date();
  try {
    await deps.saveCorrelation({
      providerCallId,
      receptionId: correlation.receptionId,
      tenantId: correlation.tenantId,
      siteId: correlation.siteId,
      position: withEventBudget(next.position, next.eventCount),
      voiceState: 'queued',
      eventCount: next.eventCount,
      status: 'in_flight',
      dialExpiresAt: dialExpiresAtFrom(dialedAt, step.timeoutSeconds),
      updatedAt: dialedAt.toISOString(),
    });
  } catch {
    // 撃ってはいる。付け替えると `/status` が引けない相関を指して永久に pending になる。
    return { kind: 'handoff_incomplete', providerCallId };
  }

  // ── 4. 受付の付け替え。ここまで来て初めて `/status` が 2 手目を見る。
  try {
    await deps.repointReception(correlation.receptionId, providerCallId);
  } catch {
    return { kind: 'handoff_incomplete', providerCallId };
  }

  return { kind: 'dialed', providerCallId };
}
