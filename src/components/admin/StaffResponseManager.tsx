'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Field, SaveFeedback, useSaveFeedback } from '@/components/admin/ui';
import { color, space } from '@/components/admin/ui/tokens';
import type {
  ResolvedStaffResponseDefinition,
  StaffResponseAction,
} from '@/domain/reception/staff-response';

/**
 * 担当者応答アクション設定 (issue #99, increment 2; 保存フィードバックは #330 item2 残増分)。
 *
 * テナント/サイト配下の応答種別ごとに「担当者が選べるか（有効/無効）」「来訪者へ表示する
 * 文言の上書き」を管理 API 経由で設定する。未設定の種別はドメイン既定にフォールバックする
 * ため、初期表示でも全種別が既定（有効・既定文言）で並ぶ。
 *
 * 無効化した種別は担当者 UI/エンドポイントで選べなくなり、上書き文言は受付端末の来訪者表示
 * に反映される（応答実行経路が本設定を尊重する）。
 *
 * 保存/失敗フィードバックは共有プリミティブ（`SaveFeedback`/`useSaveFeedback`）を使う
 * （#330 item6 と同方針。これまで本画面は結果を一切表示しておらず操作後の無反応が課題だった）。
 */
const DEFAULT_TENANT_ID = 'internal';
const DEFAULT_SITE_ID = 'default-site';

type ConfigView = {
  tenantId: string;
  siteId: string;
  definitions: ResolvedStaffResponseDefinition[];
  updatedAt?: string;
};

export function StaffResponseManager({
  tenantId = DEFAULT_TENANT_ID,
  siteId = DEFAULT_SITE_ID,
}: {
  tenantId?: string;
  siteId?: string;
}) {
  const [definitions, setDefinitions] = useState<ResolvedStaffResponseDefinition[]>([]);
  const [busy, setBusy] = useState(false);
  const [editingAction, setEditingAction] = useState<StaffResponseAction | null>(null);
  const [editMessage, setEditMessage] = useState('');
  const { feedback, success, failure, clear } = useSaveFeedback();

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/admin/staff-response?tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as ConfigView;
      setDefinitions(data.definitions);
    }
  }, [tenantId, siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (action: StaffResponseAction, body: Record<string, unknown>, successMessage?: string) => {
      if (busy) return;
      setBusy(true);
      clear();
      try {
        const res = await fetch('/api/admin/staff-response', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId, siteId, action, ...body }),
        });
        if (res.ok) {
          const data = (await res.json()) as ConfigView;
          setDefinitions(data.definitions);
          success(successMessage);
        } else {
          failure();
        }
      } catch {
        failure('通信エラーのため保存に失敗しました。');
      } finally {
        setBusy(false);
      }
    },
    [busy, tenantId, siteId, clear, success, failure],
  );

  const toggle = useCallback(
    (d: ResolvedStaffResponseDefinition) =>
      patch(d.action, { enabled: !d.enabled }, d.enabled ? '無効化しました' : '有効化しました'),
    [patch],
  );

  const saveMessage = useCallback(
    async (action: StaffResponseAction) => {
      // 空文字を渡すと上書きを解除して既定へ戻す。
      const trimmed = editMessage.trim();
      await patch(
        action,
        { messageOverride: trimmed.length === 0 ? null : trimmed },
        '表示文言を保存しました',
      );
      setEditingAction(null);
      setEditMessage('');
    },
    [editMessage, patch],
  );

  const resetMessage = useCallback(
    (action: StaffResponseAction) => patch(action, { messageOverride: null }, '既定の文言に戻しました'),
    [patch],
  );

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>担当者応答アクション</h1>
      <p style={{ opacity: 0.7, marginTop: -8 }}>
        テナント <code>{tenantId}</code> / 拠点 <code>{siteId}</code> で、担当者が選べる応答
        アクションの有効/無効と、来訪者向けに表示する文言を設定します。無効にした応答は担当者
        画面に表示されず、文言の上書きは受付端末の来訪者表示に反映されます。
      </p>

      <div style={{ marginBottom: space.sm }}>
        <SaveFeedback
          feedback={feedback}
          successTestId="staff-response-config-saved"
          errorTestId="staff-response-config-error"
        />
      </div>

      <div
        data-testid="staff-response-config-list"
        style={{ display: 'flex', flexDirection: 'column', gap: space.md }}
      >
        {definitions.map((d) => {
          const editing = editingAction === d.action;
          return (
            <Card key={d.action} testId="staff-response-config-card">
              <header style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong data-testid="staff-response-config-label" style={{ fontSize: '1.05rem' }}>
                  {d.staffLabel}
                </strong>
                <code style={{ fontSize: '0.8rem', opacity: 0.6 }}>{d.action}</code>
                <span
                  data-testid="staff-response-config-status"
                  style={{ fontSize: '0.8rem', color: d.enabled ? color.success : color.muted }}
                >
                  {d.enabled ? '有効' : '無効'}
                </span>
                <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                  <Button
                    data-testid="staff-response-config-toggle"
                    onClick={() => toggle(d)}
                    disabled={busy}
                  >
                    {d.enabled ? '無効化' : '有効化'}
                  </Button>
                </div>
              </header>

              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: 4 }}>
                  来訪者向け表示文言{d.isMessageOverridden ? '（上書き中）' : '（既定）'}
                </div>
                {editing ? (
                  <div style={{ display: 'flex', gap: space.sm, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <Field label="表示文言" htmlFor={`msg-${d.action}`}>
                      <input
                        id={`msg-${d.action}`}
                        data-testid="staff-response-config-message-input"
                        value={editMessage}
                        onChange={(e) => setEditMessage(e.target.value)}
                        placeholder={d.defaultVisitorMessage}
                        style={{ ...inputStyle, minWidth: 320 }}
                      />
                    </Field>
                    <Button
                      variant="primary"
                      data-testid="staff-response-config-message-save"
                      onClick={() => saveMessage(d.action)}
                      disabled={busy}
                    >
                      保存
                    </Button>
                    <Button onClick={() => setEditingAction(null)} disabled={busy}>
                      取消
                    </Button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' }}>
                    <p
                      data-testid="staff-response-config-message"
                      style={{ margin: 0, fontSize: '0.9rem', opacity: 0.85 }}
                    >
                      {d.visitorMessage}
                    </p>
                    <Button
                      data-testid="staff-response-config-message-edit"
                      onClick={() => {
                        setEditingAction(d.action);
                        setEditMessage(d.isMessageOverridden ? d.visitorMessage : '');
                      }}
                      disabled={busy}
                    >
                      文言を編集
                    </Button>
                    {d.isMessageOverridden ? (
                      <Button
                        data-testid="staff-response-config-message-reset"
                        onClick={() => resetMessage(d.action)}
                        disabled={busy}
                      >
                        既定に戻す
                      </Button>
                    ) : null}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

const inputStyle: React.CSSProperties = {
  minHeight: 44,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
};
