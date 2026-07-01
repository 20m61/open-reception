/**
 * 永続化バックエンドのファクトリ (docs/persistence-design.md §3.1)。
 *
 * DATA_BACKEND 環境変数で実装を選択する:
 *   - 'memory'（既定 / dev / test / CI）: プロセス内 in-memory
 *   - 'dynamodb'（本番 / AWS）: DynamoDB シングルテーブル
 *
 * fail-closed (#273 inc1): **デプロイ実行**（Lambda 実行マーカー
 * `AWS_LAMBDA_FUNCTION_NAME` あり = OpenNext の実デプロイ）で DATA_BACKEND が
 * 未設定なら、黙って揮発性の memory にフォールバックせず throw する。
 * `NODE_ENV` ではなく Lambda マーカーで判定するのは server-secret.ts と同じ理由:
 * ローカルの production ビルド（quality-gate の build / e2e / lighthouse は
 * `next start` で NODE_ENV=production）を壊さないため。
 *
 * バックエンドはプロセス内で 1 つだけ生成し、全ストアで共有する。
 */
import type { DataBackend } from './backend';
import { MemoryBackend } from './memory';

export type BackendKind = 'memory' | 'dynamodb';

/**
 * 環境変数からバックエンド種別を決定する純粋関数（unit テスト対象）。
 *
 * - デプロイ実行（AWS_LAMBDA_FUNCTION_NAME あり）で DATA_BACKEND 未設定 → throw。
 *   明示的な `DATA_BACKEND=memory` は「意図的に揮発でよい」宣言として許容する
 *   （fail-closed の対象はあくまで**設定漏れ**）。
 * - それ以外（dev / test / CI / ローカル `next start`）は従来どおり memory 既定。
 */
export function resolveBackendKind(env: Record<string, string | undefined>): BackendKind {
  const kind = env.DATA_BACKEND;
  if (kind === undefined) {
    if (env.AWS_LAMBDA_FUNCTION_NAME) {
      throw new Error(
        'DATA_BACKEND is not set in a deployed environment; refusing the volatile in-memory fallback ' +
          '(data would be lost on every cold start). Set DATA_BACKEND=dynamodb (plus TABLE_NAME) on the ' +
          'server Lambda — infra/lib/stacks/web-stack.ts does this for CDK deploys — or set ' +
          "DATA_BACKEND=memory explicitly if ephemeral data is intentional. See docs/persistence-design.md. (#273)",
      );
    }
    return 'memory';
  }
  if (kind === 'memory' || kind === 'dynamodb') return kind;
  throw new Error(`Unknown DATA_BACKEND="${kind}". Use 'memory' or 'dynamodb'.`);
}

// Next.js の production ビルドでは route handler / server component が別モジュール
// インスタンスにバンドルされ得るため、モジュールレベル変数だと in-memory backend が
// それぞれ別インスタンスになり状態を共有できない（受付ログが admin 画面に出ない等）。
// プロセス全体で 1 つを共有するため globalThis に載せる（dynamodb 利用時は無害）。
const GLOBAL_KEY = Symbol.for('open-reception.data-backend');
type BackendGlobal = { [GLOBAL_KEY]?: DataBackend };
const backendGlobal = globalThis as BackendGlobal;

function create(): DataBackend {
  switch (resolveBackendKind(process.env)) {
    case 'memory':
      return new MemoryBackend();
    case 'dynamodb':
      // 遅延 import で AWS SDK をコールドスタート時のみ読み込む。
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return new (require('./dynamodb').DynamoBackend)() as DataBackend;
  }
}

export function getBackend(): DataBackend {
  if (!backendGlobal[GLOBAL_KEY]) backendGlobal[GLOBAL_KEY] = create();
  return backendGlobal[GLOBAL_KEY];
}

/** テスト用: バックエンドのキャッシュを破棄する（次回 getBackend で再生成）。 */
export function __resetBackend(): void {
  backendGlobal[GLOBAL_KEY] = undefined;
}

export type { DataBackend } from './backend';
