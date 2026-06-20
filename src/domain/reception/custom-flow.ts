/**
 * 来訪目的別カスタム受付フローの純ドメインモデル (issue #100, increment 1)。
 *
 * 来訪目的（面接 / 宅配 / 工事 など）ごとに、受付端末で表示する「ステップの並び」と
 * 「来訪者情報入力フォームのフィールド」を切り替えられるようにする。本モジュールは
 * 状態遷移（src/domain/reception/state.ts）とは責務が異なり、**フロー定義そのもの**
 * （何を・どの順で表示し、どの入力を要求するか）を純データ + 純関数で表す。
 *
 * 設計方針:
 *   - すべて純粋（I/O なし）。バリデーション・正規化・既定フロー生成をここに閉じ込め、
 *     永続化（src/lib/reception/flow-config）・認可・監査は外側の層が担う（責務分離）。
 *   - 入力フィールドタイプは MVP で text / textarea / select / checkbox に限定する
 *     （issue #100 UX 方針）。機微情報欄を安易に作らないため、フィールドは表示ラベルと
 *     必須/任意・選択肢のみを持ち、保存先カラム名などの自由定義は inc1 では持たない。
 *   - ステップ種別は受付端末の画面に対応する（目的選択 → 担当者/部署選択 →
 *     来訪者情報入力 → 確認 → 呼び出し）。フローごとに表示するステップを取捨選択できる。
 *
 * PII 方針: フロー定義自体は来訪者の個人情報を含まない（テンプレート）。入力された値は
 * 受付セッション側で最小限に扱う（src/domain/reception/session.ts）。
 */

/* ===================== ステップ ===================== */

/**
 * 受付フローのステップ種別。受付端末の各画面に対応する。
 * 'purpose' は目的選択そのものなので 1 フロー定義内では通常先頭に固定されるが、
 * モデル上は順序の一要素として扱い、表示制御を一元化する。
 */
export const FLOW_STEP_KINDS = [
  'purpose', // 目的選択
  'target', // 担当者・部署選択
  'visitorInfo', // 来訪者情報入力
  'confirm', // 確認
  'call', // 呼び出し
] as const;

export type FlowStepKind = (typeof FLOW_STEP_KINDS)[number];

export function isFlowStepKind(value: unknown): value is FlowStepKind {
  return typeof value === 'string' && (FLOW_STEP_KINDS as readonly string[]).includes(value);
}

/** 確認・呼び出しは必須ステップ（どのフローでも省略不可）。 */
export const REQUIRED_STEP_KINDS: ReadonlySet<FlowStepKind> = new Set<FlowStepKind>([
  'confirm',
  'call',
]);

/* ===================== 入力フィールド ===================== */

