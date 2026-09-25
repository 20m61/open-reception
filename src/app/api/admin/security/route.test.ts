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
const recordDangerAction = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/admin/audit', () => ({
  recordDangerAction: (...args: unknown[]) => recordDangerAction(...args),
}));

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

  /**
   * 🔴 **監査の `pinChanged` は「PIN を送ったか」（レビュー 2 周目 MAJOR 2）。**
   *
   * 以前は「未設定→設定済みの遷移」で計算しており、**ローテーションが全部 false** だった
   * —— 退職・漏洩時の PIN 変更は必ず 2 回目以降なので、監査は全件「変更なし」になる。
   * **間違った記録は無い記録より悪い。**
   */
  it('🔴 PIN のローテーションも監査に残る', async () => {
    const put = (body: unknown) =>
      PUT(
        new Request('http://localhost/api/admin/security', {
          method: 'PUT',
          body: JSON.stringify(body),
        }),
      );
    await put({ pin: '4821' });
    await put({ pin: '5555' });
    const metadata = recordDangerAction.mock.calls.map(
      (c) => (c[0] as { metadata: { pinChanged: boolean } }).metadata.pinChanged,
    );
    expect(metadata).toEqual([true, true]);
    // 下界: PIN を送らない更新では false（常に true にして満たしていない）。
    await put({ emergencyStop: true });
    expect(
      (recordDangerAction.mock.calls.at(-1)?.[0] as { metadata: { pinChanged: boolean } }).metadata
        .pinChanged,
    ).toBe(false);
    // 🔴 値は残さない。
    expect(JSON.stringify(recordDangerAction.mock.calls)).not.toContain('4821');
  });

  /**
   * 🔴 **GET 側にも同じ主張を置く（レビュー 3 周目 MINOR 1。変異が生存していた）。**
   * 管理 UI が毎回読むのは GET であり、PUT にだけ主張があっても穴は塞がらない。
   */
  it('🔴 GET も PIN の値を返さない', async () => {
    await PUT(
      new Request('http://localhost/api/admin/security', {
        method: 'PUT',
        body: JSON.stringify({ pin: '4821' }),
      }),
    );
    const text = await (await GET()).text();
    expect(text).not.toContain('4821');
    expect(text).not.toContain('pbkdf2');
    // 下界: 応答が空でない。
    expect(JSON.parse(text)).toMatchObject({ pinConfigured: true });
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

/**
 * 🔴 **競合を 409 に写像する配線 (#1158 AC2)。**
 *
 * 判定は store が縛っている。残る危険は配線で、例外を 500 にする・握って 200 にする・
 * 競合でも監査に「更新した」と残す、のどれも store のテストからは見えない。
 */
describe('PUT /api/admin/security の競合 (#1158)', () => {
  const put = (body: unknown) =>
    PUT(
      new Request('http://localhost/api/admin/security', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    );

  it('🔴 GET は版を返し、版付きの保存が通るたびに 1 つ進む（下界）', async () => {
    const { rev } = (await (await GET()).json()) as { rev: number };
    expect(rev).toBe(0);
    const res = await put({ rev, pinRequired: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rev: number }).rev).toBe(1);
    expect(((await (await GET()).json()) as { rev: number }).rev).toBe(1);
  });

  it('🔴 古い版からの保存は 409 で、何も書かず、監査にも残さない', async () => {
    const { rev } = (await (await GET()).json()) as { rev: number };
    await put({ emergencyStop: true }); // 別の操作が先に書いた
    recordDangerAction.mockClear();
    const res = await put({ rev, pinRequired: true, ipAllowlist: [] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict' });
    expect(recordDangerAction).not.toHaveBeenCalled();
    const now = (await (await GET()).json()) as { pinRequired: boolean; emergencyStop: boolean };
    expect(now).toMatchObject({ pinRequired: false, emergencyStop: true });
  });

  it('🔴 版の形が違えば 400 で、何も書かない', async () => {
    const res = await put({ rev: 'x', emergencyStop: true });
    expect(res.status).toBe(400);
    expect(recordDangerAction).not.toHaveBeenCalled();
    expect(((await (await GET()).json()) as { emergencyStop: boolean }).emergencyStop).toBe(false);
  });

  it('版を付けない保存（緊急停止のトグル）は版に縛られない', async () => {
    await put({ pinRequired: true });
    const res = await put({ emergencyStop: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ emergencyStop: true, rev: 2 });
  });
});
