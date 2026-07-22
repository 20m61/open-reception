/**
 * STT session を Transport（issue #369）の close ライフサイクルへ結びつけるための薄い glue
 * (issue #370)。
 *
 * `VoiceTransportClient`（`src/lib/voice-transport/client.ts`）を直接 import せず、
 * `registerCloseHook` を持つ構造的型だけに依存する — 「STT は Transport の下流で chunk を
 * 受ける想定だが、直接依存は最小に」という設計方針（issue #370 指示）をここで満たす。
 * `VoiceTransportClient` はもちろん、同じ形さえ持てば他の実装（テスト用 fake 等）にも使える。
 */
import type { SttSession } from '@/domain/voice-stt/types';

export type CloseHookRegistrar = {
  registerCloseHook(hook: () => void | Promise<void>): void;
};

/**
 * Transport 終了時（`registerCloseHook` 経由）に STT session を確実に close するよう登録する。
 * `VoiceTransportClient.close()` は登録済みフックを 1 回だけ・確実に呼ぶため、STT session の
 * 二重 close 安全性はセッション実装側（`close()` の idempotency）に委ねる。
 */
export function attachSttSessionClose(target: CloseHookRegistrar, session: SttSession): void {
  target.registerCloseHook(() => session.close());
}
