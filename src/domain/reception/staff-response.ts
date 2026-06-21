/**
 * 担当者応答アクションのドメイン定義 (issue #99 increment 1)。
 *
 * 既存 (0a37182 / issue #4 2c) の「応答する＝通話に参加し connected に確定」とは別の軸で、
 * 担当者が状況に応じた“返答”を選び、その結果を受付端末の来訪者向け画面へ短い言葉で反映する。
 *
 * 本モジュールは純関数のみ（副作用なし）。
 *   - 応答種別 enum（STAFF_RESPONSE_ACTIONS）
 *   - 各種別 → 受付端末表示メッセージ / 重要度 / 誤タップ防止 / 既定文言 の写像
 *   - 応答種別 → 来訪者向けの「待機状態（kiosk status）」への写像（状態遷移の最小モデル）
 *
 * PII を一切扱わない。監査には種別（action）のみを残す（log.ts / audit は本増分では触らない）。
 */

/** 担当者が選べる応答アクションの種別。順序は受付端末・担当者画面の表示順を兼ねる。 */
export const STAFF_RESPONSE_ACTIONS = [
  'coming', // 今行きます
  'wait', // 5分お待ちください
  'reroute', // 別担当に回します
  'decline', // 本日は対応できません
  'reception_phone', // 受付電話へおかけください
] as const;

export type StaffResponseAction = (typeof STAFF_RESPONSE_ACTIONS)[number];

/**
 * 来訪者向けの待機状態。受付端末はこの値で画面表示を切り替える。
 *  - acknowledged: 担当者が応答済み（来訪を受け付けた）。前向きな待機。
 *  - waiting: 待つよう案内された（まだ来ない）。
 *  - rerouted: 別担当・別窓口へ取り次ぎ中。
 *  - declined: 本日は対応不可。代替導線へ。
 *  - redirected_phone: 受付電話など別チャネルへ誘導。
 */
export const KIOSK_WAIT_STATUSES = [
  'acknowledged',
  'waiting',
  'rerouted',
  'declined',
  'redirected_phone',
] as const;

export type KioskWaitStatus = (typeof KIOSK_WAIT_STATUSES)[number];

/** 来訪者への表示の重要度。受付端末側の見た目（success/info/warning/danger）に対応。 */
export type StaffResponseSeverity = 'success' | 'info' | 'warning' | 'danger';

export type StaffResponseDefinition = {
  action: StaffResponseAction;
  /** 担当者画面のボタン文言。 */
  staffLabel: string;
  /** 来訪者向けの既定メッセージ（短く・迷わせない）。管理画面で上書きする余地を残す。 */
  defaultVisitorMessage: string;
  /** 来訪者向け待機状態。受付端末の画面分岐に使う。 */
  kioskStatus: KioskWaitStatus;
  /** 受付端末の表示トーン。 */
  severity: StaffResponseSeverity;
  /** 誤タップ防止の確認を必須とするか（拒否・別チャネル誘導など後戻りしにくい操作）。 */
  requiresConfirmation: boolean;
  /** 応答後に来訪者へ代替導線（受付窓口等）を案内するか。 */
  offersFallback: boolean;
  /** 既定で有効か。将来、管理画面でテナント別に有効/無効・文言を上書きする前提の初期値。 */
  defaultEnabled: boolean;
};

/**
 * 応答種別の定義表。来訪者文言は短く、競合サービスの文言を流用しない独自表現にする。
 */
const DEFINITIONS: Record<StaffResponseAction, StaffResponseDefinition> = {
  coming: {
    action: 'coming',
    staffLabel: '今行きます',
    defaultVisitorMessage: '担当者がまもなくお越しになります。少々お待ちください。',
    kioskStatus: 'acknowledged',
    severity: 'success',
    requiresConfirmation: false,
    offersFallback: false,
    defaultEnabled: true,
  },
  wait: {
    action: 'wait',
    staffLabel: '5分お待ちください',
    defaultVisitorMessage: '担当者の手が空き次第お伺いします。少々お待ちください。',
    kioskStatus: 'waiting',
    severity: 'info',
    requiresConfirmation: false,
    offersFallback: false,
    defaultEnabled: true,
  },
  reroute: {
    action: 'reroute',
    staffLabel: '別担当に回します',
    defaultVisitorMessage: '別の担当者におつなぎしています。少々お待ちください。',
    kioskStatus: 'rerouted',
    severity: 'info',
    requiresConfirmation: false,
    offersFallback: false,
    defaultEnabled: true,
  },
  decline: {
    action: 'decline',
    staffLabel: '本日は対応できません',
    defaultVisitorMessage: '申し訳ありませんが、本日はご対応が難しい状況です。受付窓口へお声がけください。',
    kioskStatus: 'declined',
    severity: 'danger',
    requiresConfirmation: true,
    offersFallback: true,
    defaultEnabled: true,
  },
  reception_phone: {
    action: 'reception_phone',
    staffLabel: '受付電話へ',
    defaultVisitorMessage: 'お手数ですが、受付の電話からおかけ直しください。',
    kioskStatus: 'redirected_phone',
    severity: 'warning',
    requiresConfirmation: true,
    offersFallback: true,
    defaultEnabled: true,
  },
};

export function isStaffResponseAction(value: unknown): value is StaffResponseAction {
  return typeof value === 'string' && (STAFF_RESPONSE_ACTIONS as readonly string[]).includes(value);
}

