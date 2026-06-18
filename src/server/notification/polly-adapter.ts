/**
 * Polly 音声化アダプタ (DESIGN #34 §6)。
 * `synthesize(text, voice): Promise<AudioRef>`。
 * 失敗時は上位（handler）がテキスト fallback を判断する。
 *
 * 既存の call adapter (#20) と同じく interface + mock/real + factory 構成。
 * 実 AWS SDK 呼び出しは AwsPollyAdapter に閉じ込め、テストは MockPollyAdapter を使う。
 */
import type { AudioRef, VoiceSettings } from './types';

export interface PollyAdapter {
  synthesize(text: string, voice: VoiceSettings): Promise<AudioRef>;
}

/** テスト・ローカル用。実際の音声化は行わず決定的な結果を返す。 */
export class MockPollyAdapter implements PollyAdapter {
  async synthesize(text: string, voice: VoiceSettings): Promise<AudioRef> {
    // 文字数のみを反映した擬似データ（PII を保持しない）。
    const marker = `mock:${voice.voiceId}:${text.length}`;
    return {
      format: 'mp3',
      base64: Buffer.from(marker).toString('base64'),
    };
  }
}

/**
 * Amazon Polly 実装。AWS SDK v3 (@aws-sdk/client-polly) を遅延 import して
 * mock/test 経路に SDK 依存を持ち込まない。Lambda 実行時のみ読み込む。
 */
export class AwsPollyAdapter implements PollyAdapter {
  constructor(private readonly region: string) {}

  async synthesize(text: string, voice: VoiceSettings): Promise<AudioRef> {
    const { PollyClient, SynthesizeSpeechCommand } = await import('@aws-sdk/client-polly');
    const client = new PollyClient({ region: this.region });
    const res = await client.send(
      new SynthesizeSpeechCommand({
        Text: text,
        OutputFormat: 'mp3',
        VoiceId: voice.voiceId as never,
        LanguageCode: voice.languageCode as never,
        Engine: voice.engine,
      }),
    );
    if (!res.AudioStream) {
      throw new Error('Polly returned empty AudioStream');
    }
    const bytes = await res.AudioStream.transformToByteArray();
    return {
      format: 'mp3',
      base64: Buffer.from(bytes).toString('base64'),
    };
  }
}

/** 環境に応じて adapter を選ぶ。POLLY_ENABLED=true のときのみ実 Polly を使う。 */
export function createPollyAdapter(
  env: Record<string, string | undefined> = process.env,
): PollyAdapter {
  if (env.POLLY_ENABLED === 'true') {
    return new AwsPollyAdapter(env.AWS_REGION ?? 'ap-northeast-1');
  }
  return new MockPollyAdapter();
}
