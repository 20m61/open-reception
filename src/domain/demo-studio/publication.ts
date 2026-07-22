/**
 * 受付体験スタジオ「下書き・テスト・本番公開」の純ロジック (issue #363 Increment 3)。
 *
 * Inc1/Inc2 は組込テンプレート（`./scenarios.ts`）とカスタムシナリオ編集/保存（`./editor.ts` /
 * `./store.ts`）まで。Inc3 は保存済みシナリオを **draft / test / published** の 3 段階で扱い、
 * 本番公開に version 履歴と rollback を与える。
 *
 * 設計方針:
 *   - すべて**純関数**（I/O なし・入力を破壊しない）。永続化は `./publication-store.ts`、
 *     API 認可/監査は route が担う。TDD で決定的に検証できるよう時刻は呼び出し側が ISO で渡す。
 *   - version 履歴は **append-only**。publish も rollback も新しい version を積むだけで、過去の
 *     スナップショットを書き換え/削除しない（監査可能性・「以前の公開へ戻せる」AC の担保）。
 *   - 「誤った Site/Kiosk への公開防止」は `validatePublishTarget` を **fail-closed**（許可一覧に
 *     一致しなければ拒否）で行う。許可一覧は route がテナントの実 Kiosk から組む。
 *   - スナップショットは入力シナリオから深くコピーし、後続の編集が履歴を汚さないようにする。
 */
import type { DemoScenario } from './scenario';

/** 公開ライフサイクルの 3 状態。issue #363 Inc3 AC「下書き・テスト・本番公開を分離できる」。 */
export const DEMO_PUBLICATION_STATUSES = ['draft', 'test', 'published'] as const;
export type DemoPublicationStatus = (typeof DEMO_PUBLICATION_STATUSES)[number];

/** 公開先。Site/Kiosk の組で表す（誤公開防止の検証単位）。 */
export type DemoPublishTarget = {
  siteId: string;
  kioskId: string;
};

/** 公開スナップショット（append-only 履歴の 1 要素）。過去分は不変。 */
export type DemoPublicationVersion = {
  /** 1 始まりの単調増加番号。 */
  version: number;
  /** 公開時点のシナリオの深いコピー（以後不変）。 */
  scenario: DemoScenario;
  /** この version の公開先。 */
  target: DemoPublishTarget;
  /** 公開時刻（ISO）。 */
  publishedAt: string;
  /** rollback で作られた version の場合、復元元の version 番号。 */
  rolledBackFrom?: number;
};

/** 公開単位（1 シナリオに対する公開ライフサイクル状態＋履歴）。 */
export type DemoPublication = {
  id: string;
  /** 公開対象のシナリオ id（`./store.ts` の保存済みカスタムシナリオ）。 */
  scenarioId: string;
  status: DemoPublicationStatus;
  /** published のときの現在の公開先（currentVersion の target と一致）。 */
  target?: DemoPublishTarget;
  /** append-only の公開履歴（未 publish は空）。 */
  versions: DemoPublicationVersion[];
  /** 現在ライブな version 番号（versions 内を指す）。 */
  currentVersion?: number;
  updatedAt: string;
};

type Ok<T> = { ok: true } & T;
type Err<R extends string> = { ok: false; reason: R };

/* ---------------- ガード ---------------- */

export function isDemoPublishTarget(v: unknown): v is DemoPublishTarget {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.siteId === 'string' && o.siteId.length > 0 && typeof o.kioskId === 'string' && o.kioskId.length > 0;
}

export function isDemoPublicationStatus(v: unknown): v is DemoPublicationStatus {
  return typeof v === 'string' && (DEMO_PUBLICATION_STATUSES as readonly string[]).includes(v);
}

/* ---------------- 生成・状態遷移 ---------------- */

/** 新規公開単位を draft で作る（履歴なし）。 */
export function createPublication(id: string, scenarioId: string, nowIso: string): DemoPublication {
  return { id, scenarioId, status: 'draft', versions: [], updatedAt: nowIso };
}

/**
 * draft ↔ test の状態遷移のみ許可する。published への遷移は `publish()` 専用
 * （target 検証とスナップショットが必須のため setStatus では行わせない）。
 */
