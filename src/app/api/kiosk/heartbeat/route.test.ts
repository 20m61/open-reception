/**
 * kiosk heartbeat ルートの単体テスト。
 *
 * Kiosk→Device 統合 (issue #87 inc3): heartbeat が Device.lastSeenAt を更新する read 経路を
 * 通すこと、Device 更新が失敗しても heartbeat 応答（active/pinRequired/authorized）を
 * 壊さないこと（best-effort）を検証する。
 *
 * #261: 対応 Device が無い kiosk（旧レジストリのみの端末）は、kiosk レジストリでの実在を
 * 確認したうえで Device へ取り込む（adoptKiosk）。未登録 id では取り込まない
 * （無認可 heartbeat からの任意行作成を防ぐ）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getKioskConfig = vi.fn();
const getKiosk = vi.fn();
const getSecuritySettings = vi.fn();
const readKioskSession = vi.fn();
const recordHeartbeat = vi.fn();
const adoptKiosk = vi.fn();
const cookieGet = vi.fn(() => ({ value: 'kiosk-cookie' }));
const resolveDeviceBinding = vi.fn();
const recordDeploymentReport = vi.fn();
const SCOPE = { tenantId: 'internal', siteId: 'default-site' };

vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/kiosk/kiosk-store', () => ({
  getKioskConfig: (...a: unknown[]) => getKioskConfig(...a),
  getKiosk: (...a: unknown[]) => getKiosk(...a),
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  resolveDefaultScope: () => SCOPE,
}));
vi.mock('@/lib/security/security-store', () => ({
  getSecuritySettings: (...a: unknown[]) => getSecuritySettings(...a),
}));
vi.mock('@/domain/security/types', () => ({
  effectiveKioskActive: (active: boolean, emergencyStop: boolean) => active && !emergencyStop,
}));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  readKioskSession: (...a: unknown[]) => readKioskSession(...a),
}));
vi.mock('@/lib/tenant/store', () => ({
  getDeviceService: () => ({
    recordHeartbeat: (...a: unknown[]) => recordHeartbeat(...a),
    adoptKiosk: (...a: unknown[]) => adoptKiosk(...a),
  }),
}));

vi.mock('@/lib/product-context/device-binding', () => ({
  resolveDeviceBinding: (...a: unknown[]) => resolveDeviceBinding(...a),
}));
vi.mock('@/lib/experience-version/deployment-store', () => ({
  recordDeploymentReport: (...a: unknown[]) => recordDeploymentReport(...a),
}));

import { GET } from './route';

function call(kioskId = 'kiosk-dev', query = '') {
  return GET(
    new Request(`http://localhost/api/kiosk/heartbeat?kioskId=${kioskId}${query}`),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getKioskConfig.mockResolvedValue({ kioskId: 'kiosk-dev', active: true });
  getKiosk.mockResolvedValue({
    ok: true,
    value: { id: 'kiosk-dev', displayName: '受付端末1', enabled: true },
  });
  getSecuritySettings.mockResolvedValue({ emergencyStop: false, pinRequired: false });
  readKioskSession.mockResolvedValue({ kioskId: 'kiosk-dev' });
  recordHeartbeat.mockResolvedValue({ matched: true });
  adoptKiosk.mockResolvedValue({ created: true });
  resolveDeviceBinding.mockResolvedValue({
    tenantId: 'internal',
    siteId: 'default-site',
    kioskId: 'kiosk-dev',
  });
  recordDeploymentReport.mockResolvedValue(undefined);
});

describe('GET /api/kiosk/heartbeat 構成の反映報告 (#420 Inc3)', () => {
  it('読み込んだ版を報告すると記録する', async () => {
    await call('kiosk-dev', '&loadedRevision=3&loadedConfigHash=sha256:content');

    expect(recordDeploymentReport).toHaveBeenCalledWith(
      expect.objectContaining({
        kioskId: 'kiosk-dev',
        tenantId: 'internal',
        siteId: 'default-site',
        loadedRevision: 3,
        loadedConfigHash: 'sha256:content',
      }),
    );
  });

  it('報告が無い heartbeat では書き込まない', async () => {
    await call('kiosk-dev');
    expect(recordDeploymentReport).not.toHaveBeenCalled();
  });

  it('セッションが無い（または不一致の）端末の報告は受け付けない', async () => {
    readKioskSession.mockResolvedValue(null);

    await call('kiosk-dev', '&loadedRevision=3');

    expect(recordDeploymentReport).not.toHaveBeenCalled();
  });

  it('未登録の端末からの報告は捨てる（任意行を作らない）', async () => {
    resolveDeviceBinding.mockResolvedValue(null);

    await call('kiosk-dev', '&loadedRevision=3');

    expect(recordDeploymentReport).not.toHaveBeenCalled();
  });

  it('不正な revision / errorCode は未報告として扱う', async () => {
    await call('kiosk-dev', '&loadedRevision=abc&errorCode=%3Cscript%3E&loadedConfigHash=sha256:x');

    expect(recordDeploymentReport).toHaveBeenCalledWith(
      expect.objectContaining({ loadedRevision: undefined, errorCode: undefined }),
    );
  });

  it('読込エラーを報告できる', async () => {
    await call('kiosk-dev', '&errorCode=asset_load_failed&errorRevision=4');

    expect(recordDeploymentReport).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'asset_load_failed', errorRevision: 4 }),
    );
  });

  it('報告の記録に失敗しても heartbeat 応答は返る（best-effort）', async () => {
    recordDeploymentReport.mockRejectedValue(new Error('backend down'));

    const res = await call('kiosk-dev', '&loadedRevision=3');

    expect(res.status).toBe(200);
  });
});

describe('GET /api/kiosk/heartbeat (#87 inc3 Kiosk→Device)', () => {
  it('kiosk id で Device.lastSeenAt 更新を呼ぶ', async () => {
    await call('kiosk-dev');
    expect(recordHeartbeat).toHaveBeenCalledWith('kiosk-dev');
  });

  it('Device 更新に失敗しても heartbeat 応答は返る（best-effort）', async () => {
    recordHeartbeat.mockRejectedValue(new Error('backend down'));
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toBe(true);
    expect(body.pinRequired).toBe(false);
    expect(body.authorized).toBe(true);
  });

  it('応答形は従来どおり（active/pinRequired/authorized/serverTime）', async () => {
    const res = await call();
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['active', 'authorized', 'pinRequired', 'serverTime'].sort(),
    );
  });

  it('Device 一致時は取り込み（adoptKiosk）を呼ばない', async () => {
    await call('kiosk-dev');
    expect(adoptKiosk).not.toHaveBeenCalled();
  });
});

describe('GET /api/kiosk/heartbeat (#261 kiosk-only 端末の Device 取り込み)', () => {
  it('対応 Device が無く kiosk レジストリに実在する端末は Device へ取り込む', async () => {
    recordHeartbeat.mockResolvedValue({ matched: false });
    readKioskSession.mockResolvedValue({ kioskId: 'kiosk-legacy' });
    getKiosk.mockResolvedValue({
      ok: true,
      value: { id: 'kiosk-legacy', displayName: '旧端末', enabled: true },
    });
    const res = await call('kiosk-legacy');
    expect(res.status).toBe(200);
    expect(getKiosk).toHaveBeenCalledWith('kiosk-legacy');
    expect(adoptKiosk).toHaveBeenCalledWith(
      { id: 'kiosk-legacy', displayName: '旧端末', enabled: true },
      SCOPE,
    );
  });

  it('kiosk レジストリに無い id は取り込まない（無認可の任意行作成を防ぐ）', async () => {
    recordHeartbeat.mockResolvedValue({ matched: false });
    readKioskSession.mockResolvedValue({ kioskId: 'kiosk-unknown' });
    getKiosk.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x' } });
    await call('kiosk-unknown');
    expect(adoptKiosk).not.toHaveBeenCalled();
  });

  it('空 kioskId は kiosk レジストリを引かない（DynamoDB の空 SK を避ける既存規約）', async () => {
    // 端末 ID はセッションが権威になったので (#419)、空になり得るのはセッションが無いときだけ。
    recordHeartbeat.mockResolvedValue({ matched: false });
    readKioskSession.mockResolvedValue(null);
    await call('');
    expect(getKiosk).not.toHaveBeenCalled();
    expect(adoptKiosk).not.toHaveBeenCalled();
  });

  it('取り込みに失敗しても heartbeat 応答は返る（best-effort）', async () => {
    recordHeartbeat.mockResolvedValue({ matched: false });
    readKioskSession.mockResolvedValue({ kioskId: 'kiosk-legacy' });
    adoptKiosk.mockRejectedValue(new Error('backend down'));
    const res = await call('kiosk-legacy');
    expect(res.status).toBe(200);
    expect((await res.json()).active).toBe(true);
  });
});

describe('GET /api/kiosk/heartbeat (#284 inc1 死活記録のセッション紐づけ)', () => {
  it('kiosk セッションが無いリクエストは死活を記録しない（偽 online 注入対策）', async () => {
    readKioskSession.mockResolvedValue(null);
    const res = await call('kiosk-dev');
    expect(recordHeartbeat).not.toHaveBeenCalled();
    expect(adoptKiosk).not.toHaveBeenCalled();
    // 応答は既存互換: 端末の失効検知/緊急停止検知は従来どおり返す。
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toBe(true);
    expect(body.authorized).toBe(false);
  });

  it('クエリの kioskId は無視し、セッションの端末として記録する (#419)', async () => {
    // 旧実装は「不一致なら記録をスキップ」していた。クライアントが `kiosk-dev` 固定値を送って
    // いたため、実エンロール端末（ランダム UUID）では**常に不一致**になり記録されなかった。
    // クエリを信用せずセッションを権威にすることで、偽 online の注入を防ぎつつ記録が働く。
    readKioskSession.mockResolvedValue({ kioskId: 'kiosk-other' });
    const res = await call('kiosk-dev');
    expect(recordHeartbeat).toHaveBeenCalledWith('kiosk-other');
    // authorized は「有効な kiosk セッションを保持しているか」の既存意味を維持する。
    expect((await res.json()).authorized).toBe(true);
  });

  it('セッションの kioskId と一致するリクエストのみ死活を記録する', async () => {
    readKioskSession.mockResolvedValue({ kioskId: 'kiosk-dev' });
    await call('kiosk-dev');
    expect(recordHeartbeat).toHaveBeenCalledWith('kiosk-dev');
  });

  it('セッション不一致でも kiosk-only 端末の取り込み（adoptKiosk）は行わない', async () => {
    recordHeartbeat.mockResolvedValue({ matched: false });
    readKioskSession.mockResolvedValue(null);
    await call('kiosk-legacy');
    expect(getKiosk).not.toHaveBeenCalled();
    expect(adoptKiosk).not.toHaveBeenCalled();
  });
});

describe('端末 ID はセッションが権威 (#419 kiosk-dev 除去)', () => {
  it('セッションが在れば、クエリの kioskId を無視してセッションの端末で判定する', async () => {
    readKioskSession.mockResolvedValue({ kioskId: 'device-uuid' });
    resolveDeviceBinding.mockResolvedValue({
      tenantId: 'internal',
      siteId: 'default-site',
      kioskId: 'device-uuid',
    });

    // クライアントが別 ID（従来の 'kiosk-dev' 固定値）を送ってきても、それでは判定しない。
    const res = await call('kiosk-dev');

    expect(await res.json()).toMatchObject({ active: true, authorized: true });
    expect(recordHeartbeat).toHaveBeenCalledWith('device-uuid');
  });

  it('エンロール済み端末の有効性は device 台帳で判定する（旧 kiosk レジストリに無くても失効させない）', async () => {
    // 実際のエンロール端末はランダム UUID で、旧 kiosk レジストリには存在しない。
    // 旧レジストリだけを見ると getKioskConfig が active:false を返し、正常な端末が失効表示になる。
    readKioskSession.mockResolvedValue({ kioskId: 'device-uuid' });
    getKioskConfig.mockResolvedValue({ kioskId: 'device-uuid', active: false });
    resolveDeviceBinding.mockResolvedValue({
      tenantId: 'internal',
      siteId: 'default-site',
      kioskId: 'device-uuid',
    });

    expect(await (await call('kiosk-dev')).json()).toMatchObject({ active: true });
  });

  it('失効した端末は active:false（個別の失効が実端末に効く, #30）', async () => {
    readKioskSession.mockResolvedValue({ kioskId: 'device-uuid' });
    // resolveDeviceBinding は status!=='active' の端末に null を返す（fail-closed）。
    resolveDeviceBinding.mockResolvedValue(null);
    getKioskConfig.mockResolvedValue({ kioskId: 'device-uuid', active: false });

    expect(await (await call('kiosk-dev')).json()).toMatchObject({ active: false });
  });

  it('緊急停止は device 台帳の有効性より優先する', async () => {
    readKioskSession.mockResolvedValue({ kioskId: 'device-uuid' });
    resolveDeviceBinding.mockResolvedValue({
      tenantId: 'internal',
      siteId: 'default-site',
      kioskId: 'device-uuid',
    });
    getSecuritySettings.mockResolvedValue({ emergencyStop: true, pinRequired: false });

    expect(await (await call('kiosk-dev')).json()).toMatchObject({ active: false });
  });

  it('device 台帳に無い旧レジストリ端末は従来どおり kiosk レジストリで判定する', async () => {
    readKioskSession.mockResolvedValue({ kioskId: 'kiosk-dev' });
    resolveDeviceBinding.mockResolvedValue(null);
    getKioskConfig.mockResolvedValue({ kioskId: 'kiosk-dev', active: true });

    expect(await (await call('kiosk-dev')).json()).toMatchObject({ active: true });
  });

  it('身元不明（セッション無し・kioskId 無し）は active を fail-open で true にする', async () => {
    // 「失効」と「未エンロール」は別物。false に倒すと、未エンロール端末に「利用できません」を
    // 出してしまいエンロール導線へ進めない（#239）。受付フローは authorized=false で塞がれている。
    readKioskSession.mockResolvedValue(null);
    const res = await GET(new Request('http://localhost/api/kiosk/heartbeat'));

    expect(await res.json()).toMatchObject({ active: true, authorized: false });
    expect(getKioskConfig).not.toHaveBeenCalled();
  });

  it('身元不明でも緊急停止は効く', async () => {
    readKioskSession.mockResolvedValue(null);
    getSecuritySettings.mockResolvedValue({ emergencyStop: true, pinRequired: false });

    const res = await GET(new Request('http://localhost/api/kiosk/heartbeat'));
    expect(await res.json()).toMatchObject({ active: false });
  });

  it('セッションが無ければクエリの kioskId で従来どおり判定する（未エンロール端末の失効検知）', async () => {
    readKioskSession.mockResolvedValue(null);
    getKioskConfig.mockResolvedValue({ kioskId: 'kiosk-dev', active: true });

    expect(await (await call('kiosk-dev')).json()).toMatchObject({
      active: true,
      authorized: false,
    });
    expect(getKioskConfig).toHaveBeenCalledWith('kiosk-dev');
    // セッションが無い以上、死活も反映報告も記録しない（偽 online の注入経路を作らない）。
    expect(recordHeartbeat).not.toHaveBeenCalled();
  });

  it('kioskId を送らないクライアントでも、セッションが在れば記録される', async () => {
    readKioskSession.mockResolvedValue({ kioskId: 'device-uuid' });
    resolveDeviceBinding.mockResolvedValue({
      tenantId: 'internal',
      siteId: 'default-site',
      kioskId: 'device-uuid',
    });

    const res = await GET(
      new Request('http://localhost/api/kiosk/heartbeat?loadedRevision=3&loadedConfigHash=sha256:a'),
    );

    expect(await res.json()).toMatchObject({ authorized: true });
    expect(recordHeartbeat).toHaveBeenCalledWith('device-uuid');
    expect(recordDeploymentReport).toHaveBeenCalledWith(
      expect.objectContaining({ kioskId: 'device-uuid', loadedRevision: 3 }),
    );
  });
});
