'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Field, SaveFeedback, useSaveFeedback } from '@/components/admin/ui';
import { useSiteScope } from './use-site-scope';
import { SiteScopeSelect } from './SiteScopeSelect';
import { resolveScopeGate } from './scope-gate';
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
type ConfigView = {
  tenantId: string;
  siteId: string;
  definitions: ResolvedStaffResponseDefinition[];
  updatedAt?: string;
};

export function StaffResponseManager({
  tenantId,
  siteId: defaultSiteId,
}: {
  tenantId: string;
  /** サーバが解決した既定拠点（`resolveDefaultScope().siteId`）。ヘッダの対象拠点と同じ出所。 */
  siteId: string;
}) {
  const { sites, siteId, scopeKey, scopeReady, isCurrentScope, selectSite, sitePending, listStatus, reloadSites } =
    useSiteScope(tenantId, defaultSiteId);
  const [definitions, setDefinitions] = useState<ResolvedStaffResponseDefinition[]>([]);
  /**
   * **どのスコープの設定が今画面に載っているか。** 有効/無効の切替と文言の上書きは
   * `action` でしか対象を決めないので、これが無いと見出しが B を指したまま A の設定を
   * 書き換えられる（#539 / #541 と同型）。
   */
  const [definitionsScopeKey, setDefinitionsScopeKey] = useState<string | null>(null);
  const dataLoaded = definitionsScopeKey === scopeKey;
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editingAction, setEditingAction] = useState<StaffResponseAction | null>(null);
  const [editMessage, setEditMessage] = useState('');
  const { feedback, success, failure, clear } = useSaveFeedback();

  /** 可否の判断は 1 箇所。ハンドラもボタンの `disabled` もこの値を見る。 */
  const gate = resolveScopeGate({
    scopeReady,
    dataLoaded,
    sitePending,
    busy,
    listStatus,
    loadFailed,
  });

  const load = useCallback(async () => {
    // 拠点が確定するまで取得しない。
    if (!scopeReady) return;
    const startedWith = scopeKey;
    let res: Response;
    try {
      res = await fetch(
        `/api/admin/staff-response?tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`,
      );
    } catch {
      if (!isCurrentScope(startedWith)) return;
      setLoadFailed(true);
      return;
    }
    // 取得中に拠点／テナントが変わっていたら捨てる。
    if (!isCurrentScope(startedWith)) return;
    if (res.ok) {
      const data = (await res.json()) as ConfigView;
      setLoadFailed(false);
      setDefinitionsScopeKey(startedWith);
      setDefinitions(data.definitions);
    } else {
      // **失敗を握り潰さない。** 以前は `if (res.ok)` だけで、401/403/5xx のとき
      // 画面は空のまま何も言わなかった（未設定と区別が付かない）。
      setLoadFailed(true);
    }
  }, [tenantId, siteId, scopeKey, scopeReady, isCurrentScope]);

  useEffect(() => {
    // 拠点が変わった瞬間に前拠点の設定を捨てる。編集中の文言も閉じる。
    setDefinitionsScopeKey((prev) => (prev === scopeKey ? prev : null));
    setDefinitions((prev) => (prev.length === 0 ? prev : []));
    setLoadFailed(false);
    setEditingAction(null);
    void load();
  }, [load, scopeKey]);

  const patch = useCallback(
    async (action: StaffResponseAction, body: Record<string, unknown>, successMessage?: string) => {
      // 載っている設定に対する変更。ボタンと同じ 1 つの値を見る。
      if (!gate.canMutate) return;
      // **応答の適用にも同じ門が要る。** PATCH が飛行中に拠点を切り替えると、遅れて届いた
      // A の応答が B の画面へ載り、無効化したはずの応答が有効に戻る・来訪者向け文言が
      // 別拠点のものに置き換わる（読みに写した守りを書きにも写す）。
      const startedWith = scopeKey;
      setBusy(true);
      clear();
      try {
        const res = await fetch('/api/admin/staff-response', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId, siteId, action, ...body }),
        });
        if (!isCurrentScope(startedWith)) return;
        if (res.ok) {
          const data = (await res.json()) as ConfigView;
          setDefinitionsScopeKey(startedWith);
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
    [gate.canMutate, tenantId, siteId, scopeKey, isCurrentScope, clear, success, failure],
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
        担当者が選べる応答アクションの有効/無効と、来訪者向けに表示する文言を拠点ごとに
        設定します。無効にした応答は担当者画面に表示されず、文言の上書きは受付端末の
        来訪者表示に反映されます。
      </p>

      {/* 拠点は本文で名指しせずセレクタに委ねる（ヘッダの対象拠点と二重に言わない）。 */}
      <div style={{ marginBottom: space.md, maxWidth: 320 }}>
        <SiteScopeSelect
          sites={sites}
          siteId={siteId}
          onSelect={selectSite}
          onRetry={reloadSites}
          disabled={sitePending || busy}
          testId="staff-response-site-select"
          status={listStatus}
        />
      </div>

      {/* 取得できていないことを「設定が無い」と誤読させない。 */}
      {gate.unavailable !== null ? (
        <p data-testid="staff-response-config-unavailable" style={{ color: color.muted }}>
          {gate.unavailable === 'site-list-error'
            ? '拠点を確認できないため、応答アクションを表示できません。'
            : gate.unavailable === 'load-failed'
              ? '応答アクションを取得できませんでした。'
              : '読み込み中…'}
        </p>
      ) : null}

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
                    disabled={!gate.canMutate}
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
                      disabled={!gate.canMutate}
                    >
                      保存
                    </Button>
                    <Button onClick={() => setEditingAction(null)} disabled={!gate.canMutate}>
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
                      disabled={!gate.canMutate}
                    >
                      文言を編集
                    </Button>
                    {d.isMessageOverridden ? (
                      <Button
                        data-testid="staff-response-config-message-reset"
                        onClick={() => resetMessage(d.action)}
                        disabled={!gate.canMutate}
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
