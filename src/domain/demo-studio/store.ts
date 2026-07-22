/**
 * カスタムデモシナリオの永続化 (issue #363 Increment 2)。
 *
 * Inc1 の組込 9 シナリオ（`./scenarios.ts`）は**読み取り専用テンプレート**。Inc2 では管理者が
 * それを複製して編集・保存できる。保存済みシナリオはここで getBackend()（§9 標準・
 * docs/persistence-design.md）の Collection に閉じる。占有領域（demo-studio）内に置き、永続化の
 * 境界だけを担う（検証は `./scenario.ts` の validateDemoScenario、UI 整形は `./editor.ts`）。
 *
 * 解決順（AC「設定→プレビュー反映」）: `resolveDemoScenario` は **保存済み → 組込** の順で引く。
 * これによりプレビュー iframe は id ひとつでカスタム・組込の双方を解決できる。
 */
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';
import type { DemoScenario } from './scenario';
import { getDemoScenario as getBuiltinScenario } from './scenarios';

export const DEMO_SCENARIO_COLLECTION = 'demo_scenario';

/** 保存済みシナリオの安全弁（デモ用途では十分・無境界読み防止）。 */
export const SAVED_DEMO_SCENARIO_LIMIT = 200;

function scenarios(): Collection<DemoScenario> {
  return getBackend().collection<DemoScenario>(DEMO_SCENARIO_COLLECTION);
}

/** 保存済みカスタムシナリオを一覧する（組込テンプレートは含めない）。 */
export async function listSavedDemoScenarios(): Promise<DemoScenario[]> {
  return scenarios().list({ limit: SAVED_DEMO_SCENARIO_LIMIT });
}

/** 保存済みカスタムシナリオを id で引く（組込は対象外）。 */
export async function getSavedDemoScenario(id: string): Promise<DemoScenario | undefined> {
  return scenarios().get(id);
}

/**
 * シナリオを id で解決する。順序は **保存済み → 組込**（保存済みが優先）。
 * プレビュー/デモ実行の単一の解決点。未知 id は undefined。
 */
export async function resolveDemoScenario(id: string): Promise<DemoScenario | undefined> {
  return (await scenarios().get(id)) ?? getBuiltinScenario(id);
}

/** カスタムシナリオを作成/上書き保存する（検証済みの値を渡すこと）。 */
export async function saveDemoScenario(scenario: DemoScenario): Promise<void> {
  await scenarios().put(scenario);
}

/** 保存済みカスタムシナリオを削除する。 */
export async function deleteSavedDemoScenario(id: string): Promise<void> {
  await scenarios().remove(id);
}

/** テスト用: 保存済みシナリオを初期状態へ戻す（memory backend のみ実効）。 */
export async function __resetDemoScenarios(): Promise<void> {
  await scenarios().reset();
}
