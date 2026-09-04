'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TENANT_FEATURE_FLAG_KEYS,
  TENANT_FEATURE_FLAG_LABELS,
  type TenantFeatureFlagKey,
} from '@/domain/platform/feature-flags';
import {
  buildFeatureFlagUpdatePayload,
  featureFlagUpdateError,
  type ElevatedWriteError,
} from '@/lib/platform/client-elevation';
import { DangerActionPlaceholder } from './primitives';
import { MetricCard, font } from '@/components/admin/ui';
import { enablementState } from '../state-vocabulary';
import {
  PLATFORM_READ_TIMEOUT_MS,
  PLATFORM_WRITE_TIMEOUT_MS,
  isFlagsSummaryShape,
  isTenantFlagsShape,
  isTenantListShape,
  readTimeoutMessage,
  writeTimeoutMessage,
} from './read-response';

/**
 * 機能フラグ / 利用制限 (issue #90 inc2 / #83 inc5a)。
 *
 * read: /api/platform/feature-flags（プラットフォーム全体のフラグ + テナント別フラグのサマリ）と
 * /api/platform/tenants/[tenantId]/feature-flags（テナント単位の実効値）。
 * write: 同ルートへの PATCH（#83 §1「機能制限の変更」= 昇格必須の破壊的操作）。
 *
 * セキュリティ: 昇格・監査の強制は**サーバ（assertElevated + recordDangerAction）が本体**。
 * この UI は入力と誘導の UX のみで、クライアント判定に保護を置かない。非昇格時はサーバが
 * 403 elevation_required を返すため、画面上部の昇格パネル（#platform-elevation）へ誘導する。
 * 楽観更新はせず、成功後にサーバから再取得する（既存 platform write UI の型に合わせる）。
 */
type AuthMethod = { id: string; label: string; enabled: boolean; issues: string[] };
type TenantFlagSummary = { defaultEnabled: boolean; disabledTenants: number };

/*
 * 🔴 **この画面が横断サマリで読むキー (#968 レビュー 9 周目 m6)。**
 *
 * 述語へ渡す唯一の出所にする。`TENANT_FEATURE_FLAG_KEYS`（ドメイン定数）から導出すると、
 * キーを増やしたときに**描画は増えないのに述語だけ厳しくなり**、クライアント先行
 * デプロイの skew で「画面が読まないフィールドが欠けている」ことを理由に画面が落ちる。
 * ここを増やすときは、下の `summaryValue(data?.flags.…)` も一緒に増やす。
 */
const SUMMARY_KEYS = ['voiceSynthesis', 'avatarReception'] as const;
type FlagsResponse = {
  flags: {
    vonage: { configured: boolean; enabled: boolean };
    authMethods: AuthMethod[];
    voiceSynthesis: TenantFlagSummary;
    avatarReception: TenantFlagSummary;
  };
  limits: Record<string, { status: 'pending' }>;
};
type TenantRow = { id: string; name: string; slug: string; status: 'active' | 'suspended' };
type TenantFlagsResponse = {
  tenantId: string;
  flags: Record<TenantFeatureFlagKey, boolean>;
  updatedAt?: string;
};

function boolLabel(v: boolean): string {
  return enablementState(v).label;
}

