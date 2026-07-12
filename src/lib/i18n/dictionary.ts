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
 *     で欠落を型エラーにする）。他 locale の型は引き続き Partial（`t()` の ja フォールバック
 *     は安全網として維持）だが、**実運用ではすべての locale が全キーを網羅する**運用を
 *     #327 で開始した。`i18n.test.ts` の「locale 網羅の機械検証」が
 *     `SUPPORTED_LOCALES` の全 locale × 全 `MessageKey` の完全一致を検証し、キー追加時に
 *     いずれかの locale の翻訳を書き忘れるとローカル品質ゲート（unit）で FAIL する。
 *     新規キーを追加する際は **ja/en/ko/zh 全てに追記する**こと（自前の短い翻訳で可、
 *     外部翻訳 API は使わない #105）。
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
  // 待機画面リードの安心情報 / 目的選択の絞り込み見出し（#324 1画面1メッセージ）
  | 'reception.idleReassure'
  | 'reception.purposeDetailPrompt'
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
  // 目的選択カードの説明（待機カードと視覚語彙を統一, #324-3）
  | 'reception.purpose.meeting.desc'
  | 'reception.purpose.delivery.desc'
  | 'reception.purpose.interview.desc'
  | 'reception.purpose.other.desc'
  | 'reception.proceedConfirm'
  | 'reception.editInfo'
  | 'reception.callWithThis'
  // 呼び出し中/結果/お詫びのステータス画面（#103 increment 4・{target} は補間）
  | 'reception.callingTitle'
  | 'reception.callingBody'
  // 呼び出し中の段階的ケア (#323)。経過に応じて文言を切り替える（UI 層のタイマー派生。
  // state.ts / ui-contract.ts の状態・遷移は変えない）。
  | 'reception.callingStageWaiting'
  | 'reception.callingStageNotice'
  | 'reception.connectedBody'
  | 'reception.finishReception'
  | 'reception.timeoutBody'
  | 'reception.failedBody'
  | 'reception.altContact'
  // 担当者クイック応答 (#99) の「5分お待ちください」に対する目安の再案内 (#323 AC2)。
  | 'reception.staffResponseWaitReguidance'
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
  | 'reception.optionalLabel'
  // 進捗ステッパーのステップ短ラベル（#121 UX）
  | 'reception.step.purpose'
  | 'reception.step.target'
  | 'reception.step.info'
  | 'reception.step.confirm'
  // 無操作タイムアウトのカウントダウン警告（#125 UX・{seconds} 補間）
  | 'reception.inactivityTitle'
  | 'reception.inactivityBody'
  | 'reception.inactivityCountdown'
  | 'reception.inactivityContinue'
  // 待機画面の退館チェックアウト導線ラベル、および /kiosk/checkout 画面文言
  // （#327・全 locale 完全網羅を単体テストで強制する対象）。
  | 'kiosk.checkoutLink'
  | 'checkout.title'
  | 'checkout.description'
  | 'checkout.stayIdLabel'
  | 'checkout.submit'
  | 'checkout.presentListTitle'
  | 'checkout.emptyPresent'
  | 'checkout.checkedInAt'
  | 'checkout.checkoutButton'
  | 'checkout.doneTitle'
  | 'checkout.doneBody'
  | 'checkout.error.notFound'
  | 'checkout.error.alreadyCheckedOut'
  | 'checkout.error.invalid'
  | 'checkout.error.network'
  // 退館の自己特定 再設計 (#328)。QR/短コード + ラベル照合 + 確認ステップ。
  | 'checkout.lead'
  | 'checkout.tokenSectionTitle'
  | 'checkout.tokenSectionHint'
  | 'checkout.tokenLabel'
  | 'checkout.tokenPlaceholder'
  | 'checkout.scanButton'
  | 'checkout.or'
  | 'checkout.codeSectionTitle'
  | 'checkout.codeSectionHint'
  | 'checkout.codeLabel'
  | 'checkout.codePlaceholder'
  | 'checkout.targetLabelLabel'
  | 'checkout.targetLabelPlaceholder'
  | 'checkout.resolveSubmit'
  | 'checkout.targetUnknown'
  | 'checkout.purposeUnknown'
  | 'checkout.back'
  | 'checkout.startOver'
  | 'checkout.confirm.title'
  | 'checkout.confirm.lead'
  | 'checkout.confirm.question'
  | 'checkout.confirm.timeLabel'
  | 'checkout.confirm.targetLabel'
  | 'checkout.confirm.purposeLabel'
  | 'checkout.confirm.yes'
  | 'checkout.confirm.no'
  | 'checkout.error.expired'
  | 'checkout.error.throttled'
  | 'checkout.error.notRecognized'
  // 受付完了画面の退館クレデンシャル提示 (#342)。退館 QR / 短コード / 有効期限（{time} 補間）。
  | 'checkout.credential.title'
  | 'checkout.credential.instruction'
  | 'checkout.credential.codeLabel'
  | 'checkout.credential.expiresAt'
  | 'checkout.credential.qrAlt'
  // 待機サイネージ（埋め込み版 SignageWaitingView / スタンドアロン /kiosk/signage）の
  // 未設定フォールバック CTA・来訪検知トグル文言 (#327 2nd increment)。
  | 'kiosk.signage.tapToStart'
  | 'kiosk.signage.presenceOn'
  | 'kiosk.signage.presenceOff'
  | 'kiosk.signage.presenceUnavailable'
  // 来訪者向けプライバシー通知（受付情報入力ステップ, #314）。要約は常時表示、詳細は折りたたみ。
  | 'privacy.noticeTitle'
  | 'privacy.summary'
  | 'privacy.detailsShow'
  | 'privacy.detailsHide'
  | 'privacy.purposeLabel'
  | 'privacy.purposeText'
  | 'privacy.storageLabel'
  | 'privacy.storageText'
  | 'privacy.retentionLabel'
  | 'privacy.retentionText'
  | 'privacy.contactLabel'
  | 'privacy.contactText'
  | 'privacy.presenceCameraLabel'
  | 'privacy.presenceCameraNote'
  // 担当者検索で 0 件だったときの次の一手（部署一覧・チャット相談への誘導, #322）。
  | 'reception.searchNoResultsGuidance'
  | 'reception.searchNoResultsChatCta'
  | 'reception.searchMaybeMatch';

