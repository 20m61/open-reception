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

/* ---------------- 保存時の検証（Increment 2・カスタムシナリオ編集/保存） ---------------- */

/**
 * カスタムシナリオ保存時の上限とパターン (issue #363 Inc2)。
 *
 * 目的は 2 つ:
 *   1. 「巨大入力」を保存境界で弾く（ストレージ肥大・DoS 面の抑制）。
 *   2. `id` を collection キー/URL パスに使える安全な文字種に限定する（キー注入の防止）。
 * 値は運用上十分に緩く、かつデモ用途を超える持ち込みを許さない範囲に置く。
 */
export const DEMO_SCENARIO_LIMITS = {
  /** 合成 id の許容パターン（英数・ハイフン・アンダースコアのみ）。 */
  idPattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
  idMaxLength: 64,
  nameMaxLength: 80,
  maxVisitorInputs: 12,
  valueMaxLength: 120,
  maxCallResults: 8,
} as const;

/** フィールド別の検証エラー（UI がフィールド脇に表示する。キーはドット区切りパス）。 */
export type DemoScenarioFieldErrors = Record<string, string>;

export type ValidateDemoScenarioResult =
  | { ok: true; scenario: DemoScenario }
  | { ok: false; errors: DemoScenarioFieldErrors };

/**
 * sandbox 内容境界 (issue #363 Inc2・AC「URL・スクリプト等を持ち込ませない」)。
 *
 * シナリオの文言はデモ用の擬似ラベルのみを想定する。URL・スクリプト・テンプレート補間・
 * 制御文字を含む文字列は保存を拒否する。これにより保存済みシナリオが外部リソース参照や
 * インジェクションの運び手にならないことを構造的に担保する（sandbox の既定拒否と対を成す）。
 */
export function hasUnsafeScenarioText(s: string): boolean {
  // 制御文字（改行・タブ含む。デモ文言に不要）。
  if (/[\u0000-\u001f\u007f]/.test(s)) return true;
  // HTML/スクリプト角括弧。
  if (/[<>]/.test(s)) return true;
  // URL スキーム・プロトコル相対（`//host`）・危険スキーム。
  if (/\/\//.test(s)) return true;
  if (/\b(?:https?|data|javascript|vbscript|file|blob):/i.test(s)) return true;
  // テンプレート補間・バッククォート。
  if (/\$\{|\{\{|`/.test(s)) return true;
  return false;
}

function checkText(
  errors: DemoScenarioFieldErrors,
  key: string,
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string') {
    errors[key] = '文字列が必要です';
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors[key] = '必須です';
    return undefined;
  }
  if (trimmed.length > maxLength) {
    errors[key] = `${maxLength} 文字以内で入力してください`;
    return undefined;
  }
  if (hasUnsafeScenarioText(trimmed)) {
    errors[key] = 'URL・記号・スクリプトは使用できません';
    return undefined;
  }
  return trimmed;
}

/**
 * 保存対象のシナリオ候補を検証し、フィールド別エラーを収集して返す (issue #363 Inc2)。
 *
 * `isDemoScenario`（構造ガード・boolean）と違い、
 *   - どのフィールドが・なぜ不正かを `errors` に**全件**集める（UI がフィールド脇に出す）。
 *   - 「巨大入力」を上限で弾き、`id` を安全な文字種に限定し、文言の URL/スクリプト持ち込みを拒否する。
 * 成功時は正規化済み（trim 済み・既知キーのみの）シナリオを返す。
 */
export function validateDemoScenario(v: unknown): ValidateDemoScenarioResult {
  const errors: DemoScenarioFieldErrors = {};
  if (typeof v !== 'object' || v === null) {
    return { ok: false, errors: { _: 'シナリオの形式が不正です' } };
  }
  const o = v as Record<string, unknown>;

  // id: 安全な文字種・長さのみ（collection キー/URL パスに使う）。
  let id: string | undefined;
  if (typeof o.id !== 'string' || o.id.length === 0) {
    errors.id = '必須です';
  } else if (o.id.length > DEMO_SCENARIO_LIMITS.idMaxLength) {
    errors.id = `${DEMO_SCENARIO_LIMITS.idMaxLength} 文字以内にしてください`;
  } else if (!DEMO_SCENARIO_LIMITS.idPattern.test(o.id)) {
    errors.id = '英数字・ハイフン・アンダースコアのみ使用できます';
  } else {
    id = o.id;
  }

  const name = checkText(errors, 'name', o.name, DEMO_SCENARIO_LIMITS.nameMaxLength);

  if (!isIn(DEMO_INITIAL_MODES, o.initialMode)) {
    errors.initialMode = '不明な起動モードです';
  }

  const visitorInputs: DemoVisitorInput[] = [];
  if (!Array.isArray(o.visitorInputs)) {
    errors.visitorInputs = '配列が必要です';
  } else if (o.visitorInputs.length > DEMO_SCENARIO_LIMITS.maxVisitorInputs) {
    errors.visitorInputs = `ターンは ${DEMO_SCENARIO_LIMITS.maxVisitorInputs} 個までです`;
  } else {
    o.visitorInputs.forEach((turn, i) => {
      const t = turn as Record<string, unknown>;
      if (typeof turn !== 'object' || turn === null) {
        errors[`visitorInputs.${i}`] = '形式が不正です';
        return;
      }
      let modeOk = true;
      if (!isIn(DEMO_INPUT_MODES, t.mode)) {
        errors[`visitorInputs.${i}.mode`] = '不明な入力手段です';
        modeOk = false;
      }
      const value = checkText(errors, `visitorInputs.${i}.value`, t.value, DEMO_SCENARIO_LIMITS.valueMaxLength);
      if (modeOk && value !== undefined) {
        visitorInputs.push({ mode: t.mode as DemoInputMode, value });
      }
    });
  }

  const simulatedResults: DemoSimulatedResults = {};
  if (typeof o.simulatedResults !== 'object' || o.simulatedResults === null) {
    errors.simulatedResults = 'オブジェクトが必要です';
  } else {
    const r = o.simulatedResults as Record<string, unknown>;
    if (r.stt !== undefined) {
      if (isIn(DEMO_STT_RESULTS, r.stt)) simulatedResults.stt = r.stt;
      else errors['simulatedResults.stt'] = '不明な音声認識結果です';
    }
    if (r.qr !== undefined) {
      if (isIn(DEMO_QR_RESULTS, r.qr)) simulatedResults.qr = r.qr;
      else errors['simulatedResults.qr'] = '不明なQR結果です';
    }
    if (r.runtime !== undefined) {
      if (isIn(DEMO_RUNTIME_STATES, r.runtime)) simulatedResults.runtime = r.runtime;
      else errors['simulatedResults.runtime'] = '不明なランタイム状態です';
    }
    if (r.call !== undefined) {
      if (!Array.isArray(r.call)) {
        errors['simulatedResults.call'] = '配列が必要です';
      } else if (r.call.length > DEMO_SCENARIO_LIMITS.maxCallResults) {
        errors['simulatedResults.call'] = `呼び出し結果は ${DEMO_SCENARIO_LIMITS.maxCallResults} 個までです`;
      } else if (!r.call.every((c) => isIn(DEMO_CALL_RESULTS, c))) {
        errors['simulatedResults.call'] = '不明な呼び出し結果が含まれます';
      } else {
        simulatedResults.call = r.call as DemoCallResult[];
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    scenario: {
      id: id!,
      name: name!,
      initialMode: o.initialMode as DemoInitialMode,
      visitorInputs,
      simulatedResults,
    },
  };
}
