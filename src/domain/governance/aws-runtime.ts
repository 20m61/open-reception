/**
 * AWS 実行系（runtime）の解決と、誤接続 guard（ADR 0010 / #1103）。
 *
 * ## なぜ設定層に閉じるのか
 *
 * ローカル AWS エミュレータは**交換可能**でなければならない。LocalStack の
 * ライセンス状態が「Cognito を検証できるか」を決めてしまう状態は、製品への
 * ロックインがそのまま検証範囲の欠落になっている（2026-09-14 実測）。
 *
 * だからアプリのコードに `if (ministack)` のような分岐を置かない。実行系の違いは
 * **endpoint / region / credentials の解決**だけに落とす。エミュレータを足す・
 * 替えるときに触るのはこのファイルだけである。
 *
 * ## なぜ guard が同じ場所に居るのか
 *
 * エミュレータを増やすと**誤接続の面が増える**。「どこを向くか」を決める場所と
 * 「向いてよいか」を判定する場所が離れると、片方だけ通る経路ができる。
 * 解決と判定を 1 つの関数に閉じ、違反があれば **config を返さない**。
 *
 *     LOCAL AWS TEST + REAL PRODUCTION CREDENTIAL => ABORT
 */

/** 実行系。`aws` 以外はすべてローカルエミュレータ。 */
export type AwsRuntime = 'aws' | 'ministack' | 'moto' | 'localstack';

const RUNTIMES: ReadonlyArray<AwsRuntime> = ['aws', 'ministack', 'moto', 'localstack'];

/** エミュレータの既定 endpoint。`AWS_ENDPOINT_URL` で上書きできる。 */
const DEFAULT_ENDPOINTS: Readonly<Record<Exclude<AwsRuntime, 'aws'>, string>> = {
  // LocalStack 互換ポート。MiniStack も既定で 4566 を使う。
  ministack: 'http://127.0.0.1:4566',
  localstack: 'http://127.0.0.1:4566',
  // moto_server の既定。
  moto: 'http://127.0.0.1:5000',
};

const DEFAULT_REGION = 'ap-northeast-1';

/**
 * エミュレータへ渡す dummy 資格情報。
 *
 * 🔴 **空にせず明示的に載せる。** 載せないと SDK が ambient の資格情報チェーン
 * （env / `~/.aws` / IMDS）を解決してしまい、「endpoint はローカルなのに**実資格情報で
 * 署名する**」形になる。guard と二重に守る。
 */
const DUMMY_CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' } as const;

export type AwsRuntimeConfig = {
  readonly runtime: AwsRuntime;
  readonly emulated: boolean;
  /** 実 AWS では undefined（SDK の既定解決に任せる）。 */
  readonly endpoint?: string;
  readonly region: string;
  /** 実 AWS では undefined（role / SSO / profile に任せる）。 */
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
};

export type AwsSafetyViolation = {
  readonly code: 'real_credentials' | 'endpoint_is_real_aws' | 'real_aws_without_opt_in';
  readonly detail: string;
  /** どう直すか。メッセージにそのまま出す。 */
  readonly remedy: string;
};

export class AwsRuntimeSafetyError extends Error {
  readonly violations: ReadonlyArray<AwsSafetyViolation>;
  constructor(runtime: AwsRuntime, violations: ReadonlyArray<AwsSafetyViolation>) {
    const lines = violations.map((v) => `  - [${v.code}] ${v.detail}\n    → ${v.remedy}`);
    super(
      `AWS_RUNTIME=${runtime} は現在の環境では安全に使えません:\n${lines.join('\n')}\n` +
        'ローカル検証に実 AWS 資格情報を持ち込まないでください。',
    );
    this.name = 'AwsRuntimeSafetyError';
    this.violations = violations;
  }
}

type Env = Record<string, string | undefined>;

export function resolveAwsRuntime(env: Env): AwsRuntime {
  const raw = env.AWS_RUNTIME;
  // 既定は実 AWS。デプロイされた Lambda は AWS_RUNTIME を持たないので、既定を
  // emulator にすると本番が黙ってエミュレータを向く。危険側は guard で止める。
  if (raw === undefined || raw === '') return 'aws';
  if ((RUNTIMES as ReadonlyArray<string>).includes(raw)) return raw as AwsRuntime;
  // 黙って既定へ落とすと、綴り間違いがそのまま実 AWS 行きになる。
  throw new Error(
    `Unknown AWS_RUNTIME="${raw}". Use one of: ${RUNTIMES.join(' | ')}. (ADR 0010)`,
  );
}

