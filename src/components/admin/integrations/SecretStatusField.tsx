'use client';

import type { SecretPresence as UiSecretPresence } from '@/components/admin/ui';
import { Button, SecretStatusField as UiSecretStatusField } from '@/components/admin/ui';
import type { SecretStatus } from '@/domain/security/integration-status';

/**
 * シークレットの **状態のみ** を表示するフィールド (issue #93 / #92 increment 2)。
 * 値・private key は受け取らず描画もしない（型に value が存在しない）。
 * 表示するのは設定済み/未設定・最終更新日時・更新者・health のみ。
 *
 * #92 increment 2: 視覚は共有 `ui/SecretStatusField`（状態のみの器）へ寄せ、操作
 * （更新済みにする / 要更新）は `actions` として `ui/Button` で注入する。`secret-<key>` 系
 * の data-testid は呼び出し側・操作導線の互換のため維持する。
 */

/** ドメインの presence + health を ui の 3 状態語彙へ畳み込む（値は扱わない）。 */
function toUiPresence(status: SecretStatus): UiSecretPresence {
  if (status.presence !== 'configured') return 'missing';
  return status.health === 'needs_rotation' ? 'needs_rotation' : 'configured';
}

function updatedLabel(status: SecretStatus): string | undefined {
  if (!status.updatedAt) return undefined;
  const when = new Date(status.updatedAt).toLocaleString('ja-JP');
  return `最終更新: ${when}${status.updatedBy ? `（${status.updatedBy}）` : ''}`;
}

export function SecretStatusField({
  status,
  canManage,
  busy,
  onMarkUpdated,
  onClear,
}: {
  status: SecretStatus;
  canManage: boolean;
  busy: boolean;
  onMarkUpdated: (key: SecretStatus['key']) => void;
  onClear: (key: SecretStatus['key']) => void;
}) {
  return (
    <div data-testid={`secret-${status.key}`}>
      <UiSecretStatusField
        name={status.key}
        presence={toUiPresence(status)}
        updatedLabel={updatedLabel(status)}
        actions={
          canManage ? (
            <>
              <Button
                variant="ghost"
                data-testid={`secret-${status.key}-mark`}
                onClick={() => onMarkUpdated(status.key)}
                disabled={busy}
              >
                更新済みにする
              </Button>
              <Button
                variant="danger"
                data-testid={`secret-${status.key}-clear`}
                onClick={() => onClear(status.key)}
                disabled={busy}
              >
                要更新
              </Button>
            </>
          ) : undefined
        }
      />
    </div>
  );
}
