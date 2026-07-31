'use client';

import { Field } from '@/components/admin/ui';
import type { SelectableSite } from './site-scope';

/**
 * 拠点別設定画面の「対象拠点」セレクタ (issue #421)。
 *
 * #421 の受入条件「管理者が現在の対象 tenant/site/kiosk を見失わない」に対応する部品。
 * 各画面で個別に組むと表記も testid もばらつくので共有する（`device-site-select` は
 * 端末管理が先に持っていた同等物）。
 */
export function SiteScopeSelect({
  sites,
  siteId,
  onSelect,
  disabled = false,
  testId = 'site-scope-select',
}: {
  sites: readonly (SelectableSite & { name?: string })[];
  siteId: string;
  onSelect: (next: string) => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    // Field に htmlFor を渡し select に同じ id を付ける。これが無いと「対象拠点」の
    // ラベルが支援技術からコンボボックスの名前として結び付かず、ラベルクリックでも
    // フォーカスが移らない（#534 レビュー P2）。
    <Field label="対象拠点" htmlFor={testId}>
      <select
        id={testId}
        data-testid={testId}
        value={siteId}
        disabled={disabled || sites.length === 0}
        onChange={(e) => onSelect(e.target.value)}
      >
        {/* 一覧取得前は現在の siteId だけを出す（空 select にして選択が消えるのを避ける）。 */}
        {sites.length === 0 ? (
          <option value={siteId}>{siteId}</option>
        ) : (
          sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name ?? s.id}
            </option>
          ))
        )}
      </select>
    </Field>
  );
}
