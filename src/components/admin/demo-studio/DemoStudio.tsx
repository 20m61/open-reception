'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEMO_SCENARIOS } from '@/domain/demo-studio/scenarios';
import {
  DEMO_CALL_RESULTS,
  DEMO_INITIAL_MODES,
  DEMO_INPUT_MODES,
  DEMO_QR_RESULTS,
  DEMO_RUNTIME_STATES,
  DEMO_STT_RESULTS,
  validateDemoScenario,
  type DemoCallResult,
  type DemoInitialMode,
  type DemoInputMode,
  type DemoQrResult,
  type DemoRuntimeState,
  type DemoScenario,
  type DemoScenarioFieldErrors,
  type DemoSttResult,
} from '@/domain/demo-studio/scenario';
import {
  addTurn,
  cloneBuiltinToDraft,
  emptyDraft,
  moveTurn,
  removeTurnAt,
  scenarioToDraft,
  setInitialMode,
  setName,
  setSimulatedResults,
  updateTurnAt,
  type DemoScenarioDraft,
} from '@/domain/demo-studio/editor';
import type { DemoPublication, DemoPublicationStatus } from '@/domain/demo-studio/publication';
import type { DemoShareToken } from '@/domain/demo-studio/share-token';
import type { Kiosk } from '@/domain/kiosk/types';
import { canIssueShare, canRevokeShare, canShowRollback, shareStatus, targetLabel } from './publish-panel';

/**
 * 受付体験スタジオ Demo Harness — 3 ペイン編集スタジオ (issue #363 Increment 2)。
 *
 * Inc1（本番 Kiosk を iframe で無改変再生・Mock 注入・既定拒否 sandbox・監査）を土台に、
 * カスタムシナリオの複製・編集・保存を 3 ペインで行う:
 *   - 左  = 会話フロー（ターン一覧・追加/削除/並び替え・選択）
 *   - 中央 = 選択ターンの設定＋シミュレーション結果（文言・入力手段・呼び出し/QR/STT/ランタイム）
 *   - 右  = 既存プレビュー iframe（Inc1 の `/admin/demo/preview` を流用）
 *
 * 組込 9 シナリオは読み取り専用テンプレート。「複製して編集」でカスタム draft を作り、保存は
 * admin API（validateDemoScenario 強制・監査）に委ねる。保存後の「デモ開始」で、保存済み→組込 の
 * 解決順によりプレビューへ反映される。sandbox 境界（本番 API/Vonage/集計へ非接続）は Inc1 のまま。
 *
 * 公開/共有パネル（issue #363 Increment 3・#367 申し送り）: 保存済みカスタムシナリオを選択すると
 * 表示され、`/api/admin/demo/publications*` に委ねて draft → test/published の遷移、Kiosk への
 * 公開、version 履歴からの rollback、共有（認証なし閲覧）リンクの発行/失効を行う。**トークン値は
 * 発行直後のレスポンスでのみ受け取り、以後は再表示しない**（サーバも保存しない）。状態遷移・
 * target 検証・トークン発行は既に admin API 側が最終判定する（fail-closed・監査付き）ため、
 * ここでの表示ロジックは `./publish-panel.ts` の純関数へ切り出し、viewer には `canWrite=false`
 * で操作ボタンを無効化するだけの UI 側抑止に留める（API 側の 403 が本当のガード）。
 */

const MODE_LABEL: Record<DemoInitialMode, string> = {
  signage: 'サイネージ',
  attract: 'ATTRACT',
  reception: '受付',
  qr: 'QR受付',
  out_of_hours: '営業時間外',
};
const INPUT_MODE_LABEL: Record<DemoInputMode, string> = {
  touch: 'タッチ',
  voice: '音声',
  text: 'テキスト',
  qr: 'QR',
};
const CALL_LABEL: Record<DemoCallResult, string> = {
  answered: '応答',
  declined: '拒否',
  no_answer: '未応答',
  failed: '失敗',
};
const QR_LABEL: Record<DemoQrResult, string> = {
  valid: '有効',
  expired: '期限切れ',
  used: '使用済み',
  revoked: '失効',
};
const STT_LABEL: Record<DemoSttResult, string> = {
  success: '成功',
  low_confidence: '低信頼',
  error: 'エラー',
};
const RUNTIME_LABEL: Record<DemoRuntimeState, string> = {
  ready: '稼働',
  starting: '起動中',
  stopped: '停止',
  degraded: '劣化',
};
const STATUS_LABEL: Record<DemoPublicationStatus, string> = {
  draft: '下書き',
  test: 'テスト',
  published: '公開中',
};

type RunState = 'idle' | 'running' | 'error';

/** `/api/admin/demo/publications` が返す形（`DemoPublication` + 共有トークン）。 */
type StoredDemoPublicationClient = DemoPublication & { share?: DemoShareToken };

/** プレビューの内部解像度（横向き iPad 相当。#361 の 35%/65% レール検証と同値）。 */
const PREVIEW_WIDTH = 1080;
const PREVIEW_HEIGHT = 810;

const inputStyle: React.CSSProperties = {
  minHeight: 40,
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  width: '100%',
};

