/**
 * 音声レイヤが**声に出す文言**の決定 (#803)。
 *
 * ## なぜ独立した層にするか
 *
 * ここを `VoiceSessionLayer` の中に埋めると、**effect の中でしか観測できない**。
 * このリポジトリの unit 環境（node vitest・jsdom なし）は React の効果を回せないため、
 * 埋めた瞬間に「文言が字幕と一致すること」「name が差し込まれること」が縛れなくなる。
 * 実際、独立レビューの実測で**別キーへ差し替える変異と name を空にする変異が両方生き残った**
 * （「は現在不在です」と喋る形）。純関数にしておけば普通に縛れる。
 *
 * ## 字幕と同じキーを使う
 *
 * 表示と読み上げが食い違うと、聞いた内容と読んだ内容のどちらを信じるかを来訪者に選ばせる
 * ことになる。`announcementFor` が返すキーは `captionKeyFor` と同一で、それをここで
 * locale 解決するだけ —— **分岐を増やさない**。
 */
import { announcementFor, type VoiceKioskState } from '@/domain/voice-session/kiosk-view';
import { makeT, type Locale } from '@/lib/i18n';

/** その局面で声に出す文言。読み上げるものが無ければ null。 */
export function announcementPhrase(state: VoiceKioskState, locale: Locale): string | null {
  const announcement = announcementFor(state);
  if (announcement === null) return null;
  return makeT(locale)(announcement.key, { name: announcement.name });
}

/**
 * 直前に読み上げた局面と比べて、**いま新たに読み上げるべきか**。
 *
 * 🔴 **文言ではなく局面（state の identity）で判定する。** 文言をキーにすると、
 * 同じ名前で `unavailable` へ**再入**したときに 2 度目が黙る。実 STT が入ると
 * 「聞き取れなかったと思って同じ名前を言い直す来訪者」に**沈黙で返す**形になり、
 * #803 が塞ぎたかった状況そのものへ戻る。reducer は dispatch ごとに新しいオブジェクトを
 * 返すので、identity 比較なら再入を別物として扱える。
 */
export function shouldAnnounce(
  previous: VoiceKioskState | null,
  current: VoiceKioskState,
): boolean {
  if (announcementFor(current) === null) return false;
  return previous !== current;
}
