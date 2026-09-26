import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_DEFAULT_PIN, hashPin, isHashedPin, isPinConfigured, ITERATIONS } from '@/domain/security/pin';
import { getBackend } from '@/lib/data';
import {
  __resetSecurity,
  getSecuritySettings,
  readSecuritySettings,
  revisionOf,
  updateSecuritySettings,
  verifyPin,
} from './security-store';

/**
 * 管理画面と同じく、**現在の版を付けて**保存する (#1158: 版なしの更新は緊急停止のトグルしか
 * 受け付けない)。このファイルが縛るのは PIN の意味論なので、版の扱いは concurrency 側に任せる。
 */
async function save(patch: Record<string, unknown>) {
  return updateSecuritySettings({ rev: revisionOf((await getSecuritySettings()).rev), ...patch });
}

beforeEach(async () => {
  await __resetSecurity();
});

describe('security-store (#23 #29)', () => {
  it('既定では PIN 不要', async () => {
    expect((await getSecuritySettings()).pinRequired).toBe(false);
  });

  it('PIN 不要なら任意の入力で許可', async () => {
    expect(await verifyPin('')).toBe(true);
  });

  it('PIN 必須に変更し、一致のみ許可する', async () => {
    await save({ pinRequired: true, pin: '1234' });
    expect(await verifyPin('1234')).toBe(true);
    expect(await verifyPin('9999')).toBe(false);
  });

  /**
   * 🔴 **保存されるのはハッシュで、平文は残らない (#1021 AC3)。**
   *
   * 設定ストアのダンプ・バックアップ・永続層の中身に PIN の平文が出ない、が目的。
   * （4 桁なのでハッシュが漏れれば総当たりできる。総当たり対策は AC4 の仕事で、
   * ここで達成しているのは「平文で置かない」ことだけ。）
   */
  it('🔴 保存した PIN は平文で残らない', async () => {
    const updated = await save({ pinRequired: true, pin: '4821' });
    expect(updated.pin).not.toContain('4821');
    expect(isHashedPin(updated.pin)).toBe(true);
    // 🔴 **永続層の生レコードで主張する（自動セキュリティレビューの指摘を受けて強化）。**
    //    返り値や `getSecuritySettings()` は加工を挟むので、「書かれた値」を直接見る。
    //    ハッシュ化は代入時ではなく **`put` の直前**で行っているため、ここが本当の境界である。
    const raw = (await getBackend()
      .singleton<{ pin: string }>('security', { default: () => ({ pin: '' }) })
      .get()) as { pin: string };
    expect(raw.pin).not.toContain('4821');
    expect(isHashedPin(raw.pin)).toBe(true);
    // 下界: それでも本人は通る（ハッシュにして終わり、ではない）。
    expect(await verifyPin('4821')).toBe(true);
  });

  /**
   * 🔴 **旧レコード（平文）を読めなくしない（読み互換）。**
   *
   * 既存の設定ストアには平文 PIN が入っている。読めなくすると
   * `pinRequired: true` のサイトが**誰も authorize できなくなる** ——
   * しかも管理画面からは直せない（PIN を変えるには authorize が要らないが、
   * 端末は止まる）。**ストアへ直接置いて**実行時に確かめる。
   */
  it('🔴 平文のまま保存されている旧レコードでも照合できる', async () => {
    await getBackend().singleton('security', { default: () => ({}) }).put({
      pinRequired: true,
      pin: '4821',
      ipAllowlist: [],
      emergencyStop: false,
    });
    expect(await verifyPin('4821')).toBe(true);
    expect(await verifyPin('9999')).toBe(false);
  });

  /**
   * 🔴 **`pinConfigured` は「運用者が決めたか」を答える (#1021 MAJOR-8)。**
   * 以前は `pin !== ''` で、既定値が `'0000'` で入るため**常に true** だった。
   */
  it('🔴 既定のままなら未設定、決めたら設定済み', async () => {
    expect(isPinConfigured(await getSecuritySettings())).toBe(false);
    const updated = await save({ pin: '4821' });
    expect(isPinConfigured(updated)).toBe(true);
  });

  /**
   * 🔴 **今日の振る舞いを保存する（#1021 AC3 は fail closed にしない）。**
   *
   * 既定 PIN を拒否するのは **PIN 制御の境界変更**なので、この増分ではやらない
   * （ユーザー判断で「読み互換＋ハッシュ書き」を選んだ）。既定のまま `pinRequired` を
   * 立てたサイトが**今日と同じように**通ることを固定する ——
   * ここが無いと、既定を空にする変異が「PIN が強くなった」ように見えて通ってしまう。
   */
  it('🔴 既定のままでも組込み既定の PIN で通る（振る舞いを変えていない）', async () => {
    await save({ pinRequired: true });
    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(true);
    expect(await verifyPin('9999')).toBe(false);
  });

  /** 🔴 `KIOSK_PIN` を入れた運用者は「設定済み」と読まれる（既定と区別する）。 */
  it('🔴 KIOSK_PIN を入れていれば設定済みとして扱う', async () => {
    vi.stubEnv('KIOSK_PIN', '4821');
    await __resetSecurity();
    const settings = await getSecuritySettings();
    expect(isPinConfigured(settings)).toBe(true);
    await save({ pinRequired: true });
    expect(await verifyPin('4821')).toBe(true);
    // 下界: 組込み既定では通らない（env を読んでいることの確認）。
    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(false);
    vi.unstubAllEnvs();
  });

  /**
   * 🔴 **BLOCKER の実行時の対照（レビュー 1 周目）。**
   *
   * `.env.example` が配る `KIOSK_PIN=`（空）のまま `pinRequired: true` にしたサイトで、
   * **PIN を送らない要求が通っていた**（`verifyPin('')` が true）。
   * 空 env は「未設定」として組込み既定へ落とし、空入力は通さない。
   */
  it('🔴 KIOSK_PIN が空でも、PIN 無しの要求は通らない', async () => {
    vi.stubEnv('KIOSK_PIN', '');
    await __resetSecurity();
    await save({ pinRequired: true });
    expect(await verifyPin('')).toBe(false);
    // 下界: 組込み既定へ落ちている（全部拒否にして満たしていない）。
    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(true);
    // 空 env を「運用者が決めた」と読まない。
    expect(isPinConfigured(await getSecuritySettings())).toBe(false);
    vi.unstubAllEnvs();
  });

  /**
   * 🔴 **MAJOR 2 の実行時の対照（レビュー 1 周目）。**
   *
   * 実測: `KIOSK_PIN` を入れたサイトで **PIN と無関係な更新を 1 回する**だけで、
   * `defaults()` 由来の**平文がそのまま永続化**されていた
   * （DynamoDB backend は `default` を使わないので実デプロイでも起きる）。
   */
  it('🔴 PIN と無関係な更新でも、永続レコードに平文が残らない', async () => {
    vi.stubEnv('KIOSK_PIN', 'SECRET-9137');
    await __resetSecurity();
    const updated = await save({ emergencyStop: true });
    expect(updated.pin).not.toContain('SECRET-9137');
    expect(isHashedPin(updated.pin)).toBe(true);
    // 下界: 昇格しても本人は通る。
    await save({ pinRequired: true });
    expect(await verifyPin('SECRET-9137')).toBe(true);
    vi.unstubAllEnvs();
  });

  /**
   * 🔴 **昇格しても「設定済み」が嘘にならない（MAJOR 2 と MAJOR-8 の両立）。**
   *
   * 既定値もハッシュへ昇格するので「ハッシュ＝運用者が決めた」は成り立たない。
   * 明示フィールドで持つことを、**既定のまま別項目を更新する**ケースで確かめる。
   */
  it('🔴 既定のまま更新してもハッシュになるが、未設定のままと答える', async () => {
    const updated = await save({ emergencyStop: true });
    expect(isHashedPin(updated.pin)).toBe(true);
    expect(isPinConfigured(updated)).toBe(false);
    // 下界: 組込み既定で通る（昇格で壊していない）。
    await save({ pinRequired: true });
    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(true);
  });

  /** 🔴 旧レコードの平文も、次の書き込みで昇格する（永続層から平文が消える）。 */
  it('🔴 旧レコードの平文は次の更新でハッシュへ昇格する', async () => {
    await getBackend().singleton('security', { default: () => ({}) }).put({
      pinRequired: true,
      pin: '4821',
      ipAllowlist: [],
      emergencyStop: false,
    });
    const updated = await save({ emergencyStop: true });
    expect(updated.pin).not.toContain('4821');
    expect(await verifyPin('4821')).toBe(true);
    // 旧レコードにフラグは無いので、昇格後も「運用者が決めた」と読める必要がある。
    expect(isPinConfigured(updated)).toBe(true);
  });

  /**
   * 🔴 **旧レコードの `0000` が、昇格の瞬間に「設定済み」へ化けない。**
   *
   * 昇格するとハッシュになり形式からは判定できないので、**昇格前の平文**で
   * フラグを確定させる必要がある。ここが無いと #1021 MAJOR-8 が別経路で再発する。
   */
  it('🔴 旧レコードが組込み既定なら、昇格しても未設定のまま', async () => {
    await getBackend().singleton('security', { default: () => ({}) }).put({
      pinRequired: true,
      pin: BUILTIN_DEFAULT_PIN,
      ipAllowlist: [],
      emergencyStop: false,
    });
    const updated = await save({ emergencyStop: true });
    expect(isHashedPin(updated.pin)).toBe(true);
    expect(isPinConfigured(updated)).toBe(false);
    // 下界: それでも組込み既定では通る（今日の振る舞いを保っている）。
    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(true);
  });

  /**
   * 🔴 **空の保存値は fail closed で、画面はそれを正直に言う (#1160・ユーザー判断)。**
   *
   * `.env.example` の `KIOSK_PIN=`（空）を使っていたサイトが管理画面で 1 度保存すると
   * `pin: ''` が永続化される。レビュー 2 周目 MAJOR 1 の時点では「通る入力が無いのに
   * 画面は既定値が有効と言う」嘘を、**既定値へ倒す**ことで解いていた。#1160 で倒す向きを
   * 「誰も通さない」へ変えたので、嘘は `storedPinUnreadable`（画面の警告）で解く。
   */
  it('🔴 空の保存値では誰も通らず、未設定とも言わない（読めないと言う）', async () => {
    await getBackend().singleton('security', { default: () => ({}) }).put({
      pinRequired: true,
      pin: '',
      ipAllowlist: [],
      emergencyStop: false,
    });
    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(false);
    expect(await verifyPin('')).toBe(false);
    expect(isPinConfigured(await getSecuritySettings())).toBe(false);
    expect((await readSecuritySettings()).storedPinUnreadable).toBe(true);
  });

  /**
   * 🔴 **判定と保存で同じ正規化を使う（レビュー 2 周目 MINOR 8。変異が生存していた）。**
   *
   * 以前は `trim()` で「設定済みか」を判定しながら**未 trim の値を保存**していたので、
   * `KIOSK_PIN=" 4821 "` は「設定済み」と読まれるのに、端末では前後の空白ごと
   * 入力しないと通らない（iPad の numeric キーボードでは入力できない）。
   */
  it('🔴 KIOSK_PIN の前後の空白は落として保存する', async () => {
    vi.stubEnv('KIOSK_PIN', '  4821  ');
    await __resetSecurity();
    await save({ pinRequired: true });
    expect(await verifyPin('4821')).toBe(true);
    expect(await verifyPin('  4821  ')).toBe(false);
    vi.unstubAllEnvs();
  });

  /**
   * 🔴 **MAJOR 1 の下界（レビュー 3 周目）。** 3 状態化を読み側にだけ入れた結果、
   * `unusable` な記録が昇格で**平文として封入**され、**記録文字列がそのまま PIN**になっていた
   * （実測: 緊急停止を 1 回押すだけで発火し、ダンプを見た者が authorize できた）。
   */
  it('🔴 読めない記録は、別項目の更新後もその文字列で authorize できない', async () => {
    const unusable = `pbkdf2-sha256$2000000$AAAAAAAAAAAAAAAAAAAAAA==$BBBB`;
    await getBackend().singleton('security', { default: () => ({}) }).put({
      pinRequired: true,
      pin: unusable,
      pinSetByOperator: true,
      ipAllowlist: [],
      emergencyStop: false,
    });
    await save({ emergencyStop: true });
    expect(await verifyPin(unusable)).toBe(false);
    // 🔴 #1160（ユーザー判断で fail closed）: 既定値へも化けない。
    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(false);
    // 読めない資格情報を「設定済み」と表示しない。
    expect(isPinConfigured(await getSecuritySettings())).toBe(false);
  });

  /**
   * 🔴 **運用者が PIN 欄へ入力した文字列は、綴りが何であっても本人の PIN になる。**
   *
   * 🔴 **この主張を、前は 1 綴りでしか測っていなかった（レビュー 4 周目 MAJOR 1）。**
   * `iterations` が上限超え（＝`classify` が `unusable`）の綴りだけを当てており、
   * **隣の `hash` の綴りは壊れていた** —— 保存形式の判定（`isHashedPin`）を
   * **入力にも当てていた**ので「もうハッシュ済み」と見なされ、昇格せず素通りしていた。
   * 実測した壊れ方:
   *
   * - その文字列でも `0000` でも通らない ＝ **通る入力が 1 つも無い**（沈黙の締め出し）
   * - なのに `pinConfigured` は `true`（画面は「設定済み」と言う）
   * - 入力が**平文のまま永続層に残る**（本増分の本旨に反する）
   * - `iterations` を仕込めるので、**未認証の** `authorize` の CPU を 5ms → 478ms にできる
   *
   * テストの doc が**実測より広い主張**になっている型なので、`classify` の 4 通りを
   * 総当たりで縛る（族の見落としは、1 綴りずつ足しても塞がらない）。
   */
  it.each([
    ['plaintext（ふつうの入力）', '4821'],
    ['hash（正当な記録の形。これが壊れていた）', 'pbkdf2-sha256$10000$AAAAAAAAAAAAAAAAAAAAAA==$BBBB'],
    ['unusable（反復回数が上限超え）', 'pbkdf2-sha256$2000000$AAAAAAAAAAAAAAAAAAAAAA==$BBBB'],
    ['うちの形式でない区切り', 'pbkdf2-sha256$10000$AAAA'],
  ])('🔴 運用者の入力はそのまま本人の PIN になる: %s', async (_label, input) => {
    await __resetSecurity();
    await save({ pinRequired: true, pin: input });
    expect(await verifyPin(input)).toBe(true);
    // 下界 1: 入力を捨てて既定値へ落としていない（沈黙の誤動作になっていない）。
    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(false);
    // 下界 2: 表示と挙動が一致している。
    expect(isPinConfigured(await getSecuritySettings())).toBe(true);
  });

  /**
   * 🔴 **運用者の入力は平文で残らない（AC3 の本旨。上と対で縛る）。**
   *
   * 上の 1 本だけだと「保存せず素通りさせる」実装でも満たせてしまう
   * （実際、壊れていたときの `plaintext` 綴りはそれで通っていた）。
   * **永続レコードの生の値**を見て、入力そのものが残っていないことを言う。
   */
  it.each([
    ['plaintext', '4821'],
    ['hash の形', 'pbkdf2-sha256$10000$AAAAAAAAAAAAAAAAAAAAAA==$BBBB'],
    ['unusable の形', 'pbkdf2-sha256$2000000$AAAAAAAAAAAAAAAAAAAAAA==$BBBB'],
  ])('🔴 入力した文字列は永続層に残らない: %s', async (_label, input) => {
    await __resetSecurity();
    await save({ pinRequired: true, pin: input });
    const raw = await getBackend()
      .singleton<Record<string, unknown>>('security', { default: () => ({}) })
      .get();
    expect(raw?.pin).not.toBe(input);
    // 下界: 保存されたのは**うちの記録**である（空や既定値へ化けていない）。
    expect(isHashedPin(String(raw?.pin))).toBe(true);
  });

  /**
   * 🔴 **未認証経路の計算量を、管理操作から引き上げられない（レビュー 4 周目 MAJOR 1 の 3 番目）。**
   *
   * `pin` 欄へ `pbkdf2-sha256$1000000$…` を入れると、壊れていた実装では**その記録が
   * そのまま保存**され、未認証の `authorize` 1 回が 478ms（通常 5ms の約 90 倍）になった。
   * `pin.ts` が `MAX_ITERATIONS` を緩く取る根拠にしている「到達には記録を書ける権限が要る」を
   * **管理 API が反証していた**。保存後の記録が `ITERATIONS` で作られていることを縛る。
   */
  it('🔴 管理 API から反復回数を仕込めない', async () => {
    await __resetSecurity();
    await save({
      pinRequired: true,
      pin: 'pbkdf2-sha256$1000000$AAAAAAAAAAAAAAAAAAAAAA==$BBBB',
    });
    const raw = await getBackend()
      .singleton<Record<string, unknown>>('security', { default: () => ({}) })
      .get();
    expect(String(raw?.pin).split('$')[1]).toBe(String(ITERATIONS));
  });

  /**
   * 🔴 **この実装が書いたレコードは、必ずフラグを持つ（レビュー 4 周目 MINOR 3）。**
   *
   * バックフィルが昇格ブロックの**内側**に在ったため、`pin` が既にハッシュのレコードでは
   * `pinSetByOperator` が**永久に `undefined`** のままだった。`types.ts` は
   * 「無い場合は旧レコードとして判定する」と書いているのに、**それを強制する機構が無かった**。
   */
  it('🔴 書き戻したレコードは pinSetByOperator を必ず持つ', async () => {
    const stored = await hashPin(BUILTIN_DEFAULT_PIN);
    await getBackend().singleton('security', { default: () => ({}) }).put({
      pinRequired: true,
      pin: stored,
      ipAllowlist: [],
      emergencyStop: false,
    });
    await save({ emergencyStop: true });
    const raw = await getBackend()
      .singleton<Record<string, unknown>>('security', { default: () => ({}) })
      .get();
    expect(raw?.pinSetByOperator).toBeTypeOf('boolean');
    // 下界: 埋めるついでに**意味を変えていない**（旧レコードの推定をそのまま固定する）。
    expect(await verifyPin(BUILTIN_DEFAULT_PIN)).toBe(true);
  });

  /**
   * 🔴 **空の PIN で既存の PIN を上書きさせない（変異検証で生存した穴）。**
   *
   * `o.pin.trim() !== ''` を落とす変異が**全テストを素通りした**。落とすと空文字が
   * そのまま代入され、昇格が `hashPin('')` を作る —— 照合側は `input === ''` を常に
   * 拒否するので、**その時点で誰も authorize できなくなる**のに `pinConfigured` は
   * `true` のままになる（**沈黙の締め出し**）。管理画面の PIN 欄を空のまま保存すれば
   * 踏める（PUT は部分更新なので、空欄＝「変えない」が運用者の意図である）。
   *
   * 空白だけの入力も同じ（`trim()` 後に空になる綴り）。
   */
  it.each(['', '   '])('🔴 PIN 欄が空（%j）の保存は既存の PIN を変えない', async (blank) => {
    await save({ pinRequired: true, pin: '4821' });
    await save({ pin: blank, emergencyStop: true });
    expect(await verifyPin('4821')).toBe(true);
    // 下界: 空が「通る入力」になっていない（締め出しでも素通しでもない）。
    expect(await verifyPin('')).toBe(false);
    expect(isPinConfigured(await getSecuritySettings())).toBe(true);
  });

  /**
   * 🔴 **MAJOR 2 の下界（同）。** 運用者が `0000` を入力すると「設定済み」と表示されるが、
   * 有効な PIN は**公開既定値**である。この PR 自身が `.env.example` で
   * 「0000 なら未設定と表示される」と約束している。
   */
  it('🔴 運用者が既定値を入力しても「設定済み」とは言わない', async () => {
    const updated = await save({ pinRequired: true, pin: BUILTIN_DEFAULT_PIN });
    expect(isPinConfigured(updated)).toBe(false);
    // 下界: 別の値なら設定済み（全部 false にして満たしていない）。
    expect(isPinConfigured(await save({ pin: '4821' }))).toBe(true);
  });

  /** 🔴 `KIOSK_PIN=0000` も同じ（env 側の綴り）。 */
  it('🔴 KIOSK_PIN が既定値と同じなら未設定として扱う', async () => {
    vi.stubEnv('KIOSK_PIN', BUILTIN_DEFAULT_PIN);
    await __resetSecurity();
    expect(isPinConfigured(await getSecuritySettings())).toBe(false);
    vi.unstubAllEnvs();
  });

  /**
   * 🔴 **MINOR 2: 管理 API 側の `trim()` にも対照を置く。**
   * `KIOSK_PIN` の正規化は縛ったのに、**主経路である管理 API 側**が縛られていなかった。
   */
  it('🔴 管理 API から送られた PIN の前後の空白は落とす', async () => {
    await save({ pinRequired: true, pin: '  4821  ' });
    expect(await verifyPin('4821')).toBe(true);
    expect(await verifyPin('  4821  ')).toBe(false);
  });

  /**
   * 🔴 **MINOR 6: `ipAllowlist` が配列でないレコードで 500 にしない。**
   * `pin` について同じ理屈を書いておきながら、同じ式の隣が素通りだった。
   */
  it('🔴 ipAllowlist が配列でない旧レコードでも落ちない', async () => {
    await getBackend().singleton('security', { default: () => ({}) }).put({
      pinRequired: false,
      pin: BUILTIN_DEFAULT_PIN,
      ipAllowlist: undefined,
      emergencyStop: false,
    });
    expect((await getSecuritySettings()).ipAllowlist).toEqual([]);
  });

  it('IP 許可リストを更新できる', async () => {
    const updated = await save({ ipAllowlist: ['10.0.0.1', ' 10.0.0.2 '] });
    expect(updated.ipAllowlist).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('緊急停止は既定 false、切り替えできる', async () => {
    expect((await getSecuritySettings()).emergencyStop).toBe(false);
    expect((await save({ emergencyStop: true })).emergencyStop).toBe(true);
  });
});
