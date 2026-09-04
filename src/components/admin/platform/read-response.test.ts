/**
 * 述語の**緊さ**を 1 フィールドずつ縛る (#968 レビュー 6 周目の変異行列 N3 / N4 / N9 / N6)。
 *
 * ## なぜこのファイルが要るのか
 *
 * 6 周目の行列で「述語から**検査を 1 つだけ**落とす」変異が **3 件生存した**
 * （`status` / `secretPresence` / `every`→`some`）。原因は e2e の注入が
 * `{"detail":{}}` `{"config":{}}` のように**全フィールドを一度に落とした**形しか
 * 持っていなかったこと —— どれか 1 つの検査が残っていれば弾かれるので、
 * **どの 1 つを消しても緑のまま**だった。
 *
 * `.claude/rules/opus5-autonomous-loop.md`:
 * 「**近似の緊さは fixture でしか縛れない。境界の“すぐ内側”を踏む入力が無いと、
 * 境界を狭める変異が全部素通りする**」。ここがその「すぐ内側」である。
 *
 * ## 主張の形
 *
 * 各述語について **(a) 正しい形は通る（下界）** と **(b) 1 フィールド落とすと落ちる**
 * を対で書く。(b) だけだと「常に false」で空虚に通り、(a) だけだと「常に true」で通る。
 */
import { describe, expect, it } from 'vitest';
import {
  TENANT_DETAIL_NUMBERS,
  TENANT_DETAIL_STRINGS,
  TENANT_SITE_NUMBERS,
  TENANT_SITE_STRINGS,
  isDashboardShape,
  isFlagsSummaryShape,
  isProviderConfigShape,
  isRecord,
  isTenantDetailShape,
  isTenantFlagsShape,
  isTenantListShape,
  TENANT_ROW_STRINGS,
} from './read-response';

/** `obj` から `key` を落とした複製（`undefined` 代入ではなくキーごと消す）。 */
function without<T extends Record<string, unknown>>(obj: T, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key];
  return copy;
}

/*
 * 🔴 **期待値は実装の定数から**導かない** (#968 レビュー 6 周目の変異 S2 / S3 / S5)。
 *
 * 最初は `it.each(TENANT_DETAIL_STRINGS)`（＝**実装の定数**）と書いていた。すると**その定数から項目を
 * 削る変異は、テストの反復対象も同時に削る** —— 検査されなくなったフィールドについて
 * テストは何も言わなくなり、**緑のまま保証だけが消える**。実測で 3 件が生存した
 * （`slug` / `maintenanceDeviceCount` / サイトの `id`）。`status` だけ死んだのは、
 * e2e に「破壊的操作を出さない」という**帰結の主張**が別に在ったからで、
 * それが無い 3 件は自己参照の輪だけが唯一のオラクルだった。
 *
 * `CLAUDE.md`「検証の作法」:「**自分で導いた述語をそのままテストにすると、テストと
 * コードが同じ誤りを共有する**」。1 フィールドずつ縛る行列を書いた当の場所で踏んだ。
 *
 * だから期待値は**ここにベタ書きし**、実装の定数とは「一致すること」を別途固定する。
 * 実装から項目が消えれば一致固定が落ちるし、反復は消えた項目を検査し続ける。
 */
const EXPECT_DETAIL_STRINGS = ['name', 'slug', 'status'] as const;
const EXPECT_DETAIL_NUMBERS = [
  'siteCount',
  'deviceCount',
  'activeDeviceCount',
  'maintenanceDeviceCount',
] as const;
const EXPECT_SITE_STRINGS = ['id', 'name', 'status'] as const;
const EXPECT_SITE_NUMBERS = ['deviceCount', 'activeDeviceCount'] as const;

const VALID_SITE = {
  id: 's1',
  name: '本社',
  status: 'active',
  deviceCount: 2,
  activeDeviceCount: 1,
} as const;

const VALID_DETAIL = {
  name: 'テナント A',
  slug: 'tenant-a',
  status: 'active',
  siteCount: 1,
  deviceCount: 2,
  activeDeviceCount: 1,
  maintenanceDeviceCount: 0,
  sites: [VALID_SITE],
} as const;

