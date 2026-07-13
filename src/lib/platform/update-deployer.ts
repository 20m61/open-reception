/**
 * アップデート実行（デプロイ）の seam (#290 item1)。
 *
 * 総合開発者の更新実行/ロールバックが呼ぶ実デプロイの抽象。実デプロイ本体（デプロイ資格情報・
 * パイプライン起動）は外部リソース待ち（#195 / #65）のため、interface + mock 先行で用意する。
 * ドメインの状態遷移（`@/domain/platform/update-execution`）はデプロイ手段に依存しない。
 */
import type { UpdateAction } from '@/domain/platform/update-execution';

/** デプロイ対象（プランから組み立てる。PII は含めない）。 */
export type DeployTarget = {
  id: string;
  component: string;
  action: UpdateAction;
  toVersion: string;
};

/** デプロイ結果。message は運用ログ用（機微値・PII を書かない）。 */
export type DeployResult = { ok: boolean; message?: string };

/** 実デプロイ抽象。実 deployer（#195）と mock が同じ契約を満たす。 */
export interface UpdateDeployer {
  deploy(target: DeployTarget): Promise<DeployResult>;
}

/**
 * mock deployer。テスト/デモ用。既定は成功、`failOn` で失敗を注入できる。実行本体は無い
 * （実際のデプロイはしない）ため、本番実行に自動では使わない（getUpdateDeployer 参照）。
 */
export class MockUpdateDeployer implements UpdateDeployer {
  constructor(private readonly opts: { failOn?: (t: DeployTarget) => boolean } = {}) {}

  async deploy(target: DeployTarget): Promise<DeployResult> {
    if (this.opts.failOn?.(target)) {
      return { ok: false, message: `mock deploy failed for ${target.component}` };
    }
    return { ok: true, message: `mock deploy ${target.action} ${target.component}@${target.toVersion}` };
  }
}

/**
 * 本番実行に使う実 deployer のファクトリ。実デプロイ本体は外部リソース待ち（#195/#65）のため
 * 現時点では常に null（=実行不可）を返す。実 deployer が用意でき次第ここで生成して返す。
 * mock を本番実行へ自動で流用しない（fake 成功で状態を誤更新しないため）。
 */
export function getUpdateDeployer(): UpdateDeployer | null {
  return null;
}
