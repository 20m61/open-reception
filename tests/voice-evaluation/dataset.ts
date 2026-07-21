/**
 * 日本語受付の評価データセット (issue #365)。
 *
 * **実音声はリポジトリに入れない。** #365 は実音声の投入に明示的同意・匿名化・ライセンスを
 * 必須としているため、既定のデータセットは合成発話テキストと正解ラベルだけで構成する。
 * 実音声・協力者音声を使う実機セットは #65 側の手順で扱い、成果物として持ち込むのは
 * 計測イベントと集計値のみ（生の書き起こしと音声は持ち出さない）。
 *
 * 網羅する切り口（#365「データセット」節）:
 * 担当者名 / 同姓同名・同音異字 / 部門正式名・略称 / カタカナ社名・英語混在 / 敬称 /
 * 用件 / フィラー・接続助詞 / 相づち・訂正・環境音。
 *
 * 近端発話は「そのターンの応答が鳴り始めて N ミリ秒後」という**刺激**として書き、
 * `buildDatasetEntry` が基準タイムラインで絶対時刻へ解決する。観測 onset の通番には
 * 依存しない（provider が onset を取りこぼしてもラベルがずれない）。
 */
import { buildDatasetEntry, type VoiceEvalDatasetEntry, type VoiceEvalDatasetSpec } from './synthetic-provider';

const SPECS: VoiceEvalDatasetSpec[] = [
  {
    id: 'person-name-honorific',
    description: '敬称付きの担当者名で面会を申し出る（最頻ケース）',
    tags: ['person-name', 'honorific', 'short-answer'],
    speechDurationMs: 900,
    nearEnd: [],
    turns: [
      {
        turnIndex: 0,
        referenceTranscript: '営業部の山田さんにお会いしたいのですが',
        shouldCommit: true,
        endsWithFiller: false,
        utteranceKind: 'short_answer',
        expectedPersonNames: ['山田'],
        expectedDepartmentNames: ['営業部'],
        expectedEntityIds: ['staff-yamada'],
      },
    ],
  },
  {
    id: 'homophone-name',
    description: '同音異字の担当者名（斎藤 / 齋藤 / 佐藤）。CER が低くても取り違える回帰を捕まえる',
    tags: ['person-name', 'homophone'],
    speechDurationMs: 1100,
    nearEnd: [],
    turns: [
      {
        turnIndex: 0,
        referenceTranscript: '斎藤さんをお願いします',
        shouldCommit: true,
        endsWithFiller: false,
        utteranceKind: 'short_answer',
        expectedPersonNames: ['斎藤'],
        expectedEntityIds: ['staff-saito-a'],
      },
    ],
  },
  {
    id: 'department-alias',
    description: '部門の略称・別名（総務 → 総務課、人事 → 人事総務部）',
    tags: ['department', 'alias'],
    speechDurationMs: 1000,
    nearEnd: [],
    turns: [
      {
        turnIndex: 0,
        referenceTranscript: '総務の方をお願いします',
        shouldCommit: true,
        endsWithFiller: false,
        utteranceKind: 'short_answer',
        expectedDepartmentNames: ['総務'],
        expectedEntityIds: ['dept-general-affairs'],
      },
    ],
  },
  {
    id: 'katakana-company',
    description: 'カタカナ社名と英語混在（アクメコーポレーション / ACME Inc.）',
    tags: ['company', 'katakana', 'mixed-script'],
    speechDurationMs: 1400,
    nearEnd: [],
    turns: [
      {
        turnIndex: 0,
        referenceTranscript: 'アクメコーポレーションの田中と申します',
        shouldCommit: true,
        endsWithFiller: false,
        utteranceKind: 'free_form',
        expectedPersonNames: ['田中'],
      },
    ],
  },
  {
    id: 'filler-mid-utterance',
    description: 'フィラー・接続助詞で切れる発話。ここで確定すると誤ターン終了になる',
    tags: ['turn', 'filler'],
    speechDurationMs: 1200,
    nearEnd: [],
    turns: [
      // 「えーと、あの」で一旦止まるが発話は続く → 確定してはいけない
      { turnIndex: 0, referenceTranscript: 'えーと、あの', shouldCommit: false, endsWithFiller: true },
      {
        turnIndex: 1,
        referenceTranscript: '配送でお伺いしました',
        shouldCommit: true,
        endsWithFiller: false,
        utteranceKind: 'short_answer',
      },
    ],
  },
  {
    id: 'backchannel-then-interruption',
    description: 'キャラクター発話中の相づち（誤停止してはいけない）と、真の割り込み（止めるべき）',
    tags: ['barge-in', 'backchannel'],
    speechDurationMs: 900,
    nearEnd: [
      { id: 'backchannel-hai', turnIndex: 0, offsetFromPlaybackStartMs: 400, label: 'backchannel' },
      { id: 'correction', turnIndex: 1, offsetFromPlaybackStartMs: 350, label: 'interruption' },
    ],
    turns: [
      {
        turnIndex: 0,
        referenceTranscript: '山田さんをお願いします',
        shouldCommit: true,
        endsWithFiller: false,
        utteranceKind: 'short_answer',
      },
      {
        turnIndex: 1,
        referenceTranscript: 'すみません、佐藤さんでした',
        shouldCommit: true,
        endsWithFiller: false,
        utteranceKind: 'free_form',
      },
    ],
  },
  {
    id: 'echo-and-environment',
    description: '自己音声エコーと環境音での誤停止を数える',
    tags: ['barge-in', 'echo', 'environment'],
    speechDurationMs: 800,
    nearEnd: [
      { id: 'self-echo', turnIndex: 0, offsetFromPlaybackStartMs: 200, label: 'echo' },
      { id: 'hvac-noise', turnIndex: 1, offsetFromPlaybackStartMs: 600, label: 'environment' },
    ],
    turns: [
      {
        turnIndex: 0,
        referenceTranscript: '面会です',
        shouldCommit: true,
        endsWithFiller: false,
        utteranceKind: 'short_answer',
      },
      {
        turnIndex: 1,
        referenceTranscript: '採用の面接で参りました',
        shouldCommit: true,
        endsWithFiller: false,
        utteranceKind: 'free_form',
      },
    ],
  },
  {
    id: 'consecutive-near-end',
    description: '1 回の再生中に相づちと真の割り込みが連続する。停止の帰属規則と刺激マッチングを検証する',
    tags: ['barge-in', 'backchannel', 'attribution'],
    speechDurationMs: 900,
    nearEnd: [
      // 間隔は許容窓 (STIMULUS_TOLERANCE_MS) の 2 倍より広く取る。近すぎると窓が重なり、
      // 観測をどちらの刺激に帰属させるか決められない（バリデータが弾く）。
      { id: 'backchannel-ee', turnIndex: 0, offsetFromPlaybackStartMs: 300, label: 'backchannel' },
      { id: 'real-interruption', turnIndex: 0, offsetFromPlaybackStartMs: 1500, label: 'interruption' },
    ],
    turns: [
      {
        turnIndex: 0,
        referenceTranscript: '経理部をお願いします',
        shouldCommit: true,
        endsWithFiller: false,
        utteranceKind: 'short_answer',
        expectedDepartmentNames: ['経理部'],
      },
    ],
  },
];

export const VOICE_EVAL_DATASET: VoiceEvalDatasetEntry[] = SPECS.map(buildDatasetEntry);

export const VOICE_EVAL_SCENARIOS = VOICE_EVAL_DATASET.map((entry) => entry.scenario);
