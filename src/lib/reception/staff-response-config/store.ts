/**
 * 担当者応答設定ストア / StaffResponseConfigService の組み立て (issue #99 increment 2)。
 *
 * route・応答実行経路から使う StaffResponseConfigService を 1 つ生成して共有する。
 * 永続化は getBackend()（DATA_BACKEND=memory|dynamodb）に委譲する
 * DataBackedStaffResponseConfigRepository。
 *
 * シードは不要: 未保存サイトは純ドメインの既定（全種別有効・既定文言）にフォールバックする
 * ため、管理画面でも受付端末でも初期状態から正しく表示・動作する。
 */
import {
  DataBackedStaffResponseConfigRepository,
} from './repository';
import { StaffResponseConfigService } from './service';

let service: StaffResponseConfigService | undefined;

export function getStaffResponseConfigService(): StaffResponseConfigService {
  if (!service) {
    service = new StaffResponseConfigService({
      repo: new DataBackedStaffResponseConfigRepository(),
    });
  }
  return service;
}

/** テスト用: サービスを破棄する（次回 getStaffResponseConfigService で再生成）。 */
export function __resetStaffResponseConfigService(): void {
  service = undefined;
}
