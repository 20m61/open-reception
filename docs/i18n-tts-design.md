# 多言語 UI / TTS 受付 設計 (issue #103)

受付端末 `/kiosk` と管理画面の一部文言を多言語化し、来訪者が日本語以外でも受付を
進められるようにするための設計。MVP では **UI 文言と TTS の多言語化**を優先し、
音声認識（STT）の多言語化は後続検討とする（#103 非スコープ）。

関連: 親 #96 / ライセンス・プライバシー #105 / 既存音声設計 #28・#34。

## 0. increment と非破壊方針

- **increment 1（本 PR）= 基盤新設のみ**:
  - i18n 基盤 `src/lib/i18n/**`（locale 型・辞書・`t()` 純関数・既定フォールバック）。
  - 言語切替 `src/components/kiosk/LanguageSwitcher.tsx`（スタンドアロン）と適用例
    `LocalizedWelcome.tsx`。**KioskFlow へは組み込まない**（配線は次増分）。
  - 多言語 TTS 選択 `src/lib/voice/locale-voice.ts` + `VoiceSettings.localeVoices`（任意）。
  - 言語設定 `src/app/admin/languages/**` + `/api/admin/languages`（有効/既定言語）。
- **increment 2 以降 = 配線・移行**:
  - KioskFlow への言語選択導入、既存全文言の `t()` 置換（§全文言移行計画）。
  - kiosk voice 再生経路への `resolveLocaleVoice` 配線、Polly voiceId の locale 別設定。
  - Playwright での主要言語 smoke / iPad viewport 表示崩れ確認。

既存ファイル（KioskFlow / kiosk page・layout / 受付ログ / AI 案内）は本増分で改変しない。

## 1. 対応言語

| 優先 | locale | 自言語ラベル | TTS 言語コード（既定） |
| ---- | ------ | ------------ | ---------------------- |
| 1    | `ja`   | 日本語       | `ja-JP`                |
| 2    | `en`   | English      | `en-US`                |
| 3    | `ko`   | 한국어       | `ko-KR`                |
| 4    | `zh`   | 中文         | `cmn-CN`               |

- 既定 locale は **`ja`**。未対応・未設定の locale は既定へフォールバックする
  （`normalizeLocale` / `t()`）。
- locale は ISO 639-1 の primary subtag を採用（`ja-JP` → `ja`、`zh-Hans` → `zh`）。
  地域・文字種の細分化は現時点で行わない（中国語は簡体を初期既定とする）。
- 自言語ラベルは翻訳に依存しない固定値（`LOCALE_NATIVE_LABEL`）。読めない言語でも
  自分の言語を選べるようにするため（#103 UX 方針）。

## 2. 辞書方針

- **キー命名**: `<画面>.<要素>` のドット区切り（例 `welcome.title` / `reception.confirm`）。
- **正の言語**: 既定 locale (`ja`) が全キーを網羅する（型 `Record<MessageKey, string>` で
  欠落をコンパイルエラーにする）。他 locale は `Partial` 可で、欠落キーは `t()` が `ja` へ
  フォールバックする。これにより**翻訳途中でも UI が壊れない**。
- **inc1 の収録範囲**: kiosk 受付の主要文言サブセット（welcome / 用件選択 / 確認 / 呼出
  待機 / 完了 / 音声 fallback / 共通ボタン）。既存の全文言は次増分で移行する。
- **PII / 内部情報を埋め込まない**（#103 セキュリティ）。文言は静的定数で、来訪者名や
  社内情報を辞書に入れない。動的値は将来パラメータ補間で扱う（inc1 では未導入）。

### `t()` のフォールバック順

1. 指定 locale の辞書に key があればそれを返す。
2. 無ければ既定 locale (`ja`) の辞書（全キー網羅）を返す。
3. （型上は到達しない）既定にも無ければ key 文字列をそのまま返す。

## 3. TTS 言語選択

- `resolveLocaleVoice(settings, locale)` が UI locale から **TTS 言語コード・voiceId・
  話速・音量**を導出する純関数。
- 解決順:
  1. `VoiceSettings.localeVoices[locale]` の上書き（`languageCode` / `voiceId`）。
  2. 無ければ `LOCALE_LANGUAGE_CODE[locale]`、`voiceId` は空（再生側が lang から既定選択）。
  3. locale が対応外なら既定 locale (`ja`) へフォールバック。
- `localeVoices` は **任意フィールド**（後方互換）。未設定運用では従来どおり単一言語で動く。
- **TTS 失敗時もテキストで完走**: 既存 `voice-store` の `fallbackText`（多言語化は次増分）
  と画面文言で受付を完走できる。音声は常に補助。
- Polly 実装は `src/server/notification/polly-adapter.ts`（`languageCode` / `voiceId` /
  `engine` を受ける）。locale → voiceId の具体マッピングは運用設定（`localeVoices`）で持ち、
  コードにハードコードしない。

## 4. 言語設定（管理画面）

- `GET/PUT /api/admin/languages`：有効言語（`enabledLocales`）と既定言語
  （`defaultLocale`）の単一設定（voice 設定と同じ singleton backend に永続化）。
- 認可: `requireActor`（`resolveAdminActor`）で管理セッション必須。未認証は 401。
- 監査: 既存 `voice.updated`（i18n/voice 隣接）を再利用し PII なしで記録
  （新規 `AuditAction` 追加は `src/domain/reception/log.ts` 編集が必要なため本増分外）。
- 不変条件は `sanitizeLanguageSettings` 純関数で最終補正：対応外除外・重複排除・
  空集合は既定のみ・`defaultLocale` は `enabledLocales` 内へ補正。

