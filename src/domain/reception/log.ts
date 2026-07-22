/**
 * 受付履歴・監査ログのドメイン型 (issue #19)。
 *
 * 個人情報は最小限にする。ReceptionLog には来訪者の氏名・会社名・メモなどの
 * PII を含めない（誰を呼んだか・結果・所要時間など運用に必要な情報のみ）。
 */
import type {
  CallOutcome,
  ReceptionPurposeId,
  ReceptionSession,
  ReceptionTargetType,
} from './session';

/**
 * 受付体験メトリクスのステップ識別子 (issue #319)。
 *
 * 受付フローの「局面」だけを表す列挙で、PII は一切含まない。ファネル（どこで離脱したか）と
 * ステップ別所要の集計に使う。順序は experience-summary の `EXPERIENCE_STEP_ORDER` で定義する。
 */
export type ExperienceStep =
  | 'selectingPurpose'
  | 'selectingTarget'
  | 'inputVisitorInfo'
  | 'confirming'
  | 'calling'
  | 'connected';

/**
 * 来訪者が用件確定までに主に用いた入力手段 (issue #319)。
 * 操作種別のみで PII ではない。STT/チャット/QR 利用率の算出に使う。
 */
export type ExperienceInputMethod = 'touch' | 'stt' | 'chat' | 'qr';

/**
 * 受付体験 KPI の計測メトリクス (issue #319)。
 *
 * すべて PII を含まない（所要 ms・回数・列挙値のみ。氏名/会社名/メモ/連絡先は持たない）。
 * `.claude/rules/pii-secret-minimization.md` / docs/audit-logging.md の最小化方針に従う。
 * 旧レコード互換のため ReceptionLog 側では optional（未設定でも既存集計は壊れない）。
 */
export type ReceptionExperience = {
  /**
   * ステップ別の滞在所要 (ms)。実際に入ったステップのみキーを持つ（未到達ステップはキーなし）。
   * ファネルの「到達したか」と平均滞在時間の算出に使う。
   */
  stepDurations?: Partial<Record<ExperienceStep, number>>;
  /**
   * 受付開始（START）から呼び出し確定（calling への遷移）までの所要 (ms)。
   * 「30 秒以内呼び出し開始率」KPI の分子判定に使う。呼び出しへ到達しなかった受付では未設定。
   */
  timeToCallMs?: number;
  /** 「戻る」操作の回数（やり直し量）。0 のときは省略する。 */
  backCount?: number;
  /** 「キャンセル」操作の回数。0 のときは省略する。 */
  cancelCount?: number;
  /** 主入力手段（touch/stt/chat/qr）。判定できないときは未設定。 */
  inputMethod?: ExperienceInputMethod;
  /**
   * 無操作リセット・キャンセルなどで離脱したときに到達していた最終ステップ (issue #319 AC)。
   * 完遂（connected 到達）した受付では未設定。ファネルの離脱ステップ特定に使う。
   */
  abandonedAtStep?: ExperienceStep;
};

/** 体験メトリクスで許可するステップ列挙（サニタイズ用の網羅リスト）。 */
const EXPERIENCE_STEP_VALUES: readonly ExperienceStep[] = [
  'selectingPurpose',
  'selectingTarget',
  'inputVisitorInfo',
  'confirming',
  'calling',
  'connected',
];

