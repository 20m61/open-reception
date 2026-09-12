import type { VoiceTransportConnectionContext, VoiceTransportTokenClaims } from '@/domain/voice-transport/types';
import {
  VOICE_TRANSPORT_AUTH_PROTOCOL_PREFIX,
  VOICE_TRANSPORT_MAX_AUDIO_FRAME_BYTES,
  VOICE_TRANSPORT_MIN_AUDIO_FRAME_BYTES,
  VOICE_TRANSPORT_WS_PATH,
  VOICE_TRANSPORT_WS_PROTOCOL,
} from '@/domain/voice-transport/protocol';
import {
  authorizeVoiceTransportConnection,
  type VoiceTransportAuthorizationReason,
  type VoiceTransportAuthorizerDeps,
} from '@/lib/voice-transport/connection-authorizer';

/**
 * Realtime Node gateway の公開契約 (issue #369)。
 *
 * TLS/WSS 終端や RFC6455 framing 自体は adapter（Caddy + WebSocket library）の責務。
 * このモジュールは upgrade 前後で必ず通す accept/session 境界だけを持つ。
 * 音声はメモリ上で次段へ渡すだけで永続化しない。
 */
const HEARTBEAT_FRAME = new Uint8Array([0]);
const MAX_CONTEXT_ID_LENGTH = 256;

export type VoiceTransportRuntimeScope = {
  /** deployment/runtime binding 由来。接続URLからは受け取らない。 */
  tenantId: string;
  /** RealtimeRuntimeStack = Site 1:1 の site binding。接続URLからは受け取らない。 */
  siteId: string;
};

export type VoiceTransportGatewayAdmissionState = 'ready' | 'not_ready' | 'draining';

export type VoiceTransportGatewayDeps = VoiceTransportAuthorizerDeps & {
  /** #366 の readiness/drain 状態を注入する。gateway 自身は営業時間判断を持たない。 */
  admissionState: () => VoiceTransportGatewayAdmissionState;
};

export type VoiceTransportGatewayAcceptRequest = {
  /** Node IncomingMessage.url 相当。host/token は含めず path + query を渡す。 */
  requestTarget: string;
  /** `Sec-WebSocket-Protocol` の生値。token は URL/query へ入れない。 */
  protocolHeader: string | undefined;
  /** private deployment binding / runtime config から注入する site scope。 */
  runtimeScope: VoiceTransportRuntimeScope;
};

export type VoiceTransportGatewayRejectionReason =
  | 'wrong_path'
  | 'invalid_request_context'
  | 'invalid_protocol'
  | 'not_ready'
  | 'draining'
  | VoiceTransportAuthorizationReason;

export type VoiceTransportGatewayRejection = {
  ok: false;
  status: 400 | 401 | 403 | 429 | 503;
  reason: VoiceTransportGatewayRejectionReason;
};

export type VoiceTransportGatewayAcceptResult =
  | {
      ok: true;
      /** WebSocket handshake で選択して返す protocol。auth protocol は絶対に echo しない。 */
      protocol: typeof VOICE_TRANSPORT_WS_PROTOCOL;
      session: VoiceTransportGatewaySession;
    }
  | VoiceTransportGatewayRejection;

export type VoiceTransportGatewayFrameResult =
  | { ok: true; kind: 'heartbeat'; reply: Uint8Array }
  | { ok: true; kind: 'audio'; bytes: Uint8Array }
  | {
      ok: false;
      reason: 'session_closed' | 'text_frame_not_allowed' | 'invalid_audio_frame' | 'frame_too_large';
      closeCode: 1003 | 1007 | 1008 | 1009;
    };

type ParsedProtocol = { token: string };
type ParsedRequestContext = VoiceTransportConnectionContext;

function rejection(
  reason: VoiceTransportGatewayRejectionReason,
  status: VoiceTransportGatewayRejection['status'],
): VoiceTransportGatewayRejection {
  // token / protocolHeader を結果に含めない。呼び出し側がそのままログしても credential が漏れない形に固定する。
  return { ok: false, status, reason };
}

function singleBoundedParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length !== 1) return null;
  const value = values[0]?.trim() ?? '';
  if (!value || value.length > MAX_CONTEXT_ID_LENGTH) return null;
  return value;
}

/**
 * tenant/site は runtime binding から決め、client が上書きできない。
 * kiosk/reception は接続要求の routing context として URL から受け取り、署名済み token claims と照合する。
 */
export function parseVoiceTransportRequestContext(
  requestTarget: string,
  runtimeScope: VoiceTransportRuntimeScope,
): { ok: true; context: ParsedRequestContext } | VoiceTransportGatewayRejection {
  let url: URL;
  try {
    url = new URL(requestTarget, 'https://realtime.invalid');
  } catch {
    return rejection('invalid_request_context', 400);
  }

  if (url.pathname !== VOICE_TRANSPORT_WS_PATH) return rejection('wrong_path', 400);

  // 契約に無い query を黙って受けると、将来 token 等を URL に載せる実装が紛れ込みやすい。
  for (const key of url.searchParams.keys()) {
    if (key !== 'kioskId' && key !== 'receptionSessionId') {
      return rejection('invalid_request_context', 400);
    }
  }

  const kioskId = singleBoundedParam(url.searchParams, 'kioskId');
  const receptionSessionId = singleBoundedParam(url.searchParams, 'receptionSessionId');
  if (!kioskId || !receptionSessionId || !runtimeScope.tenantId || !runtimeScope.siteId) {
    return rejection('invalid_request_context', 400);
  }

  return {
    ok: true,
    context: {
      tenantId: runtimeScope.tenantId,
      siteId: runtimeScope.siteId,
      kioskId,
      receptionSessionId,
    },
  };
}

