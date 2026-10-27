/**
 * 予約の永続化 (#97 increment 3 / #736 Gate A)。
 *
 * ## 事実
 *
 * 予約は `MemoryReservationRepository`（モジュールスコープの singleton）に載っていた。
 * routing 側は `getBackend()` に載っているのに、予約だけがプロセス内のまま。
 *
 * 🔴 **その結果、本番形態では QR がまったく機能しない。** 管理画面で発行した予約は、
 * 受付端末のリクエストを処理する別の Lambda インスタンスからは見えない。
 * **発行した QR は必ず「不明な QR」になる。**
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { asReservationId, asReservationToken, type VisitReservation } from '@/domain/reservation/types';
import { hashReservationToken } from '@/domain/reservation/token';
import { getBackend } from '@/lib/data';
import type { DataBackend } from '@/lib/data/backend';
import { MemoryBackend } from '@/lib/data/memory';
import { makeDynamoBackend } from '@/lib/data/fake-dynamo';
import {
  DataBackedReservationRepository,
  RESERVATION_COLLECTION,
  ReservationRetentionUncomputableError,
} from './data-backed-repository';

const TOKEN = asReservationToken('TEST-reservation-token');
const TOKEN_HASH = hashReservationToken(TOKEN);
const OTHER_HASH = hashReservationToken(asReservationToken('TEST-other-token'));

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_1 = asSiteId('site-1');
const S_2 = asSiteId('site-2');

const DAY = 24 * 60 * 60 * 1000;
/**
 * 🔴 日付は `Date.now()` 相対で作る。固定日付だと保存期間（#1022）を過ぎた瞬間に
 * 全テストが「引けない」側へ倒れ、越境テストが空虚に通るようになる（CLAUDE.md「検証の作法」）。
 */
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();

function res(over: Partial<VisitReservation> = {}): VisitReservation {
  return {
    id: asReservationId('rsv-1'),
    tenantId: T_A,
    siteId: S_1,
    visitorName: 'TEST-来客',
    visitAt: isoIn(1 * DAY),
    targetType: 'staff',
    targetId: 'staff-1',
    tokenHash: TOKEN_HASH,
    usagePolicy: 'single_use',
    expiresAt: isoIn(8 * DAY),
    status: 'active',
    retentionDays: 30,
    createdAt: isoIn(-1 * DAY),
    updatedAt: isoIn(-1 * DAY),
    ...over,
  };
}

beforeEach(async () => {
  await getBackend()
    .collection<{ id: string; scopedTokenHash: string }>(RESERVATION_COLLECTION, {
      indexedField: 'scopedTokenHash',
    })
    .reset();
});

describe('DataBackedReservationRepository (#736)', () => {
  it('create / get / list', async () => {
    const repo = new DataBackedReservationRepository();
    expect((await repo.create(res())).ok).toBe(true);
    expect(await repo.get(T_A, S_1, asReservationId('rsv-1'))).toMatchObject({ id: 'rsv-1' });
    expect(await repo.list(T_A, S_1)).toHaveLength(1);
  });

  it('id 重複は conflict', async () => {
    const repo = new DataBackedReservationRepository();
    await repo.create(res());
    const again = await repo.create(res());
    expect(again.ok).toBe(false);
  });

  /**
   * 🔴 **これが本体。** 発行したインスタンスと照合するインスタンスが別でも引けること。
   * in-memory singleton だとここで落ちる（別インスタンスは空の Map を持つ）。
   */
  it('🔴 別インスタンスから token hash で引ける（発行と照合が別 Lambda でも成立する）', async () => {
    await new DataBackedReservationRepository().create(res());

    // 受付端末側の Lambda インスタンス相当。
    const reader = new DataBackedReservationRepository();
    const found = await reader.findByTokenHash(T_A, S_1, TOKEN_HASH);

    expect(found, '別インスタンスから予約を引けない').toBeDefined();
    expect(found?.id).toBe('rsv-1');
  });

  it('一致しない hash では引けない', async () => {
    const repo = new DataBackedReservationRepository();
    await repo.create(res());
    expect(await repo.findByTokenHash(T_A, S_1, OTHER_HASH)).toBeUndefined();
  });

  /**
   * 🔴 **越境させない。** 索引キーへ境界を畳み込んであるので、他テナント・他サイトは
   * 索引の時点で引けない。「在るが読めない」と「無い」を同じ結果（undefined）にする。
   */
  it('🔴 他テナント・他サイトからは同じ token hash でも引けない', async () => {
    const repo = new DataBackedReservationRepository();
    await repo.create(res());
    expect(await repo.findByTokenHash(T_B, S_1, TOKEN_HASH)).toBeUndefined();
    expect(await repo.findByTokenHash(T_A, S_2, TOKEN_HASH)).toBeUndefined();
  });

  it('🔴 get / list も越境しない', async () => {
    const repo = new DataBackedReservationRepository();
    await repo.create(res());
    expect(await repo.get(T_B, S_1, asReservationId('rsv-1'))).toBeUndefined();
    expect(await repo.list(T_B, S_1)).toHaveLength(0);
  });

  it('put で上書きでき、更新後の状態が読める（使用済み化）', async () => {
    const repo = new DataBackedReservationRepository();
    await repo.create(res());
    await repo.put(res({ status: 'used', usedAt: isoIn(0) }));
    expect((await repo.get(T_A, S_1, asReservationId('rsv-1')))?.status).toBe('used');
  });

  /**
   * 🔴 索引用の派生値をドメイン型へ混ぜない。API 応答や監査へそのまま流れると、
   * token hash が意図せず外へ出る経路になりうる。
   */
  it('🔴 読み出した予約に索引用の派生値を混ぜない', async () => {
    const repo = new DataBackedReservationRepository();
    await repo.create(res());
    const found = await repo.findByTokenHash(T_A, S_1, TOKEN_HASH);
    expect(found).toBeDefined();
    expect(Object.keys(found!)).not.toContain('scopedTokenHash');
  });
});

