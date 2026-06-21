'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MOTION_KEYS, type MotionKey, type MotionMapping } from '@/domain/motion/types';
import type { Asset } from '@/domain/assets/types';
import { DataTable, Field, type Column } from '@/components/admin/ui';

const KEY_LABEL: Record<MotionKey, string> = {
  idle: '待機', greeting: '挨拶', listening: '入力中', thinking: '確認中', selecting: '選択中',
  calling: '呼び出し中', connected: '接続', success: '成功/完了', failed: '失敗', timeout: '未応答', fallback: '代替導線',
};

/** 状態別モーション割り当て (issue #31)。各状態キーにモーションアセット（#27）を割り当てる。 */
export function MotionsManager() {
  const [mapping, setMapping] = useState<MotionMapping>({});
  const [defaultId, setDefaultId] = useState<string | undefined>(undefined);
  const [assets, setAssets] = useState<Asset[]>([]);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/motions');
    if (res.ok) {
      const data = (await res.json()) as { mapping: MotionMapping; defaultMotionAssetId?: string; assets: Asset[] };
      setMapping(data.mapping);
      setDefaultId(data.defaultMotionAssetId);
      setAssets(data.assets);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const assign = useCallback(
    async (body: Record<string, unknown>) => {
      await fetch('/api/admin/motions', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      await load();
    },
    [load],
  );

  const columns = useMemo<Column<MotionKey>[]>(
    () => [
      {
        key: 'state',
        header: '状態',
        cell: (key) => (
          <>
            {KEY_LABEL[key]}
            <span style={{ opacity: 0.5 }}> ({key})</span>
          </>
        ),
      },
      {
        key: 'motion',
        header: 'モーション',
        cell: (key) => (
          <select
            data-testid={`motion-${key}`}
            aria-label={`${KEY_LABEL[key]}（${key}）のモーション`}
            value={mapping[key] ?? ''}
            onChange={(e) => assign({ key, assetId: e.target.value || null })}
            style={select}
          >
            <option value="">（default を使用）</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        ),
      },
    ],
    [mapping, assets, assign],
  );

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>モーション割り当て</h1>
      <p style={{ opacity: 0.8 }}>
        受付状態ごとにモーションを割り当てます。未設定の状態は default を使い、読み込み失敗時も受付画面は壊れません。
        モーションは「アセット管理」で登録してください。
      </p>

      <div style={{ marginBottom: 16, maxWidth: 360 }}>
        <Field label="default モーション" htmlFor="motion-default">
          <select
            id="motion-default"
            data-testid="motion-default"
            aria-label="default モーション"
            value={defaultId ?? ''}
            onChange={(e) => assign({ default: e.target.value || null })}
            style={select}
          >
            <option value="">（なし）</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>
      </div>

      <DataTable
        testId="motion-table"
        columns={columns}
        rows={MOTION_KEYS}
        rowKey={(key) => key}
        rowTestId={() => 'motion-row'}
        emptyMessage="割り当て可能な状態がありません。"
      />
    </section>
  );
}

const select: React.CSSProperties = {
  minHeight: 40, padding: '8px 12px', borderRadius: 8,
  border: '1px solid var(--color-surface-2)', background: 'var(--color-surface)', color: 'var(--color-text)',
};
