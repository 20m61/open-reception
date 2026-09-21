/**
 * `/api/admin/security` が返す `pinConfigured` の**配線** (#1021 AC3)。
 *
 * ## なぜ route にテストが要るか
 *
 * 判定そのものは `@/domain/security/pin` の `isPinConfigured` が縛っている。
 * **残る危険は配線**で、ここを `s.pin !== ''` に戻す変異は純関数のテストからは見えない
 * —— そしてそれは #1021 MAJOR-8 が報告した状態そのもの（既定値のまま「設定済み」と表示）へ戻る。
 *
 * 🔴 **PIN の値そのものを返していないこと**も併せて見る（`rules/pii-secret-minimization.md`）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();

vi.mock('@/lib/auth/actor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/actor')>();
  return { ...actual, resolveAdminActor: () => resolveAdminActor() };
});
vi.mock('@/lib/admin/audit', () => ({ recordDangerAction: vi.fn().mockResolvedValue(undefined) }));

import { GET, PUT } from './route';
import { __resetSecurity } from '@/lib/security/security-store';

function tenantAdmin(): Actor {
  return {
    status: 'active',
    assignments: [
      { role: 'tenant_admin', tenantId: asTenantId('internal'), siteId: null, deviceId: null },
    ],
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await __resetSecurity();
  resolveAdminActor.mockResolvedValue(tenantAdmin());
});

describe('GET /api/admin/security の pinConfigured (#1021 AC3)', () => {
  it('🔴 既定のままなら未設定と返す（以前は常に true だった）', async () => {
    const body = (await (await GET()).json()) as { pinConfigured: boolean };
    expect(body.pinConfigured).toBe(false);
  });

  it('🔴 運用者が決めたら設定済みと返す（下界）', async () => {
    await PUT(
      new Request('http://localhost/api/admin/security', {
        method: 'PUT',
        body: JSON.stringify({ pin: '4821' }),
      }),
    );
    const body = (await (await GET()).json()) as { pinConfigured: boolean };
    expect(body.pinConfigured).toBe(true);
  });

  /**
   * 🔴 **PUT 応答の配線にも下界を置く（実測 C4 で生存した）。**
   *
   * PIN を決めたケースだけを見ていると、`updated.pin !== ''` へ戻す変異が**素通りする**
   * —— ハッシュは空でないので、どちらの式でも true になるため。
   * **PIN を決めずに別項目だけ更新した**ケースでは、正しい答えは false・変異は true になる。
   */
  it('🔴 PIN を決めずに別項目だけ更新したら、未設定のまま返す', async () => {
    const res = await PUT(
      new Request('http://localhost/api/admin/security', {
        method: 'PUT',
        body: JSON.stringify({ pinRequired: true }),
      }),
    );
    const body = (await res.json()) as { pinConfigured: boolean; pinRequired: boolean };
    expect(body.pinConfigured).toBe(false);
    // 下界: 更新そのものは効いている（何も変えずに返しているなら上の主張は空虚）。
    expect(body.pinRequired).toBe(true);
  });

  it('🔴 PIN の値そのものは返さない（平文もハッシュも）', async () => {
    const res = await PUT(
      new Request('http://localhost/api/admin/security', {
        method: 'PUT',
        body: JSON.stringify({ pin: '4821' }),
      }),
    );
    const text = await res.text();
    expect(text).not.toContain('4821');
    expect(text).not.toContain('pbkdf2');
    // 下界: 応答が空でないこと（何も返していないなら上の主張は空虚）。
    expect(JSON.parse(text)).toMatchObject({ pinConfigured: true });
  });
});
