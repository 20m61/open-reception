/**
 * 切断の共通形 (#743 AC2 後半)。
 *
 * ここが縛るのは「**呼び出し元に影響を漏らさない**」こと。切断は best-effort で、
 * 失敗しても受付側の停止は巻き戻らないし、例外も出ない。
 */
import { describe, expect, it, vi } from 'vitest';
import { hangUpIfRinging } from './hang-up';

function terminatorReturning(outcome: unknown) {
  const terminate = vi.fn(async () => outcome);
  return {
    terminate,
    resolveTerminator: (async () => ({ key: 'vonage-voice', terminate })) as never,
  };
}

describe('hangUpIfRinging (#743)', () => {
  it('通話 ID があれば切りに行く', async () => {
    const { terminate, resolveTerminator } = terminatorReturning({ kind: 'terminated' });
    const out = await hangUpIfRinging('TEST-tenant', 'TEST-uuid', { resolveTerminator });
    expect(terminate).toHaveBeenCalledWith('TEST-uuid');
    expect(out).toEqual({ kind: 'terminated' });
  });

  /** mock 経路・ビデオ経路には provider 通話が無い。叩きに行かない。 */
  it.each([undefined, ''])('通話 ID が %p なら何もしない', async (id) => {
    const { terminate, resolveTerminator } = terminatorReturning({ kind: 'terminated' });
    const out = await hangUpIfRinging('TEST-tenant', id, { resolveTerminator });
    expect(terminate).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: 'not_wired' });
  });

  it('実発信経路でないテナントは何もしない', async () => {
    const out = await hangUpIfRinging('TEST-tenant', 'TEST-uuid', {
      resolveTerminator: (async () => null) as never,
    });
    expect(out).toEqual({ kind: 'not_wired' });
  });

  /**
   * 🔴 **例外を投げ返さない。** 呼び出し元は webhook ルートと端末の `/give-up` で、
   * 切断の失敗で 5xx を返してはいけない（Vonage の再送・端末の画面固着を招く）。
   */
  it('🔴 資格情報の解決が落ちても投げ返さない', async () => {
    const out = await hangUpIfRinging('TEST-tenant', 'TEST-uuid', {
      resolveTerminator: (async () => {
        throw new Error('TEST-secret-store-down');
      }) as never,
    });
    expect(out).toEqual({ kind: 'failed' });
  });

  it('🔴 切断そのものが落ちても投げ返さない', async () => {
    const { resolveTerminator } = terminatorReturning(undefined);
    const out = await hangUpIfRinging('TEST-tenant', 'TEST-uuid', {
      resolveTerminator: (async () => ({
        key: 'vonage-voice',
        terminate: async () => {
          throw new Error('TEST-network-detail');
        },
      })) as never,
    });
    void resolveTerminator;
    expect(out).toEqual({ kind: 'failed' });
  });

  /**
   * 🔴 **通話 ID をログへ載せない。** provider 側のログと突き合わせれば来訪者の
   * 行動時刻が復元できてしまう（`rules/pii-secret-minimization.md`）。
   */
  it('🔴 失敗ログに通話 ID と例外の内容を載せない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await hangUpIfRinging('TEST-tenant', 'TEST-uuid-canary', {
      resolveTerminator: (async () => {
        throw new Error('TEST-secret-store-down');
      }) as never,
    });
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    warn.mockRestore();
    expect(logged).not.toContain('TEST-uuid-canary');
    expect(logged).not.toContain('TEST-secret-store-down');
    expect(logged).toContain('hangup_failed');
  });

  /**
   * 🔴 **切れなかったときのログにも通話 ID を載せない。** 例外経路だけ見ていると、
   * こちら（provider が 4xx/5xx を返した経路）を素通りさせる ── 実際に変異検証で
   * 素通りすることを実測した。**鳴りっぱなしが起きる唯一の経路**なので、
   * いちばん詳しく書きたくなる場所でもある。
   */
  it('🔴 切断失敗のログにも通話 ID を載せない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { resolveTerminator } = terminatorReturning({ kind: 'failed' });
    await hangUpIfRinging('TEST-tenant', 'TEST-uuid-canary', { resolveTerminator });
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    warn.mockRestore();
    expect(logged).toContain('hangup_failed');
    expect(logged).not.toContain('TEST-uuid-canary');
  });

  it('切れなかったときだけ警告を出す（成功で騒がない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = terminatorReturning({ kind: 'terminated' });
    await hangUpIfRinging('TEST-tenant', 'u', { resolveTerminator: ok.resolveTerminator });
    const already = terminatorReturning({ kind: 'already_ended' });
    await hangUpIfRinging('TEST-tenant', 'u', { resolveTerminator: already.resolveTerminator });
    expect(warn).not.toHaveBeenCalled();

    const bad = terminatorReturning({ kind: 'failed' });
    await hangUpIfRinging('TEST-tenant', 'u', { resolveTerminator: bad.resolveTerminator });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
