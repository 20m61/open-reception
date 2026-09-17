/**
 * VonageCallClient の単体テスト。実 SDK の代わりに fake VideoSdk を注入し、
 * connect/publish/streamCreated→onConnected、接続エラー、SDK ロード失敗、disconnect を検証する。
 * 実 SDK の DOM ロード（defaultLoadSdk）はブラウザ専用のため対象外（要ライブ検証）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { VonageCallClient, type VideoSdk, type VideoSession } from './vonage-client';

function makeSdk(connectError?: unknown) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const session: VideoSession = {
    connect: vi.fn((_token: string, cb: (e?: unknown) => void) => cb(connectError)),
    publish: vi.fn(),
    on: vi.fn((event: string, handler: (e: unknown) => void) => {
      handlers[event] = handler;
    }),
    disconnect: vi.fn(),
  };
  const sdk: VideoSdk = {
    initSession: vi.fn(() => session),
    initPublisher: vi.fn(() => ({})),
  };
  return { sdk, session, fireStreamCreated: () => handlers['streamCreated']?.({}) };
}

const baseOpts = {
  applicationId: 'app-1',
  sessionId: 'sess-1',
  token: 'jwt',
};

describe('VonageCallClient', () => {
  it('connects, publishes, and signals onConnected when a remote stream appears', async () => {
    const { sdk, session, fireStreamCreated } = makeSdk();
    const onConnected = vi.fn();
    const onError = vi.fn();
    const client = new VonageCallClient({ loadSdk: async () => sdk });

    await client.connect({ ...baseOpts, onConnected, onError });
    expect(sdk.initSession).toHaveBeenCalledWith('app-1', 'sess-1');
    expect(session.connect).toHaveBeenCalled();
    expect(session.publish).toHaveBeenCalled(); // 接続成功 → publisher を publish
    expect(onConnected).not.toHaveBeenCalled();

    fireStreamCreated(); // 担当者参加
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports onError when session.connect fails', async () => {
    const { sdk, session } = makeSdk(new Error('connect-failed'));
    const onError = vi.fn();
    const client = new VonageCallClient({ loadSdk: async () => sdk });
    await client.connect({ ...baseOpts, onConnected: vi.fn(), onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(session.publish).not.toHaveBeenCalled(); // エラー時は publish しない
  });

  it('reports onError when the SDK fails to load', async () => {
    const onError = vi.fn();
    const client = new VonageCallClient({
      loadSdk: async () => {
        throw new Error('sdk load failed');
      },
    });
    await client.connect({ ...baseOpts, onConnected: vi.fn(), onError });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('disconnect() tears down the session safely', async () => {
    const { sdk, session } = makeSdk();
    const client = new VonageCallClient({ loadSdk: async () => sdk });
    await client.connect({ ...baseOpts, onConnected: vi.fn(), onError: vi.fn() });
    await client.disconnect();
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    await expect(client.disconnect()).resolves.toBeUndefined(); // 二重 disconnect も安全
  });
});

/**
 * 🔴 **CSP の面は「このアダプタを使う画面すべて」に効く (#1132)。**
 *
 * `tests/e2e/security-headers.spec.ts` は **担当者画面 1 つ**で
 * 「Vonage SDK が CSP に拒否される」を固定している。だが同じ欠陥は
 * **このアダプタを構築する画面すべて**に在る —— e2e の散文はそう主張しているのに、
 * 「消費者が誰か」は何も縛っていなかった。
 *
 * 🔴 **手で数え上げない。** 消費者を列挙して固定するのではなく、**走査して集合を比べる**。
 * 3 つ目の消費者が増えたらここが赤くなり、「その画面にも CSP の面が在る」を
 * 判断させる（#1132 増分 2 の射程に入るかを人が決める）。
 *
 * 来訪者側（`KioskCallView`）の e2e は `page.addInitScript` で `window.OT` を偽物に置くので、
 * **`<script src>` を一度も発行せず CSP 違反も起きない** —— つまり来訪者側は
 * e2e からは踏めない。だからこそ、ここで**アダプタの共有**を縛る。
 */
