/**
 * 鳴っている provider 通話を切る（呼び出し側の共通形） (#743 AC2 後半)。
 *
 * 切断の呼び出し元は 2 つ（端末の `/give-up` と 2 手目の引き継ぎ失敗）で、どちらも
 * **切断の成否で自分の結果を変えない**。同じ「握り潰し方」を 2 か所に書くと片方だけ
 * 例外を漏らす形になりやすいので、1 つにまとめる。
 *
 * 🔴 **best-effort。例外を投げない・結果で分岐させない。** 呼び出し元は webhook ルートと
 * 端末ルートで、切断の失敗で 5xx を返してはいけない（Vonage の再送・画面固着を招く）。
 * 失敗したら呼出予算（`dialExpiresAt`）が経過して通話は自然に終わる ── #743 が
 * 「切らない」案として許容していた状態に戻るだけで、**悪化しない**。
 */
import type { VoiceTerminationOutcome } from '@/domain/routing/voice-terminator';
import { getCallCorrelationRepository } from './call-correlation';
import { resolveVoiceTerminator } from './voice-dial';

export type HangUpDeps = {
  resolveTerminator?: typeof resolveVoiceTerminator;
  /**
   * 通話を制御する REST の基底 URL（webhook の `region_url`）を引く。既定は相関レコード
   * （`StoredCallCorrelation.regionUrl`）。**無ければ `undefined`＝グローバルへ撃つ**。
   * 引けないこと自体は失敗ではない（区別しない）。
   */
  lookupControlBaseUrl?: (providerCallId: string) => Promise<string | undefined>;
};

async function defaultLookupControlBaseUrl(providerCallId: string): Promise<string | undefined> {
  return (await getCallCorrelationRepository().get(providerCallId))?.regionUrl;
}

/**
 * 通話 ID があれば切る。無ければ何もしない（mock 経路・ビデオ経路には provider 通話が無い）。
 *
 * 結果は**記録のためだけ**に返す。呼び出し元が分岐に使うことは想定しない。
 */
export async function hangUpIfRinging(
  tenantId: string,
  providerCallId: string | undefined,
  deps: HangUpDeps = {},
): Promise<VoiceTerminationOutcome> {
  if (providerCallId === undefined || providerCallId.length === 0) return { kind: 'not_wired' };

  try {
    // リージョンが分かっていればそこへ、分からなければグローバルへ（`resolveVoiceTerminator`
    // の既定）。引く段で落ちても切断は諦めない ── グローバルで撃てば届く。
    const controlBaseUrl = await (deps.lookupControlBaseUrl ?? defaultLookupControlBaseUrl)(
      providerCallId,
    ).catch(() => undefined);
    const terminator = await (deps.resolveTerminator ?? resolveVoiceTerminator)(
      tenantId,
      controlBaseUrl !== undefined ? { apiBaseUrl: controlBaseUrl } : {},
    );
    if (terminator === null) return { kind: 'not_wired' };

    const outcome = await terminator.terminate(providerCallId);
    // 切れなかったことは残す（鳴りっぱなしが起きうる唯一の経路）。**通話 ID は載せない**
    // ── provider 側のログと突き合わせれば来訪者の行動時刻が復元できてしまう。
    if (outcome.kind === 'failed') {
      console.warn(JSON.stringify({ event: 'hangup_failed', tenantId }));
    }
    return outcome;
  } catch {
    // 資格情報の解決自体が落ちることもある。例外の中身は載せない。
    console.warn(JSON.stringify({ event: 'hangup_failed', tenantId }));
    return { kind: 'failed' };
  }
}