/** 体験メトリクスで許可する入力手段列挙。 */
const EXPERIENCE_INPUT_METHOD_VALUES: readonly ExperienceInputMethod[] = ['touch', 'stt', 'chat', 'qr'];

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * 信頼できない入力（受付端末クライアントが送る experience ペイロード）を、PII を含まない
 * 体験メトリクスへサニタイズする (issue #319)。
 *
 * ホワイトリスト方式: 既知キーのみを型検査して取り込み、**未知キーは破棄**する（クライアントが
 * 氏名等 PII を紛れ込ませても保存しない）。所要 ms は有限・非負のみ、回数は正のみ（0/負は省略）、
 * `inputMethod`/`abandonedAtStep` は列挙値のみ許可。有効な値が 1 つも無ければ `undefined`
 * （＝保存しない。破損/空の experience をそのまま永続化しない）。
 */
export function sanitizeReceptionExperience(input: unknown): ReceptionExperience | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const o = input as Record<string, unknown>;
  const out: ReceptionExperience = {};

  if (typeof o.stepDurations === 'object' && o.stepDurations !== null) {
    const src = o.stepDurations as Record<string, unknown>;
    const sd: Partial<Record<ExperienceStep, number>> = {};
    for (const step of EXPERIENCE_STEP_VALUES) {
      const val = src[step];
      if (isFiniteNonNegative(val)) sd[step] = val;
    }
    if (Object.keys(sd).length > 0) out.stepDurations = sd;
  }
  if (isFiniteNonNegative(o.timeToCallMs)) out.timeToCallMs = o.timeToCallMs;
  if (isFiniteNonNegative(o.backCount) && o.backCount > 0) out.backCount = o.backCount;
  if (isFiniteNonNegative(o.cancelCount) && o.cancelCount > 0) out.cancelCount = o.cancelCount;
  if (
    typeof o.inputMethod === 'string' &&
    (EXPERIENCE_INPUT_METHOD_VALUES as readonly string[]).includes(o.inputMethod)
  ) {
    out.inputMethod = o.inputMethod as ExperienceInputMethod;
  }
  if (
    typeof o.abandonedAtStep === 'string' &&
    (EXPERIENCE_STEP_VALUES as readonly string[]).includes(o.abandonedAtStep)
  ) {
    out.abandonedAtStep = o.abandonedAtStep as ExperienceStep;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * ワンタップ満足度評価の値 (issue #320)。完了/未応答/失敗の終端画面から任意で送信される。
 * 3 段階の列挙のみ（PII を一切含まない）。
 */
export type SatisfactionRating = 'happy' | 'neutral' | 'unhappy';

/**
 * 満足度評価に添える任意の定型理由コード (issue #320)。
 *
 * **自由記述は設けない**（PII 混入を構造的に排除するため、コード化された列挙のみを許可する）。
 * 複数選択可。
 */
export type FeedbackReasonCode =
  | 'waitTooLong'
  | 'hardToOperate'
  | 'staffUnavailable'
  | 'other';

/** 満足度フィードバックのサニタイズ済み形（受信直後の検証結果）。 */
export type ReceptionFeedback = {
  rating: SatisfactionRating;
  reasonCodes?: FeedbackReasonCode[];
};

const SATISFACTION_RATING_VALUES: readonly SatisfactionRating[] = ['happy', 'neutral', 'unhappy'];
const FEEDBACK_REASON_CODE_VALUES: readonly FeedbackReasonCode[] = [
  'waitTooLong',
  'hardToOperate',
  'staffUnavailable',
  'other',
];

/**
 * 信頼できない入力（受付端末クライアントが送る満足度フィードバック）を、PII を含まない
 * {@link ReceptionFeedback} へサニタイズする (issue #320)。
 *
 * ホワイトリスト方式: `rating` は列挙値必須、`reasonCodes` は既知コードのみ（重複除去）を
 * 任意で取り込む。**自由記述フィールドは存在しない**ため、未知キー（例: コメント文字列）は
 * サニタイズ対象にすら含めず構造的に破棄する。`rating` が列挙値でなければ全体を `undefined`
 * にする（部分的な保存はしない）。
 */
export function sanitizeReceptionFeedback(input: unknown): ReceptionFeedback | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const o = input as Record<string, unknown>;
  if (
    typeof o.rating !== 'string' ||
    !(SATISFACTION_RATING_VALUES as readonly string[]).includes(o.rating)
  ) {
    return undefined;
  }
  const out: ReceptionFeedback = { rating: o.rating as SatisfactionRating };
  if (Array.isArray(o.reasonCodes)) {
    const known = o.reasonCodes.filter(
      (c): c is FeedbackReasonCode =>
        typeof c === 'string' && (FEEDBACK_REASON_CODE_VALUES as readonly string[]).includes(c),
    );
    const unique = Array.from(new Set(known));
    if (unique.length > 0) out.reasonCodes = unique;
  }
  return out;
}

export type ReceptionLog = {
  id: string;
  receptionId: string;
  kioskId: string;
  purpose?: ReceptionPurposeId;
  targetType?: ReceptionTargetType;
  targetId?: string;
  /** 呼び出し先の表示名（部署名・担当者名）。氏名そのものではなく呼び出し対象名。 */
  targetLabel?: string;
  outcome: CallOutcome;
  failureReason?: string;
  /** 失敗/未応答後に代替導線が使われたか。 */
  fallbackUsed: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  createdAt: string;
  /**
   * 受付体験 KPI メトリクス (issue #319)。**optional**（旧レコード・既存テスト互換）。
   * PII は含まない（所要/回数/列挙のみ）。KioskFlow が計測し、集計は experience-summary が担う。
   */
  experience?: ReceptionExperience;
  /**
   * ワンタップ満足度フィードバック (issue #320)。**optional**（未評価・旧レコード互換）。
   * 評価値・理由コードのみ（自由記述なし・PII 構造的に排除）。ログ生成時点では未確定のため、
   * 終端画面から別 API（feedback）で事後に追記される（`reception-log-store.recordSatisfactionFeedback`）。
   */
  satisfactionRating?: SatisfactionRating;
  feedbackReasonCodes?: FeedbackReasonCode[];
};

export type AuditAction =
  | 'reception.connected'
  | 'reception.answered'
  | 'reception.timeout'
  | 'reception.failed'
  | 'reception.cancelled'
  | 'reception.completed'
  | 'reception.fallback_used'
  // 管理操作 (issue #22)
  | 'department.created'
  | 'department.updated'
  | 'department.reordered'
  | 'staff.created'
  | 'staff.updated'
  | 'kiosk.created'
  | 'kiosk.revoked'
  | 'kiosk.restored'
  | 'security.updated'
  | 'voice.updated'
  | 'branding.updated'
  | 'asset.created'
  | 'asset.updated'
  | 'motion.updated'
  // 来訪予約・QR 操作 (issue #97)。PII は metadata に残さない。
  | 'reservation.created'
  | 'reservation.updated'
  | 'reservation.cancelled'
  | 'reservation.revoked'
  | 'reservation.token_issued'
  | 'reservation.token_reissued'
  // 拠点（Site）管理 (issue #87)。テナント/サイト境界の操作のみ記録。
  | 'site.created'
  | 'site.updated'
  // 営業時間・サービス単位の稼働ポリシー更新 (issue #367)。#367 の暫定監査
  // （`site.updated` + metadata.resource='operating_policy'）を専用 action へ差し替える。
  // metadata は resource/tenantId/siteId/timezone/version/件数のみ（時間帯の具体値は残さない）。
  | 'operating_policy.updated'
  // プラットフォーム運用: テナントの有効/停止 (issue #90)。理由を metadata.reason に残す。
  | 'tenant.suspended'
  | 'tenant.activated'
  // 危険操作の安全装置 (issue #83 inc4 / #91)。JIT 権限昇格と再認証。reason/対象スコープを
  // metadata に残す（機微値・PII は残さない）。実際の昇格付与・再認証フローは inc4 で接続する。
  | 'privilege.elevated'
  | 'auth.reauthenticated'
  // break-glass 緊急権限 (issue #83 §3)。発行/否認/終了を高重要度（metadata.severity='high'）で記録し、
  // 利用後レビュー対象として抽出できるようにする。break-glass 中の write は各操作の既存 action に
  // metadata.breakGlass='true' が付く。
  | 'privilege.break_glass'
  // 呼び出し先・通知ルート設定 (issue #88)。
  | 'call_route.created'
  | 'call_route.updated'
  | 'call_route.deleted'
  // 認証方式・外部連携・シークレット状態管理 (issue #93)。secret 値そのものは記録しない（状態のみ）。
  | 'auth_config.updated'
  | 'integration.updated'
  | 'integration.tested'
  | 'secret.updated'
  | 'secret.cleared'
  // 担当者応答アクション (issue #99)。応答種別は metadata.action に持つ（PII は残さない）。
  | 'reception.staff_responded'
  // ワンタップ満足度フィードバック (issue #320)。metadata は評価値・理由コードのみ（PII なし）。
  | 'reception.feedback_submitted'
  // 受付体験スタジオのデモ実行 (issue #363)。管理者が本番 Kiosk を Mock 注入で試走した事実を残す。
  // metadata は scenarioId・initialMode（列挙のみ）だけ。デモは本番受付・集計に含めない（sandbox）。
  | 'reception.demo_executed'
  // カスタムデモシナリオの保存/削除 (issue #363 Inc2)。管理者がシナリオ内容を編集・保存した事実を残す。
  // metadata は scenarioId・initialMode（列挙のみ）。シナリオ文言（PII でない擬似ラベル）は残さない。
  | 'reception.demo_scenario_saved'
  | 'reception.demo_scenario_deleted'
  // デモ公開単位（DemoPublication）のライフサイクル管理 (issue #363 Inc3・専用 action)。
  // #363/#367 の暫定監査（`reception.demo_scenario_saved`/`_deleted` + metadata.event での区別）を
  // 専用 action へ差し替える。metadata は scenarioId・status・version・siteId/kioskId 等の
  // 識別子・列挙のみ（PII・シナリオ文言・トークン値は残さない）。
  | 'reception.demo_publication_created'
  | 'reception.demo_publication_deleted'
  // draft/test 間の状態遷移（published への遷移は専用の `demo_published` を使う）。
  | 'reception.demo_status_changed'
  | 'reception.demo_published'
  | 'reception.demo_rolled_back'
  // 公開（認証なし閲覧）共有トークンの発行/失効。トークン値そのものは記録しない。
  | 'reception.demo_share_issued'
  | 'reception.demo_share_revoked'
  // 受付端末（Device）管理 (issue #87 inc2)。token 値そのものは記録しない。
  | 'device.token_reissued'
  | 'device.disabled'
  | 'device.enabled'
  // 来訪目的別カスタム受付フロー (issue #100)。
  | 'reception_flow.created'
  | 'reception_flow.updated'
  | 'reception_flow.deleted'
  // 待機中サイネージ設定 (issue #101)。
  | 'signage.updated'
  // 退館チェックアウト・滞在状態管理 (issue #102)。PII は残さない。
  | 'visitor.checked_out'
  | 'stay.updated'
  // 来訪者の自己特定による退館 (issue #328)。QR/短コードで本人が退館した記録。
  // 誤退館調査のため staff/admin 退館（visitor.checked_out）と区別する。
  // metadata は method（'qr'|'code'）と状態のみ。token/code/PII は残さない。
  | 'visitor.checkout_self_identified'
  // AI 案内 → 担当者/有人切替 (issue #104)。会話内容・PII は残さない。
  // 引き継ぎ要求が出たことと、その理由種別（metadata.reason）のみを記録する。
  | 'ai_guidance.escalated'
  // 担当者/有人へ確実に引き継がれた。
  | 'ai_guidance.handoff'
  // 引き継ぎ失敗→既存受付フロー/代替導線へフォールバックした。
  | 'ai_guidance.fallback'
  // AI 案内の運用設定（有効/無効・許可トピック）を更新した (issue #104)。
  | 'ai_guidance.config_updated'
  | 'platform.incident.created'
  | 'platform.maintenance.scheduled'
  | 'platform.notice.published'
  // テナント別機能フラグの変更 (issue #83 inc5a)。変更キーと before/after を記録する（機微値なし）。
  | 'feature_flag.updated'
  // platform の read 系監査 (issue #83 §5 / inc5b)。対象テナント切替・テナント設定閲覧・監査ログ閲覧。
  // PII・機微値は残さない。監査ログ閲覧は同一 actor の窓内連続閲覧を 1 回に絞る（自己増殖ループ防止、
  // src/domain/platform/read-audit.ts）。
  | 'platform.tenant_scope.switched'
  | 'platform.tenant.viewed'
  | 'platform.audit_log.viewed'
  // 端末レジストリ整合の dry-run プレビュー (issue #290 item2)。昇格必須・修復は行わず drift 件数のみ記録。
  | 'platform.data_reconcile.previewed'
  // テナント単位アップデートの実行 / ロールバック (issue #290 item1)。昇格必須・高重要度監査。
  // metadata は component/from/to/dryRun/result のみ（PII・秘匿値なし）。実デプロイは #195/#65 外部待ち。
  | 'platform.update.executed'
  | 'platform.update.rolled_back'
  // 接続先 Endpoint・ルーティングポリシー設定 (issue #374)。address(e164/uri) は監査に残さない。
  // 残すのは id・ownerType・channel・件数など非機微情報のみ。
  | 'contact_endpoint.created'
  | 'contact_endpoint.updated'
  | 'contact_endpoint.deleted'
  | 'routing_policy.created'
  | 'routing_policy.updated'
  | 'routing_policy.deleted';

export type AuditLog = {
  id: string;
  action: AuditAction;
  /** 操作主体。受付端末イベントは kiosk:<kioskId>、管理操作は admin:<userId> 等。 */
  actor: string;
  targetType?: string;
  targetId?: string;
  at: string;
  /** PII を含めない補助情報のみ。 */
  metadata?: Record<string, string>;
  /**
   * 高詳細監査の追加コンテキスト (issue #83 AC13)。運用者操作の追跡と設定変更の差分監査に使う。
   * いずれも任意（旧レコードや低リスク操作では未設定）。before/after は sanitize 済みで機微値を残さない。
   */
  /** 操作元 IP（`x-forwarded-for` 先頭・best-effort）。運用者操作の追跡用。 */
  ip?: string;
  /** 操作元 user-agent（切り詰め）。 */
  userAgent?: string;
  /** 変更前の値（sanitize 済み・機微値/PII は落とす）。設定変更の差分監査用。 */
  before?: Record<string, string>;
  /** 変更後の値（sanitize 済み）。 */
  after?: Record<string, string>;
};

/**
 * 終端状態の受付セッションから ReceptionLog を導出する。
 * PII（visitor.*）は意図的に含めない。
 */
export function deriveReceptionLog(
  session: ReceptionSession,
  logId: string,
  fallbackUsed: boolean,
  /**
   * KioskFlow が計測した体験メトリクス (issue #319)。省略可（旧呼び出し互換）。
   * 渡された場合のみ log に載せる（PII は含まない前提。呼び出し側で担保）。
   */
  experience?: ReceptionExperience,
): ReceptionLog {
  const endedAt = session.completedAt ?? session.updatedAt;
  const durationMs = Math.max(0, new Date(endedAt).getTime() - new Date(session.startedAt).getTime());
  return {
    id: logId,
    receptionId: session.id,
    kioskId: session.kioskId,
    purpose: session.purpose,
    targetType: session.targetType,
    targetId: session.targetId,
    targetLabel: session.targetLabel,
    outcome: session.callOutcome ?? 'failed',
    failureReason: session.failureReason,
    fallbackUsed,
    startedAt: session.startedAt,
    endedAt,
    durationMs,
    createdAt: new Date().toISOString(),
    // 未指定なら experience キー自体を付けない（旧レコード互換・最小化）。
    ...(experience ? { experience } : {}),
  };
}
