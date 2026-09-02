import { test, expect } from '@playwright/test';
import { revealStaff } from './kiosk-fixtures';
import { establishKioskSession, loginAsAdmin } from './helpers';

/**
 * admin↔kiosk のテナント統合 E2E (issue #171 inc2)。
 *
 * admin で作成・有効化した受付フローが、受付端末（kiosk セッション）の /api/kiosk/flow に
 * 表示されることを確認する。両者が同じ既定プロビジョニング・スコープ（internal/default-site）
 * を参照することの実データ検証。共有 in-memory ストア汚染を避けるため一意キーで作成する。
 */
function uniq(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
}

// このスペックが既定スコープ（internal/default-site）へ作成した有効フローは、/kiosk セッションゲート
// (issue #239) 導入後は他の kiosk テストの /api/kiosk/flow に漏れ出し既定受付フローの検証を壊す。
// 各テスト後に作成フローを必ず削除し、共有 in-memory バックエンドの汚染を残さない。
const createdFlowIds: string[] = [];

test.afterEach(async ({ page }) => {
  while (createdFlowIds.length) {
    const id = createdFlowIds.pop();
    await page.request
      .delete(`/api/admin/reception-flows/${id}?tenantId=internal&siteId=default-site`)
      .catch(() => {});
  }
});

test('admin で作成・有効化したフローが受付端末の /api/kiosk/flow に出る', async ({ page }) => {
  const key = uniq('e2e-kioskflow');
  const name = uniq('統合フロー');

  // 1) admin で受付フローを作成（既定テナント internal/default-site）。
  await loginAsAdmin(page);
  const created = await page.request.post('/api/admin/reception-flows', {
    data: {
      tenantId: 'internal',
      siteId: 'default-site',
      purposeKey: key,
      displayName: name,
      order: 99,
      steps: ['purpose', 'visitorInfo', 'confirm', 'call'],
      fields: [{ key: 'name', label: 'お名前', type: 'text', required: true }],
    },
  });
  expect(created.ok()).toBeTruthy();
  createdFlowIds.push(((await created.json()) as { id: string }).id);

  // 2) 受付端末セッションを確立する。
  await establishKioskSession(page);

  // 3) 受付端末のフロー一覧に作成したフローが含まれる（有効なフローのみ返る）。
  const res = await page.request.get('/api/kiosk/flow');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { flows: { purposeKey: string; displayName: string }[] };
  expect(body.flows.some((f) => f.purposeKey === key && f.displayName === name)).toBe(true);
});

test('admin で無効化したフローは受付端末に出ない', async ({ page }) => {
  const key = uniq('e2e-disabled');
  const name = uniq('無効フロー');

  await loginAsAdmin(page);
  const created = await page.request.post('/api/admin/reception-flows', {
    data: {
      tenantId: 'internal',
      siteId: 'default-site',
      purposeKey: key,
      displayName: name,
      order: 99,
      steps: ['purpose', 'visitorInfo', 'confirm', 'call'],
      fields: [],
    },
  });
  expect(created.ok()).toBeTruthy();
  const flow = (await created.json()) as { id: string };
  createdFlowIds.push(flow.id);
  // 無効化する。
  const patched = await page.request.patch(`/api/admin/reception-flows/${flow.id}`, {
    data: { tenantId: 'internal', enabled: false },
  });
  expect(patched.ok()).toBeTruthy();

  await establishKioskSession(page);
  const res = await page.request.get('/api/kiosk/flow');
  const body = (await res.json()) as { flows: { purposeKey: string }[] };
  expect(body.flows.some((f) => f.purposeKey === key)).toBe(false);
});

/**
 * カスタム受付フロー使用時も逃げ道が消えないこと (#325 の不変条件)。
 *
 * `KioskFlow` は「逃げ道バーは待機以外の全画面に常設される」前提で作られており、
 * `VisitorInfoForm` へ `onBack` を渡さない等、コンテンツ側の後退ボタンを撤去している。
 * ところがカスタムフローの 2 画面は逃げ道バーを描画する枝の**外**で返されていたため、
 * カスタムフローを 1 件でも持つテナントでは back も reset も無い**行き止まり**になり、
 * 来訪者は 60 秒の無操作リセットを待つしかなかった。
 *
 * 「戻れない受付」は受付完遂を直接壊すので、実データ（admin で作った有効フロー）で固定する。
 */
