'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Field } from '@/components/admin/ui';
import { color, space } from '@/components/admin/ui/tokens';
import {
  CONTINUABLE_RESULTS,
  ROUTE_ACTIONS,
  type RouteAction,
  type RouteResult,
  type RouteTransition,
  type RoutingStep,
} from '@/domain/routing/policy';
import { CONTACT_CHANNELS, type ContactChannel } from '@/domain/routing/endpoint';
import { groupIssues } from '@/lib/routing/policy-issues';
import {
  TRANSITION_KIND_OPTIONS,
  buildTransition,
  gotoStepChoices,
  transitionKindOf,
} from '@/lib/routing/transition-options';
import type { EndpointView, PolicyView } from '@/lib/routing/types';

/**
 * 文章形式ルートビルダー (issue #374, 残 increment)。
 *
 * 非エンジニアが「誰に・どの順で・何秒待って・繋がらなければどこへ」呼び出すかを、
 * 文章（`describe.ts` 由来の手順文）として理解し、フォームで編集・保存できる管理画面。
 *
 * 設計:
 *   - 接続先（ContactEndpoint）は別セクションで登録/編集する。アドレス（電話番号/SIP URI）は
 *     機微値のため一覧では**マスク表示**（`maskedAddress`）し、編集時に再入力する（API はアドレスを
 *     返さない = ブラウザに平文を持ち込まない）。
 *   - ポリシーは各カードに「文章形式の説明」（API の `description`）を表示し、その下の
 *     フォームで手順（接続先・動作・待ち時間・結果別遷移）を編集する。
 *   - 保存時に API 側が循環・不整合を検証し、`issues` を返す。ここでは step 別 / ポリシー全体別に
 *     エラーを表示する。
 */
const DEFAULT_TENANT_ID = 'internal';
const DEFAULT_SITE_ID = 'default-site';

const CHANNEL_LABELS: Record<ContactChannel, string> = { pstn: '電話 (PSTN)', sip: 'SIP' };
const ACTION_LABELS: Record<RouteAction, string> = {
  notify: '通知する',
  live_bridge: '直接つなぐ',
  announce_and_bridge: '読み上げてつなぐ',
};
const RESULT_LABELS: Record<RouteResult, string> = {
  answered: '応答',
  accepted: '受付',
  staff_coming: '対応確定',
  busy: '話中',
  no_answer: '応答なし',
  declined: '拒否',
  failed: '接続失敗',
};

const inputStyle: React.CSSProperties = {
  minHeight: 40,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
};

type Scope = { tenantId: string; siteId: string };

export function RoutingPolicyManager({
  tenantId = DEFAULT_TENANT_ID,
  siteId = DEFAULT_SITE_ID,
}: {
  tenantId?: string;
  siteId?: string;
}) {
  const scope = useMemo<Scope>(() => ({ tenantId, siteId }), [tenantId, siteId]);
  const [endpoints, setEndpoints] = useState<EndpointView[]>([]);
  const [policies, setPolicies] = useState<PolicyView[]>([]);

  const loadEndpoints = useCallback(async () => {
    const res = await fetch(
      `/api/admin/routing/endpoints?tenantId=${encodeURIComponent(scope.tenantId)}&siteId=${encodeURIComponent(scope.siteId)}`,
    );
    if (res.ok) setEndpoints((await res.json()) as EndpointView[]);
  }, [scope]);

  const loadPolicies = useCallback(async () => {
    const res = await fetch(
      `/api/admin/routing/policies?tenantId=${encodeURIComponent(scope.tenantId)}&siteId=${encodeURIComponent(scope.siteId)}`,
    );
    if (res.ok) setPolicies((await res.json()) as PolicyView[]);
  }, [scope]);

  useEffect(() => {
    void loadEndpoints();
    void loadPolicies();
  }, [loadEndpoints, loadPolicies]);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>呼び出しルート（文章形式）</h1>
      <p style={{ opacity: 0.7, marginTop: -8 }}>
        テナント <code>{scope.tenantId}</code> / 拠点 <code>{scope.siteId}</code> の取次ルートを、
        「誰に・どの順で・何秒待って・繋がらなければどこへ」という文章として確認し、編集できます。
        電話番号などの接続先は機微情報のため下 4 桁のみ表示します。
      </p>

      <EndpointsSection endpoints={endpoints} scope={scope} reload={loadEndpoints} />
      <PoliciesSection policies={policies} endpoints={endpoints} scope={scope} reload={loadPolicies} />
    </section>
  );
}

// ============================ 接続先セクション ============================