/**
 * Browser WebSocket は Authorization header を任意設定できないため、短命 token は subprotocol で提示する。
 * URL query へ token を置かず、Caddy/access log へ credential が残る既定を避ける。
 *
 * client sends:
 *   Sec-WebSocket-Protocol: open-reception.voice.v1, auth.<short-lived-token>
 * server selects/echoes:
 *   open-reception.voice.v1
 */
export function parseVoiceTransportProtocolHeader(
  protocolHeader: string | undefined,
): { ok: true; value: ParsedProtocol } | VoiceTransportGatewayRejection {
  if (!protocolHeader) return rejection('invalid_protocol', 401);

  const protocols = protocolHeader
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const stable = protocols.filter((value) => value === VOICE_TRANSPORT_WS_PROTOCOL);
  const auth = protocols.filter((value) => value.startsWith(VOICE_TRANSPORT_AUTH_PROTOCOL_PREFIX));

  // 未知 protocol も拒否し、credential を別名で運ぶ抜け道を作らない。
  if (protocols.length !== 2 || stable.length !== 1 || auth.length !== 1) {
    return rejection('invalid_protocol', 401);
  }

  const token = auth[0]!.slice(VOICE_TRANSPORT_AUTH_PROTOCOL_PREFIX.length);
  if (!token) return rejection('invalid_protocol', 401);

  return { ok: true, value: { token } };
}

function authorizationStatus(reason: VoiceTransportAuthorizationReason): VoiceTransportGatewayRejection['status'] {
  if (reason === 'concurrency_limit') return 429;
  if (
    reason === 'tenant_mismatch' ||
    reason === 'site_mismatch' ||
    reason === 'kiosk_mismatch' ||
    reason === 'reception_mismatch'
  ) {
    return 403;
  }
  return 401;
}

/**
 * HTTP upgrade を WebSocket library に渡す直前の唯一の accept path。
 * not-ready/draining は token を consume する前に拒否するため、準備完了後に同じ短命 token で再試行できる。
 */
export async function acceptVoiceTransportGatewayConnection(
  request: VoiceTransportGatewayAcceptRequest,
  deps: VoiceTransportGatewayDeps,
): Promise<VoiceTransportGatewayAcceptResult> {
  const parsedContext = parseVoiceTransportRequestContext(request.requestTarget, request.runtimeScope);
  if (!parsedContext.ok) return parsedContext;

  const admission = deps.admissionState();
  if (admission === 'not_ready') return rejection('not_ready', 503);
  if (admission === 'draining') return rejection('draining', 503);

  const parsedProtocol = parseVoiceTransportProtocolHeader(request.protocolHeader);
  if (!parsedProtocol.ok) return parsedProtocol;

  const authorized = await authorizeVoiceTransportConnection(
    parsedProtocol.value.token,
    parsedContext.context,
    deps,
  );
  if (!authorized.ok) return rejection(authorized.reason, authorizationStatus(authorized.reason));

  return {
    ok: true,
    protocol: VOICE_TRANSPORT_WS_PROTOCOL,
    session: new VoiceTransportGatewaySession(authorized.claims, deps),
  };
}

/**
 * 認可済み socket 1 本の最小 session。
 * close は冪等で、connection-authorizer が確保した concurrency slot を実 socket close 時に即解放する。
 */
export class VoiceTransportGatewaySession {
  readonly claims: VoiceTransportTokenClaims;
  private readonly deps: Pick<VoiceTransportGatewayDeps, 'streamLimiter'>;
  private closed = false;

  constructor(claims: VoiceTransportTokenClaims, deps: Pick<VoiceTransportGatewayDeps, 'streamLimiter'>) {
    this.claims = claims;
    this.deps = deps;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.deps.streamLimiter.release(this.claims.kioskId, this.claims.jti);
  }

  /**
   * adapter が受けた frame を Transport 契約へ分類する。
   * heartbeat は即応答、audio は次段（STT/turn worker）へ渡す。ここでは保存しない。
   */
  handleFrame(bytes: Uint8Array, isBinary: boolean): VoiceTransportGatewayFrameResult {
    if (this.closed) return { ok: false, reason: 'session_closed', closeCode: 1008 };
    if (!isBinary) return { ok: false, reason: 'text_frame_not_allowed', closeCode: 1003 };

    if (bytes.byteLength === 1 && bytes[0] === HEARTBEAT_FRAME[0]) {
      return { ok: true, kind: 'heartbeat', reply: HEARTBEAT_FRAME.slice() };
    }

    if (bytes.byteLength > VOICE_TRANSPORT_MAX_AUDIO_FRAME_BYTES) {
      return { ok: false, reason: 'frame_too_large', closeCode: 1009 };
    }
    if (
      bytes.byteLength < VOICE_TRANSPORT_MIN_AUDIO_FRAME_BYTES ||
      bytes.byteLength % 2 !== 0
    ) {
      return { ok: false, reason: 'invalid_audio_frame', closeCode: 1007 };
    }

    return { ok: true, kind: 'audio', bytes };
  }
}