/** 既定 locale 辞書は全キー網羅必須。他 locale は Partial 可（欠落は ja へフォールバック）。 */
type DefaultDictionary = Record<MessageKey, string>;
type LocaleDictionary = Partial<Record<MessageKey, string>>;

const ja: DefaultDictionary = {
  'welcome.title': 'ようこそ',
  'welcome.tapToStart': '画面にタッチして受付を開始してください',
  'welcome.chooseLanguage': '言語を選択してください',
  'reception.purposePrompt': 'ご用件をお選びください',
  'reception.idleReassure': 'タッチ操作だけで受付できます',
  'reception.purposeDetailPrompt': 'ご用件の種類をお選びください',
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
  'reception.purpose.meeting.desc': 'お約束の面会・ご訪問先の担当者へ',
  'reception.purpose.delivery.desc': 'お届け物・集荷の受け渡し',
  'reception.purpose.interview.desc': '会議・打ち合わせでお越しの方',
  'reception.purpose.other.desc': '上記以外のご用件',
  'reception.proceedConfirm': '確認へ進む',
  'reception.editInfo': '修正する',
  'reception.callWithThis': 'この内容で呼び出す',
  'reception.callingTitle': '呼び出し中…',
  'reception.callingBody': '{target} を呼び出しています。少々お待ちください。',
  'reception.callingStageWaiting': 'もう少しお待ちください。担当者に確認しています。',
  'reception.callingStageNotice': 'つながらない場合は、別の方法でご案内します。',
  'reception.connectedBody': '{target} が応答しました。担当者がまいりますので、そのままお待ちください。操作は不要です。',
  'reception.finishReception': '受付を終える',
  'reception.timeoutBody': '応答がありませんでした。別の方法でお呼びすることもできます。',
  'reception.failedBody': '呼び出しに失敗しました。別の方法でお呼びすることもできます。',
  'reception.altContact': '代替の連絡先へ',
  'reception.staffResponseWaitReguidance': '目安は数分です。担当者が向かい次第、この画面が切り替わります。',
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
  'reception.step.purpose': '用件',
  'reception.step.target': '相手',
  'reception.step.info': '情報',
  'reception.step.confirm': '確認',
  'reception.inactivityTitle': 'まだご利用中ですか？',
  'reception.inactivityBody': 'プライバシー保護のため、まもなく最初の画面に戻ります。',
  'reception.inactivityCountdown': '{seconds} 秒後にリセットします',
  'reception.inactivityContinue': '続ける',
  'kiosk.checkoutLink': '退館チェックアウト',
  'checkout.title': '退館チェックアウト',
  'checkout.description': '受付番号を入力するか、在館中の一覧から選んで退館してください。',
  'checkout.stayIdLabel': '受付番号',
  'checkout.submit': '退館する',
  'checkout.presentListTitle': '在館中の来訪者',
  'checkout.emptyPresent': '在館中の来訪者はいません。',
  'checkout.checkedInAt': '{time} 入館',
  'checkout.checkoutButton': '退館',
  'checkout.doneTitle': '退館を受け付けました',
  'checkout.doneBody': 'お気をつけてお帰りください。',
  'checkout.error.notFound': '受付番号が見つかりませんでした。番号をご確認ください。',
  'checkout.error.alreadyCheckedOut': 'この受付番号はすでに退館済みです。',
  'checkout.error.invalid': '受付番号を入力してください。',
  'checkout.error.network': '通信エラーが発生しました。もう一度お試しください。',
  'checkout.lead': '退館用の QR コード、または受付時にお渡しした退館コードで退館できます。',
  'checkout.tokenSectionTitle': '退館 QR で退館',
  'checkout.tokenSectionHint': '受付完了時の QR コードをかざすか、リンクを貼り付けてください。',
  'checkout.tokenLabel': '退館 QR / リンク',
  'checkout.tokenPlaceholder': 'QR を読み取るか、リンクを貼り付け',
  'checkout.scanButton': '確認へ進む',
  'checkout.or': 'または',
  'checkout.codeSectionTitle': '退館コードで退館',
  'checkout.codeSectionHint': '4 桁の退館コードと、呼び出し先（部署・担当）を入力してください。',
  'checkout.codeLabel': '退館コード（4 桁）',
  'checkout.codePlaceholder': '0000',
  'checkout.targetLabelLabel': '呼び出し先（部署・担当）',
  'checkout.targetLabelPlaceholder': '例: 総務部',
  'checkout.resolveSubmit': '確認へ進む',
  'checkout.targetUnknown': '呼び出し先の記録なし',
  'checkout.purposeUnknown': '用件の記録なし',
  'checkout.back': '戻る',
  'checkout.startOver': '最初に戻る',
  'checkout.confirm.title': '退館の確認',
  'checkout.confirm.lead': '以下の内容で退館します。ご本人かご確認ください。',
  'checkout.confirm.question': '{time} に {target} 宛でご来館の方で間違いありませんか？',
  'checkout.confirm.timeLabel': '入館時刻',
  'checkout.confirm.targetLabel': '呼び出し先',
  'checkout.confirm.purposeLabel': '用件',
  'checkout.confirm.yes': 'はい、退館します',
  'checkout.confirm.no': 'いいえ、戻る',
  'checkout.error.expired': '退館コードの有効期限が切れています。受付にお問い合わせください。',
  'checkout.error.throttled': '退館コードの試行が続いたため、しばらく受け付けを制限しています。少し時間をおくか、退館 QR をご利用いただくか、受付にお問い合わせください。',
  'checkout.error.notRecognized': '退館コードまたは呼び出し先が確認できませんでした。もう一度ご確認ください。',
  'checkout.credential.title': '退館用のご案内',
  'checkout.credential.instruction': 'お帰りの際は、この QR コードまたは退館コードを受付端末でご提示ください。',
  'checkout.credential.codeLabel': '退館コード',
  'checkout.credential.expiresAt': '有効期限：{time}',
  'checkout.credential.qrAlt': '退館用 QR コード',
  'kiosk.signage.tapToStart': '画面をタップして受付を開始',
  'kiosk.signage.presenceOn': '来訪検知: ON',
  'kiosk.signage.presenceOff': '来訪検知: OFF',
  'kiosk.signage.presenceUnavailable': '来訪検知: 利用不可',
  'privacy.noticeTitle': '入力情報の取り扱いについて',
  'privacy.summary':
    '入力いただいたお名前・会社名・ご用件は、担当者への取り次ぎにのみ使用し、記録には保存しません。',
  'privacy.detailsShow': '詳しく見る',
  'privacy.detailsHide': '閉じる',
  'privacy.purposeLabel': '利用目的',
  'privacy.purposeText': '受付担当者の呼び出し・取り次ぎのためだけに使用します。',
  'privacy.storageLabel': '保存の有無',
  'privacy.storageText':
    'お名前・会社名・ご用件メモは受付記録に保存されません。受付完了後は画面から自動的に消去されます。',
  'privacy.retentionLabel': '保持期間',
  'privacy.retentionText':
    '呼び出し結果などの運用記録は必要な期間のみ保持し、入力いただいた個人情報自体は保持しません。',
  'privacy.contactLabel': 'お問い合わせ',
  'privacy.contactText': '取り扱いについてのご質問は受付窓口の担当者までお尋ねください。',
  'privacy.presenceCameraLabel': '来訪者検知カメラについて',
  'privacy.presenceCameraNote':
    '来訪者検知カメラの映像は端末内でのみ処理し、保存・送信は行いません。',
  'reception.searchNoResultsGuidance':
    'お探しの方が見つかりませんか？ 部署から選ぶか、チャットで受付係に相談できます。',
  'reception.searchNoResultsChatCta': 'チャットで受付係に相談する',
  'reception.searchMaybeMatch': 'もしかして',
};

