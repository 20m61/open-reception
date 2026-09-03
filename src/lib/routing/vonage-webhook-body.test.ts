/**
 * Vonage webhook 本文の読み取り (issue #4 / 2026-09-02 仕様照合)。
 *
 * ここが縛るのは「Vonage が送る形をどう読むか」1 点。route 側のテストは読めた値の
 * **使い方**を縛るので、ここでは形の境界（壊れた本文・未知の値・許可リスト）だけを見る。
 */
import { describe, expect, it } from 'vitest';
import { VONAGE_CALL_STATUSES } from '@/domain/call/voice-call-state';
import { acceptRegionUrl, parseVonageWebhookBody } from './vonage-webhook-body';

describe('parseVonageWebhookBody', () => {
  it('uuid / status / dtmf.digits / region_url を読む', () => {
    const body = parseVonageWebhookBody(
      JSON.stringify({
        uuid: 'TEST-uuid',
        status: 'ringing',
        dtmf: { digits: '2', timed_out: false },
        region_url: 'https://api-ap-3.vonage.com',
      }),
    );
    expect(body).toEqual({
      providerCallId: 'TEST-uuid',
      status: 'ringing',
      dtmfDigits: '2',
      regionUrl: 'https://api-ap-3.vonage.com',
    });
  });

  it.each(['not-json', '[]', 'null', '"str"', '42'])('本文 %s は何も読めない（投げない）', (raw) => {
    expect(parseVonageWebhookBody(raw)).toEqual({});
  });

  it('未知の status は読まない（無視して 204 を返させるため）', () => {
    expect(parseVonageWebhookBody(JSON.stringify({ status: 'TEST-unknown' })).status).toBeUndefined();
    expect(parseVonageWebhookBody(JSON.stringify({ status: 7 })).status).toBeUndefined();
  });

  it.each(VONAGE_CALL_STATUSES)('既知の status %s は読む（一覧は domain が正本）', (status) => {
    expect(parseVonageWebhookBody(JSON.stringify({ status })).status).toBe(status);
  });

  it('空の uuid は「無い」と同じ（空文字で相関を引かせない）', () => {
    expect(parseVonageWebhookBody(JSON.stringify({ uuid: '' })).providerCallId).toBeUndefined();
    expect(parseVonageWebhookBody(JSON.stringify({ uuid: 1 })).providerCallId).toBeUndefined();
  });

  it('dtmf が object でなければ digits は読まない', () => {
    expect(parseVonageWebhookBody(JSON.stringify({ dtmf: '1' })).dtmfDigits).toBeUndefined();
    expect(parseVonageWebhookBody(JSON.stringify({ dtmf: null })).dtmfDigits).toBeUndefined();
    // 空文字は「押されなかった」として**読む**（route が再案内へ倒す）。
    expect(parseVonageWebhookBody(JSON.stringify({ dtmf: { digits: '' } })).dtmfDigits).toBe('');
  });

  /**
   * 🔴 **電話番号を読まない。** 読める形にすると、いつかログへ載る。
   * 返す object のキーを許可リストで固定する。
   */
  it('to / from（電話番号）を返さない', () => {
    const body = parseVonageWebhookBody(
      JSON.stringify({
        uuid: 'u',
        to: '819012345678',
        from: '815012345678',
        conversation_uuid: 'c',
        status: 'answered',
      }),
    );
    expect(Object.keys(body).sort()).toEqual(['providerCallId', 'status']);
    expect(JSON.stringify(body)).not.toContain('819012345678');
  });
});

describe('acceptRegionUrl — 制御先の許可リスト', () => {
  it.each([
    'https://api-ap-3.vonage.com',
    'https://api-us.vonage.com',
    'https://api-eu.vonage.com',
    'https://api.nexmo.com',
  ])('%s は受け入れる', (url) => {
    expect(acceptRegionUrl(url)).toBe(url);
  });

  it('origin だけを返す（パス・クエリは落とす）', () => {
    expect(acceptRegionUrl('https://api-ap-3.vonage.com/v1/calls?x=1')).toBe(
      'https://api-ap-3.vonage.com',
    );
  });

  /**
   * 🔴 signature secret が漏れた世界では、ここが「JWT 付きリクエストを任意ホストへ
   * 向けさせる口」になる。https かつ Vonage のドメイン以外は捨てる。
   */
  it.each([
    'http://api-ap-3.vonage.com',
    'https://evil.example.com',
    'https://vonage.com.evil.example.com',
    'https://notvonage.com',
    'https://api.vonage.com.attacker.test/',
    'ftp://api.vonage.com',
    '',
    'not a url',
    42,
    null,
    undefined,
  ])('%p は捨てる', (value) => {
    expect(acceptRegionUrl(value)).toBeUndefined();
  });

  it('本文の region_url も同じ許可リストを通る', () => {
    expect(
      parseVonageWebhookBody(JSON.stringify({ region_url: 'https://evil.example.com' })).regionUrl,
    ).toBeUndefined();
  });
});