## 5. ナビゲーション配線（intended・本増分では未配線）

- `/admin/languages` ページと `LanguageSettingsManager` は新設済みだが、
  **`src/components/admin/navigation.ts` への nav 登録は本増分で行わない**（配線は
  オーケストレータ）。intended 位置: 管理画面ナビの「音声設定」(`/admin/voice`) の
  近傍（音声・受付体験グループ）に「言語設定」(`/admin/languages`) を追加する。

## 6. 全文言移行計画（increment 2 以降）

既存 kiosk 文言を `t()` へ段階移行する。現状ハードコード文言の在り処と対応キーの対照：

| 既存箇所（参考） | 内容 | 対応キー（inc1 で用意済み） |
| ---------------- | ---- | --------------------------- |
| `voice-store` `guidanceIdle` 既定 | 待機案内 | `welcome.tapToStart` 相当 |
| `voice-store` `guidanceConfirm` 既定 | 確認案内 | `reception.confirm` |
| `voice-store` `fallbackText` 既定 | 音声不可案内 | `voice.fallbackNotice` |
| `KioskFlow` 用件選択 | 用件ボタン | `reception.appointment` / `delivery` / `other` |
| `KioskFlow` 呼出/待機/完了 | 状態表示 | `reception.calling` / `waitMessage` / `thanks` |
| 共通ボタン | 次へ/戻る/キャンセル | `common.next` / `reception.back` / `common.cancel` |

移行手順（増分ごと）:
1. KioskFlow に locale state を導入（言語選択 → 受付状態機械が保持）。
2. 画面単位でハードコード文言を `tr('...')` へ置換し、不足キーを辞書へ追加。
3. TTS 案内文言を locale 別に持てるよう `voice-store` を拡張（`guidance*` の多言語化）。
4. Playwright で ja/en/ko/zh の主要画面 smoke と iPad viewport 表示崩れを確認。

## 6b. locale 網羅の機械検証（#327・スコープ決定）

`docs/ui-review-2026-07-11.md` H2（English モードに退館チェックアウトの日本語が残存、
`/kiosk/checkout` が locale 非連動）への対応として、**#327 で以下を追加した**:

- **辞書は既に ja/en/ko/zh 全キーを完全網羅していた**（inc1 時点の「他 locale はサブセット可・
  `t()` が ja へフォールバック」という設計は型上は維持しつつ、運用上は #327 時点で実際には
  すでに全キー・全 locale が翻訳済みだった）。そのため #327 では **一部キーだけを対象にした
  部分的な網羅チェックではなく、`MessageKey` 全キー × `SUPPORTED_LOCALES` 全 locale の
  完全一致**を `src/lib/i18n/i18n.test.ts`（`describe('locale 網羅の機械検証 (#327)')`）で
  強制する運用に切り替えた。新規キー追加時は **ja/en/ko/zh 全てへの追記が必須**になり、
  1 つでも欠けるとローカル品質ゲート（unit）が FAIL する。
- **CJK 生リテラルの検出**（`scripts/check-cjk-literals.ts` + `src/lib/i18n/cjk-literal.test.ts`）:
  TypeScript AST を解析し、文字列/テンプレートリテラル/JSX テキストに含まれる CJK
  （ひらがな・カタカナ・CJK 統合漢字・ハングル）を検出する。日本語コメントは対象外。
  `src/components/kiosk/checkout/**` は例外なしで完全検証、他の未移行 kiosk コンポーネントは
  `CJK_EXCEPTION_ALLOWLIST`（ファイル単位）で明示的に除外し、ゲートを green に保ちつつ
  **新規ファイル・checkout 配下の新規リテラルは即座に検出**される。allowlist 済みファイル
  内への追加リテラルまでは検出しない（ファイル単位のため）。行単位 diff ベースの検出強化は
  残りの kiosk 画面棚卸し（follow-up）と合わせて再検討する。
- **待機画面の CheckoutLink**（`KioskFlow.tsx`）と `/kiosk/checkout`（`CheckoutFlow.tsx`）を
  i18n 化し、選択中 locale を `?locale=` クエリで橋渡しする（ページを跨ぐため React state
  ではなくクエリで locale を引き継ぐ）。`/kiosk/checkout` へ直接来た場合用に
  `LanguageSwitcher` も設置した。

## 7. ライセンス・権利・プライバシー (#105)

`docs/license-privacy-guide.md` の観点を本機能に適用する。

- **翻訳文言**: すべて本プロジェクトの内製表現。競合 SaaS の UI / 文言を**コピーしない**。
  外部翻訳 API（機械翻訳）を採用する場合は、(1) 入力テキストの送信内容に PII を含めない、
  (2) 出力訳文の商用利用・再配布可否を利用規約で確認、(3) 訳文の権利帰属を確認、を
  判断ログに記録する。inc1 では外部翻訳 API を使用していない（人手内製）。
- **TTS（音声モデル）**: Polly 等の voiceId / 言語コードは利用規約・商用プラン条件を
  採用時に確認する。生成音声の利用範囲（無人受付端末での常時再生）が許可されることを
  確認する。録音・保存はしない（音声は再生のみ、PII を保持しない）。
- **辞書データ**: 外部から取得した翻訳辞書・用語集は使用しない（採用する場合は
  ライセンス確認が必要）。
- **個人情報**: 辞書・言語設定・TTS 選択ロジックいずれも来訪者 PII を保持しない。
  言語設定の監査ログにも PII を含めない。
- **秘密情報**: 言語設定 API はフロントに secret を露出しない（設定値は公開可能な
  言語コードのみ）。