export function FeatureFlags() {
  const [data, setData] = useState<FlagsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch('/api/platform/feature-flags', {
        signal: AbortSignal.timeout(PLATFORM_READ_TIMEOUT_MS),
      });
      if (!res.ok) {
        setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : '機能フラグの取得に失敗しました。');
        return;
      }
      const body: unknown = await res.json();
      // **実際に読むフィールドまで**見る。`{"flags":null}` / `{"flags":{}}` は 1 段検査を素通りしていた。
      if (!isFlagsSummaryShape(body, SUMMARY_KEYS)) {
        setError('機能フラグの形式が不正です。時間をおいて再試行してください。');
        return;
      }
      setError(null);
      setData(body as FlagsResponse);
    } catch (cause) {
      // 通信そのものの失敗も、応答が返らない（ハング）も「失敗」へ落とす (#968)。
      setError(
        cause instanceof Error && cause.name === 'TimeoutError'
          ? readTimeoutMessage('機能フラグ')
          : '機能フラグを取得できませんでした。通信を確認してください。',
      );
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const summaryValue = (s: TenantFlagSummary | undefined) =>
    s ? `既定 ${boolLabel(s.defaultEnabled)}` : '—';
  const summaryNote = (s: TenantFlagSummary | undefined) =>
    s ? (s.disabledTenants > 0 ? `無効化テナント ${s.disabledTenants} 件` : '全テナント既定値') : undefined;

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>機能フラグ / 利用制限</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        プラットフォーム全体の機能フラグと利用上限を確認し、テナント単位で機能を切り替えます。
        機密値は表示しません。変更（機能制限の変更）は JIT 昇格が必要な破壊的操作で、監査に記録されます。
      </p>

      {error ? (
        <p role="alert" data-testid="platform-feature-flags-error" style={{ color: 'var(--color-platform-warn)' }}>
          {error}{' '}
          <button type="button" data-testid="platform-feature-flags-retry" onClick={() => void loadSummary()}>
            再試行
          </button>
        </p>
      ) : null}

      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>機能フラグ</h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <MetricCard
          label="Vonage 電話通知"
          value={data ? boolLabel(data.flags.vonage.enabled) : '—'}
          note={data ? (data.flags.vonage.configured ? '設定済み' : '未設定') : undefined}
        />
        <MetricCard
          label="音声合成"
          value={summaryValue(data?.flags.voiceSynthesis)}
          note={summaryNote(data?.flags.voiceSynthesis)}
        />
        <MetricCard
          label="VRM / アバター受付"
          value={summaryValue(data?.flags.avatarReception)}
          note={summaryNote(data?.flags.avatarReception)}
        />
      </div>

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>ログイン方式</h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        {(data?.flags.authMethods ?? []).map((m) => (
          <MetricCard
            key={m.id}
            label={m.label}
            value={boolLabel(m.enabled)}
            note={m.issues.length > 0 ? m.issues.join(' / ') : undefined}
          />
        ))}
      </div>

      <TenantFeatureFlagEditor onChanged={() => void loadSummary()} />

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>
        利用上限（実データ未接続）
      </h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <MetricCard label="受付端末上限" placeholder placeholderText="未接続" note="メータリング接続後" />
        <MetricCard label="月間通話数上限" placeholder placeholderText="未接続" note="メータリング接続後" />
        <MetricCard label="概算コスト上限" placeholder placeholderText="未接続" note="メータリング接続後" />
      </div>

      <div style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="利用上限の変更" />
      </div>
    </section>
  );
}

/**
 * テナント別機能フラグの編集（昇格つき write, #83 inc5a）。
 * テナントを選び、フラグごとに理由つきで切替える。成功後はサーバから再取得（楽観更新なし）。
 */
