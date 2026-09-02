import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSttRecognitionSimulated } from '@/domain/voice/stt-capability';

/**
 * 擬似認識であることが `/admin/voice` に出ていることを機械で縛る (#872)。
 *
 * 運用者は「音声認識を有効にする」を本番テナントで入れられる。既定の STT はマイクを使わず
 * 在席担当者名を返す mock なので、**来訪者は聞き取られていないのに聞き取られたと信じる**。
 * ラベルは「結果は候補表示・確認必須」と安心させる方向にだけ書かれていた。
 *
 * 文言そのものを逐語で固定すると推敲のたびに落ちるので、**満たすべき条件**で縛る:
 * 擬似である間は (1) 注意書きが存在し (2) 擬似であることに言及し (3) マイクを使わない旨に
 * 言及する。実 provider が既定になれば、この検査は「出ていないこと」を要求する側へ反転する。
 */
const SOURCE = readFileSync(
  join(process.cwd(), 'src/components/admin/VoiceManager.tsx'),
  'utf8',
);

describe('音声認識が擬似であることの開示 (#872)', () => {
  it('擬似の間は、トグルの近くに擬似である旨の注意書きが出る', () => {
    if (!isSttRecognitionSimulated()) {
      // 実 provider が既定になったら、逆に注意書きが残っていないことを要求する。
      expect(SOURCE).not.toContain('voice-stt-simulated-notice');
      return;
    }
    expect(SOURCE, '注意書きの要素が無い').toContain('voice-stt-simulated-notice');
    expect(SOURCE, '「擬似」であることに触れていない').toContain('擬似認識');
    expect(SOURCE, 'マイクを使わないことに触れていない').toContain('マイクは使わず');
    // 表示条件が宣言に紐づいていること（べた書きで常時表示にしない）。
    expect(SOURCE, '表示条件が宣言に紐づいていない').toContain('isSttRecognitionSimulated()');
  });

  it('注意書きは STT トグルより後に置く（有効化の判断材料として読める位置）', () => {
    if (!isSttRecognitionSimulated()) return;
    const toggle = SOURCE.indexOf("data-testid=\"voice-stt\"");
    const notice = SOURCE.indexOf('voice-stt-simulated-notice');
    expect(toggle, 'STT トグルが見つからない').toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(toggle);
  });
});
