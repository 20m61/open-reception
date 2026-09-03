import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **読み取りの失敗を「読み込み中…」と出さない** (#870 増分 03 / 04)。
 *
 * ## 何が起きていたか
 *
 * 6 つの設定画面が `if (res.ok) setX(...)` に `else` を持たず、`if (!x) return <p>読み込み中…</p>`
 * で門を閉じていた。401 / 403 / 5xx / オフラインのとき、運用者は**終わらない待ち**に入る。
 * 何が起きたのかも、再試行の手段も画面に無い。
 *
 * 営業時間設定はさらに悪く、`setLoadedScopeKey` を `if (res.ok)` の**外**で呼んでいたため
 * 「読めた」状態になり、**「まだ設定がありません（未設定の間は常時営業として扱われます）」と
 * 断定表示**していた。取得できていないことを、設定が無いことと言い換えていた。しかもその
 * 状態からの保存は `expectedVersion` を落とすので、**この画面が土台にしている楽観ロックも
 * 同時に外れる**。
 *
 * ## なぜ登録簿にするか
 *
 * **同じ欠陥は `SignageManager` と `StaffResponseManager` で修正済みで、理由まで書いてあった**
 * のに他へ伝播していなかった。「直した画面」を数えても再発は止まらないので、
 * **読み込み中…を出しうる画面を実ファイルから集め、全部に失敗系の機構を要求する**。
 *
 * 登録簿は 3 方向に落ちる（`admin-site-context.test.ts` と同じ考え方）:
 *  - 新しい画面がどちらにも無い → 落ちる（見逃さない）
 *  - 登録した機構がファイルから消えた → 落ちる（腐らせない）
 *  - 読み込み中…を出さなくなった画面が登録に残る → 落ちる（消し忘れない）
 *
 * ## 検出器を「トークンの有無」にしない
 *
 * 当初 `setError` の有無で判定しようとしたが、**`BrandingManager` はロゴ保存用の `setError` を
 * 持っていて読み取り失敗は握り潰していた** —— つまり「既に対策済みの集合としか一致しない」
 * 検出器になるところだった（本リポジトリが繰り返し踏んでいる型）。そこで**機構をファイルごとに
 * 名指しで登録**し、その名前が実ファイルに在ることだけを機械で確かめる。登録の正しさは
 * 人が読んで担保し、機械は**ずれ**を止める。
 */
const ADMIN_DIR = resolve(process.cwd(), 'src/components/admin');

/**
 * 利用者に見える「読み込み中」表示。`aria-label="読み込み中"`（`AdminNav`）や
 * スクリーンリーダ用の隠しテキスト（`Skeleton`）は門ではないので対象外にする。
 */
const LOADING_TEXT = /読み込み中…|読み込み中です/;

/**
 * コメントを落とす。**説明の散文が自分の検査に引っかかる**のを避けるため。
 * 「なぜ直したか」を書くには旧挙動の文言を引用する必要があり、引用を消して検査を通すのは
 * 説明を捨てて検査に合わせることになる（#869 / #873 で同じ型を踏んだ）。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function findTsx(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTsx(path));
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) found.push(path);
  }
  return found;
}

/**
 * 画面 → 読み取り失敗を表示に反映する機構。**値はその画面のソースに実在する識別子**。
 *
 * `AdminReadGate` は #870 で入れた共有の門（loading / failed / loaded を出し分け、失敗には
 * 再試行を添える）。それ以外は既にその画面が持っていた機構で、いずれも実物を読んで確認した。
 */
const READ_FAILURE_MECHANISM: Readonly<Record<string, string>> = {
  /**
   * 共有の門そのもの。ここが「まだ」と「だめだった」を出し分ける唯一の場所なので、
   * 走査にも引っかかる。除外せず登録する —— 除外条件を書くと、次に似た名前の
   * ファイルを作ったときに黙って対象から外れる。
   */
  'AdminReadGate.tsx': 'resolveAdminReadState',
  // #870 増分 04 で共有の門へ寄せた 6 画面。
  'AiGuidanceManager.tsx': 'AdminReadGate',
  'BrandingManager.tsx': 'AdminReadGate',
  'LanguageSettingsManager.tsx': 'AdminReadGate',
  'SecurityManager.tsx': 'AdminReadGate',
  'VoiceManager.tsx': 'AdminReadGate',
  'integrations/IntegrationsManager.tsx': 'AdminReadGate',
  // #870 増分 03。拠点別画面なので既存の `resolveScopeGate` に載せる。
  'OperatingHoursManager.tsx': 'resolveScopeGate',
  // 以下は #870 以前から失敗を出し分けていた画面（実物を読んで確認済み）。
  'ReservationsManager.tsx': 'resolveScopeGate',
  'SignageManager.tsx': 'resolveScopeGate',
  'StaffResponseManager.tsx': 'resolveScopeGate',
  /** 端末一覧の取得失敗を専用 state で持ち、「端末一覧を表示できません。」と出す。 */
  'DevicesManager.tsx': 'listError',
  /** 拠点一覧の状態から `'loading' | 'ok' | 'missing' | 'error'` を導いて出し分ける。 */
  'SiteDetail.tsx': 'listStatus',
  /** 取得の失敗だけを操作の失敗と別に持つ（`catch` でオフラインも失敗へ落とす）。 */
  'StayManager.tsx': 'setLoadFailed',
  /** 403 と取得失敗を文言で分け、`error` があるときは読み込み中…を出さない。 */
  'auth/AuthMethodSettings.tsx': 'setError',
  /** 取得失敗を `writeError` に載せ、`!flags && !writeError` のときだけ読み込み中…を出す。 */
  'platform/FeatureFlags.tsx': 'writeError',
  /**
   * 共有データテーブル (#896)。`rows` が空のとき、`loaded` / `failed` から
   * `resolveAdminReadState` で 3 状態を出し分ける。**渡さない呼び出し側は今までどおり**
   * 0 件として扱う（移行を一度に強制しない）ので、ここに載るのは部品側の保証。
   *
   * `platform/UpdateStatus.tsx` はここへ寄せた結果、自分では読み込み中…を出さなくなり
   * 登録簿から外れた（保証が消えたのではなく、この行へ移った）。移行の網羅は
   * `tests/config/platform-list-states.test.ts` が別に縛る。
   */
  'ui/DataTable.tsx': 'resolveAdminReadState',
  /**
   * platform の表の中で「読み込み中 / 失敗 / 0 件」を出し分ける行 (#896)。
   * 共有の門と**同じ 3 状態の語彙**（`resolveAdminReadState`）を使う —— `data` は失敗しても
   * `null` のままなので、`loaded` だけを見ると失敗が永遠の「読み込み中」に化ける。
   */
  'platform/primitives.tsx': 'resolveAdminReadState',
  // 明示的な phase 機械（`{ phase: 'error' }` を持ち、catch でもそこへ落とす）。
  'costs/CostManager.tsx': "phase: 'error'",
  'dashboard/Dashboard.tsx': "phase: 'error'",
  'usage/UsageManager.tsx': "phase: 'error'",
};

const SCREENS = findTsx(ADMIN_DIR)
  .map((path) => ({ key: relative(ADMIN_DIR, path), code: readFileSync(path, 'utf8') }))
  .filter((f) => LOADING_TEXT.test(f.code));

describe('読み取り失敗を「読み込み中…」と出さない (#870)', () => {
  it('読み込み中…を出す画面を 10 件以上見つけている（走査が空振りしていない＝下界）', () => {
    expect(SCREENS.length).toBeGreaterThanOrEqual(10);
  });

  it('読み込み中…を出す画面はすべて登録簿に在る（新しい画面を見逃さない）', () => {
    const missing = SCREENS.map((s) => s.key).filter((k) => !(k in READ_FAILURE_MECHANISM));
    expect(
      missing,
      '読み込み中…を出すなら、読み取りが失敗したときに別の表示へ落ちる機構が要る。' +
        'AdminReadGate か resolveScopeGate に載せ、この登録簿へ機構名を書くこと',
    ).toEqual([]);
  });

  it.each(Object.entries(READ_FAILURE_MECHANISM))(
    '%s は登録した機構 %s を実際に持つ（登録を腐らせない）',
    (key, mechanism) => {
      const screen = SCREENS.find((s) => s.key === key);
      // 読み込み中…を出さなくなった画面が登録に残っていても落とす（消し忘れ防止＝下界）。
      expect(screen, `${key} は読み込み中…を出していない。登録簿から消すこと`).toBeDefined();
      expect(screen?.code, `${key} に ${mechanism} が無い`).toContain(mechanism);
    },
  );
});

/**
 * 営業時間設定だけの追加検査 (#870 増分 03)。
 *
 * この画面の欠陥は「読み込み中…で止まる」より重い。取得に失敗すると
 * **「まだ設定がありません（未設定の間は常時営業として扱われます）」と断定表示**していた ——
 * 取得できていないことを、設定が無いことと言い換えていた。運用者は「営業時間の設定は要らない」
 * と読む。さらにその状態からの保存は `expectedVersion` を落とすので、**楽観ロック（#367）も
 * 同時に外れる**。
 *
 * 断定表示そのものは正常時には必要なので消せない。**到達順**で縛る:
 * 出せない理由がある間に早期 return していれば、断定表示へは原理的に到達しない。
 */
describe('営業時間: 取得失敗を「未設定」と言い換えない (#870 増分 03)', () => {
  // 到達順を見るので、コメント中の引用に当たらないよう落としてから走査する。
  const SOURCE = stripComments(readFileSync(join(ADMIN_DIR, 'OperatingHoursManager.tsx'), 'utf8'));

  it('「未設定」の断定表示より前に、出せない理由での早期 return がある', () => {
    const gate = SOURCE.indexOf('gate.unavailable !== null');
    const assertion = SOURCE.indexOf('まだ設定がありません');
    expect(gate, '出せない理由での早期 return が無い').toBeGreaterThan(-1);
    expect(assertion, '未設定の断定表示が見つからない（文言が変わったら本検査を見直す）').toBeGreaterThan(-1);
    expect(assertion, '断定表示が門より前にある').toBeGreaterThan(gate);
  });

  it('取得できたときだけ「読めた」ことにする（setLoadedScopeKey を成功枝の中でだけ呼ぶ）', () => {
    // 失敗枝で「読めた」にすると、上の到達順の検査を満たしたまま断定表示へ入れてしまう。
    const failureBranch = SOURCE.indexOf('setLoadFailed(true);');
    const markLoaded = SOURCE.indexOf('setLoadedScopeKey(requestedScope);');
    expect(failureBranch).toBeGreaterThan(-1);
    expect(markLoaded, '成功枝で「読めた」にしていない').toBeGreaterThan(failureBranch);
  });

  it('保存の可否はハンドラとボタンで同じ値を見る（サイレント no-op を作らない）', () => {
    // 片方だけ強くすると「押せるのに何も起きない」になる（#552 で実際に P1 になった型）。
    const occurrences = SOURCE.split('gate.canMutate').length - 1;
    expect(occurrences, 'ハンドラとボタンの両方で gate.canMutate を見ていない').toBeGreaterThanOrEqual(2);
  });
});
