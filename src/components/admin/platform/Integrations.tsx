'use client';

import { useEffect, useState } from 'react';
import { DangerActionPlaceholder } from './primitives';
import { DataTable, type Column } from '@/components/admin/ui';
import { enablementState } from '../state-vocabulary';
import { PLATFORM_READ_TIMEOUT_MS, isIntegrationsShape, readTimeoutMessage } from './read-response';

/**
 * 外部連携状態（read 中心） (issue #90, increment 3 / #83)。
 *
 * /api/platform/integrations（developer 専用 read）から、外部連携（Vonage 等）と管理ログイン方式
 * （Entra / Cognito / 共有パスワード）の登録状態・有効状態・接続結果・最終日時を横断表示する。
 * **API シークレットや秘密鍵などの機密値は表示しない**。シークレット再登録・連携設定変更は
 * 破壊的操作として確認・昇格・監査を伴う導線に隔離する（次増分）。
 */
type IntegrationRow = {
  id: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  lastResult: 'untested' | 'success' | 'failure';
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastErrorSummary?: string;
};
type AuthMethodRow = {
  id: string;
  label: string;
  enabled: boolean;
  issues: string[];
};
type IntegrationsResponse = {
  integrations: IntegrationRow[];
  authMethods: AuthMethodRow[];
};

const RESULT_LABEL: Record<IntegrationRow['lastResult'], string> = {
  untested: '未テスト',
  success: '成功',
  failure: '失敗',
};

const INTEGRATION_COLUMNS: ReadonlyArray<Column<IntegrationRow>> = [
  { key: 'label', header: '連携', cell: (i) => i.label },
  { key: 'configured', header: '設定', cell: (i) => (i.configured ? '済' : '未'), cellStyle: () => ({ opacity: 0.8 }) },
  { key: 'enabled', header: '有効', cell: (i) => enablementState(i.enabled).label, cellStyle: () => ({ opacity: 0.8 }) },
  { key: 'lastResult', header: '直近結果', cell: (i) => RESULT_LABEL[i.lastResult], cellStyle: () => ({ opacity: 0.8 }) },
  { key: 'summary', header: '要約', cell: (i) => i.lastErrorSummary ?? '-', cellStyle: () => ({ opacity: 0.6 }) },
];

const AUTH_METHOD_COLUMNS: ReadonlyArray<Column<AuthMethodRow>> = [
  { key: 'label', header: '方式', cell: (m) => m.label },
  { key: 'enabled', header: '有効', cell: (m) => enablementState(m.enabled).label, cellStyle: () => ({ opacity: 0.8 }) },
  {
    key: 'issues',
    header: '設定上の問題',
    cell: (m) => (m.issues.length ? m.issues.join(' / ') : '-'),
    cellStyle: () => ({ opacity: 0.6 }),
  },
];

export function Integrations() {
  const [data, setData] = useState<IntegrationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/platform/integrations', {
          signal: AbortSignal.timeout(PLATFORM_READ_TIMEOUT_MS),
        });
        if (cancelled) return;
        if (!res.ok) {
          setError(
            res.status === 403 ? 'この画面の閲覧権限がありません。' : '連携状態の取得に失敗しました。',
          );
          return;
        }
        const body: unknown = await res.json();
        /*
         * 形が違う 200 は「0 件」ではなく「読めなかった」(#973 AC7)。
         * `authMethods` の要素が欠けると `m.issues.length` が投げ、運用者は
         * 「読めなかった」ではなく汎用の例外画面を受け取る（#968 レビュー 7 周目 MAJOR-1）。
         */
        if (!isIntegrationsShape(body)) {
          setError('連携状態の形式が不正です。時間をおいて再試行してください。');
          return;
        }
        setError(null);
        setData(body as IntegrationsResponse);
      /*
       * 🔴 **通信そのものが失敗した場合も「失敗」へ落とす (#896 レビュー M3)。**
       * `fetch` の reject（オフライン・DNS・接続断）や、HTML が返って `res.json()` が
       * 投げるケースを拾わないと `data` も `error` も `null` のままになり、
       * `resolveAdminReadState` は `'loading'` を返す ——「失敗が永遠の読み込み中に
       * 化ける」まさにその形で、画面には再試行の導線も `role="alert"` も出ない。
       */
      } catch (cause) {
        /*
         * 🔴 **ガードは `if (!cancelled) setError(...)` の形のまま置く。** 早期 return へ
         * 崩すと `tests/config/platform-list-states.test.ts` の「古い応答を捨てるガード」
         * 検査から外れる —— 方式を替えると、前の方式が守っていた変異が黙って落ちる
         * (`.claude/rules/opus5-autonomous-loop.md`)。返ってこない読み取りも
         * 「終わらない待ち」にしない (#973)。
         */
        if (!cancelled)
          setError(
            cause instanceof Error && cause.name === 'TimeoutError'
              ? readTimeoutMessage('連携状態')
              : '連携状態の取得に失敗しました。',
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>外部連携</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        Vonage / Entra(Cognito) / 共有パスワードなどの連携状態を横断確認します（読み取り専用）。
        表示するのは登録状態・有効状態・接続確認結果・最終日時のみで、API シークレットや秘密鍵
        などの機密値は表示しません。
      </p>

      {error ? (
        <p role="alert" data-testid="platform-integrations-error" style={{ color: 'var(--color-platform-warn)' }}>
          {error}
        </p>
      ) : null}

      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>外部連携</h2>
      {/*
        生 `<table>` を共有 `ui/DataTable` へ寄せた (#896 AC1)。横スクロール領域は
        `DataTable` が持つので、外側の `overflowX` ラッパは要らない。3 状態は
        `loaded` / `failed` で渡す（#947 で生 `<tbody>` に置いていた 3 状態の判断を、部品側へ移したもの）。
      */}
      <DataTable
        testId="platform-integrations"
        scrollRegionLabel="外部連携"
        columns={INTEGRATION_COLUMNS}
        rows={data?.integrations ?? []}
        rowKey={(i) => i.id}
        loaded={data !== null}
        failed={error !== null}
        emptyMessage="連携がありません。"
        failureMessage="外部連携の状態を読み込めませんでした。"
      />

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>
        管理画面ログイン方式
      </h2>
      {/*
        生 `<table>` を共有 `ui/DataTable` へ寄せた (#896 AC1)。横スクロール領域は
        `DataTable` が持つので、外側の `overflowX` ラッパは要らない。3 状態は
        `loaded` / `failed` で渡す（#947 で生 `<tbody>` に置いていた 3 状態の判断を、部品側へ移したもの）。
      */}
      <DataTable
        testId="platform-auth-methods"
        scrollRegionLabel="管理画面ログイン方式"
        columns={AUTH_METHOD_COLUMNS}
        rows={data?.authMethods ?? []}
        rowKey={(m) => m.id}
        loaded={data !== null}
        failed={error !== null}
        emptyMessage="認証方式がありません。"
        failureMessage="ログイン方式の状態を読み込めませんでした。"
      />

      <div style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="シークレット再登録 / 連携設定の変更" />
      </div>
    </section>
  );
}