function EndpointsSection({
  endpoints,
  scope,
  reload,
}: {
  endpoints: EndpointView[];
  scope: Scope;
  reload: () => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [channel, setChannel] = useState<ContactChannel>('pstn');
  const [address, setAddress] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        ownerType: 'staff',
        ownerId: ownerId.trim() || 'unassigned',
        channel,
        providerKey: 'vonage',
        enabled: true,
        label: label.trim() || undefined,
      };
      if (channel === 'pstn') body.e164 = address.trim();
      else body.uri = address.trim();
      const res = await fetch('/api/admin/routing/endpoints', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        setError(j.message ?? '接続先を登録できませんでした。');
        return;
      }
      setLabel('');
      setAddress('');
      setOwnerId('');
      await reload();
    } finally {
      setBusy(false);
    }
  }, [busy, scope, ownerId, channel, address, label, reload]);

  const removeEndpoint = useCallback(
    async (e: EndpointView) => {
      if (!window.confirm(`接続先「${e.label ?? e.id}」を削除します。よろしいですか?`)) return;
      await fetch(`/api/admin/routing/endpoints/${e.id}?tenantId=${encodeURIComponent(scope.tenantId)}`, {
        method: 'DELETE',
      });
      await reload();
    },
    [scope, reload],
  );

  const toggle = useCallback(
    async (e: EndpointView) => {
      await fetch(`/api/admin/routing/endpoints/${e.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: scope.tenantId, enabled: !e.enabled }),
      });
      await reload();
    },
    [scope, reload],
  );

  return (
    <div style={{ marginBottom: space.xl }}>
      <h2>接続先</h2>
      <div style={{ display: 'flex', gap: space.sm, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: space.md }}>
        <Field label="表示名" htmlFor="ep-label" hint="例: 山田の個人携帯（氏名以外の呼称推奨）">
          <input id="ep-label" data-testid="endpoint-label-input" value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="種別" htmlFor="ep-channel">
          <select id="ep-channel" data-testid="endpoint-channel-select" value={channel} onChange={(e) => setChannel(e.target.value as ContactChannel)} style={inputStyle}>
            {CONTACT_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={channel === 'pstn' ? '電話番号 (E.164)' : 'SIP URI'} htmlFor="ep-address" hint={channel === 'pstn' ? '例: +81312345678' : '例: sip:user@example.com'}>
          <input id="ep-address" data-testid="endpoint-address-input" value={address} onChange={(e) => setAddress(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="担当者/組織 ID" htmlFor="ep-owner">
          <input id="ep-owner" data-testid="endpoint-owner-input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} style={inputStyle} />
        </Field>
        <Button variant="primary" data-testid="endpoint-add" onClick={add} disabled={busy || address.trim() === ''}>
          接続先を追加
        </Button>
      </div>
      {error ? (
        <p data-testid="endpoint-error" style={{ color: color.danger, fontSize: '0.85rem' }}>
          {error}
        </p>
      ) : null}

      <div data-testid="endpoint-list" style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
        {endpoints.length === 0 ? (
          <p data-testid="endpoint-empty" style={{ opacity: 0.6 }}>
            接続先が未登録です。
          </p>
        ) : (
          endpoints.map((e) => (
            <Card key={e.id} testId="endpoint-card">
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong data-testid="endpoint-name">{e.label ?? e.id}</strong>
                <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>{CHANNEL_LABELS[e.channel]}</span>
                <span data-testid="endpoint-masked" style={{ fontSize: '0.85rem', opacity: 0.7 }}>
                  {e.maskedAddress}
                </span>
                <span data-testid="endpoint-status" style={{ fontSize: '0.8rem', color: e.enabled ? color.success : color.muted }}>
                  {e.enabled ? '有効' : '無効'}
                </span>
                <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                  <Button data-testid="endpoint-toggle" onClick={() => toggle(e)}>
                    {e.enabled ? '無効化' : '有効化'}
                  </Button>
                  <Button variant="danger" data-testid="endpoint-delete" onClick={() => removeEndpoint(e)}>
                    削除
                  </Button>
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

// ============================ ポリシーセクション ============================

type DraftPolicy = {
  id?: string;
  name: string;
  enabled: boolean;
  fallbackPolicyId?: string;
  steps: RoutingStep[];
};

function emptyStep(): RoutingStep {
  return { id: `step-${Math.random().toString(36).slice(2, 8)}`, endpointId: '', action: 'notify', timeoutSeconds: 20, nextOn: {} };
}

function PoliciesSection({
  policies,
  endpoints,
  scope,
  reload,
}: {
  policies: PolicyView[];
  endpoints: EndpointView[];
  scope: Scope;
  reload: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftPolicy | null>(null);
  const [policyErrors, setPolicyErrors] = useState<string[]>([]);
  const [stepErrors, setStepErrors] = useState<Record<string, string[]>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startNew = useCallback(() => {
    setDraft({ name: '', enabled: true, steps: [emptyStep()] });
    setPolicyErrors([]);
    setStepErrors({});
    setSaveError(null);
  }, []);

  const startEdit = useCallback((p: PolicyView) => {
    setDraft({ id: p.id, name: p.name, enabled: p.enabled, fallbackPolicyId: p.fallbackPolicyId, steps: p.steps });
    setPolicyErrors([]);
    setStepErrors({});
    setSaveError(null);
  }, []);

  const removePolicy = useCallback(
    async (p: PolicyView) => {
      if (!window.confirm(`ルート「${p.name}」を削除します。よろしいですか?`)) return;
      await fetch(`/api/admin/routing/policies/${p.id}?tenantId=${encodeURIComponent(scope.tenantId)}`, { method: 'DELETE' });
      await reload();
    },
    [scope, reload],
  );

  const save = useCallback(async () => {
    if (!draft || busy) return;
    setBusy(true);
    setPolicyErrors([]);
    setStepErrors({});
    setSaveError(null);
    try {
      const body = {
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        name: draft.name,
        enabled: draft.enabled,
        fallbackPolicyId: draft.fallbackPolicyId ?? null,
        steps: draft.steps,
      };
      const url = draft.id
        ? `/api/admin/routing/policies/${draft.id}`
        : '/api/admin/routing/policies';
      const res = await fetch(url, {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setDraft(null);
        await reload();
        return;
      }
      const j = (await res.json().catch(() => ({}))) as { message?: string; issues?: Parameters<typeof groupIssues>[0] };
      if (j.issues && j.issues.length > 0) {
        const grouped = groupIssues(j.issues);
        setPolicyErrors(grouped.policyLevel);
        setStepErrors(grouped.byStep);
      } else {
        setSaveError(j.message ?? '保存できませんでした。');
      }
    } finally {
      setBusy(false);
    }
  }, [draft, busy, scope, reload]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ marginRight: 'auto' }}>取次ルート</h2>
        <Button variant="primary" data-testid="policy-new" onClick={startNew}>
          新しいルート
        </Button>
      </div>

      <div data-testid="policy-list" style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
        {policies.length === 0 ? (
          <p data-testid="policy-empty" style={{ opacity: 0.6 }}>
            取次ルートが未登録です。
          </p>
        ) : (
          policies.map((p) => (
            <Card key={p.id} testId="policy-card">
              <header style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong data-testid="policy-name" style={{ fontSize: '1.05rem' }}>
                  {p.name}
                </strong>
                <span style={{ fontSize: '0.8rem', color: p.enabled ? color.success : color.muted }}>
                  {p.enabled ? '有効' : '無効'}
                </span>
                <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                  <Button data-testid="policy-edit" onClick={() => startEdit(p)}>
                    手順を編集
                  </Button>
                  <Button variant="danger" data-testid="policy-delete" onClick={() => removePolicy(p)}>
                    削除
                  </Button>
                </div>
              </header>
              {/* 文章形式の説明（describe.ts 由来）。 */}
              <ol data-testid="policy-prose" style={{ marginTop: 10, marginBottom: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {p.description.map((line, i) => (
                  <li key={i} data-testid="policy-prose-line" style={{ fontSize: '0.9rem', lineHeight: 1.6, listStyle: i === 0 ? 'none' : 'decimal', marginLeft: i === 0 ? -18 : 0, fontWeight: i === 0 ? 700 : 400 }}>
                    {line}
                  </li>
                ))}
              </ol>
            </Card>
          ))
        )}
      </div>

      {draft ? (
        <PolicyEditor
          draft={draft}
          setDraft={setDraft}
          endpoints={endpoints}
          policies={policies}
          policyErrors={policyErrors}
          stepErrors={stepErrors}
          saveError={saveError}
          busy={busy}
          onSave={save}
          onCancel={() => setDraft(null)}
        />
      ) : null}
    </div>
  );
}

function PolicyEditor({
  draft,
  setDraft,
  endpoints,
  policies,
  policyErrors,
  stepErrors,
  saveError,
  busy,
  onSave,
  onCancel,
}: {
  draft: DraftPolicy;
  setDraft: (d: DraftPolicy) => void;
  endpoints: EndpointView[];
  policies: PolicyView[];
  policyErrors: string[];
  stepErrors: Record<string, string[]>;
  saveError: string | null;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const update = (patch: Partial<DraftPolicy>) => setDraft({ ...draft, ...patch });
  const updateStep = (index: number, patch: Partial<RoutingStep>) => {
    const steps = draft.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    update({ steps });
  };
  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= draft.steps.length) return;
    const steps = [...draft.steps];
    const a = steps[index];
    const b = steps[target];
    if (!a || !b) return;
    steps[index] = b;
    steps[target] = a;
    update({ steps });
  };
  const removeStep = (index: number) => update({ steps: draft.steps.filter((_, i) => i !== index) });

  return (
    <Card testId="policy-editor" style={{ marginTop: space.lg, borderColor: color.accent }}>
      <h3 style={{ marginTop: 0 }} data-testid="policy-editor-title">
        {draft.id ? 'ルートを編集' : '新しいルート'}
      </h3>

      {policyErrors.length > 0 ? (
        <ul data-testid="policy-error" style={{ color: color.danger, fontSize: '0.85rem', margin: '0 0 12px', paddingLeft: 18 }}>
          {policyErrors.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      ) : null}
      {saveError ? (
        <p data-testid="policy-save-error" style={{ color: color.danger, fontSize: '0.85rem' }}>
          {saveError}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: space.sm, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: space.md }}>
        <Field label="ルート名" htmlFor="pol-name">
          <input id="pol-name" data-testid="policy-name-input" value={draft.name} onChange={(e) => update({ name: e.target.value })} style={inputStyle} />
        </Field>
        <Field label="繋がらなかったときの引き継ぎ先" htmlFor="pol-fallback" hint="全手順で繋がらなければ別ルートへ引き継ぎます">
          <select
            id="pol-fallback"
            data-testid="policy-fallback-select"
            value={draft.fallbackPolicyId ?? ''}
            onChange={(e) => update({ fallbackPolicyId: e.target.value || undefined })}
            style={inputStyle}
          >
            <option value="">（引き継がず終了）</option>
            {policies
              .filter((p) => p.id !== draft.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.9rem' }}>
          <input type="checkbox" data-testid="policy-enabled-toggle" checked={draft.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          有効
        </label>
      </div>

      <div data-testid="policy-steps" style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}>
        {draft.steps.map((step, index) => (
          <StepRow
            key={step.id}
            step={step}
            index={index}
            total={draft.steps.length}
            steps={draft.steps}
            endpoints={endpoints}
            policies={policies}
            errors={stepErrors[step.id] ?? []}
            onChange={(patch) => updateStep(index, patch)}
            onMove={(dir) => move(index, dir)}
            onRemove={() => removeStep(index)}
          />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: space.md }}>
        <Button data-testid="policy-add-step" onClick={() => update({ steps: [...draft.steps, emptyStep()] })}>
          手順を追加
        </Button>
        <Button variant="primary" data-testid="policy-save" onClick={onSave} disabled={busy}>
          保存
        </Button>
        <Button data-testid="policy-cancel" onClick={onCancel}>
          取消
        </Button>
      </div>
    </Card>
  );
}

function StepRow({
  step,
  index,
  total,
  steps,
  endpoints,
  policies,
  errors,
  onChange,
  onMove,
  onRemove,
}: {
  step: RoutingStep;
  index: number;
  total: number;
  steps: RoutingStep[];
  endpoints: EndpointView[];
  policies: PolicyView[];
  errors: string[];
  onChange: (patch: Partial<RoutingStep>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const setTransition = (result: RouteResult, transition: RouteTransition | undefined) => {
    const nextOn = { ...step.nextOn };
    if (transition === undefined) delete nextOn[result];
    else nextOn[result] = transition;
    onChange({ nextOn });
  };

  return (
    <div data-testid="policy-step" style={{ border: `1px solid ${errors.length ? color.danger : color.border}`, borderRadius: 10, padding: space.sm }}>
      <div style={{ display: 'flex', gap: space.sm, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <span style={{ fontWeight: 700, alignSelf: 'center' }}>{index + 1}.</span>
        <Field label="接続先" htmlFor={`step-ep-${step.id}`}>
          <select
            id={`step-ep-${step.id}`}
            data-testid="step-endpoint-select"
            value={step.endpointId}
            onChange={(e) => onChange({ endpointId: e.target.value })}
            style={inputStyle}
          >
            <option value="">（選択してください）</option>
            {endpoints.map((ep) => (
              <option key={ep.id} value={ep.id}>
                {ep.label ?? ep.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="動作" htmlFor={`step-action-${step.id}`}>
          <select
            id={`step-action-${step.id}`}
            data-testid="step-action-select"
            value={step.action}
            onChange={(e) => onChange({ action: e.target.value as RouteAction })}
            style={inputStyle}
          >
            {ROUTE_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="待ち時間（秒）" htmlFor={`step-timeout-${step.id}`}>
          <input
            id={`step-timeout-${step.id}`}
            data-testid="step-timeout-input"
            type="number"
            min={1}
            value={step.timeoutSeconds}
            onChange={(e) => onChange({ timeoutSeconds: Number(e.target.value) })}
            style={{ ...inputStyle, width: 90 }}
          />
        </Field>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          <Button data-testid="step-up" onClick={() => onMove(-1)} disabled={index === 0}>
            ↑
          </Button>
          <Button data-testid="step-down" onClick={() => onMove(1)} disabled={index === total - 1}>
            ↓
          </Button>
          <Button variant="danger" data-testid="step-remove" onClick={onRemove}>
            削除
          </Button>
        </div>
      </div>

      {/* 結果別遷移（基本操作）。継続可能な結果ごとに、既定（次へ）から上書きできる。 */}
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', fontSize: '0.85rem', opacity: 0.8 }}>結果別の遷移を細かく指定</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {CONTINUABLE_RESULTS.map((result) => (
            <TransitionRow
              key={result}
              result={result}
              transition={step.nextOn[result]}
              policies={policies}
              steps={steps}
              currentStepId={step.id}
              endpoints={endpoints}
              onChange={(t) => setTransition(result, t)}
            />
          ))}
        </div>
      </details>

      {errors.length > 0 ? (
        <ul data-testid="step-error" style={{ color: color.danger, fontSize: '0.8rem', margin: '8px 0 0', paddingLeft: 18 }}>
          {errors.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TransitionRow({
  result,
  transition,
  policies,
  steps,
  currentStepId,
  endpoints,
  onChange,
}: {
  result: RouteResult;
  transition: RouteTransition | undefined;
  policies: PolicyView[];
  /** 同一ポリシーの手順一覧（goto_step の遷移先候補）。 */
  steps: RoutingStep[];
  /** この遷移行が属する手順の id（表示用途）。 */
  currentStepId: string;
  endpoints: EndpointView[];
  onChange: (t: RouteTransition | undefined) => void;
}) {
  const kind = transitionKindOf(transition);
  // goto_step の遷移先候補は接続先ラベルで見せる（アドレスは出さない）。
  const labelForEndpoint = (endpointId: string): string | undefined =>
    endpoints.find((ep) => ep.id === endpointId)?.label;
  const choices = gotoStepChoices(steps, labelForEndpoint);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.85rem' }}>
      <span style={{ minWidth: 64 }}>{RESULT_LABELS[result]}</span>
      <select
        data-testid="transition-kind-select"
        value={kind}
        onChange={(e) => {
          const v = e.target.value as ReturnType<typeof transitionKindOf>;
          if (v === 'goto_step') {
            // 既定の遷移先は自分以外の先頭手順（無ければ自分）。
            const first = choices.find((c) => c.stepId !== currentStepId) ?? choices[0];
            onChange(buildTransition('goto_step', { stepId: first?.stepId ?? '' }));
          } else if (v === 'fallback_policy') {
            onChange(buildTransition('fallback_policy', { policyId: policies[0]?.id ?? '' }));
          } else {
            onChange(buildTransition(v));
          }
        }}
        style={{ ...inputStyle, minHeight: 34 }}
      >
        {TRANSITION_KIND_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {transition?.kind === 'goto_step' ? (
        <select
          data-testid="transition-step-select"
          value={transition.stepId}
          onChange={(e) => onChange(buildTransition('goto_step', { stepId: e.target.value }))}
          style={{ ...inputStyle, minHeight: 34 }}
        >
          <option value="">（手順を選択）</option>
          {choices.map((c, i) => (
            <option key={c.stepId} value={c.stepId}>
              {`${i + 1}. ${c.label}`}
              {c.stepId === currentStepId ? '（この手順）' : ''}
            </option>
          ))}
        </select>
      ) : null}
      {transition?.kind === 'fallback_policy' ? (
        <select
          data-testid="transition-policy-select"
          value={transition.policyId}
          onChange={(e) => onChange(buildTransition('fallback_policy', { policyId: e.target.value }))}
          style={{ ...inputStyle, minHeight: 34 }}
        >
          <option value="">（ルートを選択）</option>
          {policies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
