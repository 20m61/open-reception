'use client';

import { useCallback, useEffect, useState } from 'react';
import { MOTION_KEYS, type MotionKey, type MotionMapping } from '@/domain/motion/types';
import type { Asset } from '@/domain/assets/types';

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

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>モーション割り当て</h1>
      <p style={{ opacity: 0.8 }}>
        受付状態ごとにモーションを割り当てます。未設定の状態は default を使い、読み込み失敗時も受付画面は壊れません。
        モーションは「アセット管理」で登録してください。
      </p>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <span style={{ width: 120 }}>default モーション</span>
        <select
          data-testid="motion-default"
          value={defaultId ?? ''}
          onChange={(e) => assign({ default: e.target.value || null })}
          style={select}
        >
          <option value="">（なし）</option>
          {assets.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </label>

      <table data-testid="motion-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
            <th style={cell}>状態</th>
            <th style={cell}>モーション</th>
          </tr>
        </thead>
        <tbody>
          {MOTION_KEYS.map((key) => (
            <tr key={key} data-testid="motion-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <td style={cell}>{KEY_LABEL[key]}<span style={{ opacity: 0.5 }}> ({key})</span></td>
              <td style={cell}>
                <select
                  data-testid={`motion-${key}`}
                  value={mapping[key] ?? ''}
                  onChange={(e) => assign({ key, assetId: e.target.value || null })}
                  style={select}
                >
                  <option value="">（default を使用）</option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const select: React.CSSProperties = {
  minHeight: 40, padding: '8px 12px', borderRadius: 8,
  border: '1px solid var(--color-surface-2)', background: 'var(--color-surface)', color: 'var(--color-text)',
};
const cell: React.CSSProperties = { padding: '8px 12px' };
