/**
 * AI 案内設定のストア (issue #104 increment 2)。
 * 既定では無効（テキスト/タッチ主導）。永続化は data backend（memory / dynamodb）に委譲する。
 * 検証・正規化は純ドメイン（src/domain/ai-guidance/config.ts）へ委譲する。
 */
import {
  applyAiGuidanceConfigPatch,
  defaultAiGuidanceConfig,
  type AiGuidanceConfig,
  type AiGuidanceConfigPatch,
} from '@/domain/ai-guidance/config';
import { getBackend } from '@/lib/data';

const store = () =>
  getBackend().singleton<AiGuidanceConfig>('ai-guidance', { default: defaultAiGuidanceConfig });

async function current(): Promise<AiGuidanceConfig> {
  return (await store().get()) ?? defaultAiGuidanceConfig();
}

export async function getAiGuidanceConfig(): Promise<AiGuidanceConfig> {
  const c = await current();
  return { enabled: c.enabled, allowedTopics: [...c.allowedTopics] };
}

export async function updateAiGuidanceConfig(patch: unknown): Promise<AiGuidanceConfig> {
  const next = applyAiGuidanceConfigPatch(
    await current(),
    (typeof patch === 'object' && patch !== null ? patch : {}) as AiGuidanceConfigPatch,
  );
  await store().put(next);
  return { enabled: next.enabled, allowedTopics: [...next.allowedTopics] };
}

/** テスト用: 既定へ戻す。 */
export async function __resetAiGuidanceConfig(): Promise<void> {
  await store().reset();
}
