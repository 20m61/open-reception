'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  PROVIDER_IDS,
  type ProviderId,
  type SecretPresence,
  type TenantProviderConfigView,
} from '@/domain/provider-config/types';
import type { ProviderConfigWarning } from '@/domain/provider-config/readiness';
import { font } from '@/components/admin/ui/tokens';
import { PLATFORM_READ_TIMEOUT_MS, isProviderConfigShape, readTimeoutMessage } from './read-response';

/**
 * テナント別 CCaaS プロバイダ設定（developer 専用・write-only secret） (issue #405 Inc1)。
 *
 * 選択中テナント（サーバ側が Cookie から導出）のプロバイダ設定を read/write する。secret は
 * **write-only**: 応答・画面には presence（設定済み/未設定）のみを出し、値は決して表示・保持しない。
 * secret 値型・ストアは server-only（本 client component は非秘密の types のみ import する, AC3）。
 *
 * secret の set/clear は「期待 provider 名の一致」を確認フィールドで要求して誤操作を防ぐ（AC6）。
 */

const CONFIG_ENDPOINT = '/api/platform/integrations/provider-config';
const SECRET_ENDPOINT = '/api/platform/integrations/provider-config/secret';

type ConfigResponse = {
  config: TenantProviderConfigView | null;
  secretPresence?: SecretPresence;
  /** 「有効にしたのに取り次げない」設定への警告 (#763)。語彙はサーバ側で列挙固定。 */
  warnings?: readonly ProviderConfigWarning[];
};

/**
 * 警告の文言。**サーバは語彙（列挙）だけを返し、文言は画面側が持つ** ──
 * 応答に自由文を載せると、そこへ設定値や secret の断片が混ざりうる
 * （`rules/pii-secret-minimization.md`）。
 */
const WARNING_TEXT: Record<ProviderConfigWarning, string> = {
  real_dialing_without_secret:
    '実発信の設定（発信元番号あり・有効）ですが secret が未設定です。この状態では受付端末が担当者を呼び出せず、来訪者には「取り次げません」と表示されます。下の欄で secret を保存してください。',
  real_dialing_without_application_id:
    '実発信の設定ですが application id が未設定です。この状態では受付端末が担当者を呼び出せません。',
};

const th = { padding: '6px 8px' } as const;

function presenceOf(res: ConfigResponse): SecretPresence {
  return res.config?.secretPresence ?? res.secretPresence ?? 'missing';
}

