/**
 * **本番の DynamoDB バックエンドを、実 DynamoDB エミュレータに対して**通す統合テスト
 * （#1103 条件 4 / ADR 0010）。
 *
 * 🔴 **特定のエミュレータに結合しない。** MiniStack / Moto / LocalStack のどれでも
 * 同じ 8 本が通ることを実測している（2026-09-14）。結合していたのは当初の到達性
 * チェックだけで、`/_localstack/health` を叩いていたため Moto で落ちた ―― 交換可能性を
 * 検証するテスト自身がロックインを持っていた。
 *
 * ## なぜ要るか
 *
 * `dynamodb.test.ts` は in-memory の fake DocumentClient に対して同じ契約を検証している。
 * fake は**自分で書いた述語**なので、実エンジンとの食い違いは原理的に検出できない
 * （`CLAUDE.md`「検証の作法」の「自分で導いた述語をそのままテストにすると、テストと
 * コードが同じ誤りを共有する」）。ここで縛るのは fake では保証できないもの:
 *
 * - **テーブル形状が実際にコードの要求と合っていること**（GSI1 が無ければ query は実際に throw する）
 * - **条件付き書き込みを実エンジンが本当に拒否すること**（fake の寛容さに寄りかからない）
 * - **TTL 属性が epoch 秒で載り、テーブル側で TTL が有効になっていること**
 * - **内部キーが呼び出し側へ漏れないこと**（PII/レスポンス衛生）
 *
 * 🔴 **エミュレータ専用の repository は作らない。** 叩くのは `getBackend()` が返す本番実装
 * そのもので、差し替えるのは `AWS_ENDPOINT_URL` だけである。
 *
 * ## 走らせ方
 *
 * `npm run local:aws:test`（`scripts/local-aws.sh test`）から実行される。単体では:
 *
 * ```
 * LOCAL_AWS_INTEGRATION=1 DATA_BACKEND=dynamodb npx vitest run src/lib/data/dynamodb.emulator.test.ts
 * ```
 *
 * 🔴 **既定の品質ゲートは変えない。** フラグが無ければ suite ごと skip する
 * （#1103 条件 6「LocalStack green を release evidence に昇格しない」）。ただし
 * **「有効なのに繋がらない」は skip ではなく FAIL** にする ―― でなければ環境が壊れた
 * ときに空虚な緑になる。
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataBackend } from './backend';

const ENABLED = process.env.LOCAL_AWS_INTEGRATION === '1';
const TABLE = process.env.TABLE_NAME ?? 'open-reception-local';
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://127.0.0.1:4566';
const TIMEOUT = 60_000;

/** 衝突しない接尾辞。並行実行や再実行で状態を共有しない。 */
const RUN = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

type Visit = {
  id: string;
  tenantId: string;
  state: 'waiting' | 'called';
  note?: string;
};

type Audit = {
  id: string;
  at: string;
  correlationId: string;
  action: string;
};

