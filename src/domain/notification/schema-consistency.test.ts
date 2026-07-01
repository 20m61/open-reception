/**
 * notification schema の単一定義担保テスト (issue #275)。
 *
 * app 側（src/lib/notification）と worker 側（src/server/notification）が、
 * それぞれ src/domain/notification の同一 schema/検証関数を参照していることを
 * **参照同一性（===）** で固定する。どちらかが独自定義へ戻る（ドリフトする）と
 * このテストが落ちる。
 */
import { describe, expect, it } from 'vitest';

// --- domain（単一の定義元） ---
import {
  NOTIFICATION_CHANNELS as domainChannels,
  isNotificationChannelKind as domainIsChannel,
  asCallRouteId as domainAsCallRouteId,
  type CallRoute as DomainCallRoute,
} from '@/domain/notification/call-route';
import {
  validateGroup as domainValidateGroup,
  validateGroups as domainValidateGroups,
  validateRouteName as domainValidateRouteName,
  validateTarget as domainValidateTarget,
} from '@/domain/notification/call-route-validation';
import type { NotificationRequest as DomainNotificationRequest } from '@/domain/notification/notify';
import {
  MAX_MESSAGE_LENGTH as domainMaxMessageLength,
  validateNotificationRequest as domainValidateNotificationRequest,
} from '@/domain/notification/notify-validation';

// --- app 側（lib/notification 経由の再輸出） ---
import {
  NOTIFICATION_CHANNELS as libChannels,
  isNotificationChannelKind as libIsChannel,
  asCallRouteId as libAsCallRouteId,
  type CallRoute as LibCallRoute,
} from '@/lib/notification/types';
import {
  validateGroup as libValidateGroup,
  validateGroups as libValidateGroups,
  validateRouteName as libValidateRouteName,
  validateTarget as libValidateTarget,
} from '@/lib/notification/validation';

// --- worker 側（server/notification 経由の再輸出） ---
import type { NotificationRequest as ServerNotificationRequest } from '@/server/notification/types';
import {
  MAX_MESSAGE_LENGTH as serverMaxMessageLength,
  validateNotificationRequest as serverValidateNotificationRequest,
} from '@/server/notification/validation';

describe('notification schema の定義箇所は domain/notification の 1 箇所 (#275)', () => {
  it('app 側の call-route 検証関数は domain と同一参照である', () => {
    expect(libValidateRouteName).toBe(domainValidateRouteName);
    expect(libValidateTarget).toBe(domainValidateTarget);
    expect(libValidateGroup).toBe(domainValidateGroup);
    expect(libValidateGroups).toBe(domainValidateGroups);
    expect(libChannels).toBe(domainChannels);
    expect(libIsChannel).toBe(domainIsChannel);
    expect(libAsCallRouteId).toBe(domainAsCallRouteId);
  });

  it('worker 側の /notify 検証関数・上限値は domain と同一参照である', () => {
    expect(serverValidateNotificationRequest).toBe(domainValidateNotificationRequest);
    expect(serverMaxMessageLength).toBe(domainMaxMessageLength);
  });

  it('同一 payload は app/worker どちらの import 経路でも同じ検証結果になる', () => {
    const payload = {
      siteId: 'site-001',
      requestId: 'req-001',
      kind: 'call',
      message: '受付にお客様がお見えです',
      target: { type: 'phone', value: '+819000000000' },
    };
    expect(serverValidateNotificationRequest(payload)).toEqual(
      domainValidateNotificationRequest(payload),
    );
    const invalid = { ...payload, siteId: 'a/../b' };
    expect(serverValidateNotificationRequest(invalid)).toEqual(
      domainValidateNotificationRequest(invalid),
    );
  });

  it('型が相互代入可能である（コンパイル時検証）', () => {
    // 片側だけ型が変わると以下の代入が型エラーになり typecheck で検出される。
    const req: DomainNotificationRequest = {
      siteId: 's',
      requestId: 'r',
      kind: 'call',
      message: 'm',
    };
    const asServer: ServerNotificationRequest = req;
    const backToDomain: DomainNotificationRequest = asServer;
    expect(backToDomain).toBe(req);

    const route: DomainCallRoute = {
      id: domainAsCallRouteId('route-1'),
      tenantId: 'tenant-1' as DomainCallRoute['tenantId'],
      siteId: 'site-1' as DomainCallRoute['siteId'],
      name: 'r',
      groups: [],
      enabled: true,
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    };
    const asLib: LibCallRoute = route;
    const backToDomainRoute: DomainCallRoute = asLib;
    expect(backToDomainRoute).toBe(route);
  });
});
