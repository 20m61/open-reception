import { describe, expect, it } from 'vitest';
import {
  endpointAddress,
  endpointRef,
  validateEndpoint,
  type ContactEndpoint,
} from './endpoint';

const validPstn = {
  id: 'ep-1',
  ownerType: 'staff',
  ownerId: 'staff-1',
  channel: 'pstn',
  e164: '+819012345678',
  providerKey: 'vonage',
  enabled: true,
  label: '山田の個人携帯',
};

const validSip = {
  id: 'ep-2',
  ownerType: 'organization',
  ownerId: 'org-1',
  channel: 'sip',
  uri: 'sip:reception@example.com',
  providerKey: 'vonage',
  enabled: true,
};

describe('validateEndpoint (#374)', () => {
  it('pstn を正規化して e164 を保持する', () => {
    const r = validateEndpoint({ ...validPstn, id: '  ep-1 ', e164: ' +819012345678 ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        id: 'ep-1',
        ownerType: 'staff',
        ownerId: 'staff-1',
        channel: 'pstn',
        e164: '+819012345678',
        providerKey: 'vonage',
        enabled: true,
        label: '山田の個人携帯',
      });
    }
  });

  it('sip を正規化して uri を保持する', () => {
    const r = validateEndpoint(validSip);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.channel).toBe('sip');
      if (r.value.channel === 'sip') expect(r.value.uri).toBe('sip:reception@example.com');
      expect(r.value.label).toBeUndefined();
    }
  });

  it('pstn なのに e164 が E.164 形式でなければ拒否する', () => {
    const r = validateEndpoint({ ...validPstn, e164: '090-1234-5678' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_endpoint');
  });

  it('先頭 + が無い番号を拒否する', () => {
    expect(validateEndpoint({ ...validPstn, e164: '819012345678' }).ok).toBe(false);
  });

  it('sip なのに uri がスキーム無しなら拒否する', () => {
    expect(validateEndpoint({ ...validSip, uri: 'reception@example.com' }).ok).toBe(false);
  });

  it('未知の channel を拒否する', () => {
    expect(validateEndpoint({ ...validPstn, channel: 'fax' }).ok).toBe(false);
  });

  it('未知の ownerType を拒否する', () => {
    expect(validateEndpoint({ ...validPstn, ownerType: 'guest' }).ok).toBe(false);
  });

  it('providerKey 空を拒否する', () => {
    expect(validateEndpoint({ ...validPstn, providerKey: '  ' }).ok).toBe(false);
  });

  it('enabled が boolean でなければ拒否する', () => {
    expect(validateEndpoint({ ...validPstn, enabled: 'true' }).ok).toBe(false);
  });

  it('label が長すぎると拒否する（入力サイズ上限 / 第5wave nit）', () => {
    const longLabel = 'ラベル'.repeat(200);
    expect(validateEndpoint({ ...validPstn, label: longLabel }).ok).toBe(false);
  });

  it('エラーメッセージにアドレス値を含めない（PII 最小化）', () => {
    const r = validateEndpoint({ ...validPstn, e164: '09012345678' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message.includes('09012345678')).toBe(false);
  });
});

describe('endpointRef / endpointAddress (#374)', () => {
  const pstn: ContactEndpoint = {
    id: 'ep-1',
    ownerType: 'staff',
    ownerId: 'staff-1',
    channel: 'pstn',
    e164: '+819012345678',
    providerKey: 'vonage',
    enabled: true,
  };

  it('endpointRef はアドレス（e164/uri）を構造的に含めない', () => {
    const ref = endpointRef(pstn);
    expect(ref).toEqual({
      id: 'ep-1',
      ownerType: 'staff',
      channel: 'pstn',
      providerKey: 'vonage',
    });
    expect(JSON.stringify(ref).includes('+819012345678')).toBe(false);
  });

  it('endpointAddress は channel に応じたアドレスを返す', () => {
    expect(endpointAddress(pstn)).toBe('+819012345678');
    expect(
      endpointAddress({
        id: 'ep-2',
        ownerType: 'organization',
        ownerId: 'org-1',
        channel: 'sip',
        uri: 'sip:r@example.com',
        providerKey: 'vonage',
        enabled: true,
      }),
    ).toBe('sip:r@example.com');
  });
});
