import { describe, expect, it } from 'vitest';
import { appConfig } from './app-config';

describe('appConfig', () => {
  it('受付端末と管理画面の入口を分離している', () => {
    expect(appConfig.kioskBasePath).toBe('/kiosk');
    expect(appConfig.adminBasePath).toBe('/admin');
    expect(appConfig.kioskBasePath).not.toBe(appConfig.adminBasePath);
  });

  it('アプリ名を保持している', () => {
    expect(appConfig.name).toBe('open-reception');
  });
});
