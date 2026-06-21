import { describe, expect, it } from 'vitest';
import {
  STAFF_RESPONSE_ACTIONS,
  buildStaffResponseResult,
  getStaffResponseDefinition,
  isStaffResponseAction,
  isStaffResponseEnabled,
  kioskStatusFor,
  listStaffResponseDefinitions,
  requiresConfirmation,
  resolveStaffResponseDefinition,
  resolveStaffResponseDefinitions,
  resolvedVisitorMessageFor,
  visitorMessageFor,
} from './staff-response';

describe('staff-response domain', () => {
  it('全応答種別に来訪者向けメッセージと待機状態が定義されている', () => {
    for (const action of STAFF_RESPONSE_ACTIONS) {
      const def = getStaffResponseDefinition(action);
      expect(def.action).toBe(action);
      expect(def.defaultVisitorMessage.length).toBeGreaterThan(0);
      expect(def.staffLabel.length).toBeGreaterThan(0);
    }
  });

  it('応答種別 → 来訪者向け待機状態を写像する', () => {
    expect(kioskStatusFor('coming')).toBe('acknowledged');
    expect(kioskStatusFor('wait')).toBe('waiting');
    expect(kioskStatusFor('reroute')).toBe('rerouted');
    expect(kioskStatusFor('decline')).toBe('declined');
    expect(kioskStatusFor('reception_phone')).toBe('redirected_phone');
  });

  it('拒否・別チャネル誘導は誤タップ防止の確認を要求する', () => {
    expect(requiresConfirmation('decline')).toBe(true);
    expect(requiresConfirmation('reception_phone')).toBe(true);
    // 前向きな応答は確認不要（素早く返答できる）。
    expect(requiresConfirmation('coming')).toBe(false);
    expect(requiresConfirmation('wait')).toBe(false);
    expect(requiresConfirmation('reroute')).toBe(false);
  });

  it('拒否・別チャネル誘導は代替導線を提示する', () => {
    expect(getStaffResponseDefinition('decline').offersFallback).toBe(true);
    expect(getStaffResponseDefinition('reception_phone').offersFallback).toBe(true);
    expect(getStaffResponseDefinition('coming').offersFallback).toBe(false);
  });

  it('文言の上書きがあればそれを使い、空白なら既定文言を使う', () => {
    expect(visitorMessageFor('coming', 'すぐ向かいます')).toBe('すぐ向かいます');
    expect(visitorMessageFor('coming', '   ')).toBe(getStaffResponseDefinition('coming').defaultVisitorMessage);
    expect(visitorMessageFor('coming')).toBe(getStaffResponseDefinition('coming').defaultVisitorMessage);
  });

  it('isStaffResponseAction は既知の種別のみ受け付ける', () => {
    expect(isStaffResponseAction('coming')).toBe(true);
    expect(isStaffResponseAction('unknown')).toBe(false);
    expect(isStaffResponseAction(123)).toBe(false);
    expect(isStaffResponseAction(undefined)).toBe(false);
  });

  it('buildStaffResponseResult は PII を含まない来訪者向け結果を組み立てる', () => {
    const result = buildStaffResponseResult('decline', '2026-06-20T00:00:00.000Z');
    expect(result).toEqual({
      action: 'decline',
      kioskStatus: 'declined',
      visitorMessage: getStaffResponseDefinition('decline').defaultVisitorMessage,
      severity: 'danger',
      offersFallback: true,
      respondedAt: '2026-06-20T00:00:00.000Z',
    });
  });

  it('管理画面向けに有効な定義一覧を表示順で返す', () => {
    const list = listStaffResponseDefinitions();
    expect(list.map((d) => d.action)).toEqual([...STAFF_RESPONSE_ACTIONS]);
    // 全種別が将来の管理画面で有効/無効・文言を切り替えられるよう defaultEnabled を持つ。
    for (const def of list) {
      expect(typeof def.defaultEnabled).toBe('boolean');
    }
  });
});

describe('staff-response config resolution (issue #99 inc2)', () => {
  it('isStaffResponseEnabled は設定がなければ defaultEnabled を返す', () => {
    expect(isStaffResponseEnabled('coming')).toBe(getStaffResponseDefinition('coming').defaultEnabled);
    expect(isStaffResponseEnabled('coming', {})).toBe(true);
  });

  it('isStaffResponseEnabled は設定の enabled を優先する', () => {
    expect(isStaffResponseEnabled('coming', { coming: { enabled: false } })).toBe(false);
    // 指定のない種別は既定にフォールバックする。
    expect(isStaffResponseEnabled('wait', { coming: { enabled: false } })).toBe(true);
  });

  it('resolvedVisitorMessageFor は上書きがあればそれを、空白/未指定なら既定を返す', () => {
    expect(resolvedVisitorMessageFor('coming', { coming: { messageOverride: 'すぐ参ります' } })).toBe(
      'すぐ参ります',
    );
    expect(resolvedVisitorMessageFor('coming', { coming: { messageOverride: '  ' } })).toBe(
      getStaffResponseDefinition('coming').defaultVisitorMessage,
    );
    expect(resolvedVisitorMessageFor('coming')).toBe(
      getStaffResponseDefinition('coming').defaultVisitorMessage,
    );
  });

  it('resolveStaffResponseDefinition は実効的な enabled / visitorMessage / 上書きフラグを返す', () => {
    const overridden = resolveStaffResponseDefinition('decline', {
      enabled: false,
      messageOverride: '本日は受付を終了しました',
    });
    expect(overridden.enabled).toBe(false);
    expect(overridden.visitorMessage).toBe('本日は受付を終了しました');
    expect(overridden.isMessageOverridden).toBe(true);

    const def = resolveStaffResponseDefinition('coming');
    expect(def.enabled).toBe(getStaffResponseDefinition('coming').defaultEnabled);
    expect(def.visitorMessage).toBe(getStaffResponseDefinition('coming').defaultVisitorMessage);
    expect(def.isMessageOverridden).toBe(false);
  });

  it('resolveStaffResponseDefinitions は全種別を表示順で実効化する', () => {
    const list = resolveStaffResponseDefinitions({ coming: { enabled: false } });
    expect(list.map((d) => d.action)).toEqual([...STAFF_RESPONSE_ACTIONS]);
    expect(list.find((d) => d.action === 'coming')?.enabled).toBe(false);
    expect(list.find((d) => d.action === 'wait')?.enabled).toBe(true);
  });
});
