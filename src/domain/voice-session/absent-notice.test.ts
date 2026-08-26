/**
 * 不在の担当者を名指しされたときの応答 (#803)。
 *
 * ## 何が問題だったか
 *
 * 相手選択画面は**不在の担当者もカードとして出す**が押させない（「本日不在」バッジ）。
 * 一方で音声側は、#788 で在席者だけを解決対象にしたため**候補ゼロ → 聞き直し**になる。
 * 来訪者には「聞き取れなかった」に見えるので、**同じ名前を言い直し続けうる**。
 *
 * **同じ事実に対して、タッチは理由を言い、音声は言わない。** これを揃える。
 *
 * ## 選ばせはしない
 *
 * 音声とタッチの等価性は *タッチで押せるものが音声でも選べる* ことであって、
 * *音声の方が多く選べる* ことではない。不在の相手は**認識するが選択させない**。
 *
 * ## 低信頼のときに「不在です」と断定しない
 *
 * 聞き違えた名前に対して「◯◯は本日不在です」と言うのは、**新しい嘘**である。
 * 断定するのは高信頼のときだけで、低信頼なら既存の復唱（「◯◯様ですね？」）を挟む。
 */
import { describe, expect, it } from 'vitest';
import { bridgeCommittedTurn } from './kiosk-bridge';
import {
  kioskDirectoryToEntityDirectory,
  kioskDirectoryToUnavailableDirectory,
} from '@/components/kiosk/voice-directory';
import {
  voiceKioskReducer,
  captionKeyFor,
  announcementFor,
  type VoiceKioskState,
  type VoiceKioskEvent,
} from './kiosk-view';
import { VOICE_MODE_TO_EXPERIENCE } from '@/domain/experience/journey-map';
import { VoiceKioskStore } from '@/lib/voice-session/kiosk-store';
import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';

const PRESENT: EntityDirectory = {
  staff: [
    {
      id: 'in',
      displayName: '在席太郎',
      kana: 'ざいせきたろう',
      aliases: [],
      departmentId: 'd1',
      enabled: true,
      available: true,
      callTargets: [],
      fallbackStaffIds: [],
    },
  ],
  departments: [{ id: 'd1', name: '営業部', displayOrder: 0, enabled: true }],
};

const ABSENT: EntityDirectory = {
  staff: [
    {
      id: 'out',
      displayName: '不在花子',
      kana: 'ふざいはなこ',
      aliases: [],
      departmentId: 'd1',
      enabled: true,
      available: true,
      callTargets: [],
      fallbackStaffIds: [],
    },
  ],
  departments: [],
};

function turn(text: string, sttConfidence: number) {
  return bridgeCommittedTurn({
    text,
    directory: PRESENT,
    unavailableDirectory: ABSENT,
    sttConfidence,
    t: 0,
  });
}

describe('不在の担当者を名指しされたとき (#803)', () => {
  it('高信頼なら不在を告げる（聞き直しへ潰さない）', () => {
    const { event, resolved } = turn('不在花子', 0.95);
    expect(event).toEqual({ type: 'heardUnavailable', displayName: '不在花子' });
    // 🔴 **選択へ渡さない。** タッチが押させない相手を音声が呼べてはいけない。
    expect(resolved).toBeNull();
  });

  it('低信頼なら断定せず復唱を挟む（聞き違えた名前に「不在です」と言わない）', () => {
    const { event, resolved } = turn('不在花子', 0.4);
    expect(event).toMatchObject({
      type: 'heardNeedsConfirmation',
      displayName: '不在花子',
      unavailable: true,
    });
    expect(resolved).toBeNull();
  });

  it('在席の相手は従来どおり選択へ渡す（不在判定に巻き込まれない）', () => {
    const { event, resolved } = turn('在席太郎', 0.95);
    expect(event).toEqual({ type: 'heardAccepted' });
    expect(resolved?.id).toBe('in');
  });

  it('どちらにも当たらなければ従来どおり聞き直し', () => {
    const { event, resolved } = turn('まったく違う名前', 0.95);
    expect(event).toEqual({ type: 'listenStart' });
    expect(resolved).toBeNull();
  });

  /** 🔴 **不在辞書を渡さない既存の呼び出し元を壊さない**（#788 の配線は任意引数のまま）。 */
  it('不在辞書が無ければ従来どおり聞き直しになる', () => {
    const { event } = bridgeCommittedTurn({
      text: '不在花子',
      directory: PRESENT,
      sttConfidence: 0.95,
      t: 0,
    });
    expect(event).toEqual({ type: 'listenStart' });
  });
});

