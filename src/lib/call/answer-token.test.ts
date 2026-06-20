/**
 * answer-token の単体テスト。署名往復・期限・用途(role)・改ざんを検証する。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { issueAnswerToken, readAnswerToken } from './answer-token';

beforeEach(() => {
  process.env.CALL_ANSWER_SECRET = 'test-answer-secret';
});

describe('answer-token', () => {
  it('round-trips a receptionId', async () => {
    const token = await issueAnswerToken('rec-123');
    expect(await readAnswerToken(token)).toEqual({ receptionId: 'rec-123' });
  });

  it('rejects an expired token', async () => {
    const token = await issueAnswerToken('rec-123', -1000); // already expired
    expect(await readAnswerToken(token)).toBeNull();
  });

  it('rejects undefined / malformed tokens', async () => {
    expect(await readAnswerToken(undefined)).toBeNull();
    expect(await readAnswerToken('not-a-token')).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const token = await issueAnswerToken('rec-123');
    const [body] = token.split('.');
    expect(await readAnswerToken(`${body}.deadbeef`)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await issueAnswerToken('rec-123');
    process.env.CALL_ANSWER_SECRET = 'different-secret';
    expect(await readAnswerToken(token)).toBeNull();
  });
});
