# ADR 0002: TTS 音声キャッシュの境界（S3 → CloudFront → Service Worker → IndexedDB）

- ステータス: 承認（設計のみ。実配線は #65 実機 UAT・実 AWS 環境が要る）。
- 関連: issue #371（本 ADR の対象）、#365（評価ハーネス）、#369（Transport, ADR 0001）、
  #65（実機 UAT）
- 関連ドキュメント: `docs/voice-evaluation-harness.md`、`docs/adr/0001-voice-transport.md`

## 背景

Polly Neural を初期 provider として、定型音声（挨拶・案内文）はできる限り**ネットワーク生成なし**
で低遅延に再生したい（issue #371 AC）。一方で動的音声（担当者名・部門名を含む案内）は都度生成が
必要で、キャッシュヒット率がそもそも低い。境界を 1 層に決め打ちすると、定型文の配信最適化（CDN
キャッシュ）と動的文の即時性（生成後すぐ再生）を両立できない。

## 決定

### 1. キャッシュキーは `locale + voice + engine + rate + speechText + lexiconVersion`

issue #371 契約どおり。`src/domain/voice-tts/types.ts` の `buildTtsCacheKey` が構造的な衝突
（フィールド境界のずれによる誤った一致）を防ぐ形で実装する（長さプレフィックス方式）。

`speechText`（発音用テキスト）をキーに使う ── `displayText`（表示用、人名の漢字表記等）は
キーに含めない。同じ発音になる表示のゆらぎ（敬称の有無等）を意図せずキャッシュミスさせないため。

### 2. 4 層構成、各層は同じキー文字列をそのまま使う

```
[事前生成ジョブ]  定型文一覧 (cache.ts の CANNED_UTTERANCE_SEMANTIC_KEYS) × voice 設定
        │  cacheKey を鍵に Polly SynthesizeSpeech を実行（実装は #65 外部待ち）
        ▼
S3 (origin)          鍵 = cacheKey のハッシュ（S3 キー長制限のため。生 cacheKey はメタデータで保持）
        │  音声バイト列 + Speech Marks（viseme タイムライン, viseme.ts の TtsSpeechMark 形）
        ▼
CloudFront (edge)    S3 を origin にした CDN。Cache-Control は音声（不変コンテンツ）に対し長寿命。
        │  lexiconVersion がキーに含まれるため、辞書更新時は自動的に別キー = 別 URL になり、
        │  CDN 側の明示的invalidateが不要（キャッシュキー自体がバージョニングを兼ねる）。
        ▼
Service Worker (端末) iPad PWA 側。定型文一覧（事前生成対象）を起動時に先読みし、オフライン/
        │  低速回線でも定型応答だけは即時再生できるようにする。
        ▼
IndexedDB (端末メタデータ) どの cacheKey を SW キャッシュ済みか・lexiconVersion 突合・
                          事前生成一覧のバージョンを端末側で保持する。
```

動的文（担当者名等）は S3/CloudFront を経由する事前生成の対象外 ── 生成都度 S3 へも書き込み、
以後同じ動的テキストが再度要求されたときだけ CDN 経由で再利用される（同名の担当者が繰り返し
呼ばれるケースはある）。

### 3. この increment（#371）の実装範囲

**やったこと（ローカルで mock/メモリ検証済み）**:
- `TtsCache` interface（`src/domain/voice-tts/types.ts`）── 4 層のどの実装でも満たせる境界。
- `InMemoryTtsCache`（`src/lib/voice-tts/cache-store.ts`）── プロセス内メモリのみの暫定実装。
  `TtsSynthesisService`（`synthesis-service.ts`）がこの interface だけを見て動くことを保証し、
  実装差し替え（S3/CloudFront/Service Worker/IndexedDB）時にサービス側の変更が不要という設計を
  検証済み。
- 定型発話一覧と事前生成ジョブの**定義**（`src/domain/voice-tts/cache.ts` の
  `CANNED_UTTERANCE_SEMANTIC_KEYS` / `buildPregenerationJob`）── ジョブの記述のみで実行しない。

**やっていないこと（次 increment / #65 スコープ）**:
- 実 S3 バケット・CloudFront ディストリビューション（infra/lib 側の追加が必要、CDK 未着手）。
- 実 Service Worker（キャッシュ先読み・オフライン判定）。iPad Safari PWA 実機が要る。
- IndexedDB 実装（端末メタデータ永続化）。ブラウザ実機が要る。
- 事前生成ジョブの実行（`buildPregenerationJob` の出力を実際に Polly へ投げて S3 へ書く
  バッチ処理）。実 AWS 認証情報が要る。

### 4. Polly 障害時のフォールバック境界

`src/domain/voice-tts/fallback.ts` の `decideTtsFallback` は「呼び出し側が指定した代替
キャッシュキー（`TtsSynthesizeOptions.fallbackCacheKey`）にヒットすれば再生、無ければ字幕のみ」
という 2 段構成。動的文の合成失敗時は、その動的文自体のキャッシュは原理的に存在しえない
（存在すれば冒頭のキャッシュ参照で既に provider を呼ばずに済んでいる）ため、事前生成済みの
**定型フォールバック文**（例:「音声のご案内をご利用いただけません」）へ差し替える設計とした
（`synthesis-service.ts` の設計注記を参照）。

## 実測後の見直し

CDN の Cache-Control 具体値・Service Worker の先読み対象範囲・IndexedDB のメタデータ保持期限は
実 iPad Safari PWA・実回線での計測（#65）を経て確定する。
