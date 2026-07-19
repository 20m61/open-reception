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
 */
import type { VoiceEvalScenario } from '@/domain/voice/evaluation-runner';

import type { VoiceEvalDatasetEntry } from './synthetic-provider';

function scenario(
  id: string,
  description: string,
  tags: string[],
  groundTruth: VoiceEvalScenario['groundTruth'],
  utterances: { turnIndex: number; text: string }[],
): VoiceEvalScenario {
  return { id, locale: 'ja-JP', description, tags, input: { kind: 'synthetic', utterances }, groundTruth };
}

export const VOICE_EVAL_DATASET: VoiceEvalDatasetEntry[] = [
  {
    speechDurationMs: 900,
    nearEnd: [],
    scenario: scenario(
      'person-name-honorific',
      '敬称付きの担当者名で面会を申し出る（最頻ケース）',
      ['person-name', 'honorific', 'short-answer'],
      {
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
        nearEndOnsets: [],
      },
      [{ turnIndex: 0, text: '営業部の山田さんにお会いしたいのですが' }],
    ),
  },
  {
    speechDurationMs: 1100,
    nearEnd: [],
    scenario: scenario(
      'homophone-name',
      '同音異字の担当者名（斎藤 / 齋藤 / 佐藤）。CER が低くても取り違える回帰を捕まえる',
      ['person-name', 'homophone'],
      {
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
        nearEndOnsets: [],
      },
      [{ turnIndex: 0, text: '斎藤さんをお願いします' }],
    ),
  },
  {
    speechDurationMs: 1000,
    nearEnd: [],
    scenario: scenario(
      'department-alias',
      '部門の略称・別名（総務 → 総務課、人事 → 人事総務部）',
      ['department', 'alias'],
      {
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
        nearEndOnsets: [],
      },
      [{ turnIndex: 0, text: '総務の方をお願いします' }],
    ),
  },
  {
    speechDurationMs: 1400,
    nearEnd: [],
    scenario: scenario(
      'katakana-company',
      'カタカナ社名と英語混在（アクメコーポレーション / ACME Inc.）',
      ['company', 'katakana', 'mixed-script'],
      {
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
        nearEndOnsets: [],
      },
      [{ turnIndex: 0, text: 'アクメコーポレーションの田中と申します' }],
    ),
  },
  {
    speechDurationMs: 1200,
    nearEnd: [],
    scenario: scenario(
      'filler-mid-utterance',
      'フィラー・接続助詞で切れる発話。ここで確定すると誤ターン終了になる',
      ['turn', 'filler'],
      {
        turns: [
          {
            // 「えーと、あの」で一旦止まるが発話は続く → 確定してはいけない
            turnIndex: 0,
            referenceTranscript: 'えーと、あの',
            shouldCommit: false,
            endsWithFiller: true,
          },
          {
            turnIndex: 1,
            referenceTranscript: '配送でお伺いしました',
            shouldCommit: true,
            endsWithFiller: false,
            utteranceKind: 'short_answer',
          },
        ],
        nearEndOnsets: [],
      },
      [
        { turnIndex: 0, text: 'えーと、あの' },
        { turnIndex: 1, text: '配送でお伺いしました' },
      ],
    ),
  },
  {
    speechDurationMs: 900,
    nearEnd: [
      // turn 0 の応答再生中に「はい」と相づちが入る → 止めてはいけない
      { turnIndex: 0, offsetFromPlaybackStartMs: 400 },
      // turn 1 の応答再生中に本当の言い直しが入る → 止めるべき
      { turnIndex: 1, offsetFromPlaybackStartMs: 350 },
    ],
    scenario: scenario(
      'backchannel-then-interruption',
      'キャラクター発話中の相づち（誤停止してはいけない）と、真の割り込み（止めるべき）',
      ['barge-in', 'backchannel'],
      {
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
        nearEndOnsets: [
          { onsetIndex: 0, label: 'backchannel' },
          { onsetIndex: 1, label: 'interruption' },
        ],
      },
      [
        { turnIndex: 0, text: '山田さんをお願いします' },
        { turnIndex: 1, text: 'すみません、佐藤さんでした' },
      ],
    ),
  },
  {
    speechDurationMs: 800,
    nearEnd: [
      // 自己音声エコーと環境音（空調・サイネージ）。どちらも止めてはいけない
      { turnIndex: 0, offsetFromPlaybackStartMs: 200 },
      { turnIndex: 1, offsetFromPlaybackStartMs: 600 },
    ],
    scenario: scenario(
      'echo-and-environment',
      '自己音声エコーと環境音での誤停止を数える',
      ['barge-in', 'echo', 'environment'],
      {
        turns: [
          { turnIndex: 0, referenceTranscript: '面会です', shouldCommit: true, endsWithFiller: false, utteranceKind: 'short_answer' },
          { turnIndex: 1, referenceTranscript: '採用の面接で参りました', shouldCommit: true, endsWithFiller: false, utteranceKind: 'free_form' },
        ],
        nearEndOnsets: [
          { onsetIndex: 0, label: 'echo' },
          { onsetIndex: 1, label: 'environment' },
        ],
      },
      [
        { turnIndex: 0, text: '面会です' },
        { turnIndex: 1, text: '採用の面接で参りました' },
      ],
    ),
  },
];

export const VOICE_EVAL_SCENARIOS: VoiceEvalScenario[] = VOICE_EVAL_DATASET.map((entry) => entry.scenario);
