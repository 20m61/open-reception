/**
 * 受付体験スタジオ「Demo Harness」のシナリオ型 (issue #363, Increment 1)。
 *
 * 本番 Kiosk コンポーネントを Mock Adapter 注入で動かすための**静的なシナリオ定義**。
 * 型は issue #363 本文の `DemoScenario` 定義どおり。語彙は既存契約に**合わせる**:
 *   - `simulatedResults.call` … #374 `RouteResult`（`src/domain/routing/policy.ts`）の部分集合
 *     （answered / declined / no_answer / failed）。独自の結果語彙を発明しない。
 *   - `visitorInputs[].mode` … #361 `InputMode`（`src/domain/reception/ui-contract.ts`）と同一。
 *
 * PII を持ち込まない: シナリオの `value` は「用件カテゴリ」や合成表示名などデモ用の擬似値のみで、
 * 実来訪者情報・実 token を入れない（`.claude/rules/pii-secret-minimization.md`）。
 */

/** 起動時の画面レイヤー。#362 の KioskMode 語彙に沿う（out_of_hours は将来の営業時間連携の予約枠）。 */
export const DEMO_INITIAL_MODES = [
  'signage',
  'attract',
  'reception',
  'qr',
  'out_of_hours',
] as const;
export type DemoInitialMode = (typeof DEMO_INITIAL_MODES)[number];

/** 来訪者入力の手段。#361 InputMode と同一語彙。 */
export const DEMO_INPUT_MODES = ['touch', 'voice', 'text', 'qr'] as const;
export type DemoInputMode = (typeof DEMO_INPUT_MODES)[number];

/**
 * 呼び出し結果。#374 `RouteResult` の部分集合に限定する（issue #363 本文の定義どおり 4 種）。
 * RouteResult 全域（accepted / staff_coming / busy）ではなく、来訪者から見た終端結果に絞る。
 */
export const DEMO_CALL_RESULTS = ['answered', 'declined', 'no_answer', 'failed'] as const;
export type DemoCallResult = (typeof DEMO_CALL_RESULTS)[number];

/** QR 解決結果。#98 CheckinFailureReason（expired/used/revoked）＋ valid に対応。 */
export const DEMO_QR_RESULTS = ['valid', 'expired', 'used', 'revoked'] as const;
export type DemoQrResult = (typeof DEMO_QR_RESULTS)[number];

/** STT（音声認識）結果。 */
export const DEMO_STT_RESULTS = ['success', 'low_confidence', 'error'] as const;
export type DemoSttResult = (typeof DEMO_STT_RESULTS)[number];

/** ランタイム状態（端末・アバターランタイムの稼働局面）。 */
export const DEMO_RUNTIME_STATES = ['ready', 'starting', 'stopped', 'degraded'] as const;
export type DemoRuntimeState = (typeof DEMO_RUNTIME_STATES)[number];

/** シナリオが指定する来訪者の 1 入力（seed・表示用。Inc1 では自動再生しない。下記 NOTE 参照）。 */
export type DemoVisitorInput = {
  mode: DemoInputMode;
  value: string;
};

/** Mock Adapter が返す結果の指定。すべて任意（未指定は既定の正常系）。 */
export type DemoSimulatedResults = {
  stt?: DemoSttResult;
  qr?: DemoQrResult;
  /** 呼び出しの結果列（複数手の取次を表す。Inc1 は終端結果のみ再現。下記 NOTE 参照）。 */
  call?: ReadonlyArray<DemoCallResult>;
  runtime?: DemoRuntimeState;
};

/**
 * デモシナリオ（issue #363 本文の型定義どおり）。
 *
 * NOTE（Inc1 の再現範囲）: `visitorInputs` の自動再生と、`call` の複数手（代理→部門代表）を
 * 1 手ずつ個別にアニメーションする挙動は、本番 KioskFlow への注入点が無いため Inc1 では
 * 行わない（KioskFlow は編集禁止）。Inc1 は「Mock Adapter がバックエンド結果を決定論的に返し、
 * 管理者が本番 Kiosk を手動で操作して確認する」レンジに留める。詳細は mock-adapter.ts。
 */
export type DemoScenario = {
  id: string;
  name: string;
  initialMode: DemoInitialMode;
  visitorInputs: ReadonlyArray<DemoVisitorInput>;
  simulatedResults: DemoSimulatedResults;
};

function isIn<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v);
}

function isVisitorInput(v: unknown): v is DemoVisitorInput {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return isIn(DEMO_INPUT_MODES, o.mode) && typeof o.value === 'string';
}

function isSimulatedResults(v: unknown): v is DemoSimulatedResults {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.stt !== undefined && !isIn(DEMO_STT_RESULTS, o.stt)) return false;
  if (o.qr !== undefined && !isIn(DEMO_QR_RESULTS, o.qr)) return false;
  if (o.runtime !== undefined && !isIn(DEMO_RUNTIME_STATES, o.runtime)) return false;
  if (o.call !== undefined) {
    if (!Array.isArray(o.call)) return false;
    if (!o.call.every((c) => isIn(DEMO_CALL_RESULTS, c))) return false;
  }
  return true;
}

/**
 * 信頼できない入力を DemoScenario として検証する（ホワイトリスト方式）。
 * 未知の列挙値・欠落フィールドは false。API 境界・Mock Adapter の防御に使う。
 */
export function isDemoScenario(v: unknown): v is DemoScenario {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return false;
  if (typeof o.name !== 'string' || o.name.length === 0) return false;
  if (!isIn(DEMO_INITIAL_MODES, o.initialMode)) return false;
  if (!Array.isArray(o.visitorInputs) || !o.visitorInputs.every(isVisitorInput)) return false;
  if (!isSimulatedResults(o.simulatedResults)) return false;
  return true;
}