const en: LocaleDictionary = {
  'welcome.title': 'Welcome',
  'welcome.tapToStart': 'Tap the screen to begin check-in',
  'welcome.chooseLanguage': 'Please choose your language',
  'reception.purposePrompt': 'Please select the reason for your visit',
  'reception.idleReassure': 'You can check in with touch alone',
  'reception.purposeDetailPrompt': 'Please choose the type of visit',
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
  'reception.purpose.meeting.desc': 'Visiting a specific person',
  'reception.purpose.delivery.desc': 'Deliveries and pickups',
  'reception.purpose.interview.desc': 'Meetings and appointments',
  'reception.purpose.other.desc': 'Anything else',
  'reception.proceedConfirm': 'Continue to confirm',
  'reception.editInfo': 'Edit',
  'reception.callWithThis': 'Call with these details',
  'reception.callingTitle': 'Calling…',
  'reception.callingBody': 'Calling {target}. Please wait a moment.',
  'reception.callingStageWaiting': 'Thanks for your patience—still checking with the person in charge.',
  'reception.callingStageNotice': "If we can't reach them, we'll guide you another way.",
  'reception.connectedBody':
    '{target} answered and will come to meet you shortly. Please wait here—no action is needed.',
  'reception.finishReception': 'Done',
  'reception.timeoutBody': 'There was no answer. We can try another way to reach them.',
  'reception.failedBody': 'The call failed. We can try another way to reach them.',
  'reception.altContact': 'Try another way',
  'reception.staffResponseWaitReguidance': "It'll be about a few minutes. This screen will update once they're on the way.",
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
  'reception.step.purpose': 'Purpose',
  'reception.step.target': 'Person',
  'reception.step.info': 'Details',
  'reception.step.confirm': 'Confirm',
  'reception.inactivityTitle': 'Are you still there?',
  'reception.inactivityBody': 'For your privacy, this will return to the start screen shortly.',
  'reception.inactivityCountdown': 'Resetting in {seconds}s',
  'reception.inactivityContinue': 'Continue',
  'kiosk.checkoutLink': 'Checkout',
  'checkout.title': 'Checkout',
  'checkout.description':
    'Enter your reception number, or choose from the list of visitors currently on site.',
  'checkout.stayIdLabel': 'Reception number',
  'checkout.submit': 'Check out',
  'checkout.presentListTitle': 'Visitors currently on site',
  'checkout.emptyPresent': 'No visitors are currently on site.',
  'checkout.checkedInAt': 'Checked in at {time}',
  'checkout.checkoutButton': 'Check out',
  'checkout.doneTitle': 'Checkout complete',
  'checkout.doneBody': 'Please travel home safely.',
  'checkout.error.notFound': 'We could not find that reception number. Please check the number and try again.',
  'checkout.error.alreadyCheckedOut': 'This reception number has already been checked out.',
  'checkout.error.invalid': 'Please enter a reception number.',
  'checkout.error.network': 'A network error occurred. Please try again.',
  'checkout.lead': 'Check out with your checkout QR code, or with the checkout code given to you at reception.',
  'checkout.tokenSectionTitle': 'Check out with QR',
  'checkout.tokenSectionHint': 'Hold up the QR code from your check-in, or paste the link.',
  'checkout.tokenLabel': 'Checkout QR / link',
  'checkout.tokenPlaceholder': 'Scan the QR or paste the link',
  'checkout.scanButton': 'Continue',
  'checkout.or': 'or',
  'checkout.codeSectionTitle': 'Check out with a code',
  'checkout.codeSectionHint': 'Enter your 4-digit checkout code and who you were visiting (department or person).',
  'checkout.codeLabel': 'Checkout code (4 digits)',
  'checkout.codePlaceholder': '0000',
  'checkout.targetLabelLabel': 'Who you were visiting (department or person)',
  'checkout.targetLabelPlaceholder': 'e.g. General Affairs',
  'checkout.resolveSubmit': 'Continue',
  'checkout.targetUnknown': 'No visit target on record',
  'checkout.purposeUnknown': 'No purpose on record',
  'checkout.back': 'Back',
  'checkout.startOver': 'Start over',
  'checkout.confirm.title': 'Confirm checkout',
  'checkout.confirm.lead': 'You are about to check out with the details below. Please confirm this is you.',
  'checkout.confirm.question': 'Are you the visitor who arrived at {time} to see {target}?',
  'checkout.confirm.timeLabel': 'Checked in at',
  'checkout.confirm.targetLabel': 'Visiting',
  'checkout.confirm.purposeLabel': 'Purpose',
  'checkout.confirm.yes': 'Yes, check me out',
  'checkout.confirm.no': 'No, go back',
  'checkout.error.expired': 'This checkout code has expired. Please ask reception for help.',
  'checkout.error.throttled': 'Too many checkout code attempts. Please wait a moment, use your checkout QR, or ask reception for help.',
  'checkout.error.notRecognized': 'We could not recognize that checkout code or visit target. Please check and try again.',
  'checkout.credential.title': 'For your checkout',
  'checkout.credential.instruction': 'When you leave, show this QR code or checkout code at the reception device.',
  'checkout.credential.codeLabel': 'Checkout code',
  'checkout.credential.expiresAt': 'Valid until {time}',
  'checkout.credential.qrAlt': 'Checkout QR code',
  'kiosk.signage.tapToStart': 'Tap the screen to start check-in',
  'kiosk.signage.presenceOn': 'Visitor detection: ON',
  'kiosk.signage.presenceOff': 'Visitor detection: OFF',
  'kiosk.signage.presenceUnavailable': 'Visitor detection: Unavailable',
  'privacy.noticeTitle': 'About your information',
  'privacy.summary':
    'The name, company, and purpose you enter are used only to notify staff and are not saved to any record.',
  'privacy.detailsShow': 'Show details',
  'privacy.detailsHide': 'Close',
  'privacy.purposeLabel': 'Purpose of use',
  'privacy.purposeText': 'Used only to call and connect you with the staff member you are visiting.',
  'privacy.storageLabel': 'Storage',
  'privacy.storageText':
    'Your name, company, and notes are not saved to reception records. They are cleared from the screen automatically once reception is complete.',
  'privacy.retentionLabel': 'Retention period',
  'privacy.retentionText':
    'Operational records such as call outcomes are kept only as long as needed; the personal details you enter are not retained.',
  'privacy.contactLabel': 'Contact',
  'privacy.contactText': 'For questions about how your information is handled, please ask the reception staff.',
  'privacy.presenceCameraLabel': 'About the visitor-detection camera',
  'privacy.presenceCameraNote':
    'The visitor-detection camera image is processed on this device only and is never saved or transmitted.',
  'reception.searchNoResultsGuidance':
    "Can't find them? Try browsing by department, or chat with the reception desk.",
  'reception.searchNoResultsChatCta': 'Chat with the reception desk',
  'reception.searchMaybeMatch': 'Did you mean',
};