/**
 * UI 状態機械側 (#803)。**「はい」と答えたのに何も起きない**画面を作らないことが主眼。
 */
describe('不在告知の UI 状態 (#803)', () => {
  const start: VoiceKioskState = { mode: 'listening' };

  it('高信頼の不在告知は unavailable へ入り、名前を表示に持つ', () => {
    const next = voiceKioskReducer(start, { type: 'heardUnavailable', displayName: '不在花子' });
    expect(next.mode).toBe('unavailable');
    expect(next.readbackName).toBe('不在花子');
    expect(captionKeyFor(next)).toBe('voice.unavailable.staffAbsent');
  });

  it('不在の相手の復唱に「はい」でも選択へ進まず、不在を伝える', () => {
    const readback = voiceKioskReducer(start, {
      type: 'heardNeedsConfirmation',
      displayName: '不在花子',
      reason: 'low_stt_confidence',
      kind: 'staff',
      unavailable: true,
    });
    expect(readback.mode).toBe('readback');

    const confirmed = voiceKioskReducer(readback, { type: 'confirmYes' });
    // 🔴 **idle へ落とさない。** 落とすと来訪者は「はい」と答えたのに無反応の画面に残される。
    expect(confirmed.mode).toBe('unavailable');
    expect(confirmed.readbackName).toBe('不在花子');
  });

  it('在席の相手の復唱に「はい」は従来どおり待機へ（不在経路に巻き込まれない）', () => {
    const readback = voiceKioskReducer(start, {
      type: 'heardNeedsConfirmation',
      displayName: '在席太郎',
      reason: 'low_stt_confidence',
      kind: 'staff',
    });
    expect(voiceKioskReducer(readback, { type: 'confirmYes' }).mode).toBe('idle');
  });

  it('不在告知からは聞き直しへ戻れる（行き止まりにしない）', () => {
    const notice = voiceKioskReducer(start, { type: 'heardUnavailable', displayName: '不在花子' });
    expect(voiceKioskReducer(notice, { type: 'listenStart' }).mode).toBe('listening');
  });

  /** 体験状態の網羅は `journey-map` が型で要求するが、写し先の意味は実行時に縛る。 */
  it('体験状態としては「その人には繋がらない」に写る', () => {
    expect(VOICE_MODE_TO_EXPERIENCE.unavailable).toBe('person_unavailable');
  });
});

/**
 * 端末 Directory → 不在辞書の写像 (#803)。
 *
 * 🔴 **振る舞いで縛る。** 「部署を入れない」を doc に書くだけでは、次の人が入れても緑のまま
 * （実測でこの変異は生き残った）。部署名を発話したときに何が起きるかまで見る。
 */
describe('不在辞書の作り方 (#803)', () => {
  const DIRECTORY = {
    departments: [{ id: 'd1', name: '営業部' }],
    staff: [
      {
        id: 'in',
        displayName: '在席太郎',
        kana: 'ざいせきたろう',
        aliases: [],
        departmentId: 'd1',
        available: true,
      },
      {
        id: 'out',
        displayName: '不在花子',
        kana: 'ふざいはなこ',
        aliases: [],
        departmentId: 'd1',
        available: false,
      },
    ],
  };

  it('不在の担当者だけを載せ、在席者は載せない', () => {
    const absent = kioskDirectoryToUnavailableDirectory(DIRECTORY);
    expect(absent.staff.map((s) => s.id)).toEqual(['out']);
  });

  /**
   * 部署名の発話が「営業部は現在不在です」にならないこと。
   *
   * 🔴 **この不変条件を守っているのは在席側である。** 不在辞書から部署を外す変異は
   * **生き残る**（実測）—— `kioskDirectoryToEntityDirectory` が部署を全件載せるので、
   * 部署名は必ず在席側で解決され、不在照合へ到達しないため。守っているものを取り違えない
   * ために書いておく。このテストが落ちるとしたら、**在席側に部署フィルタが入ったとき**である。
   */
  it('部署名を発話しても「不在です」と言わない', () => {
    const { event } = bridgeCommittedTurn({
      text: '営業部',
      directory: kioskDirectoryToEntityDirectory(DIRECTORY),
      unavailableDirectory: kioskDirectoryToUnavailableDirectory(DIRECTORY),
      sttConfidence: 0.95,
      t: 0,
    });
    expect(event.type).not.toBe('heardUnavailable');
  });

  it('在席者は従来どおり選択対象に残る', () => {
    expect(kioskDirectoryToEntityDirectory(DIRECTORY).staff.map((s) => s.id)).toEqual(['in']);
  });
});

