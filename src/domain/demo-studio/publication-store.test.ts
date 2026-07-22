import { afterEach, describe, expect, it } from 'vitest';
import type { DemoScenario } from './scenario';
import { createPublication, publish, type DemoPublishTarget } from './publication';
import { issueShareToken } from './share-token';
import {
  __resetDemoPublications,
  attachShareToken,
  getDemoPublication,
  listDemoPublications,
  resolvePublishedByShareToken,
  saveDemoPublication,
} from './publication-store';

function scenario(id: string, name = 'デモ'): DemoScenario {
  return { id, name, initialMode: 'reception', visitorInputs: [], simulatedResults: {} };
}
const TARGET: DemoPublishTarget = { siteId: 'site-1', kioskId: 'kiosk-a' };
const NOW = Date.UTC(2026, 6, 22, 0, 0, 0);
const NOW_ISO = new Date(NOW).toISOString();

function publishedPub(id: string, scenarioId = 'custom-x') {
  const draft = createPublication(id, scenarioId, NOW_ISO);
  const r = publish(draft, scenario(scenarioId), TARGET, [TARGET], NOW_ISO);
  if (!r.ok) throw new Error('setup');
  return r.publication;
}

afterEach(async () => {
  await __resetDemoPublications();
});

describe('publication-store 永続化', () => {
  it('保存→一覧→取得できる', async () => {
    await saveDemoPublication(publishedPub('pub-a'));
    await saveDemoPublication(publishedPub('pub-b'));
    const list = await listDemoPublications();
    expect(list.map((p) => p.id).sort()).toEqual(['pub-a', 'pub-b']);
    expect((await getDemoPublication('pub-a'))?.id).toBe('pub-a');
    expect(await getDemoPublication('nope')).toBeUndefined();
  });
});

describe('resolvePublishedByShareToken（公開解決の単一の入口）', () => {
  it('published＋有効な共有トークンなら現在の公開シナリオを返す', async () => {
    const pub = attachShareToken(publishedPub('pub-a'), issueShareToken(NOW), NOW_ISO);
    await saveDemoPublication(pub);
    const token = pub.share!.token;
    const resolved = await resolvePublishedByShareToken(token, NOW + 1000);
    expect(resolved?.scenario.id).toBe('custom-x');
  });

  it('失効した共有トークンは解決しない', async () => {
    let pub = attachShareToken(publishedPub('pub-a'), issueShareToken(NOW), NOW_ISO);
    // 失効させて保存。
    const { revokeShareToken } = await import('./share-token');
    pub = { ...pub, share: revokeShareToken(pub.share!, NOW + 10) };
    await saveDemoPublication(pub);
    expect(await resolvePublishedByShareToken(pub.share!.token, NOW + 100)).toBeUndefined();
  });

  it('期限切れの共有トークンは解決しない', async () => {
    const pub = attachShareToken(publishedPub('pub-a'), issueShareToken(NOW, 1000), NOW_ISO);
    await saveDemoPublication(pub);
    expect(await resolvePublishedByShareToken(pub.share!.token, NOW + 2000)).toBeUndefined();
  });

  it('draft/test の publication は共有トークンがあっても解決しない（published のみ）', async () => {
    // draft を無理やり共有付きで保存しても公開解決されないこと。
    const draft = createPublication('pub-draft', 'custom-x', NOW_ISO);
    const withShare = attachShareToken(draft, issueShareToken(NOW), NOW_ISO);
    await saveDemoPublication(withShare);
    expect(await resolvePublishedByShareToken(withShare.share!.token, NOW + 1)).toBeUndefined();
  });

  it('未知トークンは undefined', async () => {
    await saveDemoPublication(attachShareToken(publishedPub('pub-a'), issueShareToken(NOW), NOW_ISO));
    expect(await resolvePublishedByShareToken('unknown-token-value', NOW)).toBeUndefined();
  });
});

describe('attachShareToken', () => {
  it('share を設定し updatedAt を進める', () => {
    const pub = publishedPub('pub-a');
    const withShare = attachShareToken(pub, issueShareToken(NOW), '2026-07-22T05:00:00.000Z');
    expect(withShare.share?.token).toBeDefined();
    expect(withShare.updatedAt).toBe('2026-07-22T05:00:00.000Z');
  });
});
