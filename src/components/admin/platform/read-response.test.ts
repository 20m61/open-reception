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
  AUDIT_ROW_STRINGS,
  COST_AVAILABLE_STRINGS,
  COST_PERIOD_STRINGS,
  INCIDENT_ROW_STRINGS,
  INTEGRATION_ROW_BOOLEANS,
  INTEGRATION_ROW_STRINGS,
  MAINTENANCE_DEVICE_ROW_STRINGS,
  MAINTENANCE_WINDOW_ROW_STRINGS,
  NOTICE_ROW_STRINGS,
  OBSERVABILITY_DEVICE_NUMBERS,
  OBSERVABILITY_RECEPTION_NUMBERS,
  TENANT_DETAIL_NUMBERS,
  TENANT_DETAIL_STRINGS,
  TENANT_SITE_NUMBERS,
  TENANT_SITE_STRINGS,
  UPDATE_ROW_STRINGS,
  UPDATE_STATE_COUNTS,
  isAuditLogsShape,
  isAwsCostShape,
  isDashboardShape,
  isFlagsSummaryShape,
  isIntegrationsShape,
  isMaintenanceShape,
  isObservabilityShape,
  isProviderConfigShape,
  isRecord,
  isTenantDetailShape,
  isTenantFlagsShape,
  isTenantListPageShape,
  isTenantListShape,
  isUpdateStatusShape,
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
const EXPECT_SUMMARY_KEYS = ['voiceSynthesis', 'avatarReception'] as const;
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
      expect(isFlagsSummaryShape(VALID_FLAGS_SUMMARY, EXPECT_SUMMARY_KEYS)).toBe(true);
    });

    it.each(['enabled', 'configured'])('flags.vonage.%s が欠けたら通さない', (key) => {
      expect(
        isFlagsSummaryShape({ flags: { vonage: without(VALID_FLAGS_SUMMARY.flags.vonage, key) } }, EXPECT_SUMMARY_KEYS),
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
        }, EXPECT_SUMMARY_KEYS),
      ).toBe(false);
    });

    it('🔴 authMethods の 2 件目だけが壊れていても通さない', () => {
      expect(
        isFlagsSummaryShape({
          flags: { ...VALID_FLAGS_SUMMARY.flags, authMethods: [VALID_AUTH_METHOD, null] },
        }, EXPECT_SUMMARY_KEYS),
      ).toBe(false);
    });

    /*
     * 🔴 **下界: 空配列は正当。** これが無いと「常に false」で上の主張が空虚に通る。
     * レビューの実測では、この下界が無かったために `.every` → `.some` の変異が
     * **生存していた**（`authMethods: []` を踏むものが無かった）。
     */
    it('下界: authMethods が 0 件でも通る', () => {
      expect(isFlagsSummaryShape({ flags: { ...VALID_FLAGS_SUMMARY.flags, authMethods: [] } }, EXPECT_SUMMARY_KEYS)).toBe(
        true,
      );
    });

    it('flags.authMethods が配列でなければ通さない', () => {
      expect(isFlagsSummaryShape({ flags: { ...VALID_FLAGS_SUMMARY.flags, authMethods: {} } }, EXPECT_SUMMARY_KEYS)).toBe(false);
      expect(isFlagsSummaryShape({ flags: { ...VALID_FLAGS_SUMMARY.flags, authMethods: [null] } }, EXPECT_SUMMARY_KEYS)).toBe(false);
    });

    it.each(['voiceSynthesis', 'avatarReception'])('flags.%s が欠けたら通さない', (key) => {
      expect(isFlagsSummaryShape({ flags: without(VALID_FLAGS_SUMMARY.flags, key) }, EXPECT_SUMMARY_KEYS)).toBe(false);
    });

    it.each(['defaultEnabled', 'disabledTenants'])(
      'flags.voiceSynthesis.%s が欠けたら通さない',
      (key) => {
        expect(
          isFlagsSummaryShape({
            flags: { ...VALID_FLAGS_SUMMARY.flags, voiceSynthesis: without(VALID_FLAG_SUMMARY, key) },
          }, EXPECT_SUMMARY_KEYS),
        ).toBe(false);
      },
    );

    /*
     * 🔴 **互換の向き (#968 レビュー 9 周目 m6)。**
     *
     * サーバが**画面の読まないフラグを増やしても**読めなくならないこと。8 周目は
     * `TENANT_FEATURE_FLAG_KEYS`（ドメイン定数）から導出していたので、キーを 1 つ足すと
     * **描画は増えないのに述語だけ厳しくなり**、クライアント先行デプロイの skew で
     * 機能フラグ画面が丸ごと「形式が不正です」になった。
     */
    it('🔴 画面が読まないフラグが増えても読めなくならない', () => {
      const withExtra = {
        flags: { ...VALID_FLAGS_SUMMARY.flags, someNewFlag: { defaultEnabled: true } },
      };
      expect(isFlagsSummaryShape(withExtra, EXPECT_SUMMARY_KEYS)).toBe(true);
    });

    it('🔴 画面が読むフラグが欠けたら通さない（下界と対）', () => {
      expect(
        isFlagsSummaryShape({ flags: without(VALID_FLAGS_SUMMARY.flags, 'avatarReception') }, EXPECT_SUMMARY_KEYS),
      ).toBe(false);
    });

    it('flags.vonage が null / 欠落なら通さない', () => {
      expect(isFlagsSummaryShape({ flags: { vonage: null } }, EXPECT_SUMMARY_KEYS)).toBe(false);
      expect(isFlagsSummaryShape({ flags: {} }, EXPECT_SUMMARY_KEYS)).toBe(false);
      expect(isFlagsSummaryShape({ flags: null }, EXPECT_SUMMARY_KEYS)).toBe(false);
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

    /*
     * 🔴 **混在配列（先頭は正しく、後ろが壊れている）(#968 レビュー 8 周目 m2)。**
     *
     * `[null]` だけを注入していると、`.every` を**「先頭要素だけ検査」**へ書き換える変異が
     * 素通りする（レビューが実測）。`.some` への書き換えは「0 件も正当」の下界に偶然
     * 引っかかって落ちていただけで、**混在配列を踏むオラクルではなかった**。
     * `isTenantFlagsShape` にだけ同型の主張があり、配列述語 3 つには無かった ——
     * `CLAUDE.md`「同型の 2 本には対策を入れており、3 本目にだけ入れ忘れていた」の族。
     */
    it('🔴 sites の 2 件目だけが壊れていても通さない（先頭だけ検査に退行させない）', () => {
      expect(isTenantDetailShape({ ...VALID_DETAIL, sites: [VALID_SITE, null] })).toBe(false);
      expect(
        isTenantDetailShape({ ...VALID_DETAIL, sites: [VALID_SITE, without(VALID_SITE, 'id')] }),
      ).toBe(false);
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

    it('🔴 tenants の 2 件目だけが壊れていても通さない', () => {
      expect(isTenantListShape({ tenants: [VALID_TENANT_ROW, null] })).toBe(false);
      expect(
        isTenantListShape({ tenants: [VALID_TENANT_ROW, without(VALID_TENANT_ROW, 'id')] }),
      ).toBe(false);
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

/**
 * #973: **形の検査が無かった platform 7 画面**の述語（#968 が台帳へ積んだ残り）。
 *
 * 上の #968 の行列と同じ形で書く —— **(a) 正しい形は通る（下界）** と
 * **(b) 1 フィールド落とすと落ちる**を対にする。期待値は実装の定数から導かず、
 * ここへベタ書きしたうえで「実装の一覧と一致すること」を別に固定する
 * （実装から項目を削る変異が、テストの反復対象まで一緒に削るのを防ぐ）。
 *
 * 🔴 **下界を「配列が空でも通る」まで含めて張る。** 7 画面はどれも一覧で、
 * 0 件は**正当**である（`config: null` が正当な「未設定」なのと同じ）。
 * 片側だけ主張すると「全部を失敗と断定する」変異が空虚に通る。
 */
const VALID_AUDIT_ROW = { id: 'a1', at: '2026-09-05T00:00:00Z', action: 'tenant.suspend', actor: 'dev-***' } as const;
const EXPECT_AUDIT_ROW_STRINGS = ['id', 'at', 'action', 'actor'] as const;

const VALID_INTEGRATION_ROW = {
  id: 'vonage',
  label: 'Vonage',
  configured: true,
  enabled: true,
  lastResult: 'success',
} as const;
const EXPECT_INTEGRATION_ROW_STRINGS = ['id', 'label', 'lastResult'] as const;
const EXPECT_INTEGRATION_ROW_BOOLEANS = ['configured', 'enabled'] as const;

const VALID_INTEGRATIONS = {
  integrations: [VALID_INTEGRATION_ROW],
  authMethods: [VALID_AUTH_METHOD],
} as const;

const VALID_OBSERVABILITY = {
  integrations: [VALID_INTEGRATION_ROW],
  recentActivity: [VALID_AUDIT_ROW],
  reception: { receptions: 12, successRate: 0.75, callFailures: 2, noAnswer: 1 },
  devices: { total: 4, online: 3, offline: 1, maintenance: 0, disabled: 2 },
} as const;
const EXPECT_RECEPTION_NUMBERS = ['receptions', 'callFailures', 'noAnswer'] as const;
const EXPECT_DEVICE_NUMBERS = ['total', 'online', 'offline', 'maintenance', 'disabled'] as const;

const VALID_MAINTENANCE_DEVICE = {
  tenantId: 't1',
  tenantName: 'テナント A',
  siteId: 's1',
  deviceId: 'd1',
  deviceName: '受付 1',
} as const;
const VALID_INCIDENT = {
  id: 'i1',
  scope: 'platform',
  severity: 'major',
  status: 'investigating',
  title: '通話が繋がらない',
  startedAt: '2026-09-05T00:00:00Z',
  active: true,
} as const;
const VALID_WINDOW = {
  id: 'w1',
  scope: 'platform',
  status: 'scheduled',
  startsAt: '2026-09-06T00:00:00Z',
  endsAt: '2026-09-06T01:00:00Z',
  message: '定期メンテナンス',
  impact: 'limited',
  open: true,
} as const;
const VALID_NOTICE = {
  id: 'n1',
  scope: 'platform',
  level: 'info',
  title: 'お知らせ',
  status: 'published',
  publishedAt: '2026-09-05T00:00:00Z',
  active: true,
} as const;
const VALID_MAINTENANCE = {
  summary: { devicesInMaintenance: 1, devices: [VALID_MAINTENANCE_DEVICE] },
  incidents: { activeCount: 1, incidents: [VALID_INCIDENT] },
  windows: { scheduledCount: 1, activeCount: 0, windows: [VALID_WINDOW] },
  notices: { activeCount: 1, notices: [VALID_NOTICE] },
} as const;
const EXPECT_MAINTENANCE_DEVICE_STRINGS = ['deviceId', 'deviceName', 'tenantName', 'siteId'] as const;
const EXPECT_INCIDENT_STRINGS = ['id', 'scope', 'severity', 'status', 'title', 'startedAt'] as const;
const EXPECT_WINDOW_STRINGS = ['id', 'scope', 'status', 'impact', 'message', 'startsAt', 'endsAt'] as const;
const EXPECT_NOTICE_STRINGS = ['id', 'scope', 'level', 'status', 'title', 'publishedAt'] as const;

const VALID_UPDATE_ROW = {
  id: 'u1',
  scope: 'device',
  component: 'kiosk',
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  state: 'update_available',
  checkedAt: '2026-09-05T00:00:00Z',
  pending: true,
} as const;
const VALID_UPDATES = {
  updates: {
    pendingCount: 1,
    totalCount: 2,
    byState: { up_to_date: 1, update_available: 1, updating: 0, failed: 0 },
    updates: [VALID_UPDATE_ROW],
  },
} as const;
const EXPECT_UPDATE_ROW_STRINGS = ['id', 'scope', 'component', 'currentVersion', 'latestVersion', 'state', 'checkedAt'] as const;
const EXPECT_UPDATE_STATE_COUNTS = ['update_available', 'failed'] as const;

const VALID_TENANT_LIST_ROW = { ...VALID_TENANT_ROW, updatedAt: '2026-09-05T00:00:00Z' } as const;
const VALID_TENANT_LIST_PAGE = {
  summary: { total: 3, active: 2, suspended: 1 },
  tenants: [VALID_TENANT_LIST_ROW],
} as const;

const VALID_COST_AVAILABLE = {
  status: 'available',
  currency: 'USD',
  period: { monthStart: '2026-09-01', actualEndExclusive: '2026-09-05' },
  filters: { project: 'open-reception', environment: 'dev', component: 'all' },
  actualToDate: 12.34,
  forecastRemaining: 5,
  monthEndEstimate: 17.34,
  breakdownBy: 'Component',
  breakdown: [{ key: 'Web', amount: 1.2 }],
  updatedAt: '2026-09-05T00:00:00Z',
  forecastAvailable: true,
  forecastUnavailableReason: null,
} as const;
const VALID_COST_UNAVAILABLE = {
  status: 'unavailable',
  reason: 'disabled',
  message: 'コスト取得は無効です。',
  filters: { project: 'open-reception', environment: 'dev', component: 'all' },
  updatedAt: '2026-09-05T00:00:00Z',
} as const;
const EXPECT_COST_AVAILABLE_STRINGS = ['currency', 'breakdownBy', 'updatedAt'] as const;
const EXPECT_COST_PERIOD_STRINGS = ['monthStart', 'actualEndExclusive'] as const;

describe('read-response: 形の検査が無かった 7 画面 (#973)', () => {
  it('🔴 検査対象の一覧は、テストの期待値と一致する（黙って減らせない）', () => {
    expect([...AUDIT_ROW_STRINGS]).toEqual([...EXPECT_AUDIT_ROW_STRINGS]);
    expect([...INTEGRATION_ROW_STRINGS]).toEqual([...EXPECT_INTEGRATION_ROW_STRINGS]);
    expect([...INTEGRATION_ROW_BOOLEANS]).toEqual([...EXPECT_INTEGRATION_ROW_BOOLEANS]);
    expect([...OBSERVABILITY_RECEPTION_NUMBERS]).toEqual([...EXPECT_RECEPTION_NUMBERS]);
    expect([...OBSERVABILITY_DEVICE_NUMBERS]).toEqual([...EXPECT_DEVICE_NUMBERS]);
    expect([...MAINTENANCE_DEVICE_ROW_STRINGS]).toEqual([...EXPECT_MAINTENANCE_DEVICE_STRINGS]);
    expect([...INCIDENT_ROW_STRINGS]).toEqual([...EXPECT_INCIDENT_STRINGS]);
    expect([...MAINTENANCE_WINDOW_ROW_STRINGS]).toEqual([...EXPECT_WINDOW_STRINGS]);
    expect([...NOTICE_ROW_STRINGS]).toEqual([...EXPECT_NOTICE_STRINGS]);
    expect([...UPDATE_ROW_STRINGS]).toEqual([...EXPECT_UPDATE_ROW_STRINGS]);
    expect([...UPDATE_STATE_COUNTS]).toEqual([...EXPECT_UPDATE_STATE_COUNTS]);
    expect([...COST_AVAILABLE_STRINGS]).toEqual([...EXPECT_COST_AVAILABLE_STRINGS]);
    expect([...COST_PERIOD_STRINGS]).toEqual([...EXPECT_COST_PERIOD_STRINGS]);
  });

  describe('isAuditLogsShape', () => {
    it('下界: 正しい形は通る（0 件も正当）', () => {
      expect(isAuditLogsShape({ logs: [VALID_AUDIT_ROW] })).toBe(true);
      expect(isAuditLogsShape({ logs: [] })).toBe(true);
    });

    /*
     * 🔴 **`[null]` は `Array.isArray` の 1 段検査を通ったうえで `rowKey` が投げる。**
     * #968 の BLOCKER-1 と同じ形で、運用コンソールに来訪者向け文言が出る経路。
     */
    it('要素が壊れていたら通さない', () => {
      expect(isAuditLogsShape({ logs: [null] })).toBe(false);
      expect(isAuditLogsShape({ logs: {} })).toBe(false);
      expect(isAuditLogsShape({})).toBe(false);
      expect(isAuditLogsShape(null)).toBe(false);
    });

    it.each([...EXPECT_AUDIT_ROW_STRINGS])('行の %s だけが欠けても通さない', (key) => {
      expect(isAuditLogsShape({ logs: [without(VALID_AUDIT_ROW, key)] })).toBe(false);
    });

    /** 任意フィールド（詳細列）は欠けていても正当 —— 互換の方向を逆にしない。 */
    it('下界: 任意の詳細フィールドが無くても通る', () => {
      expect(isAuditLogsShape({ logs: [{ ...VALID_AUDIT_ROW, targetType: undefined }] })).toBe(true);
    });
  });

  describe('isIntegrationsShape', () => {
    it('下界: 正しい形は通る（両方 0 件も正当）', () => {
      expect(isIntegrationsShape(VALID_INTEGRATIONS)).toBe(true);
      expect(isIntegrationsShape({ integrations: [], authMethods: [] })).toBe(true);
    });

    it.each([...EXPECT_INTEGRATION_ROW_STRINGS])('連携行の %s だけが欠けても通さない', (key) => {
      expect(
        isIntegrationsShape({ ...VALID_INTEGRATIONS, integrations: [without(VALID_INTEGRATION_ROW, key)] }),
      ).toBe(false);
    });

    it.each([...EXPECT_INTEGRATION_ROW_BOOLEANS])('連携行の %s が真偽値でなければ通さない', (key) => {
      expect(
        isIntegrationsShape({
          ...VALID_INTEGRATIONS,
          integrations: [{ ...VALID_INTEGRATION_ROW, [key]: 'true' }],
        }),
      ).toBe(false);
    });

    /** `issues.length` は欠けると投げる（#968 の `authMethods` と同じ経路）。 */
    it.each(['id', 'label', 'enabled', 'issues'])('ログイン方式の %s だけが欠けても通さない', (key) => {
      expect(
        isIntegrationsShape({ ...VALID_INTEGRATIONS, authMethods: [without(VALID_AUTH_METHOD, key)] }),
      ).toBe(false);
    });

    it('片方の一覧だけが在る応答は通さない', () => {
      expect(isIntegrationsShape({ integrations: [VALID_INTEGRATION_ROW] })).toBe(false);
      expect(isIntegrationsShape({ authMethods: [VALID_AUTH_METHOD] })).toBe(false);
    });
  });

  describe('isObservabilityShape', () => {
    it('下界: 正しい形は通る（一覧が 0 件でも正当）', () => {
      expect(isObservabilityShape(VALID_OBSERVABILITY)).toBe(true);
      expect(isObservabilityShape({ ...VALID_OBSERVABILITY, integrations: [], recentActivity: [] })).toBe(true);
    });

    /**
     * 🔴 **`successRate` は `number | null` が正当。** 受付が 0 件の月は `null` になる
     * （`formatPercent` が `null` を受ける）。ここを「数値必須」にすると、
     * **正常な月初を「読めなかった」と誤報する**。
     */
    it('下界: successRate は null でも通る（受付 0 件の月）', () => {
      expect(
        isObservabilityShape({
          ...VALID_OBSERVABILITY,
          reception: { ...VALID_OBSERVABILITY.reception, successRate: null },
        }),
      ).toBe(true);
    });

    it('successRate のキーごと欠けたら通さない', () => {
      expect(
        isObservabilityShape({
          ...VALID_OBSERVABILITY,
          reception: without(VALID_OBSERVABILITY.reception, 'successRate'),
        }),
      ).toBe(false);
    });

    it.each([...EXPECT_RECEPTION_NUMBERS])('reception.%s だけが欠けても通さない', (key) => {
      expect(
        isObservabilityShape({ ...VALID_OBSERVABILITY, reception: without(VALID_OBSERVABILITY.reception, key) }),
      ).toBe(false);
    });

    it.each([...EXPECT_DEVICE_NUMBERS])('devices.%s だけが欠けても通さない', (key) => {
      expect(
        isObservabilityShape({ ...VALID_OBSERVABILITY, devices: without(VALID_OBSERVABILITY.devices, key) }),
      ).toBe(false);
    });

    it('直近アクティビティの要素が壊れていたら通さない', () => {
      expect(isObservabilityShape({ ...VALID_OBSERVABILITY, recentActivity: [null] })).toBe(false);
    });

    it('連携行の要素が壊れていたら通さない', () => {
      expect(isObservabilityShape({ ...VALID_OBSERVABILITY, integrations: [{}] })).toBe(false);
    });
  });

  describe('isMaintenanceShape', () => {
    it('下界: 正しい形は通る（4 つの一覧が全部 0 件でも正当）', () => {
      expect(isMaintenanceShape(VALID_MAINTENANCE)).toBe(true);
      expect(
        isMaintenanceShape({
          summary: { devicesInMaintenance: 0, devices: [] },
          incidents: { activeCount: 0, incidents: [] },
          windows: { scheduledCount: 0, activeCount: 0, windows: [] },
          notices: { activeCount: 0, notices: [] },
        }),
      ).toBe(true);
    });

    it.each(['summary', 'incidents', 'windows', 'notices'])('%s の節ごと欠けたら通さない', (key) => {
      expect(isMaintenanceShape(without(VALID_MAINTENANCE, key))).toBe(false);
    });

    /**
     * 🔴 **件数カードは欠けても投げない ——「—」で無言になる。**
     * `windows` は `scheduledCount + activeCount` を足すので、片方が欠けると
     * **`NaN` が画面に出る**（#968 の `receptionsToday` と同じ族）。
     */
    it.each(['scheduledCount', 'activeCount'])('windows.%s だけが欠けても通さない', (key) => {
      expect(
        isMaintenanceShape({ ...VALID_MAINTENANCE, windows: without(VALID_MAINTENANCE.windows, key) }),
      ).toBe(false);
    });

    it('summary.devicesInMaintenance / incidents.activeCount / notices.activeCount が欠けたら通さない', () => {
      expect(
        isMaintenanceShape({ ...VALID_MAINTENANCE, summary: without(VALID_MAINTENANCE.summary, 'devicesInMaintenance') }),
      ).toBe(false);
      expect(
        isMaintenanceShape({ ...VALID_MAINTENANCE, incidents: without(VALID_MAINTENANCE.incidents, 'activeCount') }),
      ).toBe(false);
      expect(
        isMaintenanceShape({ ...VALID_MAINTENANCE, notices: without(VALID_MAINTENANCE.notices, 'activeCount') }),
      ).toBe(false);
    });

    it.each([...EXPECT_MAINTENANCE_DEVICE_STRINGS])('端末行の %s だけが欠けても通さない', (key) => {
      expect(
        isMaintenanceShape({
          ...VALID_MAINTENANCE,
          summary: { ...VALID_MAINTENANCE.summary, devices: [without(VALID_MAINTENANCE_DEVICE, key)] },
        }),
      ).toBe(false);
    });

    it.each([...EXPECT_INCIDENT_STRINGS])('障害行の %s だけが欠けても通さない', (key) => {
      expect(
        isMaintenanceShape({
          ...VALID_MAINTENANCE,
          incidents: { ...VALID_MAINTENANCE.incidents, incidents: [without(VALID_INCIDENT, key)] },
        }),
      ).toBe(false);
    });

    it.each([...EXPECT_WINDOW_STRINGS])('予定メンテナンス行の %s だけが欠けても通さない', (key) => {
      expect(
        isMaintenanceShape({
          ...VALID_MAINTENANCE,
          windows: { ...VALID_MAINTENANCE.windows, windows: [without(VALID_WINDOW, key)] },
        }),
      ).toBe(false);
    });

    it.each([...EXPECT_NOTICE_STRINGS])('お知らせ行の %s だけが欠けても通さない', (key) => {
      expect(
        isMaintenanceShape({
          ...VALID_MAINTENANCE,
          notices: { ...VALID_MAINTENANCE.notices, notices: [without(VALID_NOTICE, key)] },
        }),
      ).toBe(false);
    });
  });

  describe('isUpdateStatusShape', () => {
    it('下界: 正しい形は通る（0 件も正当）', () => {
      expect(isUpdateStatusShape(VALID_UPDATES)).toBe(true);
      expect(
        isUpdateStatusShape({
          updates: { pendingCount: 0, totalCount: 0, byState: { update_available: 0, failed: 0 }, updates: [] },
        }),
      ).toBe(true);
    });

    it.each(['pendingCount', 'totalCount'])('updates.%s だけが欠けても通さない', (key) => {
      expect(isUpdateStatusShape({ updates: without(VALID_UPDATES.updates, key) })).toBe(false);
    });

    it.each([...EXPECT_UPDATE_STATE_COUNTS])('byState.%s だけが欠けても通さない', (key) => {
      expect(
        isUpdateStatusShape({
          updates: { ...VALID_UPDATES.updates, byState: without(VALID_UPDATES.updates.byState, key) },
        }),
      ).toBe(false);
    });

    /**
     * 🔴 **`byState` に画面が読まない状態が増えても通す。** サーバが新しい
     * `UpdateState` を足したときに画面が丸ごと落ちるのは互換の方向が逆
     * （`read-response.ts` 冒頭の戒め）。
     */
    it('下界: 画面が読まない状態が増えても通る', () => {
      expect(
        isUpdateStatusShape({
          updates: {
            ...VALID_UPDATES.updates,
            byState: { ...VALID_UPDATES.updates.byState, rolling_back: 3 },
          },
        }),
      ).toBe(true);
    });

    it.each([...EXPECT_UPDATE_ROW_STRINGS])('行の %s だけが欠けても通さない', (key) => {
      expect(
        isUpdateStatusShape({ updates: { ...VALID_UPDATES.updates, updates: [without(VALID_UPDATE_ROW, key)] } }),
      ).toBe(false);
    });

    it('行の pending が真偽値でなければ通さない', () => {
      expect(
        isUpdateStatusShape({
          updates: { ...VALID_UPDATES.updates, updates: [{ ...VALID_UPDATE_ROW, pending: 'yes' }] },
        }),
      ).toBe(false);
    });
  });

  describe('isTenantListPageShape', () => {
    it('下界: 正しい形は通る（0 件も正当）', () => {
      expect(isTenantListPageShape(VALID_TENANT_LIST_PAGE)).toBe(true);
      expect(isTenantListPageShape({ summary: { total: 0, active: 0, suspended: 0 }, tenants: [] })).toBe(true);
    });

    it.each(['total', 'active', 'suspended'])('summary.%s だけが欠けても通さない', (key) => {
      expect(
        isTenantListPageShape({ ...VALID_TENANT_LIST_PAGE, summary: without(VALID_TENANT_LIST_PAGE.summary, key) }),
      ).toBe(false);
    });

    /**
     * 🔴 **一覧画面は `updatedAt` を列に出す。** ヘッダの `TenantSwitcher`（`isTenantRowShape`）は
     * 読まないので、**画面ごとに述語を分ける**（型の全項目を検査しない、の裏返し）。
     */
    it.each(['id', 'name', 'slug', 'status', 'updatedAt'])('行の %s だけが欠けても通さない', (key) => {
      expect(
        isTenantListPageShape({ ...VALID_TENANT_LIST_PAGE, tenants: [without(VALID_TENANT_LIST_ROW, key)] }),
      ).toBe(false);
    });

    it('summary ごと欠けたら通さない', () => {
      expect(isTenantListPageShape({ tenants: [VALID_TENANT_LIST_ROW] })).toBe(false);
    });
  });

  describe('isAwsCostShape', () => {
    it('下界: available / unavailable のどちらも通る', () => {
      expect(isAwsCostShape(VALID_COST_AVAILABLE)).toBe(true);
      expect(isAwsCostShape(VALID_COST_UNAVAILABLE)).toBe(true);
    });

    it('下界: 内訳 0 件・予測なしでも通る', () => {
      expect(
        isAwsCostShape({
          ...VALID_COST_AVAILABLE,
          breakdown: [],
          forecastRemaining: null,
          monthEndEstimate: null,
          forecastAvailable: false,
          forecastUnavailableReason: 'no_history',
        }),
      ).toBe(true);
    });

    it('知らない status は通さない（画面は何も描けない）', () => {
      expect(isAwsCostShape({ ...VALID_COST_AVAILABLE, status: 'partial' })).toBe(false);
      expect(isAwsCostShape({})).toBe(false);
      expect(isAwsCostShape(null)).toBe(false);
    });

    /** `data?.filters.environment` は `filters` が無いと投げる（optional chain は `data` で止まる）。 */
    it('filters が欠けたら通さない（どちらの status でも）', () => {
      expect(isAwsCostShape(without(VALID_COST_AVAILABLE, 'filters'))).toBe(false);
      expect(isAwsCostShape(without(VALID_COST_UNAVAILABLE, 'filters'))).toBe(false);
    });

    it.each([...EXPECT_COST_AVAILABLE_STRINGS])('available の %s だけが欠けても通さない', (key) => {
      expect(isAwsCostShape(without(VALID_COST_AVAILABLE, key))).toBe(false);
    });

    it.each([...EXPECT_COST_PERIOD_STRINGS])('period.%s だけが欠けても通さない', (key) => {
      expect(isAwsCostShape({ ...VALID_COST_AVAILABLE, period: without(VALID_COST_AVAILABLE.period, key) })).toBe(false);
    });

    it.each(['actualToDate', 'forecastRemaining', 'monthEndEstimate', 'forecastAvailable', 'breakdown'])(
      'available の %s だけが欠けても通さない',
      (key) => {
        expect(isAwsCostShape(without(VALID_COST_AVAILABLE, key))).toBe(false);
      },
    );

    it('内訳の要素が壊れていたら通さない', () => {
      expect(isAwsCostShape({ ...VALID_COST_AVAILABLE, breakdown: [null] })).toBe(false);
      expect(isAwsCostShape({ ...VALID_COST_AVAILABLE, breakdown: [{ key: 'Web' }] })).toBe(false);
    });

    it('unavailable の message が欠けたら通さない', () => {
      expect(isAwsCostShape(without(VALID_COST_UNAVAILABLE, 'message'))).toBe(false);
      expect(isAwsCostShape(without(VALID_COST_UNAVAILABLE, 'updatedAt'))).toBe(false);
    });
  });
});
