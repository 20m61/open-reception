/**
 * 受付 UI 文言の多言語辞書 (issue #103, increment 1)。
 *
 * 範囲 (inc1): kiosk 受付の主要文言サブセットのみ。既存全文言の一括差し替えはしない
 * （移行計画は docs/i18n-tts-design.md §全文言移行計画）。
 *
 * 構造:
 *   - キーは `<画面>.<要素>` のドット区切り（例 'welcome.title'）。フラットな
 *     Record<MessageKey, string> を locale 別に持つ。
 *   - 既定 locale (ja) を「正」とし、全キーを必ず網羅する（型 Record<MessageKey, string>
 *     で欠落を型エラーにする）。他 locale はサブセット可で、欠落は t() が ja へフォールバック。
 *
 * ライセンス / 権利 (#105):
 *   - 文言はすべて本プロジェクトの自前表現。競合 SaaS の UI 文言をコピーしない。
 *   - 翻訳は人手による内製。外部翻訳 API を使う場合の規約観点は docs/i18n-tts-design.md。
 *   - 文言に個人情報・内部情報を埋め込まない (#103 セキュリティ方針)。
 */
import type { Locale } from './locale';

/**
 * 既定 locale (ja) が網羅すべき文言キー。
 * `DefaultDictionary`（全キー網羅）が ja の型を保証し、`MessageKey` はそこから導出する。
 */
export type MessageKey =
  | 'welcome.title'
  | 'welcome.tapToStart'
  | 'welcome.chooseLanguage'
  | 'reception.purposePrompt'
  | 'reception.appointment'
  | 'reception.delivery'
  | 'reception.other'
  | 'reception.confirm'
  | 'reception.back'
  | 'reception.calling'
  | 'reception.waitMessage'
  | 'reception.thanks'
  | 'voice.fallbackNotice'
  | 'common.next'
  | 'common.cancel'
  | 'common.retry';

/** 既定 locale 辞書は全キー網羅必須。他 locale は Partial 可（欠落は ja へフォールバック）。 */
type DefaultDictionary = Record<MessageKey, string>;
type LocaleDictionary = Partial<Record<MessageKey, string>>;

const ja: DefaultDictionary = {
  'welcome.title': 'ようこそ',
  'welcome.tapToStart': '画面にタッチして受付を開始してください',
  'welcome.chooseLanguage': '言語を選択してください',
  'reception.purposePrompt': 'ご用件をお選びください',
  'reception.appointment': '訪問のお約束',
  'reception.delivery': '配達・集荷',
  'reception.other': 'その他',
  'reception.confirm': '内容をご確認ください',
  'reception.back': '戻る',
  'reception.calling': '担当者を呼び出しています',
  'reception.waitMessage': 'そのままお待ちください',
  'reception.thanks': '受付が完了しました。ありがとうございます',
  'voice.fallbackNotice': '音声がご利用いただけない場合も、画面の案内に沿って受付できます',
  'common.next': '次へ',
  'common.cancel': 'キャンセル',
  'common.retry': 'もう一度',
};

const en: LocaleDictionary = {
  'welcome.title': 'Welcome',
  'welcome.tapToStart': 'Tap the screen to begin check-in',
  'welcome.chooseLanguage': 'Please choose your language',
  'reception.purposePrompt': 'Please select the reason for your visit',
  'reception.appointment': 'Scheduled appointment',
  'reception.delivery': 'Delivery / pickup',
  'reception.other': 'Other',
  'reception.confirm': 'Please confirm the details',
  'reception.back': 'Back',
  'reception.calling': 'Calling the person in charge',
  'reception.waitMessage': 'Please wait a moment',
  'reception.thanks': 'Check-in complete. Thank you',
  'voice.fallbackNotice': 'If audio is unavailable, you can still complete check-in by following the on-screen guidance',
  'common.next': 'Next',
  'common.cancel': 'Cancel',
  'common.retry': 'Try again',
};

const ko: LocaleDictionary = {
  'welcome.title': '환영합니다',
  'welcome.tapToStart': '화면을 터치하여 접수를 시작하세요',
  'welcome.chooseLanguage': '언어를 선택해 주세요',
  'reception.purposePrompt': '방문 목적을 선택해 주세요',
  'reception.appointment': '방문 예약',
  'reception.delivery': '배송 / 수령',
  'reception.other': '기타',
  'reception.confirm': '내용을 확인해 주세요',
  'reception.back': '뒤로',
  'reception.calling': '담당자를 호출하고 있습니다',
  'reception.waitMessage': '잠시만 기다려 주세요',
  'reception.thanks': '접수가 완료되었습니다. 감사합니다',
  'voice.fallbackNotice': '음성을 사용할 수 없어도 화면 안내에 따라 접수를 완료할 수 있습니다',
  'common.next': '다음',
  'common.cancel': '취소',
  'common.retry': '다시 시도',
};

const zh: LocaleDictionary = {
  'welcome.title': '欢迎',
  'welcome.tapToStart': '请触摸屏幕开始登记',
  'welcome.chooseLanguage': '请选择语言',
  'reception.purposePrompt': '请选择来访事由',
  'reception.appointment': '预约来访',
  'reception.delivery': '快递 / 取件',
  'reception.other': '其他',
  'reception.confirm': '请确认信息',
  'reception.back': '返回',
  'reception.calling': '正在呼叫负责人',
  'reception.waitMessage': '请稍候',
  'reception.thanks': '登记完成，谢谢',
  'voice.fallbackNotice': '即使无法使用语音，您也可以按照屏幕提示完成登记',
  'common.next': '下一步',
  'common.cancel': '取消',
  'common.retry': '重试',
};

/**
 * locale → 辞書。既定 (ja) のみ全キー網羅、他はサブセット可。
 * ja は `DefaultDictionary` 型で全キー網羅をコンパイル時に強制している（上の const ja）。
 */
export const DICTIONARIES: Record<Locale, LocaleDictionary> = {
  ja,
  en,
  ko,
  zh,
};
