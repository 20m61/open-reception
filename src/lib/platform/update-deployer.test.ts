/**
 * アップデート deployer の seam（interface + mock）テスト (#290 item1)。
 *
 * 実デプロイ本体は #195/#65 外部待ち。interface+mock 先行で、mock の挙動と「実 deployer 未配線
 * （getUpdateDeployer=null）」を検証する（本番実行を mock で fake しない）。
 */
import { describe, expect, it } from 'vitest';
import { MockUpdateDeployer, getUpdateDeployer, type DeployTarget } from './update-deployer';

const target = (over: Partial<DeployTarget> = {}): DeployTarget => ({
  id: 'up-1',
  component: 'kiosk-app',
  action: 'apply',
  toVersion: '1.1.0',
  ...over,
});

describe('MockUpdateDeployer', () => {
  it('既定は成功を返す', async () => {
    await expect(new MockUpdateDeployer().deploy(target())).resolves.toMatchObject({ ok: true });
  });

  it('failOn に一致する対象は失敗を返す', async () => {
    const deployer = new MockUpdateDeployer({ failOn: (t) => t.component === 'firmware' });
    await expect(deployer.deploy(target({ component: 'firmware' }))).resolves.toMatchObject({ ok: false });
    await expect(deployer.deploy(target({ component: 'kiosk-app' }))).resolves.toMatchObject({ ok: true });
  });
});

describe('getUpdateDeployer', () => {
  it('実 deployer は未配線（外部リソース待ち #195/#65）で null を返す', () => {
    expect(getUpdateDeployer()).toBeNull();
  });
});
