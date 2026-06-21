/**
 * 永続化バックエンドのファクトリ (docs/persistence-design.md §3.1)。
 *
 * DATA_BACKEND 環境変数で実装を選択する:
 *   - 'memory'（既定 / dev / test / CI）: プロセス内 in-memory
 *   - 'dynamodb'（本番 / AWS）: DynamoDB シングルテーブル
 *
 * バックエンドはプロセス内で 1 つだけ生成し、全ストアで共有する。
 */
import type { DataBackend } from './backend';
import { MemoryBackend } from './memory';

// Next.js の production ビルドでは route handler / server component が別モジュール
// インスタンスにバンドルされ得るため、モジュールレベル変数だと in-memory backend が
// それぞれ別インスタンスになり状態を共有できない（受付ログが admin 画面に出ない等）。
// プロセス全体で 1 つを共有するため globalThis に載せる（dynamodb 利用時は無害）。
const GLOBAL_KEY = Symbol.for('open-reception.data-backend');
type BackendGlobal = { [GLOBAL_KEY]?: DataBackend };
const backendGlobal = globalThis as BackendGlobal;

function create(): DataBackend {
  const kind = process.env.DATA_BACKEND ?? 'memory';
  switch (kind) {
    case 'memory':
      return new MemoryBackend();
    case 'dynamodb':
      // 遅延 import で AWS SDK をコールドスタート時のみ読み込む（フェーズ3で実装）。
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return new (require('./dynamodb').DynamoBackend)() as DataBackend;
    default:
      throw new Error(`Unknown DATA_BACKEND="${kind}". Use 'memory' or 'dynamodb'.`);
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