/**
 * 保存期間 (#1022)。来訪の終わり（visitAt と expiresAt の遅い方）+ retentionDays で破棄する。
 *
 * memory / dynamodb（fake DocumentClient）の**両方の backend** で同じ契約を縛る。
 * 時刻は repository へ注入し、期限の**すぐ内側**（期限 - 1ms）と期限ちょうどを踏む。
 */
const BACKENDS: { name: string; make: () => { backend: () => DataBackend; raw: (id: string) => Promise<Record<string, unknown> | undefined> } }[] = [
  {
    name: 'memory',
    make: () => {
      const backend = new MemoryBackend();
      return {
        backend: () => backend,
        raw: async (id) =>
          (await backend
            .collection<{ id: string; scopedTokenHash: string }>(RESERVATION_COLLECTION, { indexedField: 'scopedTokenHash' })
            .get(id)) as Record<string, unknown> | undefined,
      };
    },
  },
  {
    name: 'dynamodb',
    make: () => {
      const { backend, fake } = makeDynamoBackend();
      return {
        backend: () => backend,
        raw: async (id) =>
          [...fake.store.values()].find((i) => i.PK === `col#${RESERVATION_COLLECTION}` && i.SK === id),
      };
    },
  },
];

/** 3 つの読み取り経路すべてから引けるか。 */
async function readable(repo: DataBackedReservationRepository, r: VisitReservation) {
  return {
    get: (await repo.get(r.tenantId, r.siteId, r.id)) !== undefined,
    list: (await repo.list(r.tenantId, r.siteId)).some((x) => x.id === r.id),
    token: (await repo.findByTokenHash(r.tenantId, r.siteId, r.tokenHash)) !== undefined,
  };
}

const ALL = { get: true, list: true, token: true };
const NONE = { get: false, list: false, token: false };

