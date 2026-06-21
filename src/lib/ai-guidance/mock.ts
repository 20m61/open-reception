/**
 * AI 案内の mock provider / mock 引き継ぎチャネル (issue #104 increment 1)。
 *
 * 実 LLM を呼ばずに、決定的にエスカレーション分岐（低信頼・NG ワード・スコープ外・
 * ユーザー要求・引き継ぎ成功/失敗）を再現する。テストと UI プレビュー用。
 */
import type {
  GuidanceProvider,
  GuidanceRequest,
  GuidanceResponse,
  HandoffChannel,
  HandoffOutcome,
  HandoffRequest,
} from './types';

/**
 * 決定的な mock provider。発話に含まれるキーワードで応答を切り替える。
 * 競合サービスのプロンプト/文言を流用しない独自の最小実装。
 */
export class MockGuidanceProvider implements GuidanceProvider {
  readonly id = 'mock';

  // eslint-disable-next-line @typescript-eslint/require-await
  async generate(request: GuidanceRequest): Promise<GuidanceResponse> {
    const text = request.utterance.toLowerCase();

    // 明示的に人を呼ぶ意思 → 低信頼として返し、上位でユーザー要求として扱う前提。
    if (text.includes('人') || text.includes('担当') || text.includes('staff')) {
      return { answer: '担当者におつなぎします。', confidence: 0.9, ngWordDetected: false, outOfScope: false };
    }
    // 要注意語の例（緊急・苦情など）。検知語そのものは返さない。
    if (text.includes('緊急') || text.includes('急病') || text.includes('emergency')) {
      return { answer: '', confidence: 0.0, ngWordDetected: true, outOfScope: false };
    }
    // 許可トピック外の質問（誤案内防止）。
    if (text.includes('天気') || text.includes('株価')) {
      return { answer: 'その内容にはお答えできません。', confidence: 0.2, ngWordDetected: false, outOfScope: true };
    }
    // 通常の FAQ/受付操作案内。
    return { answer: '受付の操作をご案内します。', confidence: 0.85, ngWordDetected: false, outOfScope: false };
  }
}

/**
 * 決定的な mock 引き継ぎチャネル。`acceptNext` で成功/失敗を制御できる。
 */
export class MockHandoffChannel implements HandoffChannel {
  readonly id = 'mock';

  constructor(private readonly accept: boolean = true) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async requestHandoff(_input: HandoffRequest): Promise<HandoffOutcome> {
    if (this.accept) {
      return { accepted: true };
    }
    return { accepted: false, fallbackHint: 'reception_flow' };
  }
}
