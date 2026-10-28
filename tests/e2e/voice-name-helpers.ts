import { expect, type Page } from '@playwright/test';

/**
 * 音声で氏名を聞き取る経路 (ADR 0011、#1290) を e2e で再現する準備。合成データだけを使う。
 *
 * - 読み上げ（`speechSynthesis`）は headless では終わりの通知が来ないので、読んだ文を
 *   `window.__spoken` へ記録して終わりを返す代役へ差し替える（`ttsFails` なら失敗を返す）。
 * - TTS の有効化は `/api/kiosk/voice` の応答だけを差し替える（端末の設定は書き換えない）。
 *   応答を差し替えられるよう、構成は旧経路（`?effectiveConfig=0`）で取る。
 * - 音声は `?voiceOrchestrator=1`（実 orchestrator を mock provider で駆動）と、合成の名乗り
 *   `?voiceVisitorName=` / 相手の発話 `?voiceTarget=` で再現する。
 */
export type VoiceNameKioskOptions = {
  visitorName?: string;
  target?: string;
  ttsFails?: boolean;
  unavailableStaffId?: string;
};

export async function openVoiceNameKiosk(page: Page, options: VoiceNameKioskOptions = {}): Promise<void> {
  await page.addInitScript((ttsFails: boolean) => {
    const spoken: string[] = [];
    (window as unknown as { __spoken: string[] }).__spoken = spoken;
    class Utterance {
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      rate = 1;
      volume = 1;
      lang = '';
      constructor(public text: string) {}
    }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance });
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speak(u: Utterance) {
          spoken.push(u.text);
          setTimeout(() => {
            if (ttsFails) return u.onerror?.();
            u.onstart?.();
            setTimeout(() => u.onend?.(), 50);
          }, 0);
        },
        cancel() {},
      },
    });
  }, options.ttsFails === true);

  await page.route('**/api/kiosk/voice', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, ttsEnabled: true } });
  });
  if (options.unavailableStaffId) {
    const id = options.unavailableStaffId;
    await page.route('**/api/kiosk/directory', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { staff: Array<{ id: string; available: boolean }> };
      await route.fulfill({
        response,
        json: { ...body, staff: body.staff.map((s) => (s.id === id ? { ...s, available: false } : s)) },
      });
    });
  }

  const params = new URLSearchParams({ voiceOrchestrator: '1', effectiveConfig: '0' });
  if (options.visitorName) params.set('voiceVisitorName', options.visitorName);
  if (options.target) params.set('voiceTarget', options.target);
  await page.goto(`/kiosk?${params.toString()}`);
  await expect(page.getByTestId('voice-layer')).toBeVisible();
}

export const spokenTexts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken);
