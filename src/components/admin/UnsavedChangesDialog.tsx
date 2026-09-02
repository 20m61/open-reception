'use client';

import { Button } from '@/components/admin/ui';
import { color, font, radius, space, zIndex } from '@/components/admin/ui/tokens';
import { useModalDialog } from './useModalDialog';

/**
 * 未保存の変更があるまま離脱しようとしたときの確認 (#912 / 課題 12)。
 *
 * 🔴 **`window.confirm` を使わない。** #889 で 8 箇所を二段確認へ移したばかりで、ここで
 * 戻すと同じ穴を開け直す（無スタイル・翻訳不可・フォーカス管理なし）。
 * フォーカス管理は #890 の `useModalDialog` に委ねる —— 新しいモーダルが同じ穴を
 * 開けられないようにするために作った共有フックなので、最初の利用者がここになる。
 *
 * 既定のフォーカスは**「このページに留まる」**側へ行く（`useModalDialog` は最初の
 * 操作要素へ移すので、留まるボタンを先に置く）。誤って Enter を押したときに
 * 入力が消えない方へ倒す。
 */
export function UnsavedChangesDialog({
  pendingHref,
  onLeave,
  onStay,
}: {
  pendingHref: string | null;
  onLeave: () => void;
  onStay: () => void;
}) {
  const ref = useModalDialog<HTMLDivElement>({ open: pendingHref !== null, onClose: onStay });
  if (pendingHref === null) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        // 暗幕は `--color-scrim`（globals.css）。生の rgba を新しく足さない (#329)。
        background: 'var(--color-scrim)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: zIndex.dialog,
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-changes-title"
        aria-describedby="unsaved-changes-body"
        tabIndex={-1}
        data-testid="unsaved-changes-dialog"
        style={{
          maxWidth: 420,
          background: color.surface,
          border: `1px solid ${color.borderStrong}`,
          borderRadius: radius.md,
          padding: space.lg,
          display: 'flex',
          flexDirection: 'column',
          gap: space.md,
        }}
      >
        <h2 id="unsaved-changes-title" style={{ margin: 0, fontSize: font.label }}>
          保存していない変更があります
        </h2>
        <p id="unsaved-changes-body" style={{ margin: 0, fontSize: font.small, opacity: 0.85 }}>
          このまま移動すると、入力した内容は失われます。
        </p>
        <div style={{ display: 'flex', gap: space.sm, justifyContent: 'flex-end' }}>
          <Button variant="primary" data-testid="unsaved-changes-stay" onClick={onStay}>
            このページに留まる
          </Button>
          <Button variant="danger" data-testid="unsaved-changes-leave" onClick={onLeave}>
            移動して変更を破棄
          </Button>
        </div>
      </div>
    </div>
  );
}