describe.each(BACKENDS)('DataBackedReservationRepository の保存期間 (#1022) — $name', ({ make }) => {
  /** 来訪の終わりを持つ予約の組合せ（どちらが後でも、どの保持日数でも）。 */
  const shapes = [
    { visit: -10 * DAY, expires: -3 * DAY, days: 30 }, // expiresAt が後
    { visit: -2 * DAY, expires: -2 * DAY + 6 * 60 * 60 * 1000, days: 1 }, // same_day 相当
    { visit: 5 * DAY, expires: 5 * DAY, days: 7 }, // 未来の来訪
    { visit: -40 * DAY, expires: -50 * DAY, days: 45 }, // visitAt が後（順序に依存しない）
  ];

  it('🔴 期限のすぐ内側では全経路で引け、期限ちょうど以降はどの経路からも引けない', async () => {
    for (const [i, shape] of shapes.entries()) {
      const { backend } = make();
      const r = res({
        id: asReservationId(`rsv-${i}`),
        visitAt: isoIn(shape.visit),
        expiresAt: isoIn(shape.expires),
        retentionDays: shape.days,
      });
      const deadline = Math.max(Date.parse(r.visitAt), Date.parse(r.expiresAt)) + shape.days * DAY;
      let now = new Date(deadline - 1);
      const repo = new DataBackedReservationRepository({ backend, now: () => now });
      expect((await repo.create(r)).ok).toBe(true);

      expect(await readable(repo, r), `inside ${JSON.stringify(shape)}`).toEqual(ALL);
      now = new Date(deadline);
      expect(await readable(repo, r), `deadline ${JSON.stringify(shape)}`).toEqual(NONE);
      now = new Date(deadline + 3 * DAY); // TTL 削除が遅延している間
      expect(await readable(repo, r)).toEqual(NONE);
    }
  });

  it('期限切れは同じサイトの他の予約の読み取りを妨げない（期限内の予約は残る）', async () => {
    const { backend } = make();
    const repo = new DataBackedReservationRepository({ backend });
    const old = res({
      id: asReservationId('rsv-old'),
      tokenHash: OTHER_HASH,
      visitAt: isoIn(-100 * DAY),
      expiresAt: isoIn(-99 * DAY),
      retentionDays: 30,
    });
    const live = res({ id: asReservationId('rsv-live') });
    await repo.create(old);
    await repo.create(live);
    expect(await readable(repo, old)).toEqual(NONE);
    expect(await readable(repo, live)).toEqual(ALL);
    expect((await repo.list(T_A, S_1)).map((x) => x.id)).toEqual(['rsv-live']);
  });

  it('書き込み時に TTL 属性（epoch 秒）を来訪の終わり + retentionDays から載せる', async () => {
    const { backend, raw } = make();
    const repo = new DataBackedReservationRepository({ backend });
    const r = res({ visitAt: isoIn(2 * DAY), expiresAt: isoIn(3 * DAY), retentionDays: 10 });
    await repo.create(r);
    const deadline = Date.parse(r.expiresAt) + 10 * DAY;
    const ttl = (await raw(r.id))?.ttl as number;
    expect(Number.isInteger(ttl)).toBe(true);
    // 物理削除は読み取り側の期限より先に起きず、遅れは 1 秒未満
    expect(ttl * 1000).toBeGreaterThanOrEqual(deadline);
    expect(ttl * 1000 - deadline).toBeLessThan(1000);
  });

  it('編集・再発行で期限が動いたら put のたびに TTL を計算し直す', async () => {
    const { backend, raw } = make();
    const repo = new DataBackedReservationRepository({ backend });
    const r = res({ visitAt: isoIn(1 * DAY), expiresAt: isoIn(2 * DAY), retentionDays: 5 });
    await repo.create(r);
    const before = (await raw(r.id))?.ttl as number;

    const moved = { ...r, expiresAt: isoIn(20 * DAY), retentionDays: 9 };
    await repo.put(moved);
    const after = (await raw(r.id))?.ttl as number;
    const deadline = Date.parse(moved.expiresAt) + 9 * DAY;
    expect(after).not.toBe(before);
    expect(after * 1000).toBeGreaterThanOrEqual(deadline);
    expect(after * 1000 - deadline).toBeLessThan(1000);
  });

  it('🔴 TTL 属性はドメイン型へ漏らさない', async () => {
    const { backend } = make();
    const repo = new DataBackedReservationRepository({ backend });
    await repo.create(res());
    for (const found of [
      await repo.get(T_A, S_1, asReservationId('rsv-1')),
      (await repo.list(T_A, S_1))[0],
      await repo.findByTokenHash(T_A, S_1, TOKEN_HASH),
    ]) {
      expect(found).toBeDefined();
      expect(Object.keys(found!)).not.toContain('ttl');
    }
  });

  /**
   * 互換性（.claude/rules/opus5-autonomous-loop.md「永続スキーマも互換なら進めてよい」）。
   * `ttl` は任意属性。本変更より前に書かれた旧レコードは持たないが、読み取り側は業務フィールド
   * から期限を計算するので、そのまま読める（期限内なら引け、期限後なら引けない）。
   */
  it('🔴 ttl 属性を持たない旧レコードも読める（期限は業務フィールドから計算する）', async () => {
    const { backend, raw } = make();
    const legacyCol = backend().collection<Record<string, unknown> & { id: string }>(
      RESERVATION_COLLECTION,
      { indexedField: 'scopedTokenHash' },
    );
    const live = res({ id: asReservationId('rsv-legacy-live') });
    const old = res({
      id: asReservationId('rsv-legacy-old'),
      tokenHash: OTHER_HASH,
      visitAt: isoIn(-60 * DAY),
      expiresAt: isoIn(-59 * DAY),
      retentionDays: 30,
    });
    for (const r of [live, old]) {
      // 旧コードの保存形そのまま（ttl を持たない）。
      await legacyCol.put({ ...r, scopedTokenHash: `${r.tenantId}#${r.siteId}#${r.tokenHash}` });
      expect(await raw(r.id)).not.toHaveProperty('ttl');
    }
    const repo = new DataBackedReservationRepository({ backend });
    expect(await readable(repo, live)).toEqual(ALL);
    expect(await repo.get(T_A, S_1, live.id)).toEqual(live);
    expect(await readable(repo, old)).toEqual(NONE);
  });

  /**
   * N1: 期限を計算できない予約（巨大・非有限・非整数の retentionDays、解釈できない日付）は
   * 書き込みを拒否し、検証を経ずに保存されていたとしても**どの読み取り経路からも返さない**。
   */
  const uncomputable: [string, Partial<VisitReservation>][] = [
    ['retentionDays=1e308', { retentionDays: 1e308 }],
    ['retentionDays=Infinity', { retentionDays: Number.POSITIVE_INFINITY }],
    ['retentionDays=NaN', { retentionDays: Number.NaN }],
    ['retentionDays=2^53', { retentionDays: 2 ** 53 }],
    ['retentionDays=1.5', { retentionDays: 1.5 }],
    ['retentionDays=0', { retentionDays: 0 }],
    ['visitAt 不正', { visitAt: 'not-a-date' }],
    ['expiresAt 不正', { expiresAt: '' }],
  ];

  it('🔴 期限を計算できない予約は create で書かずに投げる（何も保存されない）', async () => {
    for (const [label, over] of uncomputable) {
      const { backend, raw } = make();
      const repo = new DataBackedReservationRepository({ backend });
      const r = res({ id: asReservationId(`rsv-bad-${label}`), ...over });
      await expect(repo.create(r), label).rejects.toBeInstanceOf(ReservationRetentionUncomputableError);
      expect(await raw(r.id), label).toBeUndefined();
    }
  });

  it('🔴 期限を計算できない予約は put で書かずに投げる（既存レコードは変わらない）', async () => {
    for (const [label, over] of uncomputable) {
      const { backend, raw } = make();
      const repo = new DataBackedReservationRepository({ backend });
      const r = res();
      await repo.create(r);
      const before = await raw(r.id);
      await expect(repo.put({ ...r, ...over }), label).rejects.toBeInstanceOf(
        ReservationRetentionUncomputableError,
      );
      expect(await raw(r.id), label).toEqual(before);
      // 下界: 正常な put は通る（拒否が全件拒否で空虚に満たされていない）。
      await expect(repo.put({ ...r, note: 'ok' })).resolves.toBeUndefined();
    }
  });

  it('🔴 検証を経ずに保存された期限計算不能レコードは、どの時刻でもどの読み取り経路からも返さない', async () => {
    for (const [label, over] of uncomputable) {
      const { backend } = make();
      const rawCol = backend().collection<Record<string, unknown> & { id: string }>(
        RESERVATION_COLLECTION,
        { indexedField: 'scopedTokenHash' },
      );
      const r = res({ id: asReservationId('rsv-bypass'), ...over });
      await rawCol.put({ ...r, scopedTokenHash: `${r.tenantId}#${r.siteId}#${r.tokenHash}` });
      for (const t of [-400 * DAY, 0, 2 * DAY, 400 * DAY]) {
        const repo = new DataBackedReservationRepository({ backend, now: () => new Date(Date.now() + t) });
        expect(await readable(repo, r), `${label} @${t}`).toEqual(NONE);
      }
      // 対照: 同じ保存形で期限を計算できる値なら引ける（索引キーの組み立てを誤って NONE になっていない）。
      const ok = res({ id: asReservationId('rsv-bypass') });
      await rawCol.put({ ...ok, scopedTokenHash: `${ok.tenantId}#${ok.siteId}#${ok.tokenHash}` });
      expect(await readable(new DataBackedReservationRepository({ backend }), ok), label).toEqual(ALL);
    }
  });
});

