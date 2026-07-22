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

type RunState = 'idle' | 'running' | 'error';

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

export function DemoStudio() {
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

      {/* 3 ペイン */}
      <div style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* 左: 会話フロー */}
        <section
          className="card stack"
          data-testid="demo-flow-pane"
          style={{ gap: 'var(--space-xs)', flex: '1 1 240px', minWidth: 240 }}
        >
          <h2 className="card__title">会話フロー{isEditing ? '（編集）' : ''}</h2>
          {turns.length === 0 ? (
            <p className="page__lead" style={{ margin: 0 }}>ターンはありません。</p>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {turns.map((t, i) => {
                const on = i === selectedTurn;
                return (
                  <li key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <button
                      type="button"
                      data-testid={`demo-turn-${i}`}
                      data-selected={on ? 'true' : undefined}
                      aria-pressed={on}
                      className={`btn ${on ? 'btn--primary' : 'btn--ghost'}`}
                      style={{ flex: '1 1 auto', justifyContent: 'flex-start', textAlign: 'left' }}
                      onClick={() => setSelectedTurn(i)}
                    >
                      <span className="badge" style={{ marginRight: 6 }}>{INPUT_MODE_LABEL[t.mode]}</span>
                      {t.value}
                    </button>
                    {isEditing ? (
                      <span style={{ display: 'inline-flex', gap: 2 }}>
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
          style={{ gap: 'var(--space-sm)', flex: '1 1 300px', minWidth: 280 }}
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
          style={{ gap: 'var(--space-sm)', flex: '1 1 360px', minWidth: 320 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 className="card__title" style={{ margin: 0 }}>ライブプレビュー（横向きiPad）</h2>
            <button
              type="button"
              data-testid="demo-run"
              className="btn btn--primary"
              style={{ marginLeft: 'auto' }}
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