describe.skipIf(!ENABLED)('本番 DynamoDB バックエンド × 実エミュレータ', () => {
  let backend: DataBackend;
  let raw: DynamoDBDocumentClient;

  beforeAll(async () => {
    process.env.DATA_BACKEND = 'dynamodb';
    // 🔴 **本番クラスを、引数なしで env から組ませる。**
    //
    // `getBackend()` を通さないのは、その中の遅延 `require('./dynamodb')` が vitest の
    // 変換下で解決できないため（本番の Lambda と tsx では動く）。ここで欲しいのは
    // 「工場の分岐」ではなく「**実装そのものが実 DynamoDB と噛み合うか**」であり、
    // 分岐は `index.test.ts` が別途縛っている。引数なし構築は本番と同じく
    // `AWS_ENDPOINT_URL` / `TABLE_NAME` だけを見るので、LocalStack 専用の配線は無い。
    const { DynamoBackend } = await import('./dynamodb');
    backend = new DynamoBackend();
    raw = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        endpoint: ENDPOINT,
        region: process.env.AWS_REGION ?? 'ap-northeast-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }),
    );
  }, TIMEOUT);

  afterAll(() => {
    raw?.destroy();
  });

  it(
    '🔴 有効化されている以上、実際にエミュレータへ繋がること（skip で誤魔化さない）',
    async () => {
      // これが無いと、環境が落ちているときに「他のテストが全部通った」ように見える
      // 書き方（try/catch skip）へ流れやすい。繋がらないなら赤で止める。
      //
      // 🔴 **ベンダ固有の health パスで確かめない（ADR 0010）。** ここは当初
      // `/_localstack/health` を叩いており、**Moto に差し替えた瞬間に落ちた** ――
      // 交換可能性を検証するはずのテスト自身が LocalStack に結合していた。
      // 到達性は**実際に使う AWS API** で確かめる。これはどのエミュレータでも、
      // 実 AWS でも同じ意味を持つ。
      const { DynamoDBClient, ListTablesCommand } = await import('@aws-sdk/client-dynamodb');
      const probe = new DynamoDBClient({
        endpoint: ENDPOINT,
        region: process.env.AWS_REGION ?? 'ap-northeast-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      try {
        const res = await probe.send(new ListTablesCommand({}));
        expect(Array.isArray(res.TableNames), `エミュレータへ繋がらない: ${ENDPOINT}`).toBe(true);
      } finally {
        probe.destroy();
      }
    },
    TIMEOUT,
  );

  it(
    '🔴 Singleton.putIf の条件を実エンジンが評価すること（#1158。fake の述語に寄りかからない）',
    async () => {
      const s = backend.singleton<{ rev?: number; a: string }>(`it-security-${RUN}`);
      // 未作成: 「版が無い」は成立し、「版 1」は成立しない（記録が無ければ `=` は偽）。
      expect(await s.putIf({ rev: 2, a: 'no' }, { rev: 1 })).toBe(false);
      expect(await s.get()).toBeUndefined();
      expect(await s.putIf({ rev: 1, a: 'first' }, { rev: undefined })).toBe(true);
      // 在る: 版が違えば書かない。版が無いことを期待しても書かない。
      expect(await s.putIf({ rev: 9, a: 'lost' }, { rev: 2 })).toBe(false);
      expect(await s.putIf({ rev: 9, a: 'lost' }, { rev: undefined })).toBe(false);
      expect(await s.get()).toEqual({ rev: 1, a: 'first' });
      // 一致すれば置き換える。同じ版を期待した 2 本目は負ける。
      const [x, y] = await Promise.all([
        s.putIf({ rev: 2, a: 'x' }, { rev: 1 }),
        s.putIf({ rev: 2, a: 'y' }, { rev: 1 }),
      ]);
      expect([x, y].filter(Boolean)).toHaveLength(1);
      expect((await s.get())?.a).toBe(x ? 'x' : 'y');
    },
    TIMEOUT,
  );

  it(
    'GSI1 が実在し、index 越しに引けること（テーブル形状と実装の一致）',
    async () => {
      const tenantA = `tenant-a-${RUN}`;
      const col = backend.collection<Visit>(`it-visit-${RUN}`, { indexedField: 'tenantId' });

      await col.put({ id: 'v1', tenantId: tenantA, state: 'waiting' });
      await col.put({ id: 'v2', tenantId: tenantA, state: 'waiting' });

      // GSI1 がテーブルに無ければ、ここは実 DynamoDB では例外になる。
      const found = await col.listByIndex(tenantA);
      expect(found.map((v: Visit) => v.id).sort()).toEqual(['v1', 'v2']);
    },
    TIMEOUT,
  );

  it(
    '🔴 テナント越境で引けないこと（index の分離が実エンジンで成立する）',
    async () => {
      const tenantA = `tenant-a2-${RUN}`;
      const tenantB = `tenant-b2-${RUN}`;
      const col = backend.collection<Visit>(`it-tenant-${RUN}`, { indexedField: 'tenantId' });

      await col.put({ id: 'a-only', tenantId: tenantA, state: 'waiting' });

      // 上界: 自テナントからは引ける。
      expect((await col.listByIndex(tenantA)).map((v: Visit) => v.id)).toEqual(['a-only']);
      // 🔴 下界: 他テナントからは引けない。
      //
      // 🔴 **「引けない」だけを主張する assertion は、全部が壊れた世界でも通る**
      // （`CLAUDE.md` の #833 の教訓）。だから上界と必ず対で置く。
      expect(await col.listByIndex(tenantB)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    '条件付き作成を実エンジンが拒否すること（putIfAbsent の原子性）',
    async () => {
      const col = backend.collection<Visit>(`it-cond-${RUN}`, { indexedField: 'tenantId' });
      const item: Visit = { id: 'once', tenantId: `t-${RUN}`, state: 'waiting' };

      expect(await col.putIfAbsent(item), '1 回目は入るはず').toBe(true);
      expect(await col.putIfAbsent(item), '2 回目は弾かれるはず').toBe(false);
    },
    TIMEOUT,
  );

  it(
    '条件付き更新が期待値と一致するときだけ通ること',
    async () => {
      const col = backend.collection<Visit>(`it-update-${RUN}`, { indexedField: 'tenantId' });
      await col.put({ id: 'u1', tenantId: `t-${RUN}`, state: 'waiting', note: 'keep' });

      // 期待が外れているなら通らない（下界）。
      expect(await col.updateIf('u1', { state: 'called' }, { state: 'called' })).toBe(false);
      expect((await col.get('u1'))?.state, '拒否されたのに書き換わっている').toBe('waiting');

      // 期待が合っていれば通る（上界）。
      expect(await col.updateIf('u1', { state: 'called' }, { state: 'waiting' })).toBe(true);
      expect((await col.get('u1'))?.state).toBe('called');
    },
    TIMEOUT,
  );

  it(
    '🔴 TTL が epoch 秒で実際に載ること（受付セッションの失効機構）',
    async () => {
      const ttlSeconds = 300;
      const name = `it-ttl-${RUN}`;
      const col = backend.collection<Visit>(name, { ttlSeconds, indexedField: 'tenantId' });
      const before = Math.floor(Date.now() / 1000);
      await col.put({ id: 's1', tenantId: `t-${RUN}`, state: 'waiting' });
      const after = Math.floor(Date.now() / 1000);

      // 生の item を読み、属性として載っていることを確かめる
      // （backend 経由だと内部キーは剥がされるので観測できない）。
      const rawItem = await raw.send(
        new GetCommand({ TableName: TABLE, Key: { PK: `col#${name}`, SK: 's1' } }),
      );
      const ttl = rawItem.Item?.ttl;
      expect(typeof ttl, 'ttl が数値で載っていない').toBe('number');
      // 🔴 境界のすぐ内側を踏む: 近似ではなく窓で縛る。
      expect(ttl).toBeGreaterThanOrEqual(before + ttlSeconds);
      expect(ttl).toBeLessThanOrEqual(after + ttlSeconds);
    },
    TIMEOUT,
  );

  it(
    '🔴 内部キーが呼び出し側へ漏れないこと',
    async () => {
      const col = backend.collection<Visit>(`it-strip-${RUN}`, {
        ttlSeconds: 300,
        indexedField: 'tenantId',
      });
      await col.put({ id: 'k1', tenantId: `t-${RUN}`, state: 'waiting' });

      const got = await col.get('k1');
      for (const key of ['PK', 'SK', 'ttl', 'GSI1PK', 'GSI1SK']) {
        expect(got, `内部キー ${key} が漏れている`).not.toHaveProperty(key);
      }
      // 上界: 業務フィールドは残っていること（全部消す実装を弾く）。
      expect(got).toMatchObject({ id: 'k1', state: 'waiting' });
    },
    TIMEOUT,
  );

  it(
    '監査ログが時刻範囲と index の両方で引けること',
    async () => {
      const log = backend.log<Audit>(`it-audit-${RUN}`, {
        timestampField: 'at',
        indexedField: 'correlationId',
      });
      const correlationId = `corr-${RUN}`;
      const at = new Date().toISOString();
      const entry: Audit = { id: `a-${RUN}`, at, correlationId, action: 'checkin' };

      await log.put(entry);

      expect((await log.findBy('correlationId', correlationId))?.id).toBe(entry.id);
      expect((await log.listSince(at)).some((e: Audit) => e.id === entry.id)).toBe(true);
      // 下界: 未来を起点にすれば入らない（範囲条件が効いていること）。
      const future = new Date(Date.now() + 60_000).toISOString();
      expect((await log.listSince(future)).some((e: Audit) => e.id === entry.id)).toBe(false);
    },
    TIMEOUT,
  );
});
