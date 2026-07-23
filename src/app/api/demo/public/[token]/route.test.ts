/**
 * GET /api/demo/public/:token — 公開（**認証なし**）デモ解決 (issue #363 Inc3・公開モデル)。
 *
 * 安全性の固定:
 *   - admin ガードを通さずに解決できる（公開経路）。
 *   - published＋有効トークンのみ解決し、**シナリオのみ**返す（target/publication id を露出しない）。
 *   - draft/test・失効・期限切れ・未知トークンは 404（列挙オラクルを与えない）。
 *   - レート制限超過は 429。
 *   - この経路から admin 領域・実データ・target へ辿れないこと。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';
import {
  __resetDemoPublications,
  attachShareToken,
  saveDemoPublication,
} from '@/domain/demo-studio/publication-store';
import { createPublication, publish } from '@/domain/demo-studio/publication';
import { issueShareToken, revokeShareToken, DEMO_SHARE_MAX_TTL_MS } from '@/domain/demo-studio/share-token';
import { DEMO_SHARE_RATE_LIMIT } from '@/domain/demo-studio/share-access';

const TARGET = { siteId: 'tenant-demo', kioskId: 'kiosk-a' };
const NOW_ISO = '2026-07-22T00:00:00.000Z';

function scenario(id = 'custom-x') {
  return {
    id,
    name: 'デモ',
    initialMode: 'reception' as const,
    visitorInputs: [{ mode: 'touch' as const, value: 'meeting' }],
    simulatedResults: {},
  };
}
function publishedPub(id: string) {
  const r = publish(createPublication(id, 'custom-x', NOW_ISO), scenario(), TARGET, [TARGET], NOW_ISO);
  if (!r.ok) throw new Error('setup');
  return r.publication;
}
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const get = (token: string) => GET(new Request(`http://x/api/demo/public/${token}`), ctx(token));

// 有効なトークンを持つ published publication を保存し、そのトークンを返す。
async function seedShared(id = 'pub-1', ttl = DEMO_SHARE_MAX_TTL_MS): Promise<string> {
  const pub = attachShareToken(publishedPub(id), issueShareToken(Date.now(), ttl), NOW_ISO);
  await saveDemoPublication(pub);
  return pub.share!.token;
}

beforeEach(async () => {
  await __resetDemoPublications();
});

describe('GET /api/demo/public/:token', () => {
  it('published＋有効トークンはシナリオのみ返す（target/publication id を露出しない）', async () => {
    const token = await seedShared();
    const res = await get(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scenario.id).toBe('custom-x');
    expect(body.scenario.name).toBe('デモ');
    // 実データ・admin 情報へ辿れる手掛かりを一切返さない。
    expect(body.target).toBeUndefined();
    expect(body.id).toBeUndefined();
    expect(body.versions).toBeUndefined();
    expect(body.share).toBeUndefined();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('kiosk-a');
    expect(raw).not.toContain('pub-1');
  });

  it('形式不正なトークンは 404', async () => {
    expect((await get('short')).status).toBe(404);
  });

  it('未知トークンは 404', async () => {
    await seedShared();
    const res = await get('a'.repeat(43));
    expect(res.status).toBe(404);
  });

  it('失効したトークンは 404（期限内でも）', async () => {
    const pub = attachShareToken(publishedPub('pub-1'), issueShareToken(Date.now()), NOW_ISO);
    const revoked = { ...pub, share: revokeShareToken(pub.share!, Date.now()) };
    await saveDemoPublication(revoked);
    expect((await get(revoked.share!.token)).status).toBe(404);
  });

  it('期限切れのトークンは 404', async () => {
    // 過去に発行し、既に失効期限を過ぎたトークン。
    const pub = attachShareToken(publishedPub('pub-1'), issueShareToken(Date.now() - 10_000, 1000), NOW_ISO);
    await saveDemoPublication(pub);
    expect((await get(pub.share!.token)).status).toBe(404);
  });

  it('draft/test の publication は有効トークンがあっても 404（published のみ公開）', async () => {
    const draft = attachShareToken(createPublication('pub-d', 'custom-x', NOW_ISO), issueShareToken(Date.now()), NOW_ISO);
    await saveDemoPublication(draft);
    expect((await get(draft.share!.token)).status).toBe(404);
  });

  it('レート制限超過は 429', async () => {
    const token = await seedShared();
    for (let i = 0; i < DEMO_SHARE_RATE_LIMIT.maxPerWindow; i++) {
      const ok = await get(token);
      expect(ok.status).toBe(200);
    }
    expect((await get(token)).status).toBe(429);
  });
});
