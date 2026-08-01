'use client';

import { Button, Field } from '@/components/admin/ui';
import { color, font, space } from '@/components/admin/ui/tokens';
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
  onRetry,
  disabled = false,
  testId = 'site-scope-select',
  status = 'ready',
}: {
  sites: readonly (SelectableSite & { name?: string })[];
  siteId: string;
  onSelect: (next: string) => void;
  /**
   * 一覧の取得をやり直す。**必須にしてある。**
   *
   * 省略可能にすると、拠点別画面を足した人が渡し忘れて**その画面だけ復帰できない**まま
   * 通る。本リポジトリが繰り返している「ある画面で解いた対策を別の画面へ写していない」形
   * そのものなので、型で全呼び出し元に強制する（規律では抜ける）。
   */
  onRetry: () => void;
  disabled?: boolean;
  testId?: string;
  /**
   * 拠点一覧の取得状態。`error` のとき**選択中らしき拠点 ID を出さない**
   * （ヘッダは「確認できません」と言っているのに本文が拠点を名指しすると、
   * どちらが本当か分からなくなる。#552 レビュー P2）。
   */
  status?: 'idle' | 'loading' | 'ready' | 'error';
}) {
  if (status === 'error') {
    return (
      <Field label="対象拠点" htmlFor={testId}>
        <div style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
          {/* select は残す（ラベルとの結び付きを保つ）が、実在しない拠点を選ばせない。 */}
          <select id={testId} data-testid={testId} value="" disabled onChange={() => {}}>
            <option value="">拠点一覧を取得できません</option>
          </select>
          <Button variant="secondary" onClick={onRetry} data-testid={`${testId}-retry`}>
            再試行
          </Button>
        </div>
        {/*
          拠点別画面は一覧が確定するまで本文の取得を始めない（`resolveSiteScopeState` の
          `ready`）。つまり一覧の失敗はこの画面の機能全部を止めている。黙って空にせず、
          何が起きているかを言う。
        */}
        <p style={{ margin: 0, color: color.muted, fontSize: font.small }}>
          拠点を確認できないため、この画面の設定は表示・変更できません。
        </p>
      </Field>
    );
  }

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
        {/* 一覧取得前は現在の siteId だけを出す（空 select にして選択が消えるのを避ける）。
            取得失敗（`error`）は上で早期 return しているのでここには来ない。 */}
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
