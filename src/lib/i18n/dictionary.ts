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
  | 'common.retry'
  // 待機画面のクイックアクション（カード label/desc, #103 increment 2）
  | 'kiosk.action.callStaff.label'
  | 'kiosk.action.callStaff.desc'
  | 'kiosk.action.checkin.label'
  | 'kiosk.action.checkin.desc'
  | 'kiosk.action.department.label'
  | 'kiosk.action.department.desc'
  | 'kiosk.action.delivery.label'
  | 'kiosk.action.delivery.desc'
  | 'kiosk.action.other.label'
  | 'kiosk.action.other.desc'
  // 受付フロー画面の見出し・目的・主要ボタン（#103 increment 3）
  | 'reception.targetPrompt'
  | 'reception.visitorInfoPrompt'
  | 'reception.purpose.meeting'
  | 'reception.purpose.delivery'
  | 'reception.purpose.interview'
  | 'reception.purpose.other'
  | 'reception.proceedConfirm'
  | 'reception.editInfo'
  | 'reception.callWithThis'
  // 呼び出し中/結果/お詫びのステータス画面（#103 increment 4・{target} は補間）
  | 'reception.callingTitle'
  | 'reception.callingBody'
  | 'reception.connectedBody'
  | 'reception.finishReception'
  | 'reception.timeoutBody'
  | 'reception.failedBody'
  | 'reception.altContact'
  | 'reception.reset'
  | 'reception.fallbackBody'
  | 'reception.toDesk'
  | 'reception.cancelled'
  | 'reception.completedTitle'
  | 'reception.thanksLead'
  // 担当・部署選択 / 音声検索 / フォーム・確認の項目ラベル（#103 increment 5・{field} は補間）
  | 'reception.searchStaff'
  | 'reception.searchPlaceholder'
  | 'reception.byDepartment'
  | 'reception.staffAbsent'
  | 'reception.staffNotFound'
  | 'reception.voiceSearch'
  | 'reception.listening'
  | 'reception.voiceHint'
  | 'reception.fieldPurpose'
  | 'reception.fieldTarget'
  | 'reception.fieldName'
  | 'reception.fieldCompany'
  | 'reception.fieldNote'
  | 'reception.requiredLabel'
  | 'reception.optionalLabel';

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
  'kiosk.action.callStaff.label': '担当者を呼ぶ',
  'kiosk.action.callStaff.desc': 'お名前・ご用件をうかがって担当者をお呼びします',
  'kiosk.action.checkin.label': 'QR で受付',
  'kiosk.action.checkin.desc': '予約 QR コードをお持ちの方はこちら',
  'kiosk.action.department.label': '部署から選ぶ',
  'kiosk.action.department.desc': '訪問先の部署が決まっている方はこちら',
  'kiosk.action.delivery.label': '配送・納品',
  'kiosk.action.delivery.desc': 'お届け物・納品の方はこちら',
  'kiosk.action.other.label': 'その他のご用件',
  'kiosk.action.other.desc': '上記にあてはまらない方はこちら',
  'reception.targetPrompt': '担当者・部署をお選びください',
  'reception.visitorInfoPrompt': '来訪者情報を入力してください',
  'reception.purpose.meeting': '面会',
  'reception.purpose.delivery': '納品',
  'reception.purpose.interview': '打ち合わせ',
  'reception.purpose.other': 'その他',
  'reception.proceedConfirm': '確認へ進む',
  'reception.editInfo': '修正する',
  'reception.callWithThis': 'この内容で呼び出す',
  'reception.callingTitle': '呼び出し中…',
  'reception.callingBody': '{target} を呼び出しています。少々お待ちください。',
  'reception.connectedBody': '{target} が応答しました。まもなくお越しになります。',
  'reception.finishReception': '受付を終了する',
  'reception.timeoutBody': '応答がありませんでした。別の方法でお呼びすることもできます。',
  'reception.failedBody': '呼び出しに失敗しました。別の方法でお呼びすることもできます。',
  'reception.altContact': '代替の連絡先へ',
  'reception.reset': '最初に戻る',
  'reception.fallbackBody': '代表窓口にお繋ぎします。受付スタッフが対応いたしますので、しばらくお待ちください。',
  'reception.toDesk': '受付窓口へ',
  'reception.cancelled': '受付をキャンセルしました',
  'reception.completedTitle': '受付が完了しました',
  'reception.thanksLead': 'ありがとうございました',
  'reception.searchStaff': '担当者を検索（氏名・よみがな・英字）',
  'reception.searchPlaceholder': '例: さとう / Sato',
  'reception.byDepartment': '部署から選ぶ',
  'reception.staffAbsent': '現在不在です。部署または代表窓口をお選びください。',
  'reception.staffNotFound': '該当する担当者が見つかりません。部署または代表窓口をお選びください。',
  'reception.voiceSearch': '音声で担当者を探す',
  'reception.listening': '聞き取り中…',
  'reception.voiceHint': '認識した候補です。タップして検索欄に反映し、内容をご確認のうえお選びください。',
  'reception.fieldPurpose': 'ご用件',
  'reception.fieldTarget': '呼び出し先',
  'reception.fieldName': 'お名前',
  'reception.fieldCompany': '会社名',
  'reception.fieldNote': 'ご用件メモ',
  'reception.requiredLabel': '{field}（必須）',
  'reception.optionalLabel': '{field}（任意）',
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
  'kiosk.action.callStaff.label': 'Call a staff member',
  'kiosk.action.callStaff.desc': "We'll ask your name and purpose, then call the right person",
  'kiosk.action.checkin.label': 'Check in with QR',
  'kiosk.action.checkin.desc': 'If you have a reservation QR code, start here',
  'kiosk.action.department.label': 'Choose a department',
  'kiosk.action.department.desc': "If you know the department you're visiting",
  'kiosk.action.delivery.label': 'Delivery / drop-off',
  'kiosk.action.delivery.desc': 'For deliveries and drop-offs',
  'kiosk.action.other.label': 'Other inquiry',
  'kiosk.action.other.desc': 'If none of the above apply',
  'reception.targetPrompt': 'Choose a person or department',
  'reception.visitorInfoPrompt': 'Please enter your details',
  'reception.purpose.meeting': 'Visit',
  'reception.purpose.delivery': 'Delivery',
  'reception.purpose.interview': 'Meeting',
  'reception.purpose.other': 'Other',
  'reception.proceedConfirm': 'Continue to confirm',
  'reception.editInfo': 'Edit',
  'reception.callWithThis': 'Call with these details',
  'reception.callingTitle': 'Calling…',
  'reception.callingBody': 'Calling {target}. Please wait a moment.',
  'reception.connectedBody': '{target} answered. They will be with you shortly.',
  'reception.finishReception': 'Finish',
  'reception.timeoutBody': 'There was no answer. We can try another way to reach them.',
  'reception.failedBody': 'The call failed. We can try another way to reach them.',
  'reception.altContact': 'Try another way',
  'reception.reset': 'Start over',
  'reception.fallbackBody': "We'll connect you to the main desk. A staff member will assist you shortly.",
  'reception.toDesk': 'Go to the main desk',
  'reception.cancelled': 'Reception cancelled',
  'reception.completedTitle': 'Check-in complete',
  'reception.thanksLead': 'Thank you',
  'reception.searchStaff': 'Search by name (kana / romaji)',
  'reception.searchPlaceholder': 'e.g. Sato',
  'reception.byDepartment': 'Choose by department',
  'reception.staffAbsent': 'Currently unavailable. Please choose a department or the main desk.',
  'reception.staffNotFound': 'No matching staff found. Please choose a department or the main desk.',
  'reception.voiceSearch': 'Search by voice',
  'reception.listening': 'Listening…',
  'reception.voiceHint': 'Recognized candidates. Tap to fill the search box, review, then choose.',
  'reception.fieldPurpose': 'Purpose',
  'reception.fieldTarget': 'Calling',
  'reception.fieldName': 'Name',
  'reception.fieldCompany': 'Company',
  'reception.fieldNote': 'Note',
  'reception.requiredLabel': '{field} (required)',
  'reception.optionalLabel': '{field} (optional)',
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
  'kiosk.action.callStaff.label': '담당자 호출',
  'kiosk.action.callStaff.desc': '성함과 용건을 여쭙고 담당자를 호출합니다',
  'kiosk.action.checkin.label': 'QR로 접수',
  'kiosk.action.checkin.desc': '예약 QR 코드가 있으면 여기서 시작하세요',
  'kiosk.action.department.label': '부서 선택',
  'kiosk.action.department.desc': '방문할 부서를 알고 계신 분',
  'kiosk.action.delivery.label': '배송 / 납품',
  'kiosk.action.delivery.desc': '배송·납품하시는 분',
  'kiosk.action.other.label': '기타 용건',
  'kiosk.action.other.desc': '위에 해당하지 않는 분',
  'reception.targetPrompt': '담당자·부서를 선택해 주세요',
  'reception.visitorInfoPrompt': '방문자 정보를 입력해 주세요',
  'reception.purpose.meeting': '면회',
  'reception.purpose.delivery': '납품',
  'reception.purpose.interview': '미팅',
  'reception.purpose.other': '기타',
  'reception.proceedConfirm': '확인으로 진행',
  'reception.editInfo': '수정',
  'reception.callWithThis': '이 내용으로 호출',
  'reception.callingTitle': '호출 중…',
  'reception.callingBody': '{target}님을 호출하고 있습니다. 잠시만 기다려 주세요.',
  'reception.connectedBody': '{target}님이 응답했습니다. 곧 도착합니다.',
  'reception.finishReception': '접수 종료',
  'reception.timeoutBody': '응답이 없습니다. 다른 방법으로 호출할 수도 있습니다.',
  'reception.failedBody': '호출에 실패했습니다. 다른 방법으로 호출할 수도 있습니다.',
  'reception.altContact': '다른 연락 방법',
  'reception.reset': '처음으로',
  'reception.fallbackBody': '대표 창구로 연결합니다. 접수 직원이 도와드리니 잠시만 기다려 주세요.',
  'reception.toDesk': '접수 창구로',
  'reception.cancelled': '접수가 취소되었습니다',
  'reception.completedTitle': '접수가 완료되었습니다',
  'reception.thanksLead': '감사합니다',
  'reception.searchStaff': '담당자 검색 (이름 / 발음 / 영문)',
  'reception.searchPlaceholder': '예: Sato',
  'reception.byDepartment': '부서로 선택',
  'reception.staffAbsent': '현재 부재중입니다. 부서 또는 대표 창구를 선택해 주세요.',
  'reception.staffNotFound': '해당 담당자를 찾을 수 없습니다. 부서 또는 대표 창구를 선택해 주세요.',
  'reception.voiceSearch': '음성으로 검색',
  'reception.listening': '듣는 중…',
  'reception.voiceHint': '인식된 후보입니다. 탭하여 검색창에 반영하고 확인 후 선택해 주세요.',
  'reception.fieldPurpose': '용건',
  'reception.fieldTarget': '호출 대상',
  'reception.fieldName': '성함',
  'reception.fieldCompany': '회사명',
  'reception.fieldNote': '용건 메모',
  'reception.requiredLabel': '{field}(필수)',
  'reception.optionalLabel': '{field}(선택)',
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
  'kiosk.action.callStaff.label': '呼叫负责人',
  'kiosk.action.callStaff.desc': '我们会询问您的姓名和事由，然后呼叫相应人员',
  'kiosk.action.checkin.label': '扫码登记',
  'kiosk.action.checkin.desc': '持有预约二维码请从这里开始',
  'kiosk.action.department.label': '选择部门',
  'kiosk.action.department.desc': '已确定来访部门的访客',
  'kiosk.action.delivery.label': '送货 / 快递',
  'kiosk.action.delivery.desc': '送货·快递请走这里',
  'kiosk.action.other.label': '其他事由',
  'kiosk.action.other.desc': '不属于以上情况的访客',
  'reception.targetPrompt': '请选择负责人或部门',
  'reception.visitorInfoPrompt': '请输入来访者信息',
  'reception.purpose.meeting': '会面',
  'reception.purpose.delivery': '送货',
  'reception.purpose.interview': '洽谈',
  'reception.purpose.other': '其他',
  'reception.proceedConfirm': '继续确认',
  'reception.editInfo': '修改',
  'reception.callWithThis': '按此呼叫',
  'reception.callingTitle': '正在呼叫…',
  'reception.callingBody': '正在呼叫 {target}，请稍候。',
  'reception.connectedBody': '{target} 已应答，马上就来。',
  'reception.finishReception': '结束登记',
  'reception.timeoutBody': '无人应答。我们可以用其他方式联系。',
  'reception.failedBody': '呼叫失败。我们可以用其他方式联系。',
  'reception.altContact': '其他联系方式',
  'reception.reset': '返回首页',
  'reception.fallbackBody': '正在为您转接前台，工作人员将很快为您服务，请稍候。',
  'reception.toDesk': '前往前台',
  'reception.cancelled': '登记已取消',
  'reception.completedTitle': '登记完成',
  'reception.thanksLead': '谢谢',
  'reception.searchStaff': '搜索负责人（姓名 / 拼音）',
  'reception.searchPlaceholder': '例: Sato',
  'reception.byDepartment': '按部门选择',
  'reception.staffAbsent': '当前不在。请选择部门或前台。',
  'reception.staffNotFound': '未找到相应负责人。请选择部门或前台。',
  'reception.voiceSearch': '语音搜索',
  'reception.listening': '正在聆听…',
  'reception.voiceHint': '识别到的候选。点击填入搜索框，确认后选择。',
  'reception.fieldPurpose': '事由',
  'reception.fieldTarget': '呼叫对象',
  'reception.fieldName': '姓名',
  'reception.fieldCompany': '公司名',
  'reception.fieldNote': '事由备注',
  'reception.requiredLabel': '{field}（必填）',
  'reception.optionalLabel': '{field}（选填）',
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
