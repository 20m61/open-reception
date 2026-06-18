/**
 * 通知 Lambda ハンドラ (DESIGN #34 §5)。
 *
 * フロー:
 *   1. 入力検証（不正は 400）
 *   2. 認可拠点との突合（authorizer の siteId と body の siteId が不一致なら 403）
 *   3. 拠点設定取得（未登録/失効は 403）
 *   4. 通知先解決（request.target ▷ site.defaultTarget。無ければ 400）
 *   5. 冪等性: requestId で重複実行を抑止（warm container 内 best-effort）
 *   6. Polly で音声化（失敗時はテキスト fallback、synthesized=false）
 *   7. Vonage で外部通知。delivered/timeout/failed を分類
 *   8. 結果と最小メタデータを構造化ログに記録（PII・secret は出力しない）
 */
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { validateNotificationRequest } from './validation';
import { createPollyAdapter, type PollyAdapter } from './polly-adapter';
import { createVonageAdapter, type VonageAdapter } from './vonage-adapter';
import { createSiteConfigLoader, type SiteConfigLoader } from './site-config';
import type {
  NotificationRequest,
  NotificationResult,
  NotificationTarget,
  VoiceSettings,
} from './types';

export interface NotificationDeps {
  loader: SiteConfigLoader;
  polly: PollyAdapter;
  vonage: VonageAdapter;
  /** 冪等性ストア。warm container 内の簡易重複抑止。 */
  seen: Set<string>;
  log: (entry: Record<string, unknown>) => void;
}

export interface ProcessResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

/** PII を含めない構造化ログを stdout に出す（CloudWatch Logs 収集）。 */
function defaultLog(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/**
 * 通知処理の中核（API/Lambda 非依存・単体テスト対象）。
 * @param authorizedSiteId authorizer が認証した拠点 ID。指定時は body の siteId と
 *   一致しなければ 403（クロステナントなりすまし防止）。
 */
export async function processNotification(
  input: unknown,
  deps: NotificationDeps,
  authorizedSiteId?: string,
): Promise<ProcessResponse> {
  const started = Date.now();
  const validation = validateNotificationRequest(input);
  if (!validation.ok || !validation.value) {
    deps.log({ event: 'notify', outcome: 'invalid', errors: validation.errors });
    return { statusCode: 400, body: { error: 'invalid_request', messages: validation.errors } };
  }
  const req = validation.value;

  // 認可境界: 認証拠点と body の拠点が一致しない要求は拒否（IDOR/なりすまし防止）。
  if (authorizedSiteId !== undefined && authorizedSiteId !== req.siteId) {
    deps.log({ event: 'notify', siteId: req.siteId, requestId: req.requestId, outcome: 'site_mismatch' });
    return { statusCode: 403, body: { error: 'site_mismatch' } };
  }

  // 冪等性: 配信済み requestId の再送は重複として実行しない（warm container 内 best-effort）。
  if (deps.seen.has(req.requestId)) {
    deps.log({ event: 'notify', siteId: req.siteId, requestId: req.requestId, outcome: 'duplicate' });
    return { statusCode: 200, body: { status: 'duplicate', requestId: req.requestId } };
  }

  const site = await deps.loader.load(req.siteId);
  if (!site || !site.enabled) {
    deps.log({ event: 'notify', siteId: req.siteId, requestId: req.requestId, outcome: 'site_rejected' });
    return { statusCode: 403, body: { error: 'site_not_authorized' } };
  }

  const target: NotificationTarget | undefined = req.target ?? site.defaultTarget;
  if (!target) {
    deps.log({ event: 'notify', siteId: req.siteId, requestId: req.requestId, outcome: 'no_target' });
    return { statusCode: 400, body: { error: 'no_target' } };
  }

  // 音声化（失敗してもテキスト通知へ fallback して継続）。
  const audio = await synthesizeOrFallback(req, site.voice, deps);

  const result: NotificationResult = await deps.vonage.notify(target, {
    requestId: req.requestId,
    message: req.message,
    audio,
  });

  // 配信成功時のみ冪等キーを記録する。失敗/タイムアウトは再送を許可する。
  if (result.status === 'delivered') {
    rememberRequest(deps.seen, req.requestId);
  }
  deps.log({
    event: 'notify',
    siteId: req.siteId,
    requestId: req.requestId,
    kind: req.kind,
    targetType: target.type,
    status: result.status,
    synthesized: result.synthesized,
    reason: result.reason,
    durationMs: Date.now() - started,
  });

  const statusCode = result.status === 'delivered' ? 200 : result.status === 'timeout' ? 504 : 502;
  return { statusCode, body: { ...result } };
}

async function synthesizeOrFallback(
  req: NotificationRequest,
  voice: VoiceSettings,
  deps: NotificationDeps,
) {
  try {
    return await deps.polly.synthesize(req.message, voice);
  } catch (err) {
    deps.log({
      event: 'notify',
      siteId: req.siteId,
      requestId: req.requestId,
      outcome: 'synthesize_failed',
      reason: err instanceof Error ? err.name : 'unknown',
    });
    return undefined;
  }
}

// warm container 全体で共有する冪等性ストア（best-effort）。
// 注: 耐久的な exactly-once 配信は保証しない（コンテナ毎・並行非原子）。厳密保証が要る
// 場合は DynamoDB の条件付き書き込み等の外部ストアへ差し替える。メモリリーク防止のため上限を設ける。
const seen = new Set<string>();
const SEEN_MAX = 5000;

/** 上限超過時に最古のエントリを退避させて Set のメモリ増加を抑える。 */
function rememberRequest(store: Set<string>, requestId: string): void {
  if (store.size >= SEEN_MAX) {
    const oldest = store.values().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.add(requestId);
}

// adapter / loader は warm container 間で再利用する（毎リクエスト再生成しない）。
const sharedDeps: NotificationDeps = {
  loader: createSiteConfigLoader(),
  polly: createPollyAdapter(),
  vonage: createVonageAdapter(),
  seen,
  log: defaultLog,
};

/** authorizer (SIMPLE) が設定した拠点 ID を取り出す。 */
function getAuthorizedSiteId(event: NotificationEvent): string | undefined {
  const ctx = event.requestContext?.authorizer?.lambda as { siteId?: unknown } | undefined;
  return typeof ctx?.siteId === 'string' ? ctx.siteId : undefined;
}

type NotificationEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<{ siteId?: string }>;

/** API Gateway (HTTP API v2) → Lambda エントリ。 */
export async function handler(
  event: NotificationEvent,
): Promise<APIGatewayProxyResultV2> {
  let parsed: unknown;
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  const res = await processNotification(parsed, sharedDeps, getAuthorizedSiteId(event));
  return jsonResponse(res.statusCode, res.body);
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
