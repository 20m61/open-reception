/**
 * `TtsCache` のメモリ内実装 (issue #371)。
 *
 * 実キャッシュ境界（S3 origin + CloudFront edge + Service Worker + IndexedDB メタデータ）は
 * `docs/adr/0002-voice-tts-cache-boundaries.md` で設計を記録済み。実配線は #65（外部待ち・実 AWS
 * 環境が要る）。この increment はプロセス内メモリのみで `TtsCache` interface を満たし、
 * `TtsSynthesisService`（`synthesis-service.ts`）のキャッシュヒット/ミス判定をローカルで検証する。
 */
import type { TtsCache, TtsCacheEntry } from '@/domain/voice-tts/types';

export class InMemoryTtsCache implements TtsCache {
  private readonly entries = new Map<string, TtsCacheEntry>();

  get(key: string): TtsCacheEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: TtsCacheEntry): void {
    this.entries.set(key, entry);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }
}
