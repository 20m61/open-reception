/**
 * デモ公開単位の永続化と公開解決 (issue #363 Increment 3)。
 *
 * `./publication.ts`（純ロジック）で組み立てた `DemoPublication` を getBackend() の Collection に
 * 閉じる（§9 標準・docs/persistence-design.md）。占有領域（demo-studio）内に置き、永続化と
 * 「共有トークン→公開シナリオ」の解決境界だけを担う。
 *
 * 公開解決（`resolvePublishedByShareToken`）は**公開経路（認証なし）唯一の入口**であり、
 *   1. status === 'published' の publication のみ
 *   2. share トークンが**有効**（失効しておらず期限内）
 * の双方を満たす場合だけ、現在ライブな version のシナリオを返す。これにより draft/test や
 * 失効・期限切れのリンクからは実データへ辿れない（fail-closed）。
 */
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';
import type { DemoScenario } from './scenario';
import {
  currentPublishedVersion,
  type DemoPublication,
  type DemoPublicationVersion,
} from './publication';
import { isShareTokenActive, type DemoShareToken } from './share-token';

/** 公開単位に共有トークンを添えた保存形（`./publication.ts` の純型を汚さない拡張）。 */
export type StoredDemoPublication = DemoPublication & {
  /** 公開（認証なし閲覧）用の共有トークン。未共有は undefined。 */
  share?: DemoShareToken;
};

export const DEMO_PUBLICATION_COLLECTION = 'demo_publication';

/** 一覧の安全弁（無境界読み防止・デモ用途で十分）。 */
export const DEMO_PUBLICATION_LIMIT = 200;

function publications(): Collection<StoredDemoPublication> {
  return getBackend().collection<StoredDemoPublication>(DEMO_PUBLICATION_COLLECTION);
}

/** 共有トークンを publication に添える（純関数・updatedAt を進める）。 */
export function attachShareToken(
  pub: DemoPublication,
  share: DemoShareToken,
  nowIso: string,
): StoredDemoPublication {
  return { ...pub, share, updatedAt: nowIso };
}

export async function listDemoPublications(): Promise<StoredDemoPublication[]> {
  return publications().list({ limit: DEMO_PUBLICATION_LIMIT });
}

/**
 * 管理 API 応答用の view。共有トークンの**生値を落とし**、presence(発行/期限/失効の時刻)のみ返す。
 * 生値は `POST [id]/share` の発行応答にだけ載せる（「発行直後のみ表示」の不変条件をサーバ側で担保。
 * read 権限の管理者/viewer が一覧応答からトークンを回収できてはならない）。
 */
export type DemoPublicationView = DemoPublication & {
  share?: Omit<DemoShareToken, 'token'>;
};

export function toDemoPublicationView(stored: StoredDemoPublication): DemoPublicationView {
  if (!stored.share) return stored;
  const { token: _token, ...presence } = stored.share;
  return { ...stored, share: presence };
}

export async function getDemoPublication(id: string): Promise<StoredDemoPublication | undefined> {
  return publications().get(id);
}

export async function saveDemoPublication(pub: StoredDemoPublication): Promise<void> {
  await publications().put(pub);
}

export async function deleteDemoPublication(id: string): Promise<void> {
  await publications().remove(id);
}

/** 公開解決の結果（公開経路へ返すのは**シナリオのみ**。target・内部構造は載せない）。 */
export type ResolvedPublicDemo = {
  scenario: DemoScenario;
  version: DemoPublicationVersion['version'];
};

/**
 * 共有トークンから公開中のデモシナリオを解決する（公開経路唯一の入口・fail-closed）。
 *
 * published かつ share が有効な publication のみ、現在ライブな version のシナリオを返す。
 * それ以外（未知トークン・draft/test・失効・期限切れ・version 不整合）は undefined。
 * 返すのはシナリオと version 番号だけで、公開先（Site/Kiosk）や publication id は**露出しない**。
 */
export async function resolvePublishedByShareToken(
  token: string,
  nowMs: number,
): Promise<ResolvedPublicDemo | undefined> {
  const all = await publications().list({ limit: DEMO_PUBLICATION_LIMIT });
  const hit = all.find((p) => p.share?.token === token);
  if (!hit) return undefined;
  if (hit.status !== 'published') return undefined;
  if (!hit.share || !isShareTokenActive(hit.share, nowMs)) return undefined;
  const version = currentPublishedVersion(hit);
  if (!version) return undefined;
  return { scenario: version.scenario, version: version.version };
}

/** テスト用: 保存済み publication を初期化（memory backend のみ実効）。 */
export async function __resetDemoPublications(): Promise<void> {
  await publications().reset();
}
