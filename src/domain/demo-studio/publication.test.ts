import { describe, expect, it } from 'vitest';
import type { DemoScenario } from './scenario';
import {
  canRollback,
  createPublication,
  currentPublishedVersion,
  DEMO_PUBLICATION_STATUSES,
  isDemoPublishTarget,
  publish,
  rollbackTo,
  setStatus,
  validatePublishTarget,
  type DemoPublication,
  type DemoPublishTarget,
} from './publication';

function scenario(id: string, name = 'デモ'): DemoScenario {
  return {
    id,
    name,
    initialMode: 'reception',
    visitorInputs: [{ mode: 'touch', value: 'meeting' }],
    simulatedResults: { call: ['answered'], runtime: 'ready' },
  };
}

const T0 = '2026-07-22T00:00:00.000Z';
const T1 = '2026-07-22T01:00:00.000Z';
const T2 = '2026-07-22T02:00:00.000Z';

const KIOSK_A: DemoPublishTarget = { siteId: 'site-1', kioskId: 'kiosk-a' };
const KIOSK_B: DemoPublishTarget = { siteId: 'site-1', kioskId: 'kiosk-b' };
const ALLOWED = [KIOSK_A, KIOSK_B];

describe('createPublication', () => {
  it('draft 状態・空 version 履歴で作る', () => {
    const p = createPublication('pub-1', 'custom-x', T0);
    expect(p.id).toBe('pub-1');
    expect(p.scenarioId).toBe('custom-x');
    expect(p.status).toBe('draft');
    expect(p.versions).toEqual([]);
    expect(p.currentVersion).toBeUndefined();
    expect(p.target).toBeUndefined();
    expect(p.updatedAt).toBe(T0);
  });
});

describe('setStatus (draft ↔ test)', () => {
  it('draft→test / test→draft を許可し updatedAt を進める', () => {
    const p = createPublication('pub-1', 'custom-x', T0);
    const test = setStatus(p, 'test', T1);
    expect(test.ok).toBe(true);
    if (test.ok) {
      expect(test.publication.status).toBe('test');
      expect(test.publication.updatedAt).toBe(T1);
    }
    const back = setStatus(test.ok ? test.publication : p, 'draft', T2);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.publication.status).toBe('draft');
  });

  it('setStatus で published へは遷移できない（publish() を使う）', () => {
    const p = createPublication('pub-1', 'custom-x', T0);
    const r = setStatus(p, 'published', T1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_transition');
  });
});

describe('validatePublishTarget（誤った Site/Kiosk への公開防止）', () => {
  it('許可一覧に一致する target は ok', () => {
    expect(validatePublishTarget(KIOSK_A, ALLOWED).ok).toBe(true);
  });
  it('存在しない kioskId は拒否', () => {
    const r = validatePublishTarget({ siteId: 'site-1', kioskId: 'ghost' }, ALLOWED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_target');
  });
  it('siteId と kioskId の組が食い違う場合は拒否', () => {
    const r = validatePublishTarget({ siteId: 'site-9', kioskId: 'kiosk-a' }, ALLOWED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_target');
  });
  it('許可一覧が空なら常に拒否（fail-closed）', () => {
    expect(validatePublishTarget(KIOSK_A, []).ok).toBe(false);
  });
  it('構造ガード isDemoPublishTarget', () => {
    expect(isDemoPublishTarget(KIOSK_A)).toBe(true);
    expect(isDemoPublishTarget({ siteId: 'x' })).toBe(false);
    expect(isDemoPublishTarget({ siteId: 1, kioskId: 'x' })).toBe(false);
    expect(isDemoPublishTarget(null)).toBe(false);
  });
});

describe('publish', () => {
  it('許可 target なら version1 を追加し published へ', () => {
    const p = createPublication('pub-1', 'custom-x', T0);
    const r = publish(p, scenario('custom-x'), KIOSK_A, ALLOWED, T1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pub = r.publication;
    expect(pub.status).toBe('published');
    expect(pub.target).toEqual(KIOSK_A);
    expect(pub.versions).toHaveLength(1);
    expect(pub.versions[0]!.version).toBe(1);
    expect(pub.currentVersion).toBe(1);
    expect(pub.versions[0]!.scenario).toEqual(scenario('custom-x'));
    expect(pub.versions[0]!.publishedAt).toBe(T1);
  });

  it('誤った target は拒否し状態を変えない', () => {
    const p = createPublication('pub-1', 'custom-x', T0);
    const r = publish(p, scenario('custom-x'), { siteId: 'site-1', kioskId: 'ghost' }, ALLOWED, T1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_target');
  });

  it('連続 publish は version を単調増加で積む（履歴は append-only）', () => {
    const p0 = createPublication('pub-1', 'custom-x', T0);
    const r1 = publish(p0, scenario('custom-x', 'v1'), KIOSK_A, ALLOWED, T1);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = publish(r1.publication, scenario('custom-x', 'v2'), KIOSK_B, ALLOWED, T2);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const pub = r2.publication;
    expect(pub.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(pub.currentVersion).toBe(2);
    expect(pub.target).toEqual(KIOSK_B);
    // v1 の内容は保持される。
    expect(pub.versions[0]!.scenario.name).toBe('v1');
    expect(currentPublishedVersion(pub)?.scenario.name).toBe('v2');
  });

  it('スナップショットは入力 scenario から切り離される（後続の変異が履歴を汚さない）', () => {
    const p = createPublication('pub-1', 'custom-x', T0);
    const s = scenario('custom-x');
    const r = publish(p, s, KIOSK_A, ALLOWED, T1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    (s.visitorInputs as { mode: string; value: string }[]).push({ mode: 'text', value: 'leak' });
    expect(r.publication.versions[0]!.scenario.visitorInputs).toHaveLength(1);
  });
});

describe('rollbackTo', () => {
  function twoVersions(): DemoPublication {
    const p0 = createPublication('pub-1', 'custom-x', T0);
    const r1 = publish(p0, scenario('custom-x', 'v1'), KIOSK_A, ALLOWED, T1);
    if (!r1.ok) throw new Error('setup');
    const r2 = publish(r1.publication, scenario('custom-x', 'v2'), KIOSK_B, ALLOWED, T2);
    if (!r2.ok) throw new Error('setup');
    return r2.publication;
  }

  it('過去 version へ rollback すると新 version として復元し current を差し替える', () => {
    const pub = twoVersions();
    const r = rollbackTo(pub, 1, '2026-07-22T03:00:00.000Z');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = r.publication;
    // 履歴は削除されず、新しい version3 が積まれる。
    expect(next.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(next.currentVersion).toBe(3);
    // v3 は v1 の内容・target を復元する。
    expect(currentPublishedVersion(next)?.scenario.name).toBe('v1');
    expect(next.target).toEqual(KIOSK_A);
    expect(next.versions[2]!.rolledBackFrom).toBe(1);
    expect(next.status).toBe('published');
  });

  it('存在しない version への rollback は拒否', () => {
    const pub = twoVersions();
    const r = rollbackTo(pub, 99, T2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_version');
  });

  it('version 履歴が無い（未 publish）publication は rollback 不可', () => {
    const p = createPublication('pub-1', 'custom-x', T0);
    expect(canRollback(p)).toBe(false);
    const r = rollbackTo(p, 1, T1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_version');
  });
});

describe('DEMO_PUBLICATION_STATUSES', () => {
  it('draft/test/published の 3 値', () => {
    expect(DEMO_PUBLICATION_STATUSES).toEqual(['draft', 'test', 'published']);
  });
});