export function setStatus(
  pub: DemoPublication,
  status: DemoPublicationStatus,
  nowIso: string,
): Ok<{ publication: DemoPublication }> | Err<'invalid_transition'> {
  if (status === 'published') return { ok: false, reason: 'invalid_transition' };
  if (pub.status === 'published') return { ok: false, reason: 'invalid_transition' };
  return { ok: true, publication: { ...pub, status, updatedAt: nowIso } };
}

/* ---------------- 公開先の検証（誤公開防止） ---------------- */

/**
 * 公開先が許可一覧（テナントの実 Site/Kiosk）に**完全一致**するか検証する。
 * fail-closed: 一覧に無い組（存在しない kioskId・siteId と kioskId の食い違い・空一覧）は拒否。
 */
export function validatePublishTarget(
  target: DemoPublishTarget,
  allowed: readonly DemoPublishTarget[],
): Ok<Record<never, never>> | Err<'unknown_target'> {
  const hit = allowed.some((a) => a.siteId === target.siteId && a.kioskId === target.kioskId);
  return hit ? { ok: true } : { ok: false, reason: 'unknown_target' };
}

/* ---------------- 公開・rollback（append-only） ---------------- */

function cloneScenario(s: DemoScenario): DemoScenario {
  return {
    id: s.id,
    name: s.name,
    initialMode: s.initialMode,
    visitorInputs: s.visitorInputs.map((t) => ({ ...t })),
    simulatedResults: {
      ...s.simulatedResults,
      call: s.simulatedResults.call ? [...s.simulatedResults.call] : undefined,
    },
  };
}

function nextVersionNumber(pub: DemoPublication): number {
  return pub.versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
}

function appendVersion(pub: DemoPublication, v: DemoPublicationVersion, nowIso: string): DemoPublication {
  return {
    ...pub,
    status: 'published',
    target: { ...v.target },
    versions: [...pub.versions, v],
    currentVersion: v.version,
    updatedAt: nowIso,
  };
}

/**
 * シナリオを指定 target へ本番公開する。target を許可一覧で検証し、合格時のみ新 version を積む。
 * 検証に落ちたら状態を変えない（fail-closed）。
 */
export function publish(
  pub: DemoPublication,
  scenario: DemoScenario,
  target: DemoPublishTarget,
  allowed: readonly DemoPublishTarget[],
  nowIso: string,
): Ok<{ publication: DemoPublication }> | Err<'unknown_target'> {
  const check = validatePublishTarget(target, allowed);
  if (!check.ok) return check;
  const version: DemoPublicationVersion = {
    version: nextVersionNumber(pub),
    scenario: cloneScenario(scenario),
    target: { ...target },
    publishedAt: nowIso,
  };
  return { ok: true, publication: appendVersion(pub, version, nowIso) };
}

/** 現在ライブな公開 version を返す（未 publish は undefined）。 */
export function currentPublishedVersion(pub: DemoPublication): DemoPublicationVersion | undefined {
  if (pub.currentVersion === undefined) return undefined;
  return pub.versions.find((v) => v.version === pub.currentVersion);
}

/** rollback 可能か（1 つ以上の公開履歴があるか）。 */
export function canRollback(pub: DemoPublication): boolean {
  return pub.versions.length > 0;
}

/**
 * 過去の公開 version の内容・target を**新しい version として**復元する（append-only rollback）。
 * 履歴は削除せず、rolledBackFrom に復元元を記録する。存在しない version は拒否。
 */
export function rollbackTo(
  pub: DemoPublication,
  version: number,
  nowIso: string,
): Ok<{ publication: DemoPublication }> | Err<'unknown_version'> {
  const source = pub.versions.find((v) => v.version === version);
  if (!source) return { ok: false, reason: 'unknown_version' };
  const restored: DemoPublicationVersion = {
    version: nextVersionNumber(pub),
    scenario: cloneScenario(source.scenario),
    target: { ...source.target },
    publishedAt: nowIso,
    rolledBackFrom: source.version,
  };
  return { ok: true, publication: appendVersion(pub, restored, nowIso) };
}
