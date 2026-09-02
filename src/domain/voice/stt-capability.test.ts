import { describe, expect, it } from 'vitest';
import { MockSttAdapter } from '@/adapters/speech/mock-stt';
import { defaultSttAdapterFactory } from '@/components/kiosk/stt-adapter';
import { DEFAULT_STT_CAPABILITY, isSttRecognitionSimulated } from './stt-capability';

/**
 * 「既定の音声認識は擬似である」という宣言を、**実体からずらせないようにする** (#872)。
 *
 * 宣言だけを手で持つと必ず腐る。#370 が実 provider を既定にしたとき、宣言を直し忘れれば
 * 管理画面は「擬似認識です」と嘘を言い続ける。逆に今の状態で宣言を `'real'` にすれば、
 * **来訪者へ mock を出しているのに管理画面は何も警告しない**という、この Issue の元の状態へ戻る。
 *
 * そこで宣言と既定ファクトリの実体を突き合わせる。どちらを触っても、もう一方を直すまで落ちる。
 */
describe('既定 STT の能力宣言 (#872)', () => {
  it('宣言が既定ファクトリの実体と一致する', () => {
    const usesMock = defaultSttAdapterFactory([]) instanceof MockSttAdapter;
    expect(
      DEFAULT_STT_CAPABILITY === 'mock',
      usesMock
        ? '既定ファクトリは MockSttAdapter を返すのに、宣言が mock になっていない。' +
            '管理画面が擬似認識であることを運用者へ伝えられなくなる。'
        : '既定ファクトリはもう MockSttAdapter を返さないのに、宣言が mock のまま。' +
            '実 provider が入ったのに「擬似認識です」と表示し続ける。',
    ).toBe(usesMock);
  });

  it('擬似かどうかの判定は宣言から導く（呼び出し側が instanceof を書かない）', () => {
    expect(isSttRecognitionSimulated()).toBe(DEFAULT_STT_CAPABILITY === 'mock');
  });

  /*
   * 下界: 「常に true」「常に false」な実装を落とす。上の 2 本は宣言と実体が同じ向きに
   * 壊れると両方通ってしまうので、能力値の取りうる範囲そのものを固定する。
   */
  it('能力宣言は mock / real のいずれか', () => {
    expect(['mock', 'real']).toContain(DEFAULT_STT_CAPABILITY);
  });
});
