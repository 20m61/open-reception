/**
 * 試行予算の一次鍵に使う**発信元の識別**（#1021 AC4 / レビュー B1）。
 *
 * ## なぜこれが必要か
 *
 * 当初この増分は「非詐称可能な識別子は無いので予算の鍵は global しか選べない」と
 * 判断していた。**その前提はこのリポジトリ自身のコードで反証される**:
 *
 * - `src/lib/admin/audit.ts` は `x-forwarded-for` の **末尾** を採る。doc がまさに
 *   「CloudFront は client 提供の XFF の**右側**に実 client IP を追記するため、
 *   **先頭値は client 詐称可能**」と書いている
 * - `src/proxy.ts` の origin-verify が **全ルートで** CloudFront 迂回を拒否する
 *
 * つまり本番では **XFF の末尾は詐称できない viewer IP** である。authorize route が
 * 読んでいる `split(',')[0]`（先頭＝詐称可能）から一般化したのが誤りだった。
 *
 * ## なぜ鍵が global だと困るか（レビュー B2）
 *
 * global ＋ ロックアウトだと、攻撃者が少量のリクエストを投げ続けるだけで
 * **運用者が無期限に入れない**。しかも kiosk の復旧経路（エンロール URL の発行）は
 * admin セッションを要求し、その入口は `/api/admin/login` だけなので、
 * **受付が復旧不能になる**。一次鍵を発信元にすれば、他人の失敗で閉まらない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetIdentitySalt,
  assertIdentitySaltAvailable,
  clientIdentity,
  GLOBAL_IDENTITY,
} from './client-identity';

/**
 * 🔴 **鍵の材料と導出済み salt を毎回戻す。** 戻さないと、あるテストが差し替えた秘密が
 * 後続へ漏れ、**空虚に通る**（同じ鍵が出続ける）。
 */
const savedSecret = process.env.KIOSK_ENROLLMENT_SECRET;
beforeEach(() => {
  __resetIdentitySalt();
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.KIOSK_ENROLLMENT_SECRET;
  else process.env.KIOSK_ENROLLMENT_SECRET = savedSecret;
  __resetIdentitySalt();
});

const req = (xff?: string) =>
  new Request('https://example.test/api/kiosk/authorize', {
    method: 'POST',
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  });