const ko: LocaleDictionary = {
  'welcome.title': '환영합니다',
  'welcome.tapToStart': '화면을 터치하여 접수를 시작하세요',
  'welcome.chooseLanguage': '언어를 선택해 주세요',
  'reception.purposePrompt': '방문 목적을 선택해 주세요',
  'reception.idleReassure': '터치만으로 접수할 수 있습니다',
  'reception.purposeDetailPrompt': '방문 종류를 선택해 주세요',
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
  'reception.purpose.meeting.desc': '약속된 면회·담당자 방문',
  'reception.purpose.delivery.desc': '물품 전달·수령',
  'reception.purpose.interview.desc': '회의·미팅 방문',
  'reception.purpose.other.desc': '그 외 용무',
  'reception.proceedConfirm': '확인으로 진행',
  'reception.editInfo': '수정',
  'reception.callWithThis': '이 내용으로 호출',
  'reception.callingTitle': '호출 중…',
  'reception.callingBody': '{target}님을 호출하고 있습니다. 잠시만 기다려 주세요.',
  'reception.callingStageWaiting': '조금만 더 기다려 주세요. 담당자에게 확인하고 있습니다.',
  'reception.callingStageNotice': '연결되지 않으면 다른 방법으로 안내해 드립니다.',
  'reception.connectedBody': '{target}님이 응답했습니다. 담당자가 곧 나오니 그대로 기다려 주세요. 별도의 조작은 필요하지 않습니다.',
  'reception.finishReception': '접수 종료',
  'reception.timeoutBody': '응답이 없습니다. 다른 방법으로 호출할 수도 있습니다.',
  'reception.failedBody': '호출에 실패했습니다. 다른 방법으로 호출할 수도 있습니다.',
  'reception.altContact': '다른 연락 방법',
  'reception.staffResponseWaitReguidance': '예상 소요 시간은 몇 분입니다. 담당자가 출발하면 화면이 바뀝니다.',
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
  'reception.step.purpose': '용건',
  'reception.step.target': '대상',
  'reception.step.info': '정보',
  'reception.step.confirm': '확인',
  'reception.inactivityTitle': '아직 이용 중이신가요?',
  'reception.inactivityBody': '개인정보 보호를 위해 곧 첫 화면으로 돌아갑니다.',
  'reception.inactivityCountdown': '{seconds}초 후 초기화됩니다',
  'reception.inactivityContinue': '계속',
  'kiosk.checkoutLink': '퇴실 체크아웃',
  'checkout.title': '퇴실 체크아웃',
  'checkout.description': '접수 번호를 입력하거나 현재 재실 중인 목록에서 선택하여 퇴실해 주세요.',
  'checkout.stayIdLabel': '접수 번호',
  'checkout.submit': '퇴실하기',
  'checkout.presentListTitle': '현재 재실 중인 방문객',
  'checkout.emptyPresent': '현재 재실 중인 방문객이 없습니다.',
  'checkout.checkedInAt': '{time} 입실',
  'checkout.checkoutButton': '퇴실',
  'checkout.doneTitle': '퇴실이 접수되었습니다',
  'checkout.doneBody': '안전하게 귀가하시기 바랍니다.',
  'checkout.error.notFound': '접수 번호를 찾을 수 없습니다. 번호를 확인해 주세요.',
  'checkout.error.alreadyCheckedOut': '이 접수 번호는 이미 퇴실 처리되었습니다.',
  'checkout.error.invalid': '접수 번호를 입력해 주세요.',
  'checkout.error.network': '통신 오류가 발생했습니다. 다시 시도해 주세요.',
  'checkout.lead': '퇴실용 QR 코드 또는 접수 시 받은 퇴실 코드로 퇴실할 수 있습니다.',
  'checkout.tokenSectionTitle': 'QR로 퇴실',
  'checkout.tokenSectionHint': '체크인 시 받은 QR 코드를 대거나 링크를 붙여넣으세요.',
  'checkout.tokenLabel': '퇴실 QR / 링크',
  'checkout.tokenPlaceholder': 'QR을 스캔하거나 링크를 붙여넣기',
  'checkout.scanButton': '확인으로 진행',
  'checkout.or': '또는',
  'checkout.codeSectionTitle': '코드로 퇴실',
  'checkout.codeSectionHint': '4자리 퇴실 코드와 방문 대상(부서·담당자)을 입력하세요.',
  'checkout.codeLabel': '퇴실 코드(4자리)',
  'checkout.codePlaceholder': '0000',
  'checkout.targetLabelLabel': '방문 대상(부서·담당자)',
  'checkout.targetLabelPlaceholder': '예: 총무부',
  'checkout.resolveSubmit': '확인으로 진행',
  'checkout.targetUnknown': '방문 대상 기록 없음',
  'checkout.purposeUnknown': '용건 기록 없음',
  'checkout.back': '뒤로',
  'checkout.startOver': '처음으로',
  'checkout.confirm.title': '퇴실 확인',
  'checkout.confirm.lead': '아래 내용으로 퇴실합니다. 본인이 맞는지 확인해 주세요.',
  'checkout.confirm.question': '{time}에 {target}을(를) 방문하신 분이 맞습니까?',
  'checkout.confirm.timeLabel': '입실 시각',
  'checkout.confirm.targetLabel': '방문 대상',
  'checkout.confirm.purposeLabel': '용건',
  'checkout.confirm.yes': '네, 퇴실합니다',
  'checkout.confirm.no': '아니요, 돌아가기',
  'checkout.error.expired': '퇴실 코드의 유효 기간이 지났습니다. 접수처에 문의해 주세요.',
  'checkout.error.throttled': '퇴실 코드 시도가 많아 잠시 접수를 제한하고 있습니다. 잠시 후 다시 시도하거나 퇴실 QR을 이용하거나 접수처에 문의해 주세요.',
  'checkout.error.notRecognized': '퇴실 코드 또는 방문 대상을 확인할 수 없습니다. 다시 확인해 주세요.',
  'checkout.credential.title': '퇴실 안내',
  'checkout.credential.instruction': '나가실 때 이 QR 코드 또는 퇴실 코드를 접수 단말기에 제시해 주세요.',
  'checkout.credential.codeLabel': '퇴실 코드',
  'checkout.credential.expiresAt': '유효 기간: {time}',
  'checkout.credential.qrAlt': '퇴실용 QR 코드',
  'kiosk.signage.tapToStart': '화면을 터치하여 접수를 시작하세요',
  'kiosk.signage.presenceOn': '방문 감지: ON',
  'kiosk.signage.presenceOff': '방문 감지: OFF',
  'kiosk.signage.presenceUnavailable': '방문 감지: 사용 불가',
  'privacy.noticeTitle': '입력 정보 처리 안내',
  'privacy.summary':
    '입력하신 성함, 회사명, 용건은 담당자 호출 목적으로만 사용되며 기록에 저장되지 않습니다.',
  'privacy.detailsShow': '자세히 보기',
  'privacy.detailsHide': '닫기',
  'privacy.purposeLabel': '이용 목적',
  'privacy.purposeText': '방문하신 담당자를 호출하고 연결하는 용도로만 사용됩니다.',
  'privacy.storageLabel': '저장 여부',
  'privacy.storageText':
    '성함, 회사명, 메모는 접수 기록에 저장되지 않습니다. 접수가 완료되면 화면에서 자동으로 삭제됩니다.',
  'privacy.retentionLabel': '보관 기간',
  'privacy.retentionText':
    '호출 결과 등 운영 기록은 필요한 기간만 보관하며, 입력하신 개인정보 자체는 보관하지 않습니다.',
  'privacy.contactLabel': '문의처',
  'privacy.contactText': '정보 처리에 대해 궁금한 점은 접수 담당자에게 문의해 주세요.',
  'privacy.presenceCameraLabel': '방문자 감지 카메라 안내',
  'privacy.presenceCameraNote':
    '방문자 감지 카메라 영상은 이 단말기 내에서만 처리되며 저장하거나 전송하지 않습니다.',
  'reception.searchNoResultsGuidance': '찾으시는 분이 없나요? 부서에서 선택하거나 채팅으로 접수 담당자와 상담해 보세요.',
  'reception.searchNoResultsChatCta': '채팅으로 접수 담당자와 상담하기',
  'reception.searchMaybeMatch': '혹시 이 분인가요',
};

