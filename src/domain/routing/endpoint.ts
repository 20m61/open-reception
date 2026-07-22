/**
 * 接続先 Endpoint のドメイン型 (issue #374)。
 *
 * 「受付対象（誰を呼ぶか）」と「実際の接続先（どこへ繋ぐか）」を分離するための型。
 * ContactEndpoint は **アドレス（電話番号 / SIP URI）だけ**を保持し、呼び出し順や
 * フォールバックは持たない（`Endpoint に route 所有を持たせない` 設計方針）。順序・遷移は
 * RoutingPolicy 側（`./policy.ts`）が宣言する。
 *
 * PII 方針（`.claude/rules/pii-secret-minimization.md`）:
 *   - `e164` / `uri` は個人に紐づく機微値。監査ログ・トレース・provider へ渡す参照からは
 *     除外し、`endpointRef()` の非機微フィールド（id / ownerType / channel）だけを外へ出す。
 *   - `label` は「個人携帯」「総務代表」のような**表示名**で PII を含めない前提（呼び出し側が担保）。
 */

/** 接続チャネル。channel ごとにアドレスの型が変わる判別可能ユニオンの判別子。 */
export const CONTACT_CHANNELS = ['pstn', 'sip'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/** Endpoint の所有主体。誰に紐づく接続先かを表す（呼び出し順の意味は持たない）。 */
export const ENDPOINT_OWNER_TYPES = ['staff', 'organization', 'tenant', 'system'] as const;
export type EndpointOwnerType = (typeof ENDPOINT_OWNER_TYPES)[number];

type ContactEndpointBase = {
  id: string;
  ownerType: EndpointOwnerType;
  ownerId: string;
  /** 接続を担う Provider の識別子（Vonage 等）。受付ドメインは値の中身を解釈しない。 */
  providerKey: string;
  enabled: boolean;
  /**
   * 表示用ラベル（例: 「山田の個人携帯」「総務代表」）。**PII を含めない**。
   * 文章形式ルート説明（`./describe.ts`）や管理 UI がアドレスの代わりに表示する。
   * issue のモデル定義には無い加算的フィールド（アドレス＝機微値を UI へ出さないため）。
   */
  label?: string;
};

/** 固定電話・携帯（PSTN）。アドレスは E.164 電話番号。 */
export type PstnEndpoint = ContactEndpointBase & {
  channel: 'pstn';
  /** E.164 形式の電話番号。機微値。 */
  e164: string;
};

/** SIP エンドポイント。アドレスは SIP URI。 */
export type SipEndpoint = ContactEndpointBase & {
  channel: 'sip';
  /** SIP URI（sip: / sips:）。機微値。 */
  uri: string;
};

/**
 * 接続先 Endpoint（判別可能ユニオン）。channel を判別子に、pstn は `e164`、sip は `uri` を
 * **型として**強制する。channel と噛み合わないアドレスはコンパイル時に弾ける。
 */
export type ContactEndpoint = PstnEndpoint | SipEndpoint;

/** provider / 監査 / トレースへ渡してよい非機微の参照。アドレス（e164/uri）を**構造的に持たない**。 */
export type EndpointRef = {
  id: string;
  ownerType: EndpointOwnerType;
  channel: ContactChannel;
  providerKey: string;
};

export function isContactChannel(value: unknown): value is ContactChannel {
  return typeof value === 'string' && (CONTACT_CHANNELS as readonly string[]).includes(value);
}

export function isEndpointOwnerType(value: unknown): value is EndpointOwnerType {
  return typeof value === 'string' && (ENDPOINT_OWNER_TYPES as readonly string[]).includes(value);
}

/**
 * Endpoint から非機微の参照を作る。**この関数を通したものだけ**を provider・監査・トレースへ
 * 渡すこと（アドレスの漏洩を型で防ぐ）。
 */
export function endpointRef(endpoint: ContactEndpoint): EndpointRef {
  return {
    id: endpoint.id,
    ownerType: endpoint.ownerType,
    channel: endpoint.channel,
    providerKey: endpoint.providerKey,
  };
}

/**
 * Endpoint の接続アドレス（e164 / uri）を取り出す。**機微値**なので、実際に接続を行う
 * provider adapter の内部だけで使い、ログ・レスポンス・トレースには載せない。
 */
export function endpointAddress(endpoint: ContactEndpoint): string {
  return endpoint.channel === 'pstn' ? endpoint.e164 : endpoint.uri;
}

/** 表示ラベルの最大文字数（入力サイズ上限 / issue #374 第5wave nit）。文章形式説明の暴走を防ぐ。 */
export const MAX_ENDPOINT_LABEL_LENGTH = 120;

// E.164: 先頭 '+' + 国番号(1-9始まり) + 本体、合計 8〜15 桁。
const E164_RE = /^\+[1-9]\d{6,14}$/;
// SIP URI: sip: / sips: スキーム + user@host（最小検証）。
const SIP_URI_RE = /^sips?:[^\s@]+@[^\s@]+$/;

export type EndpointValidationError = { code: 'invalid_endpoint'; message: string };
export type ValidatedEndpoint =
  | { ok: true; value: ContactEndpoint }
  | { ok: false; error: EndpointValidationError };

function fail(message: string): ValidatedEndpoint {
  return { ok: false, error: { code: 'invalid_endpoint', message } };
}

/**
 * 信頼できない入力を ContactEndpoint へ正規化・検証する。channel に対応するアドレス形式
 * （E.164 / SIP URI）を必須にし、噛み合わない組み合わせを実行時にも弾く。
 * エラーメッセージにはアドレス値そのものを含めない（PII 最小化）。
 */
export function validateEndpoint(raw: unknown): ValidatedEndpoint {
  if (typeof raw !== 'object' || raw === null) return fail('endpoint must be an object');
  const o = raw as Record<string, unknown>;

  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (id === '') return fail('endpoint id is required');

  if (!isEndpointOwnerType(o.ownerType)) return fail('endpoint ownerType is invalid');
  const ownerId = typeof o.ownerId === 'string' ? o.ownerId.trim() : '';
  if (ownerId === '') return fail('endpoint ownerId is required');

  const providerKey = typeof o.providerKey === 'string' ? o.providerKey.trim() : '';
  if (providerKey === '') return fail('endpoint providerKey is required');

  if (typeof o.enabled !== 'boolean') return fail('endpoint enabled must be a boolean');

  const label = typeof o.label === 'string' && o.label.trim() !== '' ? o.label.trim() : undefined;
  if (label !== undefined && label.length > MAX_ENDPOINT_LABEL_LENGTH) return fail('endpoint label is too long');
  const base = { id, ownerType: o.ownerType, ownerId, providerKey, enabled: o.enabled, label };

  if (!isContactChannel(o.channel)) return fail('endpoint channel is invalid');

  if (o.channel === 'pstn') {
    const e164 = typeof o.e164 === 'string' ? o.e164.trim() : '';
    if (!E164_RE.test(e164)) return fail('endpoint e164 must be a valid E.164 number');
    return { ok: true, value: { ...base, channel: 'pstn', e164 } };
  }

  const uri = typeof o.uri === 'string' ? o.uri.trim() : '';
  if (!SIP_URI_RE.test(uri)) return fail('endpoint uri must be a valid SIP URI');
  return { ok: true, value: { ...base, channel: 'sip', uri } };
}