function TenantFeatureFlagEditor({ onChanged }: { onChanged?: () => void }) {
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [tenantId, setTenantId] = useState<string>('');
  const [flags, setFlags] = useState<TenantFlagsResponse | null>(null);
  const [reason, setReason] = useState('');
  const [busyKey, setBusyKey] = useState<TenantFeatureFlagKey | null>(null);
  const [writeError, setWriteError] = useState<ElevatedWriteError | null>(null);
  /*
   * 🔴 **読み取りの失敗を書き込みの失敗に相乗りさせない (#968 レビュー m3)。**
   * `writeError` は `selectTenant` / `toggle` が毎回 `null` へ落とすので、一覧の取得失敗を
   * そこへ載せると**黙って消える**。逆に書込成功の直後に再読込が失敗すると、緑の `done` と
   * 「変更リクエストの送信に失敗しました」が同時に出て、何が起きたか読めなくなる。
   */
  /*
   * 読み取りの失敗は**取得対象ごとに**持つ。1 つに束ねると、片方の再取得成功が
   * もう片方の失敗表示を消してしまう（再試行で引き直すときに実際に競合する）。
   */
  const [tenantsError, setTenantsError] = useState<string | null>(null);
  const [flagsError, setFlagsError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /*
   * いま画面が指しているテナント (#968 レビュー M3)。`loadTenantFlags` は世代を見ないと、
   * A → B と選び直した直後に **A の応答が後着して `flags` に載る**。`toggle` は
   * `flags.flags[key]` から enable を計算して **B 宛に昇格つき PATCH** を撃つので、
   * 監査には「B を変更」と正しく残りながら、値の根拠は A という状態になる。
   */
  const latestTenantId = useRef('');

  /** テナント一覧の取得。再試行から呼び直せるよう `useEffect` の外に置く (#968 レビュー m-5)。 */
  const loadTenants = useCallback(async (cancelled?: () => boolean) => {
    const aborted = () => cancelled?.() === true;
    try {
      const res = await fetch('/api/platform/tenants', {
        signal: AbortSignal.timeout(PLATFORM_READ_TIMEOUT_MS),
      });
      if (aborted()) return;
      /*
       * 🔴 **HTTP の失敗も報告する (#968 レビュー M-1)。** この画面で最も起こりやすい失敗は
       * 403（developer 権限・昇格切れ）で、reject（オフライン）より遥かに多い。黙って
       * `return` すると**テナントが 1 つも無いのと同じ見た目**になり、運用者は権限の問題に
       * 辿り着けないまま「対象テナントが選べない」で止まる。
       */
      if (!res.ok) {
        setTenantsError(
          res.status === 403
            ? 'テナント一覧の閲覧権限がありません（昇格が切れている可能性があります）。'
            : 'テナント一覧を取得できませんでした。',
        );
        return;
      }
      const body = (await res.json()) as { tenants?: unknown };
      /*
       * 🔴 **形が違う 200 は「読めなかった」であって「0 件」ではない (#968 レビュー 5 周目 MAJOR-2)。**
       *
       * 当初 `?? []` で防いだが、それは**大声の失敗を沈黙の誤動作へ変換する**だけだった
       * （`CLAUDE.md`「主修正とフォールバックを同じコミットで入れない」の族）——
       * 選択肢が空のまま「テナントが 1 つも無い」のと同じ見た目になり、しかも
       * 失敗表示は出ない。このファイル自身が「その見た目にしてはいけない」と書いている。
       */
      // 要素まで見る（`[null]` は `map` で投げる・#968 レビュー 7 周目 BLOCKER-1）。
      if (!isTenantListShape(body)) {
        setTenantsError('テナント一覧の形式が不正です。時間をおいて再試行してください。');
        return;
      }
      setTenantsError(null);
      setTenants(body.tenants as TenantRow[]);
    } catch (cause) {
      // テナントを選べないまま黙って空のプルダウンを出さない (#968)。
      if (!aborted())
        setTenantsError(
          cause instanceof Error && cause.name === 'TimeoutError'
            ? readTimeoutMessage('テナント一覧')
            : 'テナント一覧を取得できませんでした。通信を確認してください。',
        );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadTenants(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadTenants]);

  const loadTenantFlags = useCallback(async (id: string) => {
    /*
     * 🔴 **古い対象の再取得で、いま見ている対象の flags を消さない (#968 レビュー B-1)。**
     *
     * `toggle` は成功後に `loadTenantFlags(tenantId)` を呼ぶ。その間に運用者が別テナントを
     * 選ぶと、**古い id の再取得が新しい画面の `flags` を `null` にし**、直後に世代ガードが
     * 自分の応答を捨てるので `flags` も `flagsError` も `null` のまま残る ——「読み込み中…」
     * すら出ない空白（#968 が消そうとしている無言そのもの）を、ガードが新しく作る。
     */
    if (latestTenantId.current !== id) return;
    setFlags(null);
    if (id === '') return;
    try {
      const res = await fetch(`/api/platform/tenants/${encodeURIComponent(id)}/feature-flags`, {
        signal: AbortSignal.timeout(PLATFORM_READ_TIMEOUT_MS),
      });
      // 遷移をまたいだ古い応答は成否によらず捨てる (#968 レビュー M3)。
      if (latestTenantId.current !== id) return;
      if (!res.ok) {
        setFlagsError('テナントの機能フラグの取得に失敗しました。');
        return;
      }
      const body: unknown = await res.json();
      if (!isTenantFlagsShape(body, TENANT_FEATURE_FLAG_KEYS)) {
        setFlagsError('テナントの機能フラグの形式が不正です。');
        return;
      }
      setFlagsError(null);
      setFlags(body as TenantFlagsResponse);
    } catch (cause) {
      /*
       * 🔴 **拾わないと「読み込み中…」で止まる (#968)。** 描画は
       * `tenantId !== '' && !flags && !flagsError` で読み込み中を出しているので、
       * `flags` も `flagsError` も `null` のままだと終わらない待ちになる。
       */
      if (latestTenantId.current === id)
        setFlagsError(
          cause instanceof Error && cause.name === 'TimeoutError'
            ? readTimeoutMessage('テナントの機能フラグ')
            : 'テナントの機能フラグを取得できませんでした。通信を確認してください。',
        );
    }
  }, []);

  function selectTenant(id: string) {
    latestTenantId.current = id;
    setTenantId(id);
    setWriteError(null);
    setFlagsError(null);
    setDone(null);
    void loadTenantFlags(id);
  }

  async function toggle(key: TenantFeatureFlagKey, enable: boolean) {
    setWriteError(null);
    setDone(null);
    const built = buildFeatureFlagUpdatePayload({ key, enable, reason });
    if (!built.ok) {
      setWriteError({ needsElevation: false, message: built.error });
      return;
    }
    setBusyKey(key);
    try {
      const res = await fetch(`/api/platform/tenants/${encodeURIComponent(tenantId)}/feature-flags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.payload),
        // 返ってこない送信で編集 UI を固めない (#968 レビュー 7 周目 MAJOR-5)。
        signal: AbortSignal.timeout(PLATFORM_WRITE_TIMEOUT_MS),
      });
      const resBody: unknown = await res.json().catch(() => null);
      /*
       * 🔴 **昇格つき破壊的操作の成否を、別テナントの画面に出さない (#968 レビュー B-1)。**
       * `<select>` は飛行中でも操作できたので、A への PATCH が解決したとき画面は B かも
       * しれない。素で報告すると「『音声合成』を無効にしました（監査に記録済み）」が **B の
       * 画面に**出る —— 監査には A と正しく残るので、運用者だけが取り違える。
       */
      if (latestTenantId.current !== tenantId) return;
      if (!res.ok) {
        setWriteError(featureFlagUpdateError(res.status, resBody));
        return;
      }
      setDone(
        `「${TENANT_FEATURE_FLAG_LABELS[key]}」を${enablementState(enable).label}にしました（監査に記録済み）。`,
      );
      setReason('');
      // 楽観更新はしない: サーバ応答が正。テナントの実効値と横断サマリを再取得する。
      await loadTenantFlags(tenantId);
      onChanged?.();
    } catch (cause) {
      if (latestTenantId.current !== tenantId) return;
      // 中断は「失敗した」と言い切らない（送信できたかは分からない・MAJOR-5）。
      setWriteError({
        needsElevation: false,
        message:
          cause instanceof Error && cause.name === 'TimeoutError'
            ? writeTimeoutMessage('機能フラグの変更')
            : '機能フラグ変更リクエストの送信に失敗しました。',
      });
    } finally {
      setBusyKey(null);
    }
  }

  const inputStyle = {
    background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 8,
    padding: '6px 10px',
    color: 'inherit',
    fontSize: font.small,
    boxSizing: 'border-box',
  } as const;

  return (
    <div
      data-testid="tenant-feature-flag-editor"
      style={{
        marginTop: 'var(--space-lg)',
        maxWidth: 760,
        border: '1px solid color-mix(in srgb, var(--color-platform-warn) 40%, transparent)',
        borderRadius: 10,
        padding: 'var(--space-md)',
        display: 'grid',
        gap: 'var(--space-sm)',
        fontSize: font.small,
      }}
    >
      <strong style={{ color: 'var(--color-platform-warn)' }}>テナント別機能フラグの変更（昇格が必要な操作）</strong>
      <p style={{ margin: 0, opacity: 0.7 }}>
        テナントごとに利用できる機能を切り替えます。実行には対象テナントを覆う JIT
        昇格が必要で、操作理由・変更前後の値とともに監査に記録されます。無効化しても設定・データは保持されます。
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        対象テナント
        {/* 書込中の切替はレースそのもの。窓を作らない (#968 レビュー B-1)。 */}
        <select
          value={tenantId}
          onChange={(e) => selectTenant(e.target.value)}
          disabled={busyKey !== null}
          style={{ ...inputStyle, width: 'auto' }}
        >
          <option value="">選択してください</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}（{t.slug}）{t.status === 'suspended' ? ' — 停止中' : ''}
            </option>
          ))}
        </select>
      </label>

      {tenantId !== '' && flags ? (
        <>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="操作理由（必須・監査に記録）"
            aria-label="操作理由"
            style={{ ...inputStyle, width: '100%' }}
          />
          <div style={{ display: 'grid', gap: 6 }}>
            {TENANT_FEATURE_FLAG_KEYS.map((key) => (
              <div
                key={key}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap' }}
              >
                <span style={{ minWidth: 180 }}>{TENANT_FEATURE_FLAG_LABELS[key]}</span>
                <span style={{ color: flags.flags[key] ? 'var(--color-platform-ok)' : 'var(--color-platform-warn)' }}>
                  {boolLabel(flags.flags[key])}
                </span>
                <button
                  type="button"
                  disabled={busyKey !== null}
                  onClick={() => void toggle(key, !flags.flags[key])}
                  style={{ ...inputStyle, cursor: 'pointer' }}
                >
                  {busyKey === key ? '変更中…' : flags.flags[key] ? '昇格つきで無効化' : '昇格つきで有効化'}
                </button>
              </div>
            ))}
          </div>
          {flags.updatedAt ? (
            <p style={{ margin: 0, opacity: 0.5, fontSize: font.caption }}>
              最終変更: {new Date(flags.updatedAt).toLocaleString('ja-JP')}
            </p>
          ) : null}
        </>
      ) : null}
      {tenantId !== '' && !flags && !flagsError ? <p style={{ margin: 0, opacity: 0.6 }}>読み込み中…</p> : null}

      {tenantsError ? (
        <p role="alert" data-testid="platform-feature-flags-tenants-error" style={{ color: 'var(--color-platform-warn)', margin: 0 }}>
          {tenantsError}{' '}
          {/*
            🔴 **より広く塞ぐほうにこそ復帰導線が要る (#968 レビュー MJ-1)。**
            テナント一覧が引けないと `<select>` は「選択してください」だけになり、
            テナント別機能フラグの編集が**丸ごと**不能になる。狭いほう（`flagsError`）に
            だけ再試行があり広いほうに無い、という逆転になっていた。
          */}
          <button
            type="button"
            data-testid="feature-flags-tenants-retry"
            /*
             * 🔴 **押した瞬間にエラーを消さない (#968 レビュー 5 周目 MINOR-3)。**
             * 消すと自分自身がアンマウントされ、キーボード / SR 利用者のフォーカスが
             * 文書先頭へ落ちる。しかも「復帰した」を消えたことで縛れなくなる ——
             * **取得が成功したときにだけ消える**ほうが、表示としても正直である。
             */
            onClick={() => void loadTenants()}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            再試行
          </button>
        </p>
      ) : null}

      {flagsError ? (
        <p role="alert" data-testid="platform-feature-flags-flags-error" style={{ color: 'var(--color-platform-warn)', margin: 0 }}>
          {flagsError}{' '}
          {/*
            🔴 **塞いだ状態から出る道を同じ画面に置く (#968 レビュー m-5)。**
            `<select>` で同じテナントを選び直しても `onChange` は発火しないので、
            再試行の導線が無いと「別テナントへ行って戻る」かリロードしか道が無い。
          */}
          <button
            type="button"
            data-testid="feature-flags-retry"
            onClick={() => void loadTenantFlags(latestTenantId.current)}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            再試行
          </button>
        </p>
      ) : null}

      {writeError ? (
        <p role="alert" style={{ color: 'var(--color-platform-warn)', margin: 0 }}>
          {writeError.message}
          {writeError.needsElevation ? (
            <>
              {' '}
              <a href="#platform-elevation" style={{ color: 'var(--color-platform-warn)', textDecoration: 'underline' }}>
                画面上部の「JIT 昇格」パネルから昇格する
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {done ? <p style={{ color: 'var(--color-platform-ok)', margin: 0 }}>{done}</p> : null}
    </div>
  );
}
