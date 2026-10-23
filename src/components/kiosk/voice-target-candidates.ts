import { searchStaffScored, type MatchTier } from '@/domain/staff/search';
import type { Directory } from './useEffectiveConfiguration';

type DirectoryStaff = Directory['staff'][number];

export type VoiceTargetCandidate = {
  staff: DirectoryStaff;
  tier: MatchTier;
  /**
   * どの STT 候補から導出されたか。表示・ログへは出さず、テスト/デバッグ用途だけに持つ。
   * 来訪者の発話全文を永続化しない #1057 の方針を崩さないため、呼び出し側も保存しないこと。
   */
  source: string;
};

const DEFAULT_MAX_CANDIDATES = 4;

/**
 * STT が返した文字列候補を、来訪者がタップして確認できる担当者候補へ変換する (#1057)。
 *
 * - 在席 (`available`) の担当者だけを対象にする。
 * - 各 STT 候補について `searchStaffScored` の**最良 tier だけ**を採用する。
 *   exact があるのに fuzzy まで混ぜて候補を水増ししない。
 * - 同じ担当者が複数の STT 候補から得られても 1 枚に dedupe する。
 * - 画面上で判断できる数へ上限を持たせる。既定 4 件。
 * - ここでは担当者を確定しない。返した候補を UI がボタンとして提示し、来訪者の明示タップで
 *   `SELECT_TARGET` する。
 *
 * STT の文字列を `<input>` へ流し込む旧経路の置き換え用。状態機械の ReceptionState は増やさない。
 */
export function voiceTargetCandidatesFor(
  directory: Pick<Directory, 'staff'>,
  transcripts: readonly string[],
  maxCandidates = DEFAULT_MAX_CANDIDATES,
): VoiceTargetCandidate[] {
  if (maxCandidates <= 0) return [];

  const available = directory.staff.filter((staff) => staff.available);
  const seen = new Set<string>();
  const candidates: VoiceTargetCandidate[] = [];

  for (const transcript of transcripts) {
    const query = transcript.trim();
    if (query === '') continue;

    const scored = searchStaffScored(available, query);
    const bestTier = scored[0]?.tier;
    if (bestTier === undefined) continue;

    for (const match of scored) {
      if (match.tier !== bestTier) break;
      if (seen.has(match.item.id)) continue;

      seen.add(match.item.id);
      candidates.push({ staff: match.item, tier: match.tier, source: query });
      if (candidates.length >= maxCandidates) return candidates;
    }
  }

  return candidates;
}
