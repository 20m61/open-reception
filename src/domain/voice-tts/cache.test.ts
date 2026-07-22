import { describe, it, expect } from 'vitest';
import { CANNED_UTTERANCE_SEMANTIC_KEYS, buildPregenerationJob, type TtsPregenerationJobItem } from './cache';
import { buildTtsCacheKey } from './types';

describe('CANNED_UTTERANCE_SEMANTIC_KEYS (定型発話一覧の定義, issue #371)', () => {
  it('is a non-empty, de-duplicated list', () => {
    expect(CANNED_UTTERANCE_SEMANTIC_KEYS.length).toBeGreaterThan(0);
    expect(new Set(CANNED_UTTERANCE_SEMANTIC_KEYS).size).toBe(CANNED_UTTERANCE_SEMANTIC_KEYS.length);
  });
});

describe('buildPregenerationJob (事前生成ジョブの定義, issue #371 — 実行はしない)', () => {
  const voiceConfig = { locale: 'ja-JP', voice: 'Takumi', engine: 'neural' as const, rate: 1, lexiconVersion: 'v1' };

  it('produces one job item per canned utterance, each with its own cache key', () => {
    const utterances = [
      { semanticKey: CANNED_UTTERANCE_SEMANTIC_KEYS[0]!, text: { displayText: 'ようこそ' } },
      { semanticKey: CANNED_UTTERANCE_SEMANTIC_KEYS[1]!, text: { displayText: '内容をご確認ください' } },
    ];
    const job = buildPregenerationJob(utterances, voiceConfig);
    expect(job).toHaveLength(2);
    expect(new Set(job.map((j) => j.cacheKey)).size).toBe(2);
  });

  it("each job item's cacheKey matches buildTtsCacheKey for its resolved speechText (cache hit contract)", () => {
    const utterances = [{ semanticKey: CANNED_UTTERANCE_SEMANTIC_KEYS[0]!, text: { displayText: 'ようこそ' } }];
    const [job] = buildPregenerationJob(utterances, voiceConfig) as [TtsPregenerationJobItem];
    expect(job.cacheKey).toBe(buildTtsCacheKey({ ...voiceConfig, speechText: 'ようこそ' }));
  });

  it('uses speechText over displayText when both are provided (display/speech separation applies to pregeneration too)', () => {
    const utterances = [
      { semanticKey: CANNED_UTTERANCE_SEMANTIC_KEYS[0]!, text: { displayText: '田中太郎様', speechText: 'たなか たろう さま' } },
    ];
    const [job] = buildPregenerationJob(utterances, voiceConfig) as [TtsPregenerationJobItem];
    expect(job.speechText).toBe('たなか たろう さま');
  });

  it('does not perform any synthesis — the result is plain data with no side effects (実生成は #65 外部待ち)', () => {
    const utterances = [{ semanticKey: CANNED_UTTERANCE_SEMANTIC_KEYS[0]!, text: { displayText: 'ようこそ' } }];
    const job = buildPregenerationJob(utterances, voiceConfig);
    expect(job[0]).not.toHaveProperty('audioRef');
    expect(job[0]).not.toHaveProperty('generatedAt');
  });
});
