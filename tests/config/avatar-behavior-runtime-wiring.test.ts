/**
 * AvatarBehavior runtime wiring の境界を静的に固定する (#1095)。
 *
 * React effect 自体を node unit で動かさなくても、PII を含みうる VoiceKioskState 全体を
 * AvatarGuide 側へ漏らさず `mode` だけを観測通知すること、AvatarGuide が voice store を
 * 直接購読せず pure mapper を使うことは配線として検証できる。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const VOICE_LAYER = 'src/components/kiosk/VoiceSessionLayer.tsx';
const AVATAR_GUIDE = 'src/components/kiosk/avatar/AvatarGuide.tsx';

function code(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const text = line.trim();
      return !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*');
    })
    .join('\n');
}

describe('AvatarBehavior runtime wiring (#1095)', () => {
  it('🔴 VoiceSessionLayer は mode だけを通知し、mode変更では inactive を挟まず unmount 時だけ戻す', () => {
    const layer = code(VOICE_LAYER);
    expect(layer).toContain('onModeChange?: (mode: VoiceKioskMode) => void;');
    expect(layer).toMatch(
      /useEffect\(\(\) => \{\s*onModeChange\?\.\(state\.mode\);\s*\}, \[state\.mode, onModeChange\]\);/,
    );
    expect(layer).toContain("useEffect(() => () => onModeChange?.('inactive'), [onModeChange]);");
    // `inactive` cleanup を state.mode effect に戻すと listening -> speaking の間にも一瞬 inactive が入る。
    expect(layer).not.toMatch(
      /onModeChange\?\.\(state\.mode\);\s*return \(\) => onModeChange\?\.\('inactive'\)/,
    );
    expect(layer).not.toContain('onModeChange?.(state);');
  });

  it('🔴 AvatarGuide は voice store を直接購読せず pure AvatarBehavior を導出する', () => {
    const guide = code(AVATAR_GUIDE);
    expect(guide).toContain("voiceMode = 'inactive'");
    expect(guide).toContain('deriveAvatarBehavior({ avatarState, voiceMode })');
    expect(guide).not.toContain('useVoiceSession(');
    expect(guide).not.toContain('VoiceKioskStore');
  });

  it('🔴 voice phase は AvatarState を書き換えず診断属性と lip-sync だけへ接続する', () => {
    const guide = code(AVATAR_GUIDE);
    expect(guide).toContain('data-avatar-state={avatarState}');
    expect(guide).toContain('data-avatar-voice-mode={voiceMode}');
    expect(guide).toContain('data-avatar-behavior-phase={behavior.phase}');
    expect(guide).toContain('const effectiveSpeaking = speaking || behavior.speaking;');
    expect(guide).toContain('speaking={effectiveSpeaking}');
    expect(guide).toContain('avatarState={avatarState}');
  });
});
