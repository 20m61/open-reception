import { describe, expect, it } from 'vitest';
import {
  canConfirm,
  normalizedReason,
  validateConfirm,
  EMPTY_INPUT,
  type ConfirmInput,
  type ConfirmRequirement,
} from './confirm-flow';

function input(partial: Partial<ConfirmInput> = {}): ConfirmInput {
  return { ...EMPTY_INPUT, ...partial };
}

describe('validateConfirm (#91 危険操作確認フロー)', () => {
  it('要件なしなら空入力で実行可能', () => {
    const req: ConfirmRequirement = { requireImpactAck: false, requireReason: false };
    expect(validateConfirm(req, EMPTY_INPUT)).toEqual([]);
    expect(canConfirm(req, EMPTY_INPUT)).toBe(true);
  });

  it('影響範囲 ack 未チェックは不足', () => {
    const req: ConfirmRequirement = { requireImpactAck: true, requireReason: false };
    expect(validateConfirm(req, EMPTY_INPUT)).toContain('impact-not-acknowledged');
    expect(canConfirm(req, input({ impactAcknowledged: true }))).toBe(true);
  });

  it('理由必須: 空は reason-required, 短すぎは reason-too-short', () => {
    const req: ConfirmRequirement = { requireImpactAck: false, requireReason: true, minReasonLength: 4 };
    expect(validateConfirm(req, EMPTY_INPUT)).toEqual(['reason-required']);
    expect(validateConfirm(req, input({ reason: 'ab' }))).toEqual(['reason-too-short']);
    expect(validateConfirm(req, input({ reason: '  ab ' }))).toEqual(['reason-too-short']);
    expect(canConfirm(req, input({ reason: '停止する理由' }))).toBe(true);
  });

  it('確認文言: 不一致は phrase-mismatch, 前後空白は許容・大小は厳密', () => {
    const req: ConfirmRequirement = {
      requireImpactAck: false,
      requireReason: false,
      confirmationPhrase: 'DELETE',
    };
    expect(validateConfirm(req, input({ typedPhrase: 'delete' }))).toEqual(['phrase-mismatch']);
    expect(validateConfirm(req, input({ typedPhrase: '  DELETE ' }))).toEqual([]);
    expect(canConfirm(req, input({ typedPhrase: 'DELETE' }))).toBe(true);
  });

  it('複合要件: すべて満たすまで実行不可', () => {
    const req: ConfirmRequirement = {
      requireImpactAck: true,
      requireReason: true,
      confirmationPhrase: 'tenant-a',
    };
    expect(canConfirm(req, EMPTY_INPUT)).toBe(false);
    const full = input({
      impactAcknowledged: true,
      reason: '誤登録のため停止',
      typedPhrase: 'tenant-a',
    });
    expect(validateConfirm(req, full)).toEqual([]);
    expect(canConfirm(req, full)).toBe(true);
  });
});

describe('normalizedReason', () => {
  it('理由必須・充足なら trim 済みを返す', () => {
    const req: ConfirmRequirement = { requireImpactAck: false, requireReason: true };
    expect(normalizedReason(req, input({ reason: '  停止理由  ' }))).toBe('停止理由');
  });

  it('理由必須・未充足なら null', () => {
    const req: ConfirmRequirement = { requireImpactAck: false, requireReason: true, minReasonLength: 4 };
    expect(normalizedReason(req, input({ reason: 'ab' }))).toBeNull();
  });

  it('理由不要なら入力があれば返し、空なら null', () => {
    const req: ConfirmRequirement = { requireImpactAck: false, requireReason: false };
    expect(normalizedReason(req, input({ reason: 'メモ' }))).toBe('メモ');
    expect(normalizedReason(req, EMPTY_INPUT)).toBeNull();
  });
});