/** 応答種別の定義を返す。未知の種別なら null。 */
export function getStaffResponseDefinition(
  action: StaffResponseAction,
): StaffResponseDefinition {
  return DEFINITIONS[action];
}

/** 全応答種別の定義を表示順で返す（担当者画面のボタン生成・管理画面の一覧に使う）。 */
export function listStaffResponseDefinitions(): StaffResponseDefinition[] {
  return STAFF_RESPONSE_ACTIONS.map((a) => DEFINITIONS[a]);
}

/**
 * 管理画面で上書きする応答種別ごとの設定 (issue #99 increment 2)。
 * テナント/サイト境界は永続化層（src/lib/reception/staff-response-config）が持つ。
 * 本ドメインは「設定をどう解決して既定にフォールバックするか」の純関数のみを担う。
 *
 *  - enabled: 担当者がこの応答種別を選べるか。未指定なら定義の defaultEnabled。
 *  - messageOverride: 来訪者向け文言の上書き。空白/未指定なら既定文言。
 */
export type StaffResponseActionOverride = {
  enabled?: boolean;
  messageOverride?: string;
};

/** 応答種別 → 上書き設定の写像（部分指定可。指定のない種別は既定にフォールバック）。 */
export type StaffResponseConfigOverrides = Partial<
  Record<StaffResponseAction, StaffResponseActionOverride>
>;

/** 設定を適用した応答種別の実効定義。管理画面一覧・担当者ボタン生成に使う。 */
export type ResolvedStaffResponseDefinition = StaffResponseDefinition & {
  /** 設定適用後に担当者が選べるか。 */
  enabled: boolean;
  /** 設定適用後に来訪者へ表示される文言（上書き or 既定）。 */
  visitorMessage: string;
  /** 既定から上書きされた文言を持つか（管理画面の表示補助）。 */
  isMessageOverridden: boolean;
};

/** 単一応答種別に設定を適用した実効定義を返す。純関数。 */
export function resolveStaffResponseDefinition(
  action: StaffResponseAction,
  override?: StaffResponseActionOverride,
): ResolvedStaffResponseDefinition {
  const def = DEFINITIONS[action];
  const trimmed = override?.messageOverride?.trim();
  const isMessageOverridden = !!trimmed && trimmed.length > 0;
  return {
    ...def,
    enabled: override?.enabled ?? def.defaultEnabled,
    visitorMessage: isMessageOverridden ? trimmed : def.defaultVisitorMessage,
    isMessageOverridden,
  };
}

/** 全応答種別に設定を適用した実効定義を表示順で返す。 */
export function resolveStaffResponseDefinitions(
  overrides?: StaffResponseConfigOverrides,
): ResolvedStaffResponseDefinition[] {
  return STAFF_RESPONSE_ACTIONS.map((a) => resolveStaffResponseDefinition(a, overrides?.[a]));
}

/** 設定上、この応答種別が担当者から選べる（有効）か。未指定なら defaultEnabled。 */
export function isStaffResponseEnabled(
  action: StaffResponseAction,
  overrides?: StaffResponseConfigOverrides,
): boolean {
  return overrides?.[action]?.enabled ?? DEFINITIONS[action].defaultEnabled;
}

/** 設定を踏まえた来訪者向け文言。上書きがあればそれを、なければ既定を返す。 */
export function resolvedVisitorMessageFor(
  action: StaffResponseAction,
  overrides?: StaffResponseConfigOverrides,
): string {
  return visitorMessageFor(action, overrides?.[action]?.messageOverride);
}

/** 応答種別 → 来訪者向けメッセージ。上書き文言があればそれを優先する（空白は無視）。 */
export function visitorMessageFor(
  action: StaffResponseAction,
  override?: string,
): string {
  const trimmed = override?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFINITIONS[action].defaultVisitorMessage;
}

/** 応答種別 → 来訪者向け待機状態。 */
export function kioskStatusFor(action: StaffResponseAction): KioskWaitStatus {
  return DEFINITIONS[action].kioskStatus;
}

/** 誤タップ防止の確認が必要な応答種別か。 */
export function requiresConfirmation(action: StaffResponseAction): boolean {
  return DEFINITIONS[action].requiresConfirmation;
}

/**
 * 担当者の応答結果（来訪者向け）。受付端末が短時間ポーリングで取得する形を想定し、
 * PII を含めない（誰がいつ何の応答をしたかのみ）。
 */
export type StaffResponseResult = {
  action: StaffResponseAction;
  kioskStatus: KioskWaitStatus;
  visitorMessage: string;
  severity: StaffResponseSeverity;
  offersFallback: boolean;
  /** 応答時刻（ISO8601）。受付端末側で「新しい応答か」を判定するために使う。 */
  respondedAt: string;
};

/**
 * 応答種別から来訪者向けの結果オブジェクトを生成する純関数。
 * override は管理画面で設定された文言（将来）。respondedAt は呼び出し側が与える。
 */
export function buildStaffResponseResult(
  action: StaffResponseAction,
  respondedAt: string,
  override?: string,
): StaffResponseResult {
  const def = DEFINITIONS[action];
  return {
    action,
    kioskStatus: def.kioskStatus,
    visitorMessage: visitorMessageFor(action, override),
    severity: def.severity,
    offersFallback: def.offersFallback,
    respondedAt,
  };
}