/** 実 AWS の資格情報らしさ。**存在**が効くものは値を見ない。 */
function realCredentialSignals(env: Env): string[] {
  const found: string[] = [];
  const key = env.AWS_ACCESS_KEY_ID;
  if (key && /^(AKIA|ASIA)/.test(key)) found.push('AWS_ACCESS_KEY_ID');
  // 短命 STS の 3 点目。dummy key と組んでも実資格情報として成立しうる。
  if (env.AWS_SESSION_TOKEN) found.push('AWS_SESSION_TOKEN');
  // 残っていると SDK が ~/.aws を解決する。
  if (env.AWS_PROFILE) found.push('AWS_PROFILE');
  // デプロイ窓の残骸。存在するだけで dummy まで「失効済み」にされる。
  if (env.AWS_CREDENTIAL_EXPIRATION) found.push('AWS_CREDENTIAL_EXPIRATION');
  return found;
}

/** デプロイされた実行かどうか（OpenNext の Lambda 実行マーカー）。 */
function isDeployedRuntime(env: Env): boolean {
  return Boolean(env.AWS_LAMBDA_FUNCTION_NAME);
}

/**
 * 危険な組み合わせを列挙する（純関数）。空配列なら安全。
 *
 * 判定を throw ではなく配列で返すのは、テストと診断コマンドから**全部の違反**を
 * 一度に読めるようにするため。throw するのは `resolveAwsRuntimeConfig` 側。
 */
export function checkAwsRuntimeSafety(env: Env): ReadonlyArray<AwsSafetyViolation> {
  const runtime = resolveAwsRuntime(env);
  const violations: AwsSafetyViolation[] = [];
  const signals = realCredentialSignals(env);

  if (runtime !== 'aws') {
    if (signals.length > 0) {
      violations.push({
        code: 'real_credentials',
        detail: `エミュレータ実行なのに実 AWS 資格情報の痕跡があります: ${signals.join(', ')}`,
        remedy:
          'これらを unset してから実行してください（`npm run aws:local:*` は自動で落とします）。',
      });
    }
    const endpoint = env.AWS_ENDPOINT_URL;
    if (endpoint && /amazonaws\.com/i.test(endpoint)) {
      violations.push({
        code: 'endpoint_is_real_aws',
        detail: `エミュレータ実行なのに AWS_ENDPOINT_URL が実 AWS を向いています: ${endpoint}`,
        remedy: 'AWS_ENDPOINT_URL を unset するか、ローカルの endpoint を指してください。',
      });
    }
    return violations;
  }

  // runtime === 'aws'
  // デプロイ実行は止めない。guard の目的はローカル / CI からの誤接続である。
  if (!isDeployedRuntime(env) && signals.length > 0 && env.AWS_ALLOW_REAL !== '1') {
    violations.push({
      code: 'real_aws_without_opt_in',
      detail: `実 AWS 資格情報が見えています（${signals.join(', ')}）が、明示の opt-in がありません`,
      remedy:
        'ローカル検証なら AWS_RUNTIME=ministack を使ってください。意図的に実 AWS を叩くなら AWS_ALLOW_REAL=1 を明示してください。',
    });
  }
  return violations;
}

/**
 * 実行系の設定を解決する。**違反があれば config を返さず throw する。**
 *
 * 「違反を報告しつつ config も返す」形にすると呼び出し側が無視できてしまうので、
 * 返り値そのものを止める。
 */
export function resolveAwsRuntimeConfig(env: Env): AwsRuntimeConfig {
  const runtime = resolveAwsRuntime(env);
  const violations = checkAwsRuntimeSafety(env);
  if (violations.length > 0) throw new AwsRuntimeSafetyError(runtime, violations);

  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? DEFAULT_REGION;
  if (runtime === 'aws') {
    return { runtime, emulated: false, region };
  }
  return {
    runtime,
    emulated: true,
    endpoint: env.AWS_ENDPOINT_URL ?? DEFAULT_ENDPOINTS[runtime],
    region,
    credentials: DUMMY_CREDENTIALS,
  };
}
