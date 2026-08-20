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
 * ## 順序: 台帳を確定させてから撃つ
 *
 * 🔴 **撃ってから台帳を書かない。** webhook は at-least-once。同一 `jti` の再配信が発信の
 * 最中に届くと、台帳がまだ書かれていないぶん `duplicate` 判定を抜けて**二重発信**になる
 * （担当者の電話が 2 本鳴る）。先に台帳を確定させれば再配信は弾かれる。
 *
 * 逆側の損（台帳だけ書けて撃てなかった）は、その `jti` の再配信が無視されるだけで、
 * 呼出予算（`dialExpiresAt`）が timeout へ倒して代替導線に出る。**二重発信より軽い。**
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
  readonly repointReception: (receptionId: string, providerCallId: string) => Promise<void>;
  readonly now?: () => Date;
};

export type DialNextHopResult =
  /** 実発信経路ではない。呼び出し側が従来どおり「位置を進めずに保存」する。 */
  | { readonly kind: 'not_wired' }
  /** 接続先が引けない／無効。撃たないので呼び出し側が従来どおり保存する。 */
  | { readonly kind: 'endpoint_unavailable' }
  /** 台帳を確定できなかった。**撃っていない**ので呼び出し側が従来どおり保存する。 */
  | { readonly kind: 'reserve_failed' }
  /** 撃てなかった。1 手目は確定済みなので `/status` が呼出予算で倒す。 */
  | { readonly kind: 'dial_failed' }
  /** 撃てて、引き継ぎも済んだ。 */
  | { readonly kind: 'dialed'; readonly providerCallId: string }
  /** 撃てたが記録が途中で途切れた。**撃った事実は隠さない**（再発信させない）。 */
  | { readonly kind: 'handoff_incomplete'; readonly providerCallId: string };

export async function dialNextHop(deps: DialNextHopDeps): Promise<DialNextHopResult> {
  const { correlation, next, step, initiator } = deps;
  if (initiator === null) return { kind: 'not_wired' };

  // 接続先が引けない／無効なら撃たない。握り潰して撃つと誤った宛先へ繋がる余地が出る。
  const contact = deps.endpoints.find((e) => e.id === step.endpointId);
  if (contact === undefined || !contact.enabled) return { kind: 'endpoint_unavailable' };

  // ── 1. 予約（台帳の確定）。撃つ前に書く。上の doc コメント参照。
  //    位置そのものは進めない ── このレコードは 1 手目のものであり続ける。進めた位置は
  //    2 手目の新レコードが持つ。
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
      updatedAt: (deps.now?.() ?? new Date()).toISOString(),
    });
  } catch {
    return { kind: 'reserve_failed' };
  }

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
