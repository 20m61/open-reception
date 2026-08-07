import { describe, expect, it } from 'vitest';
import {
  buildCreateCallRequest,
  parseCreateCallResponse,
  type CreateCallParams,
} from './voice-initiator';

const BASE: CreateCallParams = {
  to: '+819012345678',
  from: '+815012345678',
  answerUrl: 'https://cf.example.com/api/providers/vonage/answer',
  eventUrl: 'https://cf.example.com/api/providers/vonage/events',
  timeoutSeconds: 30,
};

describe('buildCreateCallRequest (#4 Inc D)', () => {
  it('to / from を Vonage の phone エンドポイント形へ写す', () => {
    const body = buildCreateCallRequest(BASE);
    expect(body.to).toEqual([{ type: 'phone', number: '819012345678' }]);
    expect(body.from).toEqual({ type: 'phone', number: '815012345678' });
  });

  it('E.164 の先頭 + を落とす（Vonage は + を受け付けない）', () => {
    const body = buildCreateCallRequest({ ...BASE, to: '+81312345678' });
    expect(body.to[0]?.number).toBe('81312345678');
    expect(body.to[0]?.number.startsWith('+')).toBe(false);
  });

  it('answer_method / event_method を POST で明示する', () => {
    // 既定は GET で、GET だと本文が無く署名検証（payload_hash）が成立しない。
    const body = buildCreateCallRequest(BASE);
    expect(body.answer_method).toBe('POST');
    expect(body.event_method).toBe('POST');
  });

  it('answer_url / event_url を配列で渡す（Vonage の形）', () => {
    const body = buildCreateCallRequest(BASE);
    expect(body.answer_url).toEqual([BASE.answerUrl]);
    expect(body.event_url).toEqual([BASE.eventUrl]);
  });

  it('呼び出し timeout を ringing_timer に写す', () => {
    expect(buildCreateCallRequest({ ...BASE, timeoutSeconds: 45 }).ringing_timer).toBe(45);
  });

  it('来訪者情報を一切含めない（PII 境界）', () => {
    // 第 1 段の案内は NCCO 側で組み立てる。発信リクエストに PII を載せない。
    //
    // 🔴 **キーの許可リストで固定する。** `not.toMatch(/visitor|name|.../)` の否定条件だと、
    // 名指ししていない PII は素通りする。とくに案内文は日本語（`ncco: [{ text: '田中様が
    // お見えです' }]`）で入りうるので、英単語の否定では**一切止まらない**。
    // 項目を増やすときはここを更新し、その項目が PII でないことを明示的に判断すること。
    const body = buildCreateCallRequest(BASE);
    expect(Object.keys(body).sort()).toEqual([
      'answer_method',
      'answer_url',
      'event_method',
      'event_url',
      'from',
      'ringing_timer',
      'to',
    ]);
  });

  it('http(s) 以外の answer_url を拒否する', () => {
    expect(() => buildCreateCallRequest({ ...BASE, answerUrl: 'ftp://x/y' })).toThrow(
      /answerUrl/,
    );
  });

  it('E.164 でない番号を拒否する（誤った宛先へ発信しない）', () => {
    expect(() => buildCreateCallRequest({ ...BASE, to: '090-1234-5678' })).toThrow(/to/);
    expect(() => buildCreateCallRequest({ ...BASE, from: 'sip:x@y' })).toThrow(/from/);
  });

  it('timeout が非正なら拒否する', () => {
    expect(() => buildCreateCallRequest({ ...BASE, timeoutSeconds: 0 })).toThrow(/timeout/);
  });
});

describe('parseCreateCallResponse (#4 Inc D)', () => {
  it('uuid を providerCallId として取り出す', () => {
    const r = parseCreateCallResponse({ uuid: 'CALL-1', status: 'started' });
    expect(r).toEqual({ ok: true, providerCallId: 'CALL-1' });
  });

  it('uuid が無ければ失敗（相関を書けないまま発信済みになるのを防ぐ）', () => {
    expect(parseCreateCallResponse({ status: 'started' })).toEqual({
      ok: false,
      reason: 'missing_uuid',
    });
  });

  it('uuid が空文字なら失敗（空を ID として保存しない）', () => {
    expect(parseCreateCallResponse({ uuid: '' })).toEqual({ ok: false, reason: 'missing_uuid' });
  });

  it('JSON でない/オブジェクトでない応答を失敗として扱う', () => {
    expect(parseCreateCallResponse(null)).toEqual({ ok: false, reason: 'missing_uuid' });
    expect(parseCreateCallResponse('CALL-1')).toEqual({ ok: false, reason: 'missing_uuid' });
  });

  it('uuid が文字列でなければ失敗（数値 ID を暗黙変換しない）', () => {
    expect(parseCreateCallResponse({ uuid: 12345 })).toEqual({ ok: false, reason: 'missing_uuid' });
  });
});
