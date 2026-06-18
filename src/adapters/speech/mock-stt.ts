/**
 * 音声認識の mock adapter (issue #5)。
 * 実ブラウザの音声認識（Web Speech API・マイク権限）は実機前提のため #65 にスタック。
 * ここでは「候補表示 → 確認操作必須・即時呼び出ししない」フローを検証可能にする。
 */
import type { SttAdapter } from './types';

export class MockSttAdapter implements SttAdapter {
  constructor(private readonly phrases: string[]) {}

  async listen(): Promise<string[]> {
    // 認識候補を返す（最大 3 件）。来訪者は候補をタップして検索欄に反映し、確認のうえ選択する。
    return this.phrases.filter((p) => p.trim() !== '').slice(0, 3);
  }
}
