/**
 * 認証方式・外部連携・シークレット状態のドメインモデル (issue #93, increment 1)。
 *
 * セキュリティ最優先の不変条件:
 *   - 本モジュールは secret / private key / webhook secret の **値を一切保持しない**。
 *     扱うのは「設定済みか」「最終更新日時」「最終更新者」という *状態のみ*。
 *   - 値を受け取って状態へ畳み込む際も、値そのものは戻り値・ログ・監査に残さない
 *     （deriveSecretPresence 参照。bool だけを返す）。
 *   - 純関数のみ。永続化・env 読み出し・HTTP は上位層（lib/security, api）に置く。
 *
 * 既存 src/domain/security/types.ts（受付端末アクセス制御）とは責務が異なるため、
 * 同一ディレクトリに *追加* するが既存型は変更しない。
 */

/** シークレットの登録状態。値は決して含めない。 */
export type SecretPresence = 'configured' | 'missing';

/** ローテーション/要対応の指標。inc1 では env 検出と手動状態のみ（自動失効検知は次増分）。 */
export type SecretHealth = 'ok' | 'needs_rotation' | 'unknown';

/**
 * 管理画面が扱える既知のシークレット種別。値は環境変数 / Secrets Manager 側にのみ存在する。
 *
 * Vonage 資格情報（旧 `VONAGE_*` env）はテナント設定（`TenantProviderConfig` + `TenantSecretStore`）へ
 * 移行し、presence 表示も外部連携行（`getVonagePresenceForTenant`）へ移した（#405 Inc3 / #90/#93）。
 * このため個別 secret キーの一覧からは VONAGE 項目を撤去した。
 */
export const SECRET_KEYS = [
  'OAUTH_CLIENT_SECRET',
  'WEBHOOK_SECRET',
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

export function isSecretKey(value: unknown): value is SecretKey {
  return typeof value === 'string' && (SECRET_KEYS as readonly string[]).includes(value);
}

/** UI に渡せるシークレットの状態。**値は含めない**（型レベルで漏えいを防ぐ）。 */
export type SecretStatus = {
  key: SecretKey;
  presence: SecretPresence;
  health: SecretHealth;
  /** 最終更新日時（ISO 文字列）。未更新なら undefined。 */
  updatedAt?: string;
  /** 最終更新者の表示用識別子（メール等の PII は入れず、ロール/actor ラベルに留める）。 */
  updatedBy?: string;
};

/** 永続化する状態メタデータ（値は保持しない）。store がこの形で put/get する。 */
export type SecretStatusRecord = {
  presence: SecretPresence;
  health: SecretHealth;
  updatedAt?: string;
  updatedBy?: string;
};

/** 外部連携の接続確認結果。 */
export type ConnectionResult = 'untested' | 'success' | 'failure';

/** 外部連携（Vonage 等）の状態。機密値は含めず、設定の有無と接続結果のみ。 */
export type IntegrationStatus = {
  /** 連携識別子（例: 'vonage'）。 */
  id: string;
  /** 表示名。 */
  label: string;
  /** 接続に必要な設定が揃っているか。 */
  configured: boolean;
  /** 明示的に有効化されているか（configured かつ有効化フラグ）。 */
  enabled: boolean;
  /** 直近の接続テスト結果。 */
  lastResult: ConnectionResult;
  /** 直近成功日時（ISO）。 */
  lastSuccessAt?: string;
  /** 直近失敗日時（ISO）。 */
  lastFailureAt?: string;
  /** 失敗時のエラー要約（機密を含めない短文）。 */
  lastErrorSummary?: string;
};

/** 永続化する連携状態メタデータ。 */
export type IntegrationStatusRecord = {
  lastResult: ConnectionResult;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastErrorSummary?: string;
};

/** 管理画面ログイン方式の状態。Client Secret 等は含めない。 */
export type AuthMethodStatus = {
  /** 'password' | 'cognito' | 'entra' など。 */
  id: string;
  label: string;
  /** 現在この方式が有効か。 */
  enabled: boolean;
  /** 設定上の問題（未設定の必須項目など）の要約。機密は含めない。 */
  issues: string[];
};

/* ===================== 純関数（テスト対象） ===================== */

/**
 * 値の有無だけを bool に畳み込む。**値そのものは戻さない**。
 * 空文字・空白のみ・undefined は「未設定」とみなす。
 */
export function deriveSecretPresence(value: string | undefined | null): SecretPresence {
  return typeof value === 'string' && value.trim() !== '' ? 'configured' : 'missing';
}

/**
 * env から検出した presence と、永続化済みのメタデータ（更新日時/更新者/health）を
 * 合成して UI 向け SecretStatus を作る。
 * - presence は **常に env 検出を正**とする（手動状態が古くても値の実在を優先）。
 * - record が無ければ updatedAt/updatedBy は付かない。
 */
export function composeSecretStatus(
  key: SecretKey,
  envPresence: SecretPresence,
  record?: SecretStatusRecord,
): SecretStatus {
  return {
    key,
    presence: envPresence,
    health: record?.health ?? 'unknown',
    updatedAt: record?.updatedAt,
    updatedBy: record?.updatedBy,
  };
}

/**
 * 接続テスト結果を既存メタデータへ畳み込む（純関数）。
 * 成功なら lastSuccessAt、失敗なら lastFailureAt と errorSummary を更新する。
 * errorSummary は機密を含めない短文である前提（呼び出し側でサニタイズ済み）。
 */
export function applyConnectionResult(
  prev: IntegrationStatusRecord | undefined,
  result: 'success' | 'failure',
  at: string,
  errorSummary?: string,
): IntegrationStatusRecord {
  const base: IntegrationStatusRecord = prev ?? { lastResult: 'untested' };
  if (result === 'success') {
    return { ...base, lastResult: 'success', lastSuccessAt: at, lastErrorSummary: undefined };
  }
  return {
    ...base,
    lastResult: 'failure',
    lastFailureAt: at,
    lastErrorSummary: errorSummary?.slice(0, 280),
  };
}
