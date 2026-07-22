/**
 * カスタムデモシナリオ編集の純関数 (issue #363 Increment 2)。
 *
 * 3 ペイン編集スタジオ（`src/components/admin/demo-studio/`）の状態遷移をここに集約し、UI を薄く保つ。
 * すべて**入力 draft を破壊せず新しい draft を返す**（React state の不変更新前提）。検証は
 * `./scenario.ts` の validateDemoScenario、永続化は `./store.ts` が担う。
 */
import type {
  DemoInitialMode,
  DemoScenario,
  DemoSimulatedResults,
  DemoVisitorInput,
} from './scenario';

/** 編集中のシナリオ（可変配列。保存時に validateDemoScenario で DemoScenario へ確定する）。 */
export type DemoScenarioDraft = {
  id: string;
  name: string;
  initialMode: DemoInitialMode;
  visitorInputs: DemoVisitorInput[];
  simulatedResults: DemoSimulatedResults;
};

/** 組込テンプレートを複製して編集可能な draft にする（深いコピー・新 id・複製名）。 */
export function cloneBuiltinToDraft(source: DemoScenario, newId: string): DemoScenarioDraft {
  return {
    id: newId,
    name: `${source.name}（コピー）`,
    initialMode: source.initialMode,
    visitorInputs: source.visitorInputs.map((t) => ({ ...t })),
    simulatedResults: {
      ...source.simulatedResults,
      call: source.simulatedResults.call ? [...source.simulatedResults.call] : undefined,
    },
  };
}

/** 保存済みカスタムシナリオを編集用 draft に読み込む（深いコピー）。 */
export function scenarioToDraft(source: DemoScenario): DemoScenarioDraft {
  return {
    id: source.id,
    name: source.name,
    initialMode: source.initialMode,
    visitorInputs: source.visitorInputs.map((t) => ({ ...t })),
    simulatedResults: {
      ...source.simulatedResults,
      call: source.simulatedResults.call ? [...source.simulatedResults.call] : undefined,
    },
  };
}

/** 空の編集骨組み（ゼロから作成する場合）。 */
export function emptyDraft(id: string, name: string): DemoScenarioDraft {
  return { id, name, initialMode: 'reception', visitorInputs: [], simulatedResults: { runtime: 'ready' } };
}

/** 末尾にターンを追加する。 */
export function addTurn(draft: DemoScenarioDraft, turn: DemoVisitorInput): DemoScenarioDraft {
  return { ...draft, visitorInputs: [...draft.visitorInputs.map((t) => ({ ...t })), { ...turn }] };
}

/** index のターンを部分更新する（範囲外は無変更）。 */
export function updateTurnAt(
  draft: DemoScenarioDraft,
  index: number,
  patch: Partial<DemoVisitorInput>,
): DemoScenarioDraft {
  if (index < 0 || index >= draft.visitorInputs.length) return draft;
  const visitorInputs = draft.visitorInputs.map((t, i) => (i === index ? { ...t, ...patch } : { ...t }));
  return { ...draft, visitorInputs };
}

/** index のターンを削除する（範囲外は無変更）。 */
export function removeTurnAt(draft: DemoScenarioDraft, index: number): DemoScenarioDraft {
  if (index < 0 || index >= draft.visitorInputs.length) return draft;
  return { ...draft, visitorInputs: draft.visitorInputs.filter((_, i) => i !== index).map((t) => ({ ...t })) };
}

/** index のターンを dir 方向（-1 上/1 下）へ入れ替える（境界は無変更）。 */
export function moveTurn(draft: DemoScenarioDraft, index: number, dir: -1 | 1): DemoScenarioDraft {
  const target = index + dir;
  if (index < 0 || index >= draft.visitorInputs.length) return draft;
  if (target < 0 || target >= draft.visitorInputs.length) return draft;
  const visitorInputs = draft.visitorInputs.map((t) => ({ ...t }));
  const tmp = visitorInputs[index]!;
  visitorInputs[index] = visitorInputs[target]!;
  visitorInputs[target] = tmp;
  return { ...draft, visitorInputs };
}

/** simulatedResults を部分更新する（既存フィールドを保持）。 */
export function setSimulatedResults(
  draft: DemoScenarioDraft,
  patch: Partial<DemoSimulatedResults>,
): DemoScenarioDraft {
  return {
    ...draft,
    simulatedResults: {
      ...draft.simulatedResults,
      ...patch,
      ...(patch.call !== undefined ? { call: [...patch.call] } : {}),
    },
  };
}

/** 名称・起動モードの更新（薄いヘルパ）。 */
export function setName(draft: DemoScenarioDraft, name: string): DemoScenarioDraft {
  return { ...draft, name };
}

export function setInitialMode(draft: DemoScenarioDraft, initialMode: DemoInitialMode): DemoScenarioDraft {
  return { ...draft, initialMode };
}