/**
 * 告知が居座らないこと (#803)。
 *
 * 🔴 **手段の無い終端状態を作らない。** `unavailable` は「はい/いいえ」を描かないので、
 * 来訪者側に字幕を消す手段が無い。reducer 上は `listenStart` で抜けられるが、
 * **それを発火する主体が居ない**と、「◯◯は現在不在です」が用件入力・確認・呼び出し中、
 * 場合によっては次の来訪者の待機画面まで残る（独立レビューで実測指摘）。
 *
 * そこで「**受付がその画面から先へ進んだら告知は消える**」を不変条件として縛る。
 */
describe('不在告知は受付の進行で消える (#803)', () => {
  function storeAt(mode: 'unavailable' | 'readback') {
    let emit: (event: VoiceKioskEvent) => void = () => {};
    const store = new VoiceKioskStore((e) => {
      emit = e;
      return {
        start: async () => {},
        close: async () => {},
        confirmYes: () => {},
        confirmNo: () => {},
      };
    });
    store.start();
    emit(
      mode === 'unavailable'
        ? { type: 'heardUnavailable', displayName: '不在花子' }
        : {
            type: 'heardNeedsConfirmation',
            displayName: '在席太郎',
            reason: 'low_stt_confidence',
            kind: 'staff',
          },
    );
    return store;
  }

  it.each(['inputVisitorInfo', 'confirming', 'calling', 'completed', 'idle'] as const)(
    '%s へ進んだら告知は消える',
    (state) => {
      const store = storeAt('unavailable');
      expect(store.getState().mode).toBe('unavailable');
      store.notifyReceptionState(state);
      /*
       * 🔴 **落とし先まで縛る。** `not.toBe('unavailable')` は上界だけで、`listening` へ
       * 落としても満たせる。それだと「お話しください」＋パルスが受付完了まで残り、
       * 何も届かないので嘘の応答になる（独立レビューの実測指摘）。何も描かない `idle` へ。
       */
      expect(store.getState().mode).toBe('idle');
    },
  );

  it('相手選択に留まっている間は消えない（読む時間を奪わない）', () => {
    const store = storeAt('unavailable');
    store.notifyReceptionState('selectingTarget');
    expect(store.getState().mode).toBe('unavailable');
  });

  /**
   * 🔴 **下界を縛る。** 「進んだら消す」を「常に消す」で満たさない。復唱中に画面が進んでも
   * 復唱を消してよいわけではない（そちらには消す手段があり、確定待ちの意味がある）。
   */
  it('復唱中は受付が進んでも勝手に消さない', () => {
    const store = storeAt('readback');
    store.notifyReceptionState('inputVisitorInfo');
    expect(store.getState().mode).toBe('readback');
  });
});

/**
 * 読み上げ (#803 AC「音声で『不在』を伝え」「表示と読み上げが一致する」)。
 *
 * 🔴 **`aria-live` は読み上げではない。** スクリーンリーダの提示であって、端末が声に出す
 * こととは別物。前者だけを見て「読み上げている」と主張しないために、ここで分けて縛る
 * （独立レビューの指摘。テスト名が測っているものを超えて主張していた）。
 */
describe('不在告知を声に出す (#803)', () => {
  it('不在告知の局面では、字幕と同じ文言を読み上げ対象として返す', () => {
    const announcement = announcementFor({ mode: 'unavailable', readbackName: '佐藤' });
    expect(announcement).toEqual({ key: 'voice.unavailable.staffAbsent', name: '佐藤' });
    // 表示と読み上げが**同じキー**であることまで縛る（別文言に分岐させない）。
    expect(announcement?.key).toBe(captionKeyFor({ mode: 'unavailable' }));
  });

  /**
   * 🔴 **下界。** 「常に何か返す」実装で上を満たさせない。状態表示の字幕を読み上げると
   * 来訪者の発話にかぶる。
   */
  it.each(['listening', 'speaking', 'ducked', 'readback', 'fallback', 'idle', 'inactive'] as const)(
    '%s では読み上げない',
    (mode) => {
      expect(announcementFor({ mode, readbackName: '佐藤' })).toBeNull();
    },
  );
});
