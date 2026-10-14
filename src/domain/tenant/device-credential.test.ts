import { describe, expect, it } from 'vitest';
import { credentialGenerationOf, generationAfterStatusChange } from './device-credential';

describe('端末証明の世代 (#1237)', () => {
  it('世代を持たない旧レコードは 0 として読む', () => {
    expect(credentialGenerationOf({})).toBe(0);
    expect(credentialGenerationOf({ credentialGeneration: 4 })).toBe(4);
  });

  it('🔴 失効（active → revoked）で世代が上がる', () => {
    expect(generationAfterStatusChange({ status: 'active', credentialGeneration: 2 }, 'revoked')).toBe(3);
    expect(generationAfterStatusChange({ status: 'active' }, 'revoked')).toBe(1);
  });

  it('🔴 再有効化（revoked → active）でも世代が上がる', () => {
    expect(generationAfterStatusChange({ status: 'revoked', credentialGeneration: 3 }, 'active')).toBe(4);
  });

  it('状態が変わらない切替では据え置く（未設定は未設定のまま）', () => {
    expect(generationAfterStatusChange({ status: 'active', credentialGeneration: 2 }, 'active')).toBe(2);
    expect(generationAfterStatusChange({ status: 'revoked' }, 'revoked')).toBeUndefined();
  });
});