const zh: LocaleDictionary = {
  'welcome.title': '欢迎',
  'welcome.tapToStart': '请触摸屏幕开始登记',
  'welcome.chooseLanguage': '请选择语言',
  'reception.purposePrompt': '请选择来访事由',
  'reception.idleReassure': '仅触摸屏幕即可完成登记',
  'reception.purposeDetailPrompt': '请选择来访类型',
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
  'reception.purpose.meeting.desc': '拜访指定人员',
  'reception.purpose.delivery.desc': '收发货物',
  'reception.purpose.interview.desc': '会议·洽谈来访',
  'reception.purpose.other.desc': '其他事由',
  'reception.proceedConfirm': '继续确认',
  'reception.editInfo': '修改',
  'reception.callWithThis': '按此呼叫',
  'reception.callingTitle': '正在呼叫…',
  'reception.callingBody': '正在呼叫 {target}，请稍候。',
  'reception.callingStageWaiting': '请再稍候片刻，我们正在与负责人确认。',
  'reception.callingStageNotice': '如果无法接通，我们将为您提供其他方式。',
  'reception.connectedBody': '{target} 已应答，工作人员即将前来，请在此稍候。无需任何操作。',
  'reception.finishReception': '结束登记',
  'reception.timeoutBody': '无人应答。我们可以用其他方式联系。',
  'reception.failedBody': '呼叫失败。我们可以用其他方式联系。',
  'reception.altContact': '其他联系方式',
  'reception.staffResponseWaitReguidance': '预计需要几分钟。负责人出发后，本画面将自动更新。',
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
  'reception.step.purpose': '事由',
  'reception.step.target': '对象',
  'reception.step.info': '信息',
  'reception.step.confirm': '确认',
  'reception.inactivityTitle': '您还在吗？',
  'reception.inactivityBody': '为保护隐私，即将返回首页。',
  'reception.inactivityCountdown': '{seconds} 秒后重置',
  'reception.inactivityContinue': '继续',
  'kiosk.checkoutLink': '退馆结账',
  'checkout.title': '退馆结账',
  'checkout.description': '请输入受理编号，或从在馆访客列表中选择后退馆。',
  'checkout.stayIdLabel': '受理编号',
  'checkout.submit': '办理退馆',
  'checkout.presentListTitle': '在馆访客',
  'checkout.emptyPresent': '目前没有在馆访客。',
  'checkout.checkedInAt': '{time} 入馆',
  'checkout.checkoutButton': '退馆',
  'checkout.doneTitle': '退馆登记已完成',
  'checkout.doneBody': '请注意安全，一路顺风。',
  'checkout.error.notFound': '未找到该受理编号，请确认后重试。',
  'checkout.error.alreadyCheckedOut': '该受理编号已办理退馆。',
  'checkout.error.invalid': '请输入受理编号。',
  'checkout.error.network': '发生网络错误，请重试。',
  'checkout.lead': '可使用退馆二维码，或使用登记时提供的退馆码办理退馆。',
  'checkout.tokenSectionTitle': '扫码退馆',
  'checkout.tokenSectionHint': '出示登记时的二维码，或粘贴链接。',
  'checkout.tokenLabel': '退馆二维码 / 链接',
  'checkout.tokenPlaceholder': '扫描二维码或粘贴链接',
  'checkout.scanButton': '继续确认',
  'checkout.or': '或',
  'checkout.codeSectionTitle': '用退馆码退馆',
  'checkout.codeSectionHint': '请输入 4 位退馆码，以及您要拜访的对象（部门·负责人）。',
  'checkout.codeLabel': '退馆码（4 位）',
  'checkout.codePlaceholder': '0000',
  'checkout.targetLabelLabel': '拜访对象（部门·负责人）',
  'checkout.targetLabelPlaceholder': '例：总务部',
  'checkout.resolveSubmit': '继续确认',
  'checkout.targetUnknown': '无拜访对象记录',
  'checkout.purposeUnknown': '无事由记录',
  'checkout.back': '返回',
  'checkout.startOver': '回到开始',
  'checkout.confirm.title': '确认退馆',
  'checkout.confirm.lead': '将按以下信息办理退馆，请确认是否为本人。',
  'checkout.confirm.question': '您是否为 {time} 到访 {target} 的访客？',
  'checkout.confirm.timeLabel': '入馆时间',
  'checkout.confirm.targetLabel': '拜访对象',
  'checkout.confirm.purposeLabel': '事由',
  'checkout.confirm.yes': '是，办理退馆',
  'checkout.confirm.no': '否，返回',
  'checkout.error.expired': '退馆码已过期，请联系前台。',
  'checkout.error.throttled': '退馆码尝试次数过多，暂时限制受理。请稍后再试，或使用退馆二维码，或联系前台。',
  'checkout.error.notRecognized': '无法识别该退馆码或拜访对象，请确认后重试。',
  'checkout.credential.title': '退馆指引',
  'checkout.credential.instruction': '离开时，请在接待终端出示此二维码或退馆码。',
  'checkout.credential.codeLabel': '退馆码',
  'checkout.credential.expiresAt': '有效期至 {time}',
  'checkout.credential.qrAlt': '退馆二维码',
  'kiosk.signage.tapToStart': '请触摸屏幕开始登记',
  'kiosk.signage.presenceOn': '访客检测：开启',
  'kiosk.signage.presenceOff': '访客检测：关闭',
  'kiosk.signage.presenceUnavailable': '访客检测：不可用',
  'privacy.noticeTitle': '关于输入信息的处理',
  'privacy.summary': '您输入的姓名、公司名称和来访事由仅用于通知接待人员，不会保存到记录中。',
  'privacy.detailsShow': '查看详情',
  'privacy.detailsHide': '关闭',
  'privacy.purposeLabel': '使用目的',
  'privacy.purposeText': '仅用于呼叫并转接您要访问的负责人。',
  'privacy.storageLabel': '是否保存',
  'privacy.storageText': '姓名、公司名称和备注不会保存到接待记录中。登记完成后将自动从屏幕上清除。',
  'privacy.retentionLabel': '保存期限',
  'privacy.retentionText': '呼叫结果等运营记录仅保留必要期限，您输入的个人信息本身不会被保留。',
  'privacy.contactLabel': '咨询方式',
  'privacy.contactText': '如对信息处理方式有疑问，请咨询前台工作人员。',
  'privacy.presenceCameraLabel': '关于访客检测摄像头',
  'privacy.presenceCameraNote': '访客检测摄像头的画面仅在本设备内处理，不会保存或发送。',
  'reception.searchNoResultsGuidance': '找不到对方？可以从部门中选择，或通过聊天与前台工作人员咨询。',
  'reception.searchNoResultsChatCta': '通过聊天咨询前台工作人员',
  'reception.searchMaybeMatch': '是否是这位',
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
