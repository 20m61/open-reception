/**
 * Transport クライアントが依存するソケットの最小抽象 (issue #369)。
 *
 * ブラウザの `WebSocket` をそのまま実装として満たせる形にしておき（`onopen`/`onclose`/
 * `onerror`/`onmessage` プロパティ代入スタイル）、テストでは `MockVoiceTransportSocket`
 * （テストダブル、`client.test.ts` 側）に差し替える。WebRTC/LiveKit へ置換する場合も、
 * この interface だけを満たす adapter を書けば `VoiceTransportClient` 側の変更は不要
 * （`docs/adr/0001-voice-transport.md` の境界方針）。
 */

export type VoiceTransportSocketCloseInfo = { code?: number; reason?: string };

export interface VoiceTransportSocket {
  send(chunk: ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((info: VoiceTransportSocketCloseInfo) => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((data: unknown) => void) | null;
}

/** 接続 URL からソケットを生成する。呼び出しごとに新しいソケットを返すこと（再接続のたび呼ばれる）。 */
export type VoiceTransportSocketFactory = (url: string) => VoiceTransportSocket;