describe('発信元の識別 (#1021 AC4)', () => {
  /**
   * 🔴 **本体。末尾を採る。** 先頭は client が詐称できるので、先頭を採ると
   * **鍵を回すだけで予算が素通り**する（それは予算ではない）。
   */
  it('🔴 XFF の末尾を採る（先頭は詐称可能）', async () => {
    // 末尾が同じなら鍵が同じ、違えば違う。値そのものは保存しない（下の PII のテスト）。
    const tail = await clientIdentity(req('192.0.2.1'));
    expect(await clientIdentity(req('203.0.113.9, 198.51.100.7, 192.0.2.1'))).toBe(tail);
    expect(await clientIdentity(req('203.0.113.9'))).not.toBe(tail);
  });

  it('1 つだけならそれを採る', async () => {
    expect(await clientIdentity(req('192.0.2.1'))).toBe(await clientIdentity(req('192.0.2.1')));
  });

  /**
   * 🔴 **詐称された先頭に引きずられない（下界）。** 攻撃者が先頭へ別の IP を
   * 詰めても、鍵は末尾で決まる。
   */
  it('🔴 攻撃者が先頭に何を詰めても鍵は変わらない', async () => {
    const a = await clientIdentity(req('1.1.1.1, 192.0.2.1'));
    const b = await clientIdentity(req('2.2.2.2, 3.3.3.3, 192.0.2.1'));
    expect(a).toBe(b);
  });

  /** 空白・空要素を落とす（`a, , b` のような綴り）。 */
  it('空要素を落とす', async () => {
    expect(await clientIdentity(req('1.1.1.1, , 192.0.2.1 '))).toBe(
      await clientIdentity(req('192.0.2.1')),
    );
  });

  /**
   * 🔴 **識別できないときは global へ退避する（fail-safe）。**
   *
   * ヘッダが無いのは CloudFront を経ないデプロイ（ローカル開発・Function URL 直叩きが
   * 許されている構成）である。`undefined` を鍵にすると**全員が同じ鍵**になるので、
   * 明示的に global の鍵へ倒して**予算が消えないこと**を保証する。
   */
  it.each([undefined, '', '   ', ','])(
    '🔴 識別できない（%j）なら global へ退避する',
    async (xff) => {
      expect(await clientIdentity(req(xff))).toBe(GLOBAL_IDENTITY);
    },
  );

  /**
   * 🔴 **鍵に接頭辞を付ける。** `ip:` を付けないと、`GLOBAL_IDENTITY` と同じ文字列を
   * XFF に詰めるだけで**global の予算を狙って消費させられる**（鍵の衝突）。
   */
  it('🔴 global の鍵を XFF から名乗れない', async () => {
    expect(await clientIdentity(req(GLOBAL_IDENTITY))).not.toBe(GLOBAL_IDENTITY);
    expect(await clientIdentity(req(GLOBAL_IDENTITY))).toMatch(/^ip:[0-9a-f]{64}$/);
  });

  /** 🔴 鍵に PII を増やさない（IP 以外のヘッダを混ぜない）。 */
  it('🔴 鍵は IP だけで、user-agent 等を混ぜない', async () => {
    const withUa = new Request('https://example.test/x', {
      method: 'POST',
      headers: { 'x-forwarded-for': '192.0.2.1', 'user-agent': 'Mozilla/5.0 (iPad)' },
    });
    expect(await clientIdentity(withUa)).toBe(await clientIdentity(req('192.0.2.1')));
  });

  /**
   * 🔴 **生の IP を鍵に出さない（レビュー 2 周目 M-4）。**
   *
   * 鍵は DynamoDB の SK として**2 時間永続化される**ので、生の IP を入れると
   * 「未認証リクエストの IP を保存する」＝ PII 方針の変更になる。
   * 予算の鍵は「同じ発信元か」が判定できれば足りるので、値そのものは要らない。
   */
  it('🔴 鍵に生の IP を含めない', async () => {
    const key = await clientIdentity(req('192.0.2.1'));
    expect(key).not.toContain('192.0.2.1');
    expect(key).toMatch(/^ip:[0-9a-f]{64}$/);
  });

  /**
   * 🔴 **HKDF の専用ラベルを実際に使っている（変異 N15b が生存した穴）。**
   *
   * doc と PR 本文は「署名鍵をそのまま使わず**専用ラベルの HKDF で分ける**」と書いている。
   * ラベルを外しても鍵は秘密依存かつ安定なままなので、**上の 2 本は素通りする** ——
   * つまり「用途を分けている」という主張を**誰も縛っていなかった**。
   * 散文が成果物より強い状態を残さない（`.claude/rules/opus5-autonomous-loop.md`）。
   *
   * 判定は「ラベル無しで導出した値**ではない**こと」。期待値を書き写すのではなく、
   * **分離していない導出と一致しない**ことだけを主張する。
   */
  it('🔴 HKDF の用途ラベルを使っている（分離していない導出と一致しない）', async () => {
    const secret = 'TEST-enrollment-secret-label';
    process.env.KIOSK_ENROLLMENT_SECRET = secret;
    __resetIdentitySalt();
    const key = await clientIdentity(req('192.0.2.1'));

    // ラベル無し（＝用途を分けていない）で同じ手順を踏むと何になるか。
    const ikm = new TextEncoder().encode(secret);
    const material = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new Uint8Array(0) },
      material,
      256,
    );
    const unseparated = new Uint8Array(bits);
    const suffix = new TextEncoder().encode('\u0000192.0.2.1');
    const bytes = new Uint8Array(unseparated.length + suffix.length);
    bytes.set(unseparated);
    bytes.set(suffix, unseparated.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = Array.from(digest)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    expect(key, 'HKDF のラベルが空＝署名鍵と用途を分けていない').not.toBe(`ip:${hex}`);
  });

  /**
   * 🔴 **鍵の材料が無いデプロイでは `assertIdentitySaltAvailable` が落ちる
   * （変異 N19b が生存した穴）。**
   *
   * route 側のテストはこの関数を**モックしている**ので、中身を空にする変異は
   * そちらでは検出できない。空にすると未設定デプロイで `clientIdentity` が
   * **未捕捉の 500** を生む（未認証経路なので無制限に生ませられる）。
   *
   * `serverSecret` は「デプロイ実行か」を `AWS_LAMBDA_FUNCTION_NAME` で判定するので、
   * そのマーカーを立てて秘密を外す。
   */
  it('🔴 デプロイで鍵が未設定なら鍵の解決が落ちる（fail-closed）', () => {
    const savedMarker = process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'open-reception-server';
    delete process.env.KIOSK_ENROLLMENT_SECRET;
    try {
      expect(() => assertIdentitySaltAvailable()).toThrow();
    } finally {
      if (savedMarker === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      else process.env.AWS_LAMBDA_FUNCTION_NAME = savedMarker;
    }
  });

  /** 🔴 下界: 鍵が在れば落ちない（常に throw して満たしていない）。 */
  it('🔴 鍵が在れば鍵の解決は落ちない（下界）', () => {
    process.env.KIOSK_ENROLLMENT_SECRET = 'TEST-enrollment-secret-present';
    expect(() => assertIdentitySaltAvailable()).not.toThrow();
  });

  /**
   * 🔴 **salt を混ぜる。** IPv4 は空間が小さいので、salt 無しの `sha256(ip)` は
   * 総当たりで逆引きできる（＝ PII が消えていない）。
   */
  it('🔴 salt を混ぜている（素の sha256(ip) ではない）', async () => {
    const plain = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('192.0.2.1')),
    );
    const plainHex = Array.from(plain)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(await clientIdentity(req('192.0.2.1'))).not.toBe(`ip:${plainHex}`);
  });

  /**
   * 🔴 **鍵は「デプロイの秘密」から決まる（固定の公開既定値ではない）。**
   *
   * 一度は `ATTEMPT_KEY_SALT` という専用 env にしたが、実測でそれは**実装・
   * `.env.example`・設計文書の 3 箇所にしか無く、`infra/` にも `docs/deploy-aws.md` にも
   * 1 度も現れていなかった** —— 実デプロイでは公開されている dev 既定値が使われ、
   * 「逆引きできない」が**配備の現実で偽**だった（独立レビュー 3 周目 MAJOR-3）。
   *
   * 🔴 **ここは一度、散文にテストを通されている。** 最初この面は**ソースの文字列検査**
   * （`toContain('getRandomValues')`）で書いていたが、salt を公開既定値へ戻す変異が
   * **生存した** —— 直上の doc コメントに同じ語が書いてあるので、**実装を消しても通る**。
   * 検査が読んでいたのは実装ではなく自分の散文だった。だから振る舞いで縛る。
   *
   * 秘密を変えれば鍵が変わる ⇒ 鍵は秘密に依存している。定数 salt に戻すと変わらず落ちる。
   */
  it('🔴 鍵はデプロイの秘密から決まる（定数 salt ではない）', async () => {
    process.env.KIOSK_ENROLLMENT_SECRET = 'TEST-enrollment-secret-a';
    __resetIdentitySalt();
    const a = await clientIdentity(req('192.0.2.1'));
    process.env.KIOSK_ENROLLMENT_SECRET = 'TEST-enrollment-secret-b';
    __resetIdentitySalt();
    const b = await clientIdentity(req('192.0.2.1'));
    expect(b, 'salt が秘密に依存しておらず、定数になっている').not.toBe(a);
    for (const key of [a, b]) expect(key).toMatch(/^ip:[0-9a-f]{64}$/);
  });

  /**
   * 🔴 **鍵はプロセス（実行環境）をまたいで安定する**（独立レビュー 4 周目 MAJOR-1）。
   *
   * 一度は salt を**プロセス起動ごとの乱数**にした。設定が要らなくなるので MAJOR-3 は
   * 消えたが、**Lambda は同時実行ごとに別の実行環境を立てる**ので、同じ IP が
   * 実行環境の数だけ別の一次鍵に割れた。一次予算（10 回）はどれにも当たらないまま、
   * 固定鍵の global cap（60 回）だけが共有で減る ——
   * **1 本の IP を並列に投げるだけでサイト全体の初回認可を閉じられた**
   * （変更前は最低 6 本の IP が要った）。`attempt-store.ts` の
   * 「1 発信元が二次へ入れられるのは高々 `perOrigin.budget` 回」が**本番で偽**だった。
   *
   * 🔴 **この面は `reserveLayered` のテストでは絶対に見えない。** あちらは
   * **ハッシュ済みの identity 文字列を直接渡す**ので、鍵の生成（配線）を変異させていない。
   * #826（「純関数の分岐は全部 kill、配線は変異させていない」）とまったく同型である。
   */
  it('🔴 鍵はモジュール（実行環境）をまたいで安定する', async () => {
    process.env.KIOSK_ENROLLMENT_SECRET = 'TEST-enrollment-secret-stable';
    vi.resetModules();
    const first = await import('./client-identity');
    const a = await first.clientIdentity(req('192.0.2.1'));
    vi.resetModules();
    const second = await import('./client-identity');
    const b = await second.clientIdentity(req('192.0.2.1'));
    expect(second, 'モジュールが読み直されていない（テストが空虚になる）').not.toBe(first);
    expect(b, '同じ秘密なのに実行環境ごとに鍵が変わっている（一次予算が割れる）').toBe(a);
  });

  /**
   * 🔴 **salt を混ぜる。** IPv4 は空間が小さいので、salt 無しの `sha256(ip)` は
   * 総当たりで逆引きできる（＝ PII が消えていない）。
   */
  it('🔴 salt を混ぜている（素の sha256(ip) ではない）', async () => {
    const plain = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('192.0.2.1')),
    );
    const plainHex = Array.from(plain)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(await clientIdentity(req('192.0.2.1'))).not.toBe(`ip:${plainHex}`);
  });

  /**
   * 🔴 **salt は設定値ではなく、プロセス起動ごとの乱数である**
   * （独立レビュー 3 周目 MAJOR-3）。
   *
   * 一度は `ATTEMPT_KEY_SALT` という env にしたが、実測でそれは**実装・`.env.example`・
   * 設計文書の 3 箇所にしか無く、`infra/` にも `docs/deploy-aws.md` にも 1 度も
   * 現れていなかった** —— 実デプロイでは公開されている dev 既定値が使われ、
   * 「逆引きできない」という主張が**配備の現実で偽**だった。
   *
   * ## 🔴 ここは一度、散文にテストを通されている
   *
   * 最初この面は**ソースの文字列検査**で書いていた（`toContain('getRandomValues')`）。
   * salt を公開既定値へ戻す変異を当てたところ**生存した** —— 直上の doc コメントに
   * 「`crypto.getRandomValues` を使う」と書いてあるので、**実装を消しても検査が通る**。
   * 検査が読んでいたのは実装ではなく自分の散文だった。
   *
   * そこで**振る舞いで縛り直す**。モジュールを読み込み直せば salt は作り直されるので、
   * **同じ IP でも別インスタンスなら鍵が変わる**。固定 salt（env でも定数でも）に
   * 戻すと、両インスタンスが**同じ鍵**を出すのでここが落ちる。
   */
  it('🔴 salt はプロセスごとに変わる（固定の公開既定値ではない）', async () => {
    const first = await import('./client-identity');
    const a = await first.clientIdentity(req('192.0.2.1'));
    vi.resetModules();
    const second = await import('./client-identity');
    const b = await second.clientIdentity(req('192.0.2.1'));
    expect(second, 'モジュールが読み直されていない（テストが空虚になる）').not.toBe(first);
    expect(b, 'salt が固定値なので、別インスタンスでも同じ鍵になる').not.toBe(a);
    // 下界: どちらも鍵の形は保っている（「毎回壊れた値を返す」で満たさせない）。
    for (const key of [a, b]) expect(key).toMatch(/^ip:[0-9a-f]{64}$/);
  });

  /**
   * 🔴 **下界: 同じプロセスの中では鍵が安定している。** 毎回 salt を作り直すと、
   * 同じ発信元が毎回違う鍵になり**予算が一切効かなくなる**（上の同値テストは
   * 「別々の IP が違う鍵になる」側だけなので、これが無いと空虚に満たせる）。
   */
  it('🔴 同じプロセスの中では鍵が安定する', async () => {
    const first = await clientIdentity(req('192.0.2.1'));
    for (let i = 0; i < 5; i += 1) {
      expect(await clientIdentity(req('192.0.2.1'))).toBe(first);
    }
  });
});