/** 入力フィールドタイプ。MVP では 4 種に限定する（issue #100 UX 方針）。 */
export const FIELD_TYPES = ['text', 'textarea', 'select', 'checkbox'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export function isFieldType(value: unknown): value is FieldType {
  return typeof value === 'string' && (FIELD_TYPES as readonly string[]).includes(value);
}

/**
 * 来訪者情報入力フォームの 1 フィールド。
 * select は options を伴う。checkbox は単一の同意/該当チェックを表す（options なし）。
 */
export type FlowField = {
  /** フィールド識別子（フロー内で一意）。英数/ハイフンの安定キー。 */
  key: string;
  /** 表示ラベル（例: お名前 / 会社名 / 担当者名）。 */
  label: string;
  type: FieldType;
  required: boolean;
  /** select の選択肢（type==='select' のときのみ）。 */
  options?: string[];
};

/* ===================== フロー定義 ===================== */

/** ブランド付き ID。フロー定義の混在を型で防ぐ。 */
export type ReceptionFlowId = string & { readonly __brand: 'ReceptionFlowId' };
export const asReceptionFlowId = (v: string): ReceptionFlowId => v as ReceptionFlowId;

/**
 * 来訪目的別のフロー定義（テナント/サイト境界の中で管理される純データ）。
 * tenantId/siteId は永続化層が付与するため、純モデルとしては定義本体（ステップ・
 * フィールド・表示属性）に集中する。境界フィールドは flow-config 層の型で合成する。
 */
export type ReceptionFlow = {
  /** 内部的な目的キー（例: interview / delivery）。安定識別子。 */
  purposeKey: string;
  /** 受付端末に表示する目的名（例: 面接 / 宅配・納品）。 */
  displayName: string;
  /** 目的の補足説明（受付端末の目的選択カードに表示）。任意。 */
  description?: string;
  /** 目的選択画面での表示順（小さいほど先）。 */
  order: number;
  /** 有効/無効。無効な目的は受付端末に表示しない。 */
  enabled: boolean;
  /** 表示するステップ種別の並び（先頭から順に進む）。 */
  steps: FlowStepKind[];
  /** visitorInfo ステップで表示する入力フィールド。 */
  fields: FlowField[];
  /** 呼び出し完了後に受付端末へ表示する案内文。任意。 */
  completionMessage?: string;
};

/* ===================== バリデーション ===================== */

export type FlowValidationError = { code: 'invalid_input'; message: string };
export type FlowValidated<T> =
  | { ok: true; value: T }
  | { ok: false; error: FlowValidationError };

function fail(message: string): FlowValidated<never> {
  return { ok: false, error: { code: 'invalid_input', message } };
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_LABEL = 120;
const MAX_DESCRIPTION = 500;
const MAX_FIELDS = 20;
const MAX_OPTIONS = 30;

/** 目的キーの検証（小文字英数+ハイフン・先頭は英数・長さ上限）。 */
export function validatePurposeKey(raw: unknown): FlowValidated<string> {
  if (typeof raw !== 'string') return fail('purposeKey is required');
  const key = raw.trim();
  if (key === '') return fail('purposeKey must not be empty');
  if (!KEY_PATTERN.test(key))
    return fail('purposeKey must be lower-case alphanumeric with hyphens');
  return { ok: true, value: key };
}

/** 表示名の検証（空不可・長さ上限）。 */
export function validateDisplayName(raw: unknown): FlowValidated<string> {
  if (typeof raw !== 'string') return fail('displayName is required');
  const name = raw.trim();
  if (name === '') return fail('displayName must not be empty');
  if (name.length > MAX_LABEL) return fail('displayName is too long');
  return { ok: true, value: name };
}

/** 任意テキスト（説明・完了メッセージ）の検証。未指定は undefined を許容。 */
export function validateOptionalText(
  raw: unknown,
  max: number,
  field: string,
): FlowValidated<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return fail(`${field} must be a string`);
  const text = raw.trim();
  if (text === '') return { ok: true, value: undefined };
  if (text.length > max) return fail(`${field} is too long`);
  return { ok: true, value: text };
}

/**
 * ステップ並びの検証。
 *   - すべて既知の FlowStepKind であること。
 *   - 重複が無いこと。
 *   - 必須ステップ（confirm / call）を含むこと。
 *   - 順序整合: confirm は call より前であること（確認 → 呼び出し）。
 */
export function validateSteps(raw: unknown): FlowValidated<FlowStepKind[]> {
  if (!Array.isArray(raw)) return fail('steps must be an array');
  if (raw.length === 0) return fail('steps must not be empty');
  const steps: FlowStepKind[] = [];
  const seen = new Set<FlowStepKind>();
  for (const s of raw) {
    if (!isFlowStepKind(s)) return fail(`unknown step kind: ${String(s)}`);
    if (seen.has(s)) return fail(`duplicate step kind: ${s}`);
    seen.add(s);
    steps.push(s);
  }
  for (const required of REQUIRED_STEP_KINDS) {
    if (!seen.has(required)) return fail(`steps must include "${required}"`);
  }
  if (steps.indexOf('confirm') > steps.indexOf('call'))
    return fail('"confirm" step must come before "call"');
  return { ok: true, value: steps };
}

/** 単一の入力フィールドを正規化・検証する。 */
export function validateField(raw: unknown): FlowValidated<FlowField> {
  if (typeof raw !== 'object' || raw === null) return fail('field must be an object');
  const o = raw as Record<string, unknown>;

  const keyResult = validatePurposeKey(o.key);
  if (!keyResult.ok) return fail('field key must be lower-case alphanumeric with hyphens');
  const key = keyResult.value;

  const label = typeof o.label === 'string' ? o.label.trim() : '';
  if (label === '') return fail('field label is required');
  if (label.length > MAX_LABEL) return fail('field label is too long');

  if (!isFieldType(o.type)) return fail('field type is invalid');
  const required = o.required === true;

  if (o.type === 'select') {
    if (!Array.isArray(o.options)) return fail('select field requires options');
    const options: string[] = [];
    for (const opt of o.options) {
      const v = typeof opt === 'string' ? opt.trim() : '';
      if (v === '') return fail('select options must be non-empty strings');
      if (v.length > MAX_LABEL) return fail('select option is too long');
      options.push(v);
    }
    if (options.length === 0) return fail('select field requires at least one option');
    if (options.length > MAX_OPTIONS) return fail('too many select options');
    return { ok: true, value: { key, label, type: 'select', required, options } };
  }

  return { ok: true, value: { key, label, type: o.type, required } };
}

/** 入力フィールド配列を検証する（未指定は空配列を許容・key 一意・件数上限）。 */
export function validateFields(raw: unknown): FlowValidated<FlowField[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail('fields must be an array');
  if (raw.length > MAX_FIELDS) return fail('too many fields');
  const fields: FlowField[] = [];
  const keys = new Set<string>();
  for (const f of raw) {
    const v = validateField(f);
    if (!v.ok) return v;
    if (keys.has(v.value.key)) return fail(`duplicate field key: ${v.value.key}`);
    keys.add(v.value.key);
    fields.push(v.value);
  }
  return { ok: true, value: fields };
}

/** order の検証（非負整数・未指定は 0）。 */
export function validateOrder(raw: unknown): FlowValidated<number> {
  if (raw === undefined || raw === null) return { ok: true, value: 0 };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0)
    return fail('order must be a non-negative integer');
  return { ok: true, value: raw };
}

