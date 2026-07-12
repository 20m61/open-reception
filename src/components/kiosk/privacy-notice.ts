/**
 * 来訪者向けプライバシー通知の文言解決 (issue #314)。
 *
 * kiosk では来訪者情報入力ステップで氏名・会社名・要件を入力させるが、用途・保存の有無・
 * 保持期間・問い合わせ先を来訪者へ明示する UI が無かった。本モジュールは表示文言を
 * 純関数で解決し（副作用なし・node 環境でユニットテスト可能）、KioskFlow 側は結果を
 * そのまま描画するだけにする。
 *
 * テナント上書き (issue #28):
 *   - 待機画面リード（guidanceIdle, #324）と同じ既存パターンに倣い、管理画面（音声設定
 *     画面の案内文言編集 UI, VoiceSettings.privacyNotice）で上書きした文言は既定 locale
 *     (ja) の summary にのみ適用する。他 locale は常に i18n 辞書の既定文言を使う
 *     （上書き文言は運用者が日本語で入力する想定のため、他言語に機械翻訳しない）。
 *   - 未設定/空文字は実装実態に即した既定文言 (dictionary.ts の privacy.summary) へ
 *     フォールバックする。
 *
 * PII 最小化の実態 (docs/audit-logging.md, #30):
 *   - 氏名・会社名・ご用件メモは ReceptionLog/AuditLog に保存しない。
 *   - 受付完了/キャンセル/無操作タイムアウトで画面から自動的に消去される。
 *   - 保持期間の TTL 実効化 (#313) は本 increment 時点では未着手のため、既定文言では
 *     具体的な保持日数を断定しない（呼び出し結果等の運用記録のみ必要な期間保持する旨に留める）。
 *
 * presence カメラ注記 (issue #79):
 *   - 来訪者検知カメラは端末内でのみフレーム差分処理し、映像を保存・送信しない
 *     （usePresenceCamera.ts の実装方針と一致）。有効時のみ注記を追加する。
 */
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/locale';
import { makeT } from '@/lib/i18n/t';

export type PrivacyNoticeContent = {
  title: string;
  /** 入力ステップで常時表示する短い要約（テナント上書き可、ja のみ）。 */
  summary: string;
  detailsShowLabel: string;
  detailsHideLabel: string;
  purposeLabel: string;
  purposeText: string;
  storageLabel: string;
  storageText: string;
  retentionLabel: string;
  retentionText: string;
  contactLabel: string;
  contactText: string;
  /** 詳細内の presence カメラ注記の見出し（常に非空。表示可否は presenceCameraNote で判定）。 */
  presenceCameraLabel: string;
  /** presence カメラ有効時のみ非 undefined（#79）。 */
  presenceCameraNote?: string;
};

export function resolvePrivacyNoticeContent(
  locale: Locale,
  opts: { overrideSummary?: string; presenceCameraEnabled: boolean },
): PrivacyNoticeContent {
  const tr = makeT(locale);
  const trimmedOverride = opts.overrideSummary?.trim();
  const summary = locale === DEFAULT_LOCALE && trimmedOverride ? trimmedOverride : tr('privacy.summary');
  return {
    title: tr('privacy.noticeTitle'),
    summary,
    detailsShowLabel: tr('privacy.detailsShow'),
    detailsHideLabel: tr('privacy.detailsHide'),
    purposeLabel: tr('privacy.purposeLabel'),
    purposeText: tr('privacy.purposeText'),
    storageLabel: tr('privacy.storageLabel'),
    storageText: tr('privacy.storageText'),
    retentionLabel: tr('privacy.retentionLabel'),
    retentionText: tr('privacy.retentionText'),
    contactLabel: tr('privacy.contactLabel'),
    contactText: tr('privacy.contactText'),
    presenceCameraLabel: tr('privacy.presenceCameraLabel'),
    presenceCameraNote: opts.presenceCameraEnabled ? tr('privacy.presenceCameraNote') : undefined,
  };
}
