/**
 * 警告の文言が画面側にあり、語彙と 1 対 1 で揃っていること (#763)。
 *
 * 🔴 **サーバは語彙（列挙）だけを返し、文言は画面側が持つ。** 応答に自由文を載せると、
 * そこへ設定値や secret の断片が混ざりうる（`rules/pii-secret-minimization.md`）。
 * その代わり「語彙を足したのに文言が無い」が起きうるので、ここで縛る。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROVIDER_CONFIG_WARNINGS } from '@/domain/provider-config/readiness';

const source = readFileSync('src/components/admin/platform/ProviderConfig.tsx', 'utf8');

describe('プロバイダ設定の警告表示 (#763)', () => {
  it('🔴 すべての警告に文言がある（語彙だけ増えて無言にならない）', () => {
    for (const w of PROVIDER_CONFIG_WARNINGS) {
      expect(source, `${w} の文言が無い`).toContain(`${w}:`);
    }
  });

  /**
   * 🔴 **「取り次げない」ことを来訪者影響として書く。** 「secret が未設定です」だけだと
   * 運用者は「後で入れればよい」と読む ── #763 で問題にしたのは、有効にした瞬間から
   * 受付が全件 503 になるのに管理画面が何も言わないことだった。
   */
  it('🔴 secret 未設定の文言が受付への影響に触れている', () => {
    const line = source.split('\n').find((l) => l.includes('受付端末が担当者を呼び出せず'));
    expect(line, '来訪者への影響が書かれていない').toBeDefined();
  });

  it('🔴 警告を描画している（定義しただけにしない）', () => {
    expect(source).toMatch(/data\??\.warnings/);
    expect(source).toContain('provider-config-warning-');
  });
});