export function ProviderConfig() {
  const [data, setData] = useState<ConfigResponse | null>(null);
  /*
   * 🔴 **読み取りの失敗と操作の失敗を別に持つ (#968 レビュー MJ-2)。**
   *
   * 1 つの `error` に束ねたまま「再読込」ボタンを添えたところ、**保存に失敗したときにも
   * 再読込が出る**形になった。`load()` はフォーム 4 項目をサーバ値で上書きし、先頭で
   * `setLoadError(null)` するので、押した運用者は**未保存の編集を無言で捨てたうえで
   * 「保存できた」と読める画面**を受け取る。#968 が閉じようとした無言を、復帰導線が
   * 新しく作っていた。`TenantDetail` の `error` / `actionError` と同じ扱いへ揃える。
   */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 設定フォーム状態。
  const [provider, setProvider] = useState<ProviderId>('mock');
  const [enabled, setEnabled] = useState(false);
  const [applicationId, setApplicationId] = useState('');
  const [fromNumber, setFromNumber] = useState('');

  // secret フォーム状態（write-only。サーバ値では決して埋めない）。
  const [secretInput, setSecretInput] = useState('');
  const [confirmProvider, setConfirmProvider] = useState('');

  const load = useCallback(async () => {
    /*
     * 🔴 **押した瞬間に消さない (#968 レビュー 6 周目 MINOR-1)。** ここだけ `FeatureFlags` と
     * 揃っておらず、再読込ボタンが**自分をアンマウントしてフォーカスを文書先頭へ落として**
     * いた。しかもこの画面はテナント未選択だと既定で 400 なので、常用経路だった。
     */
    try {
      const res = await fetch(CONFIG_ENDPOINT, {
        signal: AbortSignal.timeout(PLATFORM_READ_TIMEOUT_MS),
      });
      if (!res.ok) {
        setLoadError(
          res.status === 403
            ? 'この操作の権限がありません。'
            : res.status === 400
              ? '対象テナントが選ばれていません。画面上部の切替で選んでください。'
              : '設定の取得に失敗しました。',
        );
        setData(null);
        return;
      }
      const body: unknown = await res.json();
      /*
       * 🔴 **`config` キーが無い 200 は「未設定」ではなく「読めなかった」(#968 レビュー 5 周目)。**
       *
       * `config: null` は**正当**（そのテナントにまだ設定が無い）。区別するのはキーの有無で、
       * 値ではない。混ぜると #870 の営業時間設定と同じ「取得できていないことを未設定と
       * 言い換える」になり、しかもここは楽観ロックの無い全置換 upsert の入口である。
       */
      if (!isProviderConfigShape(body)) {
        setLoadError('設定の形式が不正です。時間をおいて再試行してください。');
        setData(null);
        return;
      }
      const parsed = body as ConfigResponse;
      setLoadError(null);
      setData(parsed);
      if (parsed.config) {
        setProvider(parsed.config.provider);
        setEnabled(parsed.config.enabled);
        setApplicationId(parsed.config.applicationId ?? '');
        setFromNumber(parsed.config.fromNumber ?? '');
      }
    /*
     * 🔴 **読み取りの失敗を無言にしない (#968 AC2)。** reject を拾わないと `data` も
     * `error` も `null` のままで、画面は「secret 未設定」の初期値をそのまま出す ——
     * **取得できていないことを「未設定」と言い換える**形になり、運用者は secret を
     * 上書き保存しにいく（`OperatingHoursManager` が #870 で踏んだのと同じ型）。
     */
    } catch (cause) {
      setLoadError(
        cause instanceof Error && cause.name === 'TimeoutError'
          ? readTimeoutMessage('設定')
          : '設定を取得できませんでした。通信を確認してください。',
      );
      setData(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveConfig = useCallback(async () => {
    setActionError(null);
    setNotice(null);
    try {
      const res = await fetch(CONFIG_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        // secret はこのエンドポイントに送らない（別エンドポイントで write-only）。
        body: JSON.stringify({ provider, enabled, applicationId, fromNumber }),
      });
      if (!res.ok) {
        setActionError('設定の保存に失敗しました。');
        return;
      }
      setNotice('設定を保存しました。');
      await load();
    } catch {
      setActionError('設定を保存できませんでした。通信を確認してください。');
    }
  }, [provider, enabled, applicationId, fromNumber, load]);

  const saveSecret = useCallback(async () => {
    setActionError(null);
    setNotice(null);
    if (!secretInput.trim()) {
      setActionError('secret を入力してください。');
      return;
    }
    /*
     * 🔴 **送る前に画面から消す (#968 レビュー m1)。**
     *
     * 元は `await fetch` の**次の行**で消していたので、reject したときだけ値が
     * 入力欄（＝DOM）に残り続けた。`finally` へ移すと今度は**成功経路で `await load()`
     * の 1 往復ぶん残る**。送信前に消せばどちらも起きず、`finally` も要らない。
     * `.claude/rules/pii-secret-minimization.md`「画面・DOM に残さない」。
     */
    const secret = secretInput;
    setSecretInput('');
    try {
      const res = await fetch(SECRET_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret, expectedProvider: data?.config?.provider }),
      });
      if (!res.ok) {
        setActionError(
          res.status === 409
            ? '先に設定を保存し、対象プロバイダを確認してください。もう一度 secret を入力してください。'
            : 'secret の保存に失敗しました。もう一度 secret を入力してください。',
        );
        return;
      }
      setNotice('secret を保存しました（値は表示されません）。');
      await load();
    } catch {
      setActionError('secret を保存できませんでした。通信を確認してください。もう一度 secret を入力してください。');
    }
  }, [secretInput, data, load]);

  const clearSecret = useCallback(async () => {
    setActionError(null);
    setNotice(null);
    try {
      const res = await fetch(SECRET_ENDPOINT, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedProvider: confirmProvider }),
      });
      if (!res.ok) {
        setActionError(
          res.status === 409
            ? '確認のため、現在のプロバイダ名を正しく入力してください。'
            : 'secret の消去に失敗しました。',
        );
        return;
      }
      /*
       * 確認欄のクリアは**応答を受け取れたときだけ**にする (#968 レビュー m2)。
       * `confirmProvider` は secret ではなく provider 名（`placeholder` で画面に出ている）
       * なので消す PII 上の利得が無く、消去ボタンは `!confirmProvider` で無効化されるため、
       * 通信断のたびに打ち直しを強いることになる。
       */
      setConfirmProvider('');
      setNotice('secret を消去しました。');
      await load();
    } catch {
      setActionError('secret を消去できませんでした。通信を確認してください。');
    }
  }, [confirmProvider, load]);

  /*
   * 🔴 **読めていないことを「未設定」と言い換えない (#968 レビュー M2)。**
   *
   * `data === null` は「まだ読めていない / 読めなかった」であって「未設定」ではない。
   * ここを `'missing'` に潰すと、画面は **secret 未設定**・provider `mock`・無効と
   * **断定**する。しかも `PUT /api/platform/integrations/provider-config` は
   * `buildTenantProviderConfig` → `putTenantProviderConfig` の**全置換 upsert**で
   * 楽観ロックが無いので、その状態から「設定を保存」を押すと**実 CCaaS 設定が既定値で
   * 上書きされる** —— 来訪者側は担当者を呼べず「取り次げません」になる。
   * `OperatingHoursManager` が #870 で踏んだ「取得失敗を未設定と言い換える」型そのもの。
   */
  const presence = data ? presenceOf(data) : 'missing';

  const readable = data !== null;
  /*
   * 🔴 **「まだ読めていない」を「読めなかった」と断定しない (#968 レビュー 4 周目 MAJOR-3)。**
   *
   * `readable` は 3 状態を 2 つに潰す。通信中の運用者に**失敗と同じ文言・同じ無効化**を
   * 見せていた（しかも再読込ボタンは失敗表示の中なので出ない）。このリポジトリが
   * `resolveAdminReadState` で明文化している「loading と failed を混ぜない」の反対側で、
   * #870 / #896 が閉じた欠陥の向きを変えただけの形になっていた。
   */
  const presenceLabel = readable
    ? presence === 'set'
      ? '設定済み'
      : '未設定'
    : loadError !== null
      ? '取得できていません'
      : '読み込み中…';

  return (
    <section style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>テナント別プロバイダ設定</h2>
      <p style={{ opacity: 0.8, fontSize: font.small }}>
        選択中テナントの CCaaS プロバイダ設定です。secret は<strong>書き込み専用</strong>で、値は
        保存後も一切表示されません（状態のみ）。対象テナントはサーバ側で認可済みコンテキストから
        決まります。
      </p>

      {loadError ? (
        <p role="alert" data-testid="provider-config-load-error" style={{ color: 'var(--color-platform-warn)' }}>
          {loadError}{' '}
          {/*
            🔴 **塞いだ状態から出る道を同じ画面に置く (#968 レビュー m-4)。**
            読み取りに失敗すると保存系 3 つが `disabled` になるが、`load` は
            `useCallback(…, [])` でマウント時 1 回きりなので、この画面には再読込の導線が
            無かった。**読み取りの失敗にだけ添える**（レビュー MJ-2）—— 保存の失敗に
            添えると、押した運用者が未保存の編集を無言で捨てることになる。
          */}
          <button type="button" data-testid="provider-config-reload" onClick={() => void load()}>
            再読込
          </button>
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" data-testid="provider-config-action-error" style={{ color: 'var(--color-platform-warn)' }}>
          {actionError}
        </p>
      ) : null}
      {/*
        🔴 **保存の成否とは別に出す。** 保存は成功しているので `notice`（緑）だけだと
        「有効にした瞬間から受付が 503 になる」ことが伝わらない。#763 で問題にしたのは
        まさに「管理画面は未接続としか言わないのに受付は全件落ちている」状態。
      */}
      {(data?.warnings ?? []).map((w) => (
        <p key={w} data-testid={`provider-config-warning-${w}`} style={{ color: 'var(--color-platform-warn)' }}>
          {WARNING_TEXT[w]}
        </p>
      ))}
      {notice ? <p style={{ color: 'var(--color-platform-ok)' }}>{notice}</p> : null}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <tbody>
            <tr>
              <td style={th}>プロバイダ</td>
              <td style={th}>
                <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
                  {PROVIDER_IDS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
            <tr>
              <td style={th}>有効</td>
              <td style={th}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  aria-label="有効"
                />
              </td>
            </tr>
            <tr>
              <td style={th}>Application ID</td>
              <td style={th}>
                <input value={applicationId} onChange={(e) => setApplicationId(e.target.value)} />
              </td>
            </tr>
            <tr>
              <td style={th}>発信元番号</td>
              <td style={th}>
                <input value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {/* 読めていない状態からの保存は全置換 upsert なので撃たせない（#968 レビュー M2）。 */}
      <button type="button" onClick={() => void saveConfig()} disabled={!readable} style={{ marginTop: 8 }}>
        設定を保存
      </button>

      <h3 style={{ fontSize: font.body, opacity: 0.7, marginTop: 'var(--space-lg)' }}>
        API secret（書き込み専用）
      </h3>
      <p style={{ fontSize: font.small }}>
        現在の状態:{' '}
        {/* ラベルだけ 3 状態にして色が 2 状態のままだと、視覚的には loading と failed が同じ (#968 レビュー 5 周目 MINOR-2)。 */}
        <strong
          style={{
            color: !readable
              ? loadError !== null
                ? 'var(--color-platform-warn)'
                : 'var(--color-muted)'
              : presence === 'set'
                ? 'var(--color-platform-ok)'
                : 'var(--color-platform-warn)',
          }}
        >
          {presenceLabel}
        </strong>
      </p>
      <input
        type="password"
        value={secretInput}
        onChange={(e) => setSecretInput(e.target.value)}
        placeholder="新しい secret を入力（保存後は表示されません）"
        aria-label="API secret"
        autoComplete="new-password"
        style={{ width: '100%' }}
      />
      <button type="button" onClick={() => void saveSecret()} disabled={!readable} style={{ marginTop: 8 }}>
        secret を保存
      </button>

      <div style={{ marginTop: 'var(--space-md)' }}>
        <label style={{ fontSize: '0.8rem', opacity: 0.7 }}>
          消去の確認（現在のプロバイダ名を入力）
          <input
            value={confirmProvider}
            onChange={(e) => setConfirmProvider(e.target.value)}
            placeholder={data?.config?.provider ?? ''}
            aria-label="消去確認のプロバイダ名"
            style={{ marginLeft: 8 }}
          />
        </label>
        <button
          type="button"
          onClick={() => void clearSecret()}
          disabled={!readable || !confirmProvider || presence !== 'set'}
          style={{ marginLeft: 8, color: 'var(--color-platform-warn)' }}
        >
          secret を消去
        </button>
      </div>
    </section>
  );
}
