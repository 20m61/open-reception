# aituber-kit v1 UI 参考調査

> 目的: 受付キオスクの UI/UX（VRM アバター・リップシンク・会話 UI・音声統合・設定/キャラ切替）を
> 磨くうえで [tegnike/aituber-kit](https://github.com/tegnike/aituber-kit) の **MIT ライセンス期（v1 系）**
> を **設計・UX パターンの参考**として調べた記録。
>
> **方針（重要）**: aituber-kit は「あくまで参考」。コードの移植・流用は前提にしない。本レポートの
> 適用提案は原則すべて「**考え方だけ参考にする（自前実装での再構成）**」として書く。特に価値が大きい
> 場合のみ参考実装の要点を引用に留める。
>
> 調査日: 2026-07-22 / 調査手段: 公開 GitHub ページ・raw ソース・docs（WebFetch）。

---

## 1. ライセンス確認結果（事実確認）

**結論: v1 系（`v1.0.0` 〜 `v1.44.1`）は MIT ライセンス。`v2.0.0` から独自（商用有償）ライセンスへ変更。**
したがって参照してよいのは **`v1.0.0`〜`v1.44.1` のタグのソースのみ**。main / `v2.0.0` 以降は独自
ライセンスのため参照しない（本調査でも見ていない）。

| 項目 | 内容 | 確認方法 |
| --- | --- | --- |
| MIT 期のタグ範囲 | `v1.0.0` 〜 **`v1.44.1`**（v1 系の最終） | GitHub tags API（`/repos/tegnike/aituber-kit/tags`）で v1 最終 = `v1.44.1`、次メジャー = `v2.0.0` を確認 |
| 独自ライセンス開始 | **`v2.0.0`** から | `docs/license.md`（main）に「v1.x.x は MIT、v2.0.0 以降は独自ライセンス」と明記 |
| v1 LICENSE 本文 | **MIT License**、`Copyright (c) 2023 pixiv Inc.` | `raw.githubusercontent.com/tegnike/aituber-kit/v1.0.0/LICENSE` および `v1.10.0/LICENSE` を実取得し MIT 本文（"Permission is hereby granted, free of charge..."）と著作権表記を確認 |

補足:
- 著作権者が **pixiv Inc.**（tegnike 個人ではない）なのは、aituber-kit v1 が pixiv の
  **ChatVRM**（MIT）から派生しているため。v1 の VRM/表情/リップシンク周りは ChatVRM 由来の設計を
  引き継いでいる。→ 「元ネタは十分枯れた MIT の VRM チャット基盤」であり、設計参考として素性が良い。
- v2 の独自ライセンスは個人/教育/非営利/展示デモは無償だが**商用は有償**（Standard ¥100,000 〜
  Enterprise ¥1,000,000）、かつ Live2D 機能の商用利用は別途制限。**open-reception は受付端末＝商用文脈に
  なり得る**ため、v2 以降のコード/資産は参照も流用もしない、という線引きが安全。
- 本レポートは設計参考に留め、コード移植をしない方針のため、ライセンス上の帰属義務は発生しない
  （§4 参照）。ただし v1 が MIT である事実自体が「万一 UX 文言/構造が酷似しても法的リスクが小さい」
  という安心材料になる。

---

## 2. v1 アーキテクチャ要約（MIT 範囲のソースのみ・`v1.10.0` を代表に確認）

v1 は ChatVRM 由来の feature 分割。関連ディレクトリ: `src/features/{vrmViewer, emoteController,
lipSync, messages, chat, googletts, koeiromap, youtube}` と `src/components/`。受付に効く 5 点を要約する。

### 2.1 VRM アバター表示（`features/vrmViewer`, `@pixiv/three-vrm`）
- `viewer.ts`（three シーン/カメラ/ライト/レンダーループの寿命管理）＋ `model.ts`（VRM ロード・
  `expressionManager` 保持・`speak()` の窓口）＋ `vrmViewer.tsx`（React ラッパ、canvas マウント）
  の 3 層構成。**「シーン管理」「モデル」「React 結線」を分離**しているのが要点。
- レンダーループ内で毎フレーム `emoteController.update(delta)` → `vrm.update(delta)` を呼ぶ。
- → open-reception の `VrmAvatarViewer.tsx` は既にこの 3 責務を 1 ファイルに畳んで持っており
  （シーン/カメラ/ライト/ロード/mixer/レンダーループ + fallback）、**設計思想は概ね一致**。

### 2.2 リップシンク（`features/lipSync/lipSync.ts`）— v1 の最大の差分
- **実音声波形ベース**。`AudioContext` に `AnalyserNode` を繋ぎ、再生中の音声を
  `getFloatTimeDomainData()` で取得 → 2048 サンプルの**最大振幅**を取り、シグモイド
  `volume = 1/(1+exp(-45*v+5))`（`<0.1` は 0 に丸め）で 0..1 の口開き量へ変換。これを VRM 口形素へ流す。
- 音声は `ArrayBuffer` を `decodeAudioData` → `BufferSource` を `destination` と `analyser` の
  **両方**に接続して再生（＝聞こえる音とリップシンク解析が同一ソース）。
- **open-reception との本質的な違い**: 当リポジトリは Web Speech API の `SpeechSynthesis` を使うため
  波形が取れず、`avatar/lip-sync.ts` が**経過時間の合成 sine で口を開閉する時間ベース疑似リップシンク**。
  v1 は「実音声の振幅で駆動」。→ **将来 TTS を実音声（ArrayBuffer 返す TTS）に寄せる場合、この
  AnalyserNode 方式の"考え方"が有効**（§3-A）。

### 2.3 発話キューと screenplay（`features/messages/speakCharacter.ts`）
- **発話の直列化**を Promise チェーンで実現: `prevFetchPromise`（音声合成の取得）と
  `prevSpeakPromise`（再生）を分け、fetch は先読みしつつ **再生は 1 つずつ順番**に行う。API 叩き過ぎ
  防止に最小 1 秒間隔。
- 「発話単位」を **`screenplay`**（`{ expression, talk }` 相当。表情 + セリフ）としてまとめ、
  `viewer.model.speak(audioBuffer, screenplay)` で**表情切替とリップシンクと音声再生を 1 単位に束ねる**。
- → open-reception は screenState → guidance（`avatar/guidance.ts`）で「表情 + 発話文 + 字幕」を
  既に 1 単位化しており、**思想は一致**。ただし v1 の「fetch と play を分離して直列再生」する
  キュー分離は、複数発話を続ける局面（例: 呼び出し中の段階的アナウンス #323）で参考になる。

### 2.4 表情・所作の合成（`features/emoteController/expressionController.ts`）
- 毎フレーム `update(delta)` で **auto-blink（自動まばたき）→ auto-lookAt（自動視線）→ emotion（感情
  preset）→ lipSync（口形素）** を順に適用。
- **競合回避の工夫**: 感情が `neutral` のときは口形素の重みを 50%、感情が付いている（happy 等）ときは
  25% に落として**表情と口パクを両立**。また**非 neutral 感情中は auto-blink を抑制**して破綻を防ぐ。
- → open-reception は `emotionExpressionValues()`（感情 preset）と `mouthOpenValue()`（`aa` 口形素）を
  **別チャンネルで共存**させており（`VrmAvatarViewer` 内 `setValue('aa', ...)`）、思想は一致。ただし
  **「感情の強さでリップシンク重みを可変」「感情中はまばたき抑制」という破綻回避のノウハウは未導入**。
  現状は auto-blink / auto-lookAt そのものが未実装（視線は #65 で接続予定）。

### 2.5 会話入力 UI と話中インジケータ（`src/components/messageInputContainer.tsx`）
- Web Speech API の `SpeechRecognition`（webkit フォールバック）で音声入力。`interimResults=true` で
  **途中経過を逐次表示**、`continuous=false` で発話終了で自動停止。
- **マイクボタン**トグル + `isMicRecording` 真偽値を**録音/傾聴インジケータ**として `MessageInput` に渡し、
  録音中の視覚フィードバック（点滅等）を出す。`isFinal` で**自動送信**（手動確定不要）。
  `isChatProcessing` 中は入力欄を無効化。
- → open-reception は STT を `stt-adapter.ts` に抽象化済みで、音声 UI は `VoiceReadbackConfirm.tsx`
  （字幕 `aria-live` + 復唱 yes/no + タッチ縮退）として**受付専用に再設計済み**。v1 の「マイクボタン +
  isRecording インジケータ + interim 逐次表示」という**個々の UI 部品の考え方**は、
  `VoiceSessionLayer` に「聞き取り中インジケータ」を足す際の参考になる（§3-C）。

### 2.6 設定画面・キャラ切替 UX（`src/components/settings.tsx` / `menu.tsx`）
- 全設定（API キー、TTS バックエンド選択、VRM 差替、system prompt 等）を 1 つの設定モーダルに集約。
  VRM は**ファイル選択で即差し替え**、背景画像も同様。キャラの人格は system prompt テキストで規定。
- → open-reception は「来訪者は設定に触れない／設定は admin 側」という受付端末の要件があるため、
  v1 のような**端末上の露出した設定モーダルはそのまま不適合**。ただし「VRM / 背景 / 人格文言を
  データとして差し替え可能にし、コードから分離する」という**構成の考え方**は、テナント別キャラ設定
  （admin 側 #27/#31 系）の参考になる。

---

## 3. open-reception への適用提案（主軸=「考え方だけ参考」・優先度付き）

分類は原則 **「考え方だけ参考（自前実装で再構成）」**。「不適合」も明示する。コード移植は提案しない。

| # | 提案 | 分類 | 優先度 | 対象 issue | 依存追加 |
| --- | --- | --- | --- | --- | --- |
| A | 実音声 TTS 化した場合の **AnalyserNode 振幅駆動リップシンク**（考え方） | 考え方だけ参考 | 中（TTS 方針次第） | #5, #31, voice-tts 層 | 無（Web Audio 標準）※ #105 不要 |
| B | **感情強度でリップシンク重みを可変 + 感情中はまばたき抑制** の破綻回避ノウハウ | 考え方だけ参考 | 中 | #31, #65 | 無 |
| C | **聞き取り中インジケータ + interim 逐次字幕** を音声レイヤに追加 | 考え方だけ参考 | 中〜高 | #361, #364, voice-session 層 | 無 |
| D | **発話キューの fetch/play 分離・直列再生**（段階アナウンス向け） | 考え方だけ参考 | 低〜中 | #323, speech.ts | 無 |
| E | **auto-blink / auto-lookAt** の常時微動で「生きている」感を出す | 考え方だけ参考 | 低 | #31, #65 | 無 |
| F | 端末上の露出した設定モーダル（v1 settings.tsx 相当） | **不適合** | — | — | — |
| G | 音声/背景合成やキャラ人格を system prompt 一枚で規定する運用 | 考え方だけ参考（限定） | 低 | admin #27/#31 | 無 |

### A. AnalyserNode 振幅駆動リップシンク（考え方だけ参考）
- **現状**: `avatar/lip-sync.ts` は `SpeechSynthesis` 前提の**時間ベース合成 sine**。音声波形が無いので
  「実際にしゃべっている音」と口の動きが一致しない。
- **v1 の考え方**: 再生音を `AnalyserNode` に通し**最大振幅→シグモイド**で 0..1 化して口形素へ。
- **open-reception への再構成案**: voice-tts 層が**実音声（ArrayBuffer/Blob）を返す構成に寄せる**場合に
  限り、`Web Audio API`（`AudioContext`+`AnalyserNode`、いずれもブラウザ標準・依存追加なし）で振幅を
  取り、`VrmAvatarViewer` の `speaking` 経路を「実振幅」に差し替える。**現行の時間ベース疑似は
  SpeechSynthesis フォールバック用に残す**（音声が波形を出せない経路の保険）。純関数
  `mouthOpenValue(elapsed, speaking)` の隣に `mouthOpenFromAmplitude(volume)` を足す形が自然。
- **注意**: TTS を実音声化するか自体が方針判断（コスト/レイテンシ/オフライン）。#65 実機前提。
  Web Audio は標準 API のため **#105 ライセンスチェックは不要**。

### B. 感情強度でリップシンク重み可変 + まばたき抑制（考え方だけ参考）
- **v1 の考え方**: emotion=neutral で口形素 50%、感情付きで 25%、非 neutral 中は auto-blink 抑制。
  「感情表現と口パクの奪い合い」を重み配分で解く枯れたノウハウ。
- **再構成案**: `VrmAvatarViewer` のレンダーループで `mouthOpenValue(...)` に**感情に応じた係数**を掛ける
  （`emotion !== 'neutral'` のとき低め）。まばたきを実装するなら感情中は間引く。純データ化して
  `avatar/lip-sync.ts` or `vrm-expression.ts` にテスト付きで置ける。依存追加なし。

### C. 聞き取り中インジケータ + interim 逐次字幕（考え方だけ参考・優先度高め）
- **v1 の考え方**: `isMicRecording` を単一の真偽で持ち回り録音中フィードバック、`interimResults` で
  確定前テキストを逐次表示、`isFinal` で自動送信。
- **再構成案**: `VoiceReadbackConfirm` / `VoiceSessionLayer` に **「聞き取り中」状態の視覚表示**
  （波紋/点滅 + `aria-live` の「お話しください」）を足す。interim テキストは**確定前は PII 保持しない
  一時表示**として `data-voice-mode` の購読点に載せる（`.claude/rules/pii-secret-minimization.md`:
  interim は eval/ログへ出さない）。受付では v1 の「自動送信」は**復唱確認を必ず挟む不変条件**
  （ui-contract の REQUIRES_CONFIRMATION）と衝突するので**採らない**——インジケータと逐次表示の
  "見せ方"だけ参考にする。

### D. 発話キューの fetch/play 分離・直列再生（考え方だけ参考）
- **v1 の考え方**: 音声取得（先読み可）と再生（1 つずつ）を別 Promise チェーンで直列化。
- **再構成案**: 呼び出し中の**段階的アナウンス**（#323 の guidanceOverride で字幕を差し替える局面）で、
  複数発話が重ならないよう `speech.ts` 側に軽い直列キューを設ける発想の参考。現行は 1 発話単位なので
  優先度低。依存追加なし。

### E. auto-blink / auto-lookAt（考え方だけ参考・低優先）
- **v1 の考え方**: 待機中も自動まばたき・自動視線で「生きている」印象を維持。
- **再構成案**: `vrm-pose.ts` の手続き的ポーズと同様、**時間ベースの微動**として純関数化し
  レンダーループで適用。視線は ui-contract の `gazeTarget`（既に定義済み・実適用は #65）と接続。

### F. 端末上の設定モーダル（不適合）
- 受付端末は来訪者に設定を露出しない。v1 の settings.tsx 構成は open-reception の要件と**不適合**。
  設定は admin SPA 側に既に分離済み。

### G. キャラ人格/アセットのデータ分離（限定的に考え方参考）
- v1 が VRM/背景/人格文言をコードから分離してデータ差し替え可能にしている点は、**テナント別キャラ**
  （admin #27/#31）の構成参考になり得る。ただし人格を system prompt 一枚に集約する v1 流儀は、
  受付の「許可済みアクションに限定」（ui-contract）方針と両立させる形に**再設計**が要る。

---

## 4. 参照した旨の記録（帰属について）

- 本調査は **設計・UX パターンの参考のみ**で、aituber-kit v1 の**コード/資産は移植・流用しない**方針。
  そのため MIT ライセンス上の**帰属表示義務は発生しない**（帰属は「その copy を配布する」場合の要件）。
- 記録として: 「受付 UI の VRM/リップシンク/音声統合の設計検討にあたり、pixiv Inc. の ChatVRM 派生で
  **MIT ライセンス**の tegnike/aituber-kit の **v1 系（v1.0.0〜v1.44.1）** を設計参考として参照した」旨を
  本ドキュメントに残す。→ もし将来**方針転換してコードを移植**する場合は、その時点で #105
  （ライセンス/プライバシーチェック）を通し、`docs/license-privacy-guide.md` に沿って **v1 の LICENSE 本文
  （MIT / Copyright (c) 2023 pixiv Inc.）を NOTICE として転記**すること（本レポート単独では帰属要件は未発生）。

---

## 5. 次 wave への増分提案（2〜3 件）

1. **[C] 聞き取り中インジケータ + interim 逐次字幕（#361/#364・voice-session 層）** — 依存追加なし・
   受付体験の"待たせ感"改善に直結。復唱確認の不変条件は維持しつつ「見せ方」だけ足す小さな増分。
   まず `VoiceSessionLayer` に `listening` 表示を追加する 1 周回。
2. **[B] リップシンク重みの感情連動 + まばたき抑制（#31）** — 純関数 + テストで閉じる小増分。
   実描画確認は #65 に積むが、ロジックは headless でテスト可能。破綻回避ノウハウを先に入れておく。
3. **[A] 実音声 TTS 化の是非を設計判断する brainstorming（#5・voice-tts）** — 「時間ベース疑似のまま
   洗練させる」か「実音声＋AnalyserNode 駆動へ寄せる」かの分岐を、コスト/レイテンシ/オフライン/#65
   実機前提と併せて 1 度整理する（`writing-plans`）。実装より先に方針を固める増分。

> 参考にしたソース（すべて MIT 期・v1 タグ）: `v1.10.0/src/features/lipSync/lipSync.ts` /
> `.../messages/speakCharacter.ts` / `.../emoteController/expressionController.ts` /
> `src/components/messageInputContainer.tsx`、`v1.0.0`・`v1.10.0` の `LICENSE`、main の `docs/license.md`。