const VALID_DASHBOARD = {
  fleet: { total: 3, active: 2, suspended: 1 },
  receptionsToday: { total: 5, connected: 3, timeout: 1, failed: 1 },
} as const;
const VALID_AUTH_METHOD = { id: 'password', label: '共有パスワードログイン', enabled: true, issues: [] } as const;
const VALID_FLAG_SUMMARY = { defaultEnabled: true, disabledTenants: 0 } as const;
const VALID_FLAGS_SUMMARY = {
  flags: {
    vonage: { enabled: true, configured: false },
    authMethods: [VALID_AUTH_METHOD],
    voiceSynthesis: VALID_FLAG_SUMMARY,
    avatarReception: VALID_FLAG_SUMMARY,
  },
} as const;
const EXPECT_AUTH_METHOD_KEYS = ['id', 'label', 'enabled', 'issues'] as const;
const VALID_TENANT_ROW = { id: 't1', name: 'テナント A', slug: 'tenant-a', status: 'active' } as const;
const EXPECT_TENANT_ROW_STRINGS = ['id', 'name', 'slug', 'status'] as const;
const VALID_CONFIG = {
  config: { provider: 'vonage', enabled: true, secretPresence: 'missing' },
} as const;
const FLAG_KEYS = ['a', 'b'] as const;
const VALID_TENANT_FLAGS = { flags: { a: true, b: false } } as const;