export function DemoStudio({ canWrite = true, siteId }: { canWrite?: boolean; siteId: string }) {
  const [saved, setSaved] = useState<DemoScenario[]>([]);
  const [selectedBuiltinId, setSelectedBuiltinId] = useState<string>(DEMO_SCENARIOS[0]?.id ?? '');
  // editing != null のとき編集モード（カスタム draft）。null のとき組込テンプレートの読み取り表示。
  const [editing, setEditing] = useState<DemoScenarioDraft | null>(null);
  // 編集中 draft の保存済み id（null = 未保存の新規）。
  const [editingSavedId, setEditingSavedId] = useState<string | null>(null);
  const [selectedTurn, setSelectedTurn] = useState<number | null>(null);
  const [errors, setErrors] = useState<DemoScenarioFieldErrors>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState>('idle');

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const [previewScale, setPreviewScale] = useState(1);
  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el) return;
    const measure = () => setPreviewScale(Math.min(1, el.clientWidth / PREVIEW_WIDTH));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [previewSrc]);

  const loadSaved = useCallback(async () => {
    const res = await fetch('/api/admin/demo/scenarios');
    if (res.ok) setSaved((await res.json()) as DemoScenario[]);
  }, []);
  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  /* ---- 公開/共有パネル (issue #363 Inc3・#367 申し送り) ---- */
  const [publications, setPublications] = useState<StoredDemoPublicationClient[]>([]);
  const [kiosks, setKiosks] = useState<Kiosk[]>([]);
  const [pubBusy, setPubBusy] = useState(false);
  const [pubError, setPubError] = useState<string | null>(null);
  const [targetKioskId, setTargetKioskId] = useState('');
  // 発行直後のみ保持する共有 URL（再表示不可。publication 一覧の share には token 値を持たせない）。
  const [justIssuedShareUrl, setJustIssuedShareUrl] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [shareOrigin, setShareOrigin] = useState('');
  // 共有状態（期限切れ判定）に使う「現在時刻」。render 中に Date.now() を直接呼ばない
  // （react-hooks/purity）ため state に持ち、公開単位の再取得のたびに更新する
  // （`platform/ElevationStatus.tsx` の `now` state と同じ方針）。
  const [nowMs, setNowMs] = useState(() => Date.now());

  const loadPublications = useCallback(async () => {
    const res = await fetch('/api/admin/demo/publications');
    if (res.ok) {
      setPublications((await res.json()) as StoredDemoPublicationClient[]);
      setNowMs(Date.now());
    }
  }, []);
  const loadKiosks = useCallback(async () => {
    const res = await fetch('/api/admin/kiosks');
    if (res.ok) {
      const body = (await res.json()) as { items: Kiosk[] };
      setKiosks(body.items);
    }
  }, []);
  useEffect(() => {
    void loadPublications();
    void loadKiosks();
    setShareOrigin(window.location.origin);
  }, [loadPublications, loadKiosks]);

  // 保存済みシナリオが選択されているときだけ、その scenarioId に紐づく公開単位を表示対象にする
  // （組込テンプレート・未保存の新規 draft には公開単位が無い＝ editingSavedId が null）。
  const currentPub = useMemo(
    () => (editingSavedId ? publications.find((p) => p.scenarioId === editingSavedId) : undefined),
    [publications, editingSavedId],
  );
  const enabledKiosks = useMemo(() => kiosks.filter((k) => k.enabled), [kiosks]);

  // 選択中の公開単位が切り替わったら、前の公開先選択・発行直後トークン表示をクリアする。
  useEffect(() => {
    setTargetKioskId('');
    setJustIssuedShareUrl(null);
    setPubError(null);
  }, [currentPub?.id]);

  const createPub = useCallback(async () => {
    if (!editingSavedId) return;
    setPubBusy(true);
    setPubError(null);
    try {
      const res = await fetch('/api/admin/demo/publications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId: editingSavedId }),
      });
      if (!res.ok) {
        setPubError('公開単位の作成に失敗しました。');
        return;
      }
      await loadPublications();
    } finally {
      setPubBusy(false);
    }
  }, [editingSavedId, loadPublications]);

  const setPubStatus = useCallback(
    async (status: DemoPublicationStatus) => {
      if (!currentPub) return;
      setPubBusy(true);
      setPubError(null);
      try {
        const res = await fetch(`/api/admin/demo/publications/${currentPub.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'set_status', status }),
        });
        if (!res.ok) {
          setPubError('状態の変更に失敗しました。');
          return;
        }
        await loadPublications();
      } finally {
        setPubBusy(false);
      }
    },
    [currentPub, loadPublications],
  );

  const publishPub = useCallback(async () => {
    if (!currentPub || !targetKioskId) return;
    const kioskName = enabledKiosks.find((k) => k.id === targetKioskId)?.displayName ?? targetKioskId;
    if (!window.confirm(`このシナリオを Kiosk「${kioskName}」へ本番公開します。よろしいですか？`)) return;
    setPubBusy(true);
    setPubError(null);
    try {
      const res = await fetch(`/api/admin/demo/publications/${currentPub.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'publish', target: { siteId, kioskId: targetKioskId } }),
      });
      if (!res.ok) {
        setPubError('公開に失敗しました（対象端末が無効化・未登録の可能性があります）。');
        return;
      }
      await loadPublications();
    } finally {
      setPubBusy(false);
    }
  }, [currentPub, targetKioskId, siteId, enabledKiosks, loadPublications]);

  const rollbackPub = useCallback(
    async (version: number) => {
      if (!currentPub) return;
      if (!window.confirm(`version ${version} の内容を新しい version として復元（rollback）します。よろしいですか？`)) return;
      setPubBusy(true);
      setPubError(null);
      try {
        const res = await fetch(`/api/admin/demo/publications/${currentPub.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'rollback', version }),
        });
        if (!res.ok) {
          setPubError('ロールバックに失敗しました。');
          return;
        }
        await loadPublications();
      } finally {
        setPubBusy(false);
      }
    },
    [currentPub, loadPublications],
  );

  const issueShare = useCallback(async () => {
    if (!currentPub) return;
    setPubBusy(true);
    setPubError(null);
    setJustIssuedShareUrl(null);
    try {
      const res = await fetch(`/api/admin/demo/publications/${currentPub.id}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        setPubError('共有リンクの発行に失敗しました。');
        return;
      }
      const body = (await res.json()) as { token: string };
      // トークン値はこのレスポンス以外に来ない（サーバも平文保存しない）。再表示不可を UI で明記する。
      setJustIssuedShareUrl(`${shareOrigin}/demo/${body.token}`);
      await loadPublications();
    } finally {
      setPubBusy(false);
    }
  }, [currentPub, shareOrigin, loadPublications]);

  const revokeShare = useCallback(async () => {
    if (!currentPub) return;
    if (!window.confirm('この共有リンクを失効させます。よろしいですか？')) return;
    setPubBusy(true);
    setPubError(null);
    try {
      const res = await fetch(`/api/admin/demo/publications/${currentPub.id}/share`, { method: 'DELETE' });
      if (!res.ok) {
        setPubError('共有リンクの失効に失敗しました。');
        return;
      }
      setJustIssuedShareUrl(null);
      await loadPublications();
    } finally {
      setPubBusy(false);
    }
  }, [currentPub, loadPublications]);

  const deletePub = useCallback(async () => {
    if (!currentPub) return;
    if (!window.confirm('この公開単位を削除します（公開履歴・共有リンクも失われます）。よろしいですか？')) return;
    setPubBusy(true);
    setPubError(null);
    try {
      const res = await fetch(`/api/admin/demo/publications/${currentPub.id}`, { method: 'DELETE' });
      if (!res.ok) {
        setPubError('削除に失敗しました。');
        return;
      }
      setJustIssuedShareUrl(null);
      await loadPublications();
    } finally {
      setPubBusy(false);
    }
  }, [currentPub, loadPublications]);

  const copyShareUrl = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      // clipboard API 不可の環境（権限拒否等）は、表示済みの URL テキストを手動選択してもらう。
    }
  }, []);

  const selectedBuiltin = useMemo(
    () => DEMO_SCENARIOS.find((s) => s.id === selectedBuiltinId),
    [selectedBuiltinId],
  );

  // 表示中のシナリオ（フロー/設定ペインの描画元）。編集モードは draft、そうでなければ組込。
  const active: DemoScenario | DemoScenarioDraft | undefined = editing ?? selectedBuiltin;
  const isEditing = editing !== null;

  /* ---- draft 更新ヘルパ（純関数経由・dirty を立てる） ---- */
  const mutate = useCallback((fn: (d: DemoScenarioDraft) => DemoScenarioDraft) => {
    setEditing((d) => (d ? fn(d) : d));
    setDirty(true);
  }, []);

  /* ---- ソース選択 ---- */
  const selectBuiltin = useCallback((id: string) => {
    setEditing(null);
    setEditingSavedId(null);
    setSelectedBuiltinId(id);
    setSelectedTurn(null);
    setErrors({});
  }, []);

  const selectSaved = useCallback((scn: DemoScenario) => {
    setEditing(scenarioToDraft(scn));
    setEditingSavedId(scn.id);
    setSelectedTurn(scn.visitorInputs.length > 0 ? 0 : null);
    setDirty(false);
    setErrors({});
  }, []);

  const cloneCurrent = useCallback(() => {
    if (!selectedBuiltin) return;
    setEditing(cloneBuiltinToDraft(selectedBuiltin, ''));
    setEditingSavedId(null);
    setSelectedTurn(selectedBuiltin.visitorInputs.length > 0 ? 0 : null);
    setDirty(true);
    setErrors({});
  }, [selectedBuiltin]);

  const createBlank = useCallback(() => {
    setEditing(emptyDraft('', '新しいシナリオ'));
    setEditingSavedId(null);
    setSelectedTurn(null);
    setDirty(true);
    setErrors({});
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setEditingSavedId(null);
    setSelectedTurn(null);
    setErrors({});
    setDirty(false);
  }, []);

  /* ---- 保存 ---- */
  const save = useCallback(async (): Promise<DemoScenario | null> => {
    if (!editing) return null;
    // クライアント検証（新規は id をサーバ採番するため一時 id で検証する）。
    const candidate = { ...editing, id: editingSavedId ?? (editing.id || 'custom-temp') };
    const check = validateDemoScenario(candidate);
    if (!check.ok) {
      setErrors(check.errors);
      return null;
    }
    setErrors({});
    setSaving(true);
    try {
      const url = editingSavedId ? `/api/admin/demo/scenarios/${editingSavedId}` : '/api/admin/demo/scenarios';
      const method = editingSavedId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: editing.name,
          initialMode: editing.initialMode,
          visitorInputs: editing.visitorInputs,
          simulatedResults: editing.simulatedResults,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { errors?: DemoScenarioFieldErrors };
        if (body.errors) setErrors(body.errors);
        return null;
      }
      const savedScn = (await res.json()) as DemoScenario;
      setEditing(scenarioToDraft(savedScn));
      setEditingSavedId(savedScn.id);
      setDirty(false);
      await loadSaved();
      return savedScn;
    } finally {
      setSaving(false);
    }
  }, [editing, editingSavedId, loadSaved]);

  const removeSaved = useCallback(
    async (scn: DemoScenario) => {
      if (!window.confirm(`カスタムシナリオ「${scn.name}」を削除します。よろしいですか?`)) return;
      await fetch(`/api/admin/demo/scenarios/${scn.id}`, { method: 'DELETE' });
      if (editingSavedId === scn.id) cancelEdit();
      await loadSaved();
    },
    [editingSavedId, cancelEdit, loadSaved],
  );

  /* ---- デモ開始（監査記録 + プレビュー起動） ---- */
  const launch = useCallback(async (scenarioId: string) => {
    setRunState('running');
    try {
      const res = await fetch('/api/admin/demo/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId }),
      });
      setRunState(res.ok ? 'idle' : 'error');
    } catch {
      setRunState('error');
    }
    // 監査記録の成否に関わらず sandbox プレビューは起動する（Mock 注入・本番非接続）。
    setPreviewSrc(`/admin/demo/preview?scenario=${encodeURIComponent(scenarioId)}&t=${Date.now()}`);
  }, []);

  const runActive = useCallback(async () => {
    if (isEditing) {
      // 未保存/変更ありならまず保存してからカスタム id で起動する（保存済み→組込 で解決される）。
      let id = editingSavedId;
      if (!id || dirty) {
        const scn = await save();
        if (!scn) return;
        id = scn.id;
      }
      await launch(id);
    } else if (selectedBuiltin) {
      await launch(selectedBuiltin.id);
    }
  }, [isEditing, editingSavedId, dirty, save, launch, selectedBuiltin]);

  const sim = active?.simulatedResults ?? {};
  const turns = active?.visitorInputs ?? [];
  const selTurn = selectedTurn !== null ? turns[selectedTurn] : undefined;

  return (
    <div className="stack" data-testid="demo-studio" style={{ gap: 'var(--space-lg)' }}>
      <header className="stack" style={{ gap: 'var(--space-xs)' }}>
        <h1 className="page__title">受付体験スタジオ（デモ）</h1>
        <p className="page__lead">
          本番の受付端末画面を、模擬データ（Mock）で安全に試せます。組込テンプレートを複製して
          会話フロー・応答結果を編集し、保存したシナリオをプレビューで再生できます。ここでの操作は
          本番の呼び出し・利用量・コスト集計には一切含まれません。
        </p>
        <p className="notice notice--info" data-testid="demo-sandbox-note" style={{ margin: 0 }}>
          サンドボックス: このデモは本番 API・電話発信・集計へ接続しません（プレビューは分離された
          枠内で動作します）。
        </p>
      </header>

      {/* シナリオソース選択 */}
      <section className="card stack" data-testid="demo-source" style={{ gap: 'var(--space-sm)' }}>
        <div className="stack" data-testid="demo-templates" style={{ gap: 4 }}>
          <h2 className="card__title">テンプレート（読み取り専用）</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {DEMO_SCENARIOS.map((s) => {
              const on = !isEditing && s.id === selectedBuiltinId;
              return (
                <button
                  key={s.id}
                  type="button"
                  data-testid={`demo-template-${s.id}`}
                  data-selected={on ? 'true' : undefined}
                  aria-pressed={on}
                  className={`btn ${on ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => selectBuiltin(s.id)}
                >
                  {s.name}
                  <span className="badge" style={{ marginLeft: 6 }}>
                    {MODE_LABEL[s.initialMode]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="stack" data-testid="demo-saved-list" style={{ gap: 4 }}>
          <h2 className="card__title">保存済みカスタムシナリオ</h2>
          {saved.length === 0 ? (
            <p className="page__lead" data-testid="demo-saved-empty" style={{ margin: 0 }}>
              まだありません。テンプレートを複製して作成できます。
            </p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {saved.map((s) => {
                const on = editingSavedId === s.id;
                return (
                  <span key={s.id} style={{ display: 'inline-flex', gap: 2 }}>
                    <button
                      type="button"
                      data-testid={`demo-saved-${s.id}`}
                      data-selected={on ? 'true' : undefined}
                      aria-pressed={on}
                      className={`btn ${on ? 'btn--primary' : 'btn--ghost'}`}
                      onClick={() => selectSaved(s)}
                    >
                      {s.name}
                    </button>
                    <button
                      type="button"
                      data-testid={`demo-delete-${s.id}`}
                      className="btn btn--ghost"
                      aria-label={`${s.name}を削除`}
                      onClick={() => void removeSaved(s)}
                    >
                      削除
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {!isEditing ? (
            <button type="button" data-testid="demo-clone" className="btn btn--primary" onClick={cloneCurrent}>
              このテンプレートを複製して編集
            </button>
          ) : (
            <button type="button" data-testid="demo-cancel-edit" className="btn btn--ghost" onClick={cancelEdit}>
              編集を終了
            </button>
          )}
          <button type="button" data-testid="demo-new" className="btn btn--ghost" onClick={createBlank}>
            新規作成
          </button>
        </div>
      </section>

      {/* 公開/共有パネル (issue #363 Increment 3・#367 申し送り) */}
      <section className="card stack" data-testid="demo-pub-panel" style={{ gap: 'var(--space-sm)' }}>
        <h2 className="card__title">公開・共有</h2>
        {!canWrite ? (
          <p className="notice notice--info" data-testid="demo-pub-viewer-note" style={{ margin: 0 }}>
            閲覧のみの権限です。公開・共有の操作はできません。
          </p>
        ) : null}
        {!editingSavedId ? (
          <p className="page__lead" data-testid="demo-pub-empty" style={{ margin: 0 }}>
            保存済みカスタムシナリオを選択すると、公開先 Kiosk への公開や共有リンクの発行ができます。
          </p>
        ) : !currentPub ? (
          <>
            <p className="page__lead" style={{ margin: 0 }}>
              このシナリオはまだ公開単位を作成していません。
            </p>
            <button
              type="button"
              data-testid="demo-pub-create"
              className="btn btn--primary"
              disabled={!canWrite || pubBusy}
              onClick={() => void createPub()}
            >
              公開単位を作成（下書き）
            </button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="badge" data-testid="demo-pub-status" data-status={currentPub.status}>
                {STATUS_LABEL[currentPub.status]}
              </span>
              {dirty && editingSavedId === currentPub.scenarioId ? (
                <span className="page__lead" data-testid="demo-pub-dirty-note" style={{ margin: 0, fontSize: '0.8rem' }}>
                  未保存の変更があります（公開には保存済みの内容が使われます）。
                </span>
              ) : null}
            </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {currentPub.status === 'draft' ? (
                <button
                  type="button"
                  data-testid="demo-pub-set-test"
                  className="btn btn--ghost"
                  disabled={!canWrite || pubBusy}
                  onClick={() => void setPubStatus('test')}
                >
                  テストへ進める
                </button>
              ) : null}
              {currentPub.status === 'test' ? (
                <button
                  type="button"
                  data-testid="demo-pub-set-draft"
                  className="btn btn--ghost"
                  disabled={!canWrite || pubBusy}
                  onClick={() => void setPubStatus('draft')}
                >
                  下書きへ戻す
                </button>
              ) : null}
              <button
                type="button"
                data-testid="demo-pub-delete"
                className="btn btn--ghost"
                disabled={!canWrite || pubBusy}
                onClick={() => void deletePub()}
              >
                公開単位を削除
              </button>
            </div>

            {/* 公開先選択・公開 */}
            <div className="stack" style={{ gap: 4, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
              <label className="stack" style={{ gap: 2 }}>
                <span style={{ fontSize: '0.85rem', opacity: 0.75 }}>公開先 Kiosk</span>
                <select
                  data-testid="demo-pub-target"
                  value={targetKioskId}
                  onChange={(e) => setTargetKioskId(e.target.value)}
                  disabled={!canWrite || pubBusy || enabledKiosks.length === 0}
                  style={inputStyle}
                >
                  <option value="">選択してください</option>
                  {enabledKiosks.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.displayName}
                    </option>
                  ))}
                </select>
              </label>
              {enabledKiosks.length === 0 ? (
                <p className="notice notice--warning" data-testid="demo-pub-no-kiosks" style={{ margin: 0 }}>
                  有効な Kiosk がありません。端末管理で登録・有効化してください。
                </p>
              ) : null}
              <button
                type="button"
                data-testid="demo-pub-publish"
                className="btn btn--primary"
                disabled={!canWrite || pubBusy || !targetKioskId}
                onClick={() => void publishPub()}
              >
                このシナリオを公開する
              </button>
            </div>

            {/* version 履歴・rollback */}
            <div
              className="stack"
              data-testid="demo-pub-versions"
              style={{ gap: 4, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}
            >
              <span style={{ fontSize: '0.85rem', opacity: 0.75 }}>公開履歴</span>
              {!canShowRollback(currentPub.versions.length) ? (
                <p className="page__lead" data-testid="demo-pub-versions-empty" style={{ margin: 0 }}>
                  まだ公開されていません。
                </p>
              ) : (
                <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {[...currentPub.versions].reverse().map((v) => {
                    const isCurrent = v.version === currentPub.currentVersion;
                    return (
                      <li
                        key={v.version}
                        data-testid={`demo-pub-version-${v.version}`}
                        style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
                      >
                        <span className="badge" data-current={isCurrent ? 'true' : undefined}>
                          v{v.version}
                          {isCurrent ? '（現在）' : ''}
                        </span>
                        <span style={{ fontSize: '0.8rem', opacity: 0.75 }}>
                          {new Date(v.publishedAt).toLocaleString('ja-JP')} → {targetLabel(v.target, kiosks)}
                          {v.rolledBackFrom !== undefined ? `（v${v.rolledBackFrom} から復元）` : ''}
                        </span>
                        {!isCurrent ? (
                          <button
                            type="button"
                            data-testid={`demo-pub-rollback-${v.version}`}
                            className="btn btn--ghost"
                            disabled={!canWrite || pubBusy}
                            onClick={() => void rollbackPub(v.version)}
                          >
                            この version へロールバック
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>

            {/* 共有（認証なし閲覧）リンク */}
            <div
              className="stack"
              data-testid="demo-pub-share"
              style={{ gap: 6, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}
            >
              <span style={{ fontSize: '0.85rem', opacity: 0.75 }}>共有リンク（認証なし閲覧）</span>
              {(() => {
                const status = shareStatus(currentPub.share, nowMs);
                if (status === 'active') {
                  return (
                    <p className="page__lead" data-testid="demo-pub-share-active" style={{ margin: 0 }}>
                      共有リンクは有効です（有効期限:{' '}
                      {currentPub.share ? new Date(currentPub.share.expiresAt).toLocaleString('ja-JP') : ''}）。
                    </p>
                  );
                }
                const emptyLabel =
                  status === 'revoked'
                    ? '共有リンクは失効済みです。'
                    : status === 'expired'
                      ? '共有リンクの有効期限が切れています。'
                      : '共有リンクは未発行です。';
                return (
                  <p className="page__lead" data-testid="demo-pub-share-empty" style={{ margin: 0 }}>
                    {emptyLabel}
                  </p>
                );
              })()}
              {justIssuedShareUrl ? (
                <div className="notice notice--info stack" data-testid="demo-pub-share-token" style={{ gap: 4 }}>
                  <p style={{ margin: 0 }}>
                    発行直後のみ表示されます。この画面を離れると再表示できません。必ずコピーしてください。
                  </p>
                  <code data-testid="demo-pub-share-url" style={{ wordBreak: 'break-all' }}>
                    {justIssuedShareUrl}
                  </code>
                  <button
                    type="button"
                    data-testid="demo-pub-share-copy"
                    className="btn btn--ghost"
                    onClick={() => void copyShareUrl(justIssuedShareUrl)}
                  >
                    {copyState === 'copied' ? 'コピーしました' : 'URLをコピー'}
                  </button>
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  data-testid="demo-pub-share-issue"
                  className="btn btn--primary"
                  disabled={!canWrite || pubBusy || !canIssueShare(currentPub.status, currentPub.share, nowMs)}
                  onClick={() => void issueShare()}
                >
                  共有リンクを発行
                </button>
                {canRevokeShare(currentPub.share, nowMs) ? (
                  <button
                    type="button"
                    data-testid="demo-pub-share-revoke"
                    className="btn btn--ghost"
                    disabled={!canWrite || pubBusy}
                    onClick={() => void revokeShare()}
                  >
                    失効させる
                  </button>
                ) : null}
              </div>
            </div>

            {pubError ? (
              <p className="notice notice--warning" data-testid="demo-pub-error" style={{ margin: 0 }}>
                {pubError}
              </p>
            ) : null}
          </>
        )}
      </section>

      {/* 3 ペイン */}
      <div style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* 左: 会話フロー */}
        <section
          className="card stack"
          data-testid="demo-flow-pane"
          style={{ gap: 'var(--space-xs)', flex: '1 1 260px', minWidth: 260 }}
        >
          <h2 className="card__title">会話フロー{isEditing ? '（編集）' : ''}</h2>
          {turns.length === 0 ? (
            <p className="page__lead" style={{ margin: 0 }}>ターンはありません。</p>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {turns.map((t, i) => {
                const on = i === selectedTurn;
                return (
                  <li key={i} className="demo-turn-item">
                    <button
                      type="button"
                      data-testid={`demo-turn-${i}`}
                      data-selected={on ? 'true' : undefined}
                      aria-pressed={on}
                      title={t.value}
                      className={`btn ${on ? 'btn--primary' : 'btn--ghost'} demo-turn-chip`}
                      style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                      onClick={() => setSelectedTurn(i)}
                    >
                      <span className="badge demo-turn-chip__badge">{INPUT_MODE_LABEL[t.mode]}</span>
                      <span className="demo-turn-chip__value">{t.value}</span>
                    </button>
                    {isEditing ? (
                      <span className="demo-turn-item__actions">
                        <button
                          type="button"
                          data-testid={`demo-turn-up-${i}`}
                          className="btn btn--ghost"
                          aria-label={`ターン${i + 1}を上へ`}
                          disabled={i === 0}
                          onClick={() => mutate((d) => moveTurn(d, i, -1))}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          data-testid={`demo-turn-down-${i}`}
                          className="btn btn--ghost"
                          aria-label={`ターン${i + 1}を下へ`}
                          disabled={i === turns.length - 1}
                          onClick={() => mutate((d) => moveTurn(d, i, 1))}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          data-testid={`demo-turn-remove-${i}`}
                          className="btn btn--ghost"
                          aria-label={`ターン${i + 1}を削除`}
                          onClick={() => {
                            mutate((d) => removeTurnAt(d, i));
                            setSelectedTurn(null);
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
          {isEditing ? (
            <button
              type="button"
              data-testid="demo-turn-add"
              className="btn btn--ghost"
              onClick={() => {
                mutate((d) => addTurn(d, { mode: 'touch', value: '新しいターン' }));
                setSelectedTurn(turns.length);
              }}
            >
              ＋ ターンを追加
            </button>
          ) : null}
          {errors.visitorInputs ? (
            <p className="notice notice--warning" data-testid="demo-error-visitorInputs" style={{ margin: 0 }}>
              {errors.visitorInputs}
            </p>
          ) : null}
        </section>

        {/* 中央: 設定 */}
        <section
          className="card stack"
          data-testid="demo-settings-pane"
          style={{ gap: 'var(--space-sm)', flex: '1 1 320px', minWidth: 300 }}
        >
          <h2 className="card__title">ターン設定・シミュレーション</h2>

          {/* シナリオ全体 */}
          <label className="stack" style={{ gap: 2 }}>
            <span style={{ fontSize: '0.85rem', opacity: 0.75 }}>シナリオ名</span>
            {isEditing ? (
              <input
                data-testid="demo-name-input"
                value={editing!.name}
                onChange={(e) => mutate((d) => setName(d, e.target.value))}
                style={inputStyle}
              />
            ) : (
              <strong>{active?.name}</strong>
            )}
          </label>
          {errors.name ? (
            <p className="notice notice--warning" data-testid="demo-error-name" style={{ margin: 0 }}>{errors.name}</p>
          ) : null}

          <label className="stack" style={{ gap: 2 }}>
            <span style={{ fontSize: '0.85rem', opacity: 0.75 }}>起動モード</span>
            {isEditing ? (
              <select
                data-testid="demo-initial-mode"
                value={editing!.initialMode}
                onChange={(e) => mutate((d) => setInitialMode(d, e.target.value as DemoInitialMode))}
                style={inputStyle}
              >
                {DEMO_INITIAL_MODES.map((m) => (
                  <option key={m} value={m}>{MODE_LABEL[m]}</option>
                ))}
              </select>
            ) : (
              <span>{active ? MODE_LABEL[active.initialMode] : ''}</span>
            )}
          </label>
          {errors.initialMode ? (
            <p className="notice notice--warning" data-testid="demo-error-initialMode" style={{ margin: 0 }}>
              {errors.initialMode}
            </p>
          ) : null}

          {/* 選択ターン */}
          <div className="stack" style={{ gap: 4, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
            <span style={{ fontSize: '0.85rem', opacity: 0.75 }}>
              選択ターン{selectedTurn !== null ? `（#${selectedTurn + 1}）` : ''}
            </span>
            {selTurn ? (
              <>
                <label className="stack" style={{ gap: 2 }}>
                  <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>入力手段</span>
                  {isEditing ? (
                    <select
                      data-testid="demo-turn-mode"
                      value={selTurn.mode}
                      onChange={(e) =>
                        mutate((d) => updateTurnAt(d, selectedTurn!, { mode: e.target.value as DemoInputMode }))
                      }
                      style={inputStyle}
                    >
                      {DEMO_INPUT_MODES.map((m) => (
                        <option key={m} value={m}>{INPUT_MODE_LABEL[m]}</option>
                      ))}
                    </select>
                  ) : (
                    <span>{INPUT_MODE_LABEL[selTurn.mode]}</span>
                  )}
                </label>
                <label className="stack" style={{ gap: 2 }}>
                  <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>文言・値</span>
                  {isEditing ? (
                    <input
                      data-testid="demo-turn-value"
                      value={selTurn.value}
                      onChange={(e) =>
                        mutate((d) => updateTurnAt(d, selectedTurn!, { value: e.target.value }))
                      }
                      style={inputStyle}
                    />
                  ) : (
                    <span>{selTurn.value}</span>
                  )}
                </label>
                {errors[`visitorInputs.${selectedTurn}.value`] ? (
                  <p
                    className="notice notice--warning"
                    data-testid="demo-error-turn-value"
                    style={{ margin: 0 }}
                  >
                    {errors[`visitorInputs.${selectedTurn}.value`]}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="page__lead" style={{ margin: 0 }}>左の会話フローからターンを選択してください。</p>
            )}
          </div>

          {/* シミュレーション結果 */}
          <div className="stack" style={{ gap: 6, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
            <span style={{ fontSize: '0.85rem', opacity: 0.75 }}>シミュレーション結果</span>

            {/* 呼び出し結果列 */}
            <div className="stack" data-testid="demo-sim-call" style={{ gap: 4 }}>
              <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>呼び出し結果（順に取次）</span>
              {(sim.call ?? []).map((c, ci) => (
                <div key={ci} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {isEditing ? (
                    <select
                      data-testid={`demo-call-${ci}`}
                      value={c}
                      onChange={(e) =>
                        mutate((d) => {
                          const next = [...(d.simulatedResults.call ?? [])];
                          next[ci] = e.target.value as DemoCallResult;
                          return setSimulatedResults(d, { call: next });
                        })
                      }
                      style={inputStyle}
                    >
                      {DEMO_CALL_RESULTS.map((r) => (
                        <option key={r} value={r}>{CALL_LABEL[r]}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="badge">{CALL_LABEL[c]}</span>
                  )}
                  {isEditing ? (
                    <button
                      type="button"
                      data-testid={`demo-call-remove-${ci}`}
                      className="btn btn--ghost"
                      aria-label={`呼び出し結果${ci + 1}を削除`}
                      onClick={() =>
                        mutate((d) =>
                          setSimulatedResults(d, {
                            call: (d.simulatedResults.call ?? []).filter((_, k) => k !== ci),
                          }),
                        )
                      }
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
              {isEditing ? (
                <button
                  type="button"
                  data-testid="demo-call-add"
                  className="btn btn--ghost"
                  onClick={() =>
                    mutate((d) => setSimulatedResults(d, { call: [...(d.simulatedResults.call ?? []), 'answered'] }))
                  }
                >
                  ＋ 呼び出し結果を追加
                </button>
              ) : null}
              {errors['simulatedResults.call'] ? (
                <p className="notice notice--warning" data-testid="demo-error-call" style={{ margin: 0 }}>
                  {errors['simulatedResults.call']}
                </p>
              ) : null}
            </div>

            <EnumField
              testId="demo-sim-qr"
              label="QR結果"
              editing={isEditing}
              value={sim.qr}
              options={DEMO_QR_RESULTS}
              labels={QR_LABEL}
              onChange={(v) => mutate((d) => setSimulatedResults(d, { qr: v }))}
            />
            <EnumField
              testId="demo-sim-stt"
              label="音声認識"
              editing={isEditing}
              value={sim.stt}
              options={DEMO_STT_RESULTS}
              labels={STT_LABEL}
              onChange={(v) => mutate((d) => setSimulatedResults(d, { stt: v }))}
            />
            <EnumField
              testId="demo-sim-runtime"
              label="ランタイム"
              editing={isEditing}
              value={sim.runtime}
              options={DEMO_RUNTIME_STATES}
              labels={RUNTIME_LABEL}
              onChange={(v) => mutate((d) => setSimulatedResults(d, { runtime: v }))}
            />
          </div>

          {isEditing ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                data-testid="demo-save"
                className="btn btn--primary"
                disabled={saving || !dirty}
                onClick={() => void save()}
              >
                {saving ? '保存中…' : dirty ? '保存' : '保存済み'}
              </button>
            </div>
          ) : null}
        </section>

        {/* 右: プレビュー */}
        <section
          className="card stack"
          data-testid="demo-preview-pane"
          style={{ gap: 'var(--space-sm)', flex: '1 1 380px', minWidth: 340 }}
        >
          <div className="demo-preview-header">
            <h2 className="card__title demo-preview-header__title">ライブプレビュー（横向きiPad）</h2>
            <button
              type="button"
              data-testid="demo-run"
              className="btn btn--primary demo-preview-header__action"
              disabled={runState === 'running' || (!isEditing && !selectedBuiltin)}
              onClick={() => void runActive()}
            >
              {runState === 'running' ? '開始中…' : isEditing ? '保存してデモ開始' : 'このシナリオでデモ開始'}
            </button>
          </div>
          {runState === 'error' ? (
            <p className="notice notice--warning" data-testid="demo-run-error" style={{ margin: 0 }}>
              デモ実行の監査記録に失敗しました（プレビューは表示されます）。
            </p>
          ) : null}
          {previewSrc ? (
            <div
              ref={previewBoxRef}
              style={{
                position: 'relative',
                width: '100%',
                maxWidth: PREVIEW_WIDTH,
                aspectRatio: `${PREVIEW_WIDTH} / ${PREVIEW_HEIGHT}`,
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              <iframe
                ref={frameRef}
                data-testid="demo-preview-frame"
                title="受付端末デモプレビュー"
                src={previewSrc}
                sandbox="allow-scripts allow-same-origin allow-forms"
                style={{
                  width: PREVIEW_WIDTH,
                  height: PREVIEW_HEIGHT,
                  border: 0,
                  transform: `scale(${previewScale})`,
                  transformOrigin: 'top left',
                }}
              />
            </div>
          ) : (
            <p className="page__lead" data-testid="demo-preview-empty">
              「デモ開始」を押すと、本番の受付画面が模擬データで表示されます。
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/** undefined 可の列挙フィールド（未設定 = 既定の正常系）。 */
function EnumField<T extends string>({
  testId,
  label,
  editing,
  value,
  options,
  labels,
  onChange,
}: {
  testId: string;
  label: string;
  editing: boolean;
  value: T | undefined;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T | undefined) => void;
}) {
  return (
    <label className="stack" style={{ gap: 2 }}>
      <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>{label}</span>
      {editing ? (
        <select
          data-testid={testId}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : (e.target.value as T))}
          style={inputStyle}
        >
          <option value="">未設定（既定）</option>
          {options.map((o) => (
            <option key={o} value={o}>{labels[o]}</option>
          ))}
        </select>
      ) : (
        <span>{value ? labels[value] : '未設定'}</span>
      )}
    </label>
  );
}