describe('このアダプタを使う画面 (#1132)', () => {
  /**
   * 🔴 **走査は既存の同型に揃える** —— `src/lib/security/client-secret-guard.test.ts` の
   * `listSourceFiles`。最初は `readdirSync` → `statSync` と 2 段で書いていたが、
   * **`withFileTypes` なら 1 回で済む**（間に木が変わりうる隙も作らない）。
   * 新しい走査を発明しない。
   */
  function listSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listSourceFiles(full));
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  /**
   * 🔴 **走査は `it` の中で行う（collection 時に走らせない）。** describe 本体で
   * 全ファイルを読むと、そこで throw したときに **assertion failure ではなく
   * suite レベルのエラー**になり、「どのテストが落ちたか分からない FAIL」に見える
   * （レビュー 1 周目の指摘）。走査自体が主張の一部なので、失敗は test の中で起こす。
   */
  const SRC = join(process.cwd(), 'src');
  const rel = (f: string): string => f.slice(SRC.length + 1);
  const SELF = 'adapters/call/vonage-client.ts';

  /**
   * 🔴 **モジュールパスで走査する（レビュー 7 周目）。**
   *
   * 当初は `new VonageCallClient(` の部分文字列一致だったが、**別名 import を取りこぼす**
   * （`import { VonageCallClient as VC }` → `new VC(` になる）。実測で 3 つ目の消費者を
   * 別名で足しても**全テストが緑**だった。しかも別名 import はこのリポジトリの常用
   * イディオムで、本番コードに 6 件以上ある。
   *
   * `CLAUDE.md`「調査の作法」がまさにこれを規定している ——
   * 「識別子を `name(` と括弧付きで探すと取りこぼす」「**モジュールパスでも走査する**」
   * 「否定的な結論は 2 通り以上で確かめる」。**2 通り走査して集合の一致まで縛る。**
   */
  const importersOf = (): string[] =>
    listSourceFiles(SRC)
      .filter((f) => rel(f) !== SELF)
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return src.includes('adapters/call/vonage-client') || src.includes("from './vonage-client'");
      })
      .map(rel)
      .sort();

  const constructorsOf = (): string[] =>
    listSourceFiles(SRC)
      .filter((f) => readFileSync(f, 'utf8').includes('new VonageCallClient('))
      .map(rel)
      .sort();

  const EXPECTED_CONSUMERS = [
    'components/kiosk/KioskCallView.tsx',
    'components/staff/StaffCallView.tsx',
  ];

  /**
   * 🔴 **この走査は深さ 1 である（レビュー 8 周目 MINOR 2）。**
   *
   * 縛れるのは「`vonage-client` を**直接** import するファイルの集合」だけで、
   * 「このアダプタを使う**画面**の集合」ではない。実測: factory
   *（`new VonageCallClient(...)` を返すモジュール）を 1 枚挟むと、3 つ目の画面を足しても
   * `EXPECTED_CONSUMERS` を factory 1 件に書き換えるだけで**全テストが緑**になる ——
   * 2 通りの走査は factory で一致したままなので不一致検出も効かない。
   *
   * 推移閉包にはしない。**今日 indirection は 1 枚も無く（下の一致が示す）、
   * 守るものが無い機構は入れない**（7 周目に `ALLOWED_SOURCES` を撤回したのと同じ判断）。
   * 代わりに**射程をここに書く** —— 増分 2 が factory を導入するなら、
   * そのとき推移閉包へ替えるか、この走査を撤回して別の縛り方にすること。
   */
  it('🔴 vonage-client を直接 import する本番ファイルは担当者画面と来訪者画面の 2 つ', () => {
    expect(importersOf()).toEqual(EXPECTED_CONSUMERS);
  });

  /**
   * 🔴 **2 通りの走査が一致することまで縛る。** 片方だけを持つと、
   * 「その条件では見つからなかった」を「無い」と読んでしまう。
   * 別名 import が増えたらここがずれて赤くなる（部分文字列側だけが取りこぼす）。
   */
  it('🔴 モジュールパス走査と識別子走査の結果が一致する（片方の取りこぼしを検出する）', () => {
    expect(constructorsOf()).toEqual(importersOf());
  });

  /**
   * 🔴 **下界。** 走査が壊れて空集合を返すと、上の `toEqual` は**書き換えるまで赤い**ので
   * 気づけるが、逆に「全部のファイルを拾う」形の壊れ方は気づけない。
   * 母集団が十分大きいこと（＝走査が `src` を歩けていること）を併せて縛る。
   */
  it('走査が src を歩けている（空でも全部でもない）', () => {
    const all = listSourceFiles(SRC);
    expect(all.length).toBeGreaterThan(100);
    expect(importersOf().length).toBeLessThan(all.length);
  });
});
