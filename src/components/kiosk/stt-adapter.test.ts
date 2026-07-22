import { describe, expect, it } from 'vitest';
import { defaultSttAdapterFactory, type SttAdapterFactory } from './stt-adapter';

describe('defaultSttAdapterFactory (#370 STT アダプタ DI の既定)', () => {
  it('既定ファクトリは MockSttAdapter 相当（候補を最大3件・空白除外で返す）＝注入しない時は従来どおり', async () => {
    const adapter = defaultSttAdapterFactory(['さとう', '', '  ', 'すずき', 'たなか', 'いとう']);
    const candidates = await adapter.listen();
    expect(candidates).toEqual(['さとう', 'すずき', 'たなか']);
  });

  it('候補が無ければ空配列（即時呼び出ししない従来契約を維持）', async () => {
    const adapter = defaultSttAdapterFactory([]);
    expect(await adapter.listen()).toEqual([]);
  });

  it('注入ファクトリはそのまま尊重される（外部 STT を将来接続できる中立 interface）', async () => {
    const injected: SttAdapterFactory = () => ({
      listen: async () => ['カスタム候補'],
    });
    const adapter = injected(['ignored']);
    expect(await adapter.listen()).toEqual(['カスタム候補']);
  });
});