/** フロー定義作成の入力（API ボディ相当の生値）。 */
export type ReceptionFlowDraft = {
  purposeKey?: unknown;
  displayName?: unknown;
  description?: unknown;
  order?: unknown;
  steps?: unknown;
  fields?: unknown;
  completionMessage?: unknown;
};

/**
 * 生のドラフトを検証済み ReceptionFlow へ正規化する（enabled は既定 true）。
 * 純関数。最初に見つかった検証エラーで停止する（fail-fast）。
 */
export function validateReceptionFlow(draft: ReceptionFlowDraft): FlowValidated<ReceptionFlow> {
  const purposeKey = validatePurposeKey(draft.purposeKey);
  if (!purposeKey.ok) return purposeKey;
  const displayName = validateDisplayName(draft.displayName);
  if (!displayName.ok) return displayName;
  const description = validateOptionalText(draft.description, MAX_DESCRIPTION, 'description');
  if (!description.ok) return description;
  const order = validateOrder(draft.order);
  if (!order.ok) return order;
  const steps = validateSteps(draft.steps);
  if (!steps.ok) return steps;
  const fields = validateFields(draft.fields);
  if (!fields.ok) return fields;
  const completionMessage = validateOptionalText(
    draft.completionMessage,
    MAX_DESCRIPTION,
    'completionMessage',
  );
  if (!completionMessage.ok) return completionMessage;

  return {
    ok: true,
    value: {
      purposeKey: purposeKey.value,
      displayName: displayName.value,
      description: description.value,
      order: order.value,
      enabled: true,
      steps: steps.value,
      fields: fields.value,
      completionMessage: completionMessage.value,
    },
  };
}

/* ===================== 既定フロー・問い合わせ ===================== */

/** 全ステップを含む標準ステップ並び。多くの目的の出発点として使う。 */
export const DEFAULT_STEPS: readonly FlowStepKind[] = [
  'purpose',
  'target',
  'visitorInfo',
  'confirm',
  'call',
];

/**
 * 既定（通常受付）フロー。フロー未設定でも受付が壊れないためのフォールバック。
 * 既存の通常受付に合わせ、氏名（任意）・会社名（任意）の最小入力のみを持つ。
 */
export function defaultReceptionFlow(): ReceptionFlow {
  return {
    purposeKey: 'general',
    displayName: '通常受付',
    description: 'ご担当者または部署を選んでお呼び出しします。',
    order: 0,
    enabled: true,
    steps: [...DEFAULT_STEPS],
    fields: [
      { key: 'name', label: 'お名前', type: 'text', required: false },
      { key: 'company', label: '会社名', type: 'text', required: false },
    ],
    completionMessage: undefined,
  };
}

/**
 * 有効なフローを表示順 → displayName の安定順で並べ替えて返す（純関数・非破壊）。
 * 受付端末の目的選択に渡す一覧の整形に使う。
 */
export function sortFlowsForDisplay<T extends Pick<ReceptionFlow, 'order' | 'displayName'>>(
  flows: readonly T[],
): T[] {
  return [...flows].sort((a, b) =>
    a.order !== b.order ? a.order - b.order : a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0,
  );
}

/** 表示順に並んだ「有効な」フローのみを返す（受付端末向け）。 */
export function enabledFlowsForDisplay<
  T extends Pick<ReceptionFlow, 'order' | 'displayName' | 'enabled'>,
>(flows: readonly T[]): T[] {
  return sortFlowsForDisplay(flows.filter((f) => f.enabled));
}