describe('read-response: 述語の緊さ (#968)', () => {
  /*
   * 🔴 **`isRecord` の変異は等価だった（実測）。** 9 箇所の呼び出しが直後に必ず
   * 名前付きフィールドを要求するので、配列を通しても結果が変わらない —— つまり
   * **振る舞いのテストでは殺せない**。ここは「契約の固定」であって振る舞いの主張ではない。
   * 固定する理由は `isTenantFlagsShape` が `keys.every(...)` を使っていること:
   * keys が空になれば `every` は真になり、そのとき配列が通ってしまう。
   */
  /*
   * 🔴 **実装の一覧とテストの期待値が一致していること。**
   * 反復をベタ書きへ移しただけだと、実装から項目が消えたとき「述語は緩くなったが
   * テストは古い項目を検査し続ける」形になり、どちらが正しいのか誰も判定できない。
   * 一致を固定しておけば、**実装を緩めた瞬間にここが落ちる**。
   */
  it('🔴 検査対象の一覧は、テストの期待値と一致する（黙って減らせない）', () => {
    expect([...TENANT_DETAIL_STRINGS]).toEqual([...EXPECT_DETAIL_STRINGS]);
    expect([...TENANT_DETAIL_NUMBERS]).toEqual([...EXPECT_DETAIL_NUMBERS]);
    expect([...TENANT_SITE_STRINGS]).toEqual([...EXPECT_SITE_STRINGS]);
    expect([...TENANT_SITE_NUMBERS]).toEqual([...EXPECT_SITE_NUMBERS]);
  });

  it('isRecord: 配列と null はレコードでない（契約の固定）', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  describe('isDashboardShape', () => {
    it('下界: 正しい形は通る', () => {
      expect(isDashboardShape(VALID_DASHBOARD)).toBe(true);
    });

    it.each(['total', 'active', 'suspended'])('fleet.%s が欠けたら通さない', (key) => {
      expect(isDashboardShape({ fleet: without(VALID_DASHBOARD.fleet, key) })).toBe(false);
    });

    it.each(['total', 'active', 'suspended'])('fleet.%s が数値でなければ通さない', (key) => {
      expect(isDashboardShape({ fleet: { ...VALID_DASHBOARD.fleet, [key]: '3' } })).toBe(false);
    });

    /*
     * 🔴 **`receptionsToday` は投げないが**無言になる** (#968 レビュー 7 周目 MAJOR-2)。**
     * 画面は `data?.receptionsToday?.total ?? '—'` と optional chain で読むので、
     * 欠けても例外にならず **4 枚のカードが `—` のまま**になる。「まだ来ていない」と
     * 「取れなかった」が区別できない —— #968 AC2 が名指しした無言の `—` そのもの。
     */
    it.each(['total', 'connected', 'timeout', 'failed'])(
      'receptionsToday.%s が欠けたら通さない',
      (key) => {
        expect(
          isDashboardShape({ ...VALID_DASHBOARD, receptionsToday: without(VALID_DASHBOARD.receptionsToday, key) }),
        ).toBe(false);
      },
    );

    it('receptionsToday そのものが欠けたら通さない', () => {
      expect(isDashboardShape({ fleet: VALID_DASHBOARD.fleet })).toBe(false);
    });

    it('fleet が null / 配列 / 欠落なら通さない', () => {
      expect(isDashboardShape({ fleet: null })).toBe(false);
      expect(isDashboardShape({ fleet: [] })).toBe(false);
      expect(isDashboardShape({})).toBe(false);
      expect(isDashboardShape(null)).toBe(false);
    });
  });

  describe('isFlagsSummaryShape', () => {
    it('下界: 正しい形は通る', () => {
      expect(isFlagsSummaryShape(VALID_FLAGS_SUMMARY)).toBe(true);
    });

    it.each(['enabled', 'configured'])('flags.vonage.%s が欠けたら通さない', (key) => {
      expect(
        isFlagsSummaryShape({ flags: { vonage: without(VALID_FLAGS_SUMMARY.flags.vonage, key) } }),
      ).toBe(false);
    });

    /*
     * 🔴 **`authMethods[]` の要素まで (#968 レビュー 7 周目 MAJOR-1)。**
     * `{"authMethods":[{}]}` は 6 周目の述語を**通ったうえで** `m.issues.length` が
     * 投げていた。これが「X1（error boundary 削除）は等価」という私の主張を
     * 崩した実例 —— 述語が受理する応答で投げる経路が実在した。
     */
    it.each(EXPECT_AUTH_METHOD_KEYS)('flags.authMethods[].%s が欠けたら通さない', (key) => {
      expect(
        isFlagsSummaryShape({
          flags: { ...VALID_FLAGS_SUMMARY.flags, authMethods: [without(VALID_AUTH_METHOD, key)] },
        }),
      ).toBe(false);
    });

    it('flags.authMethods が配列でなければ通さない', () => {
      expect(isFlagsSummaryShape({ flags: { ...VALID_FLAGS_SUMMARY.flags, authMethods: {} } })).toBe(false);
      expect(isFlagsSummaryShape({ flags: { ...VALID_FLAGS_SUMMARY.flags, authMethods: [null] } })).toBe(false);
    });

    it.each(['voiceSynthesis', 'avatarReception'])('flags.%s が欠けたら通さない', (key) => {
      expect(isFlagsSummaryShape({ flags: without(VALID_FLAGS_SUMMARY.flags, key) })).toBe(false);
    });

    it.each(['defaultEnabled', 'disabledTenants'])(
      'flags.voiceSynthesis.%s が欠けたら通さない',
      (key) => {
        expect(
          isFlagsSummaryShape({
            flags: { ...VALID_FLAGS_SUMMARY.flags, voiceSynthesis: without(VALID_FLAG_SUMMARY, key) },
          }),
        ).toBe(false);
      },
    );

    it('flags.vonage が null / 欠落なら通さない', () => {
      expect(isFlagsSummaryShape({ flags: { vonage: null } })).toBe(false);
      expect(isFlagsSummaryShape({ flags: {} })).toBe(false);
      expect(isFlagsSummaryShape({ flags: null })).toBe(false);
    });
  });

  describe('isTenantFlagsShape', () => {
    it('下界: 正しい形は通る', () => {
      expect(isTenantFlagsShape(VALID_TENANT_FLAGS, FLAG_KEYS)).toBe(true);
    });

    /*
     * 🔴 **`every` → `some` を殺すのはこの 1 本だけ。** 6 周目に生存した変異 N9。
     * 「全部欠けた `{}`」では `some` も偽になるので、**1 つだけ残った**形が要る。
     */
    it.each(FLAG_KEYS)('flags.%s だけが欠けても通さない（some では通ってしまう）', (key) => {
      expect(isTenantFlagsShape({ flags: without(VALID_TENANT_FLAGS.flags, key) }, FLAG_KEYS)).toBe(
        false,
      );
    });

    it('真偽でない値を通さない', () => {
      expect(isTenantFlagsShape({ flags: { a: true, b: 'false' } }, FLAG_KEYS)).toBe(false);
    });
  });

  describe('isTenantDetailShape', () => {
    it('下界: 正しい形は通る（拠点 0 件も正当）', () => {
      expect(isTenantDetailShape(VALID_DETAIL)).toBe(true);
      expect(isTenantDetailShape({ ...VALID_DETAIL, sites: [] })).toBe(true);
    });

    /*
     * 🔴 **`status` の 1 件が 6 周目に生存した変異 N3。** これが欠けると
     * `data.status === 'active' ? … : '有効化する'` が undefined で偽になり、
     * **状態が読めていないテナントに破壊的操作を提示**する。
     */
    it.each(EXPECT_DETAIL_STRINGS)('%s だけが欠けても通さない', (key) => {
      expect(isTenantDetailShape(without(VALID_DETAIL, key))).toBe(false);
    });

    it.each(EXPECT_DETAIL_NUMBERS)('%s だけが欠けても通さない', (key) => {
      expect(isTenantDetailShape(without(VALID_DETAIL, key))).toBe(false);
    });

    /*
     * 🔴 **要素まで見る。** `{"sites":[null]}` は `Array.isArray` を通ったうえで
     * `rowKey={(s) => s.id}` が投げる（6 周目に X1 を追う途中で見つけた実欠陥）。
     */
    it('sites の要素が null なら通さない', () => {
      expect(isTenantDetailShape({ ...VALID_DETAIL, sites: [null] })).toBe(false);
    });

    it.each(EXPECT_SITE_STRINGS)('sites[].%s だけが欠けても通さない', (key) => {
      expect(isTenantDetailShape({ ...VALID_DETAIL, sites: [without(VALID_SITE, key)] })).toBe(
        false,
      );
    });

    it.each(EXPECT_SITE_NUMBERS)('sites[].%s だけが欠けても通さない', (key) => {
      expect(isTenantDetailShape({ ...VALID_DETAIL, sites: [without(VALID_SITE, key)] })).toBe(
        false,
      );
    });

    it('sites が配列でなければ通さない', () => {
      expect(isTenantDetailShape({ ...VALID_DETAIL, sites: {} })).toBe(false);
      expect(isTenantDetailShape({ ...VALID_DETAIL, sites: null })).toBe(false);
    });
  });

  /*
   * 🔴 **ここだけは `error.tsx` が受けられない (#968 レビュー 7 周目 BLOCKER-1)。**
   *
   * `TenantSwitcher` は `src/app/platform/layout.tsx` が描画しており、Next の
   * `error.tsx` は**同じセグメントの layout が投げた例外を捕まえない**。
   * `{"tenants":[null]}` は `Array.isArray` の 1 段検査を通り、
   * `resolveViewingContext` の `tenants.map((t) => t.id)` が投げ、例外は root まで
   * 上がって **platform の全画面**が来訪者向け 4 言語の文言になっていた（レビュー実測）。
   */
  describe('isTenantListShape', () => {
    it('下界: 正しい形は通る（0 件も正当）', () => {
      expect(isTenantListShape({ tenants: [VALID_TENANT_ROW] })).toBe(true);
      expect(isTenantListShape({ tenants: [] })).toBe(true);
    });

    it('要素が null なら通さない（ヘッダが投げる形）', () => {
      expect(isTenantListShape({ tenants: [null] })).toBe(false);
    });

    it.each(EXPECT_TENANT_ROW_STRINGS)('tenants[].%s だけが欠けても通さない', (key) => {
      expect(isTenantListShape({ tenants: [without(VALID_TENANT_ROW, key)] })).toBe(false);
    });

    it('tenants が配列でない / 欠落なら通さない', () => {
      expect(isTenantListShape({ tenants: {} })).toBe(false);
      expect(isTenantListShape({})).toBe(false);
      expect(isTenantListShape(null)).toBe(false);
    });

    it('🔴 検査対象の一覧は、テストの期待値と一致する', () => {
      expect([...TENANT_ROW_STRINGS]).toEqual([...EXPECT_TENANT_ROW_STRINGS]);
    });
  });

  describe('isProviderConfigShape', () => {
    it('下界: 正しい形は通る', () => {
      expect(isProviderConfigShape(VALID_CONFIG)).toBe(true);
    });

    /*
     * 🔴 **下界その 2: `config: null` は「まだ設定が無い」正当な応答。**
     * これを失敗と呼ぶと、未設定のテナントで永遠に設定できなくなる。
     */
    it('下界: config: null は正当（未設定であって失敗ではない）', () => {
      expect(isProviderConfigShape({ config: null })).toBe(true);
    });

    /*
     * 🔴 **`secretPresence` の 1 件が 6 周目に生存した変異 N4。** これが欠けると
     * secret を「未設定」と断定したうえ、**楽観ロックの無い全置換 upsert** の
     * 保存導線が開く —— 実在する secret を既定値で上書きできてしまう。
     */
    it.each(['provider', 'enabled', 'secretPresence'])('config.%s だけが欠けても通さない', (key) => {
      expect(isProviderConfigShape({ config: without(VALID_CONFIG.config, key) })).toBe(false);
    });

    /*
     * 🔴 **`warnings` も画面が読む (#968 レビュー 7 周目 MAJOR-1)。**
     * `(data?.warnings ?? []).map(...)` は `{}` を `??` が素通りさせるので投げる。
     * 任意フィールドなので「無い」は正当、「在るが配列でない」だけを弾く。
     */
    it('warnings が在るのに配列でなければ通さない', () => {
      expect(isProviderConfigShape({ ...VALID_CONFIG, warnings: {} })).toBe(false);
    });

    it('下界: warnings が無い / 配列なら通る', () => {
      expect(isProviderConfigShape({ ...VALID_CONFIG, warnings: [] })).toBe(true);
      expect(isProviderConfigShape(VALID_CONFIG)).toBe(true);
    });

    it('config キー自体が無い応答は「未設定」ではなく「読めなかった」', () => {
      expect(isProviderConfigShape({})).toBe(false);
      expect(isProviderConfigShape(null)).toBe(false);
    });
  });
});