test('カスタム受付フローの画面にも逃げ道バーが常設される（行き止まりを作らない）', async ({
  page,
}) => {
  const key = uniq('e2e-escape');
  const name = uniq('逃げ道フロー');

  await loginAsAdmin(page);
  const created = await page.request.post('/api/admin/reception-flows', {
    data: {
      tenantId: 'internal',
      siteId: 'default-site',
      purposeKey: key,
      displayName: name,
      order: 99,
      steps: ['purpose', 'visitorInfo', 'confirm', 'call'],
      fields: [{ key: 'name', label: 'お名前', type: 'text', required: true }],
    },
  });
  expect(created.ok()).toBeTruthy();
  createdFlowIds.push(((await created.json()) as { id: string }).id);

  await establishKioskSession(page);
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();

  // カスタム目的選択（selectingPurpose）。
  await expect(page.getByTestId('custom-purpose-view')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('kiosk-escape-bar')).toBeVisible();
  await expect(page.getByTestId('escape-reset')).toBeVisible();

  // カスタム目的を選ぶと相手選択へ進み、相手を決めるとカスタム入力画面へ入る
  // （カスタムフローでも相手選択は既定画面。入力ステップだけがカスタムになる）。
  //
  // **`.first()` で掴まない。** flow-mutation project は複数 spec を並行実行するので、
  // 一覧の先頭が他 spec の作ったフローになりうる（実際 `並び替えA-*` を掴んで
  // custom-visitor-view に辿り着けず落ちた）。**自分が作ったフローを名前で選ぶ。**
  await page.getByTestId('purpose-option').filter({ hasText: name }).click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();

  // カスタム来訪者情報入力（inputVisitorInfo）。ここが最も戻りたくなる画面。
  await expect(page.getByTestId('custom-visitor-view')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('kiosk-escape-bar')).toBeVisible();
  await expect(page.getByTestId('escape-back')).toBeVisible();

  // 実際に戻れる（描画されているだけでなく機能する）。
  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();
});

/**
 * カスタム受付フロー画面の i18n (issue #327 follow-up)。
 *
 * `PurposeSelector` / `VisitorInfoForm` は locale を一切受け取っておらず、English を選んでも
 * 日本語の見出し・ボタンが出ていた。フロー名や項目ラベルはテナントが管理画面で入力した値
 * なので翻訳しない（入力された言語のまま出す）が、**画面の固定文言は訳す**。
 */
test('English を選ぶとカスタム受付フローの画面も英語になる', async ({ page }) => {
  const key = uniq('e2e-i18n');
  const name = uniq('i18n flow');

  await loginAsAdmin(page);
  const created = await page.request.post('/api/admin/reception-flows', {
    data: {
      tenantId: 'internal',
      siteId: 'default-site',
      purposeKey: key,
      displayName: name,
      order: 99,
      steps: ['purpose', 'visitorInfo', 'confirm', 'call'],
      fields: [{ key: 'name', label: 'Full name', type: 'text', required: true }],
    },
  });
  expect(created.ok()).toBeTruthy();
  createdFlowIds.push(((await created.json()) as { id: string }).id);

  await establishKioskSession(page);
  await page.goto('/kiosk');
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByTestId('start-reception').click();

  // 目的選択の見出しが英語（フロー名はテナント入力なのでそのまま）。
  await expect(page.getByTestId('purpose-selector')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('purpose-selector')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Please select the reason for your visit' })).toBeVisible();

  await page.getByTestId('purpose-option').first().click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();

  // 入力フォームの見出しと主 CTA が英語。
  await expect(page.getByTestId('visitor-info-form')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('visitor-info-form')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Please enter your details' })).toBeVisible();
  await expect(page.getByTestId('visitor-submit')).toHaveText('Continue to confirm');
});

test('カスタム受付フローの主 CTA も「押せない」を視覚語彙で示す (#778 AC2/AC3)', async ({ page }) => {
  // 旧実装はインラインスタイルで `cursor: pointer` 固定・disabled 表現ゼロだった。
  // 「押せそうに見えて反応しない主 CTA」は opacity 0.5 より悪く、明るいロビーの初見
  // 来訪者は連打して受付を諦める。組込みフローの `to-confirm` を見る E2E では気づけない。
  const key = uniq('e2e-affordance');
  const name = uniq('affordance flow');

  await loginAsAdmin(page);
  const created = await page.request.post('/api/admin/reception-flows', {
    data: {
      tenantId: 'internal',
      siteId: 'default-site',
      purposeKey: key,
      displayName: name,
      order: 99,
      steps: ['purpose', 'visitorInfo', 'confirm', 'call'],
      fields: [{ key: 'name', label: 'お名前', type: 'text', required: true }],
    },
  });
  expect(created.ok()).toBeTruthy();
  createdFlowIds.push(((await created.json()) as { id: string }).id);

  await establishKioskSession(page);
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-selector')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('purpose-option').first().click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  await expect(page.getByTestId('visitor-info-form')).toBeVisible({ timeout: 15_000 });

  const submit = page.getByTestId('visitor-submit');
  await expect(submit).toBeDisabled();
  const off = await submit.evaluate((el) => {
    const s = getComputedStyle(el);
    return { borderStyle: s.borderTopStyle, cursor: s.cursor, backgroundImage: s.backgroundImage };
  });
  expect(off.borderStyle, '破線で「押せない」を示していない').toBe('dashed');
  expect(off.cursor, 'カーソルが押せるように見えたまま').toBe('not-allowed');
  expect(off.backgroundImage, 'アクセントの塗りが残っている').toBe('none');

  // 必須項目が埋まれば主 CTA の見た目へ戻る（組込みフローと同じ語彙）。
  await page.getByTestId('field-input').first().fill('来客 一郎');
  await expect(submit).toBeEnabled();
  const on = await submit.evaluate((el) => getComputedStyle(el).borderTopStyle);
  expect(on).not.toBe('dashed');
});
