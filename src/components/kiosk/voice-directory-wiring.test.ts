/**
 * 受付端末の Directory が音声 orchestrator へ届く配線 (#788)。
 *
 * ## 何をここで縛り、何を縛らないか
 *
 * 写像そのものは `voice-directory.test.ts` が両側（上界＝不在を通さない／下界＝在席は必ず
 * 解決できる）から縛る。**配線が生きていること自体**は E2E
 * （`tests/e2e/kiosk-voice-orchestrator.spec.ts`「担当者を押さずに音声だけで相手が決まる」）が
 * 振る舞いで縛る ── 空辞書へ戻す変異・`useMemo` の依存から `directory` を落とす変異・
 * memo の結果を捨てる変異は、いずれも実測でその E2E が落とした。
 *
 * ここに残すのは **E2E が構造的に踏めない縮退**だけ。E2E の Directory は必ず担当者を含むので、
 * 「担当者が 0 人のときだけ音声レイヤごと消える」型の早期 return は素通りする（実測で生存）。
 * 端末が空の Directory を持つのは取得前・取得失敗・在席者ゼロで、まさに壊れていても
 * 気づけない局面なので、ソースに対して固定する。
 *
 * 🔴 振る舞いで縛れないのは環境の制約でもある。このリポジトリの vitest は node 環境で、
 * jsdom も testing-library も無いため React の効果を実行できない
 * （`checkin-call-wiring.test.ts` と同じ制約）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync('src/components/kiosk/KioskFlow.tsx', 'utf8');

/**
 * ローカル音声セッションを組み立てる `useMemo` の本体。
 *
 * 呼び出し式ではなく**ブロック**を取るので、`const entities = ...(directory);` のように
 * 中間変数へ切り出すリファクタでも落ちない（呼び出し 1 行を文字列一致で見ていた版は落ちた）。
 * ただし縛れるのは**引数名が `directory` のまま**の切り出しまで。`...(dirForVoice)` へ改名
 * すると落ちる ── ソース文字列に対する検査である以上、この程度の脆さは残る。
 */
function localVoiceMemoBody(): string {
  const marker = 'const localVoiceSession = useMemo(() => {';
  const start = SOURCE.indexOf(marker);
  expect(start, `${marker} が見つからない（改名したなら本テストも直すこと）`).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\n  }, [', start);
  expect(end, 'useMemo の依存配列が見つからない').toBeGreaterThan(start);
  return SOURCE.slice(start + marker.length, end);
}

/** その `useMemo` の依存配列の中身。 */
function localVoiceMemoDeps(): string {
  const from = SOURCE.indexOf('\n  }, [', SOURCE.indexOf('const localVoiceSession = useMemo(() => {'));
  const deps = SOURCE.slice(from).match(/^\n {2}\}, \[([\s\S]*?)\]\);/);
  expect(deps, 'useMemo の依存配列を読めない').not.toBeNull();
  return deps?.[1] ?? '';
}

/**
 * 受付局面の通知が controller へ届く配線 (#788 レビュー 2 周目)。
 *
 * 合成発話の起点は `notifyReceptionState('selectingTarget')` なので、`useVoiceSession` の
 * effect が `receptionState` を依存に持たなくなると**新しい起点が丸ごと死ぬ**
 * （demo-studio のゼロタッチ再生も同時に死ぬ）。依存を落とす変異は
 * `src/lib/voice-session/**` `src/components/kiosk/**` の 601 tests 全緑で生存した（実測）。
 * store 側の中継（`VoiceKioskStore.notifyReceptionState`）は unit で縛られているので、
 * 残るこの 1 行だけを構造で固定する。
 */
describe('受付局面が音声 controller へ中継される (#788)', () => {
  const HOOK = readFileSync('src/components/kiosk/useVoiceSession.ts', 'utf8');

  it('receptionState の変化で controller へ通知する', () => {
    const effect = HOOK.slice(HOOK.indexOf('store.notifyReceptionState(receptionState)'));
    const deps = effect.match(/\}, \[([^\]]*)\]\);/);
    expect(deps, 'notifyReceptionState の effect と依存配列が見つからない').not.toBeNull();
    expect(deps?.[1]).toMatch(/\breceptionState\b/);
  });
});

describe('KioskFlow が実 Directory を音声へ渡す (#788)', () => {
  it('EntityDirectory は端末が保持する directory から作る', () => {
    expect(SOURCE).toContain("from './voice-directory'");
    expect(localVoiceMemoBody()).toContain('kioskDirectoryToEntityDirectory(directory)');
    /*
     * 🔴 **不在辞書の配線も同じ扱いにする** (#803)。これを足すまで、`KioskFlow` から
     * 第 2 引数を消す変異は **206 tests 全緑のまま生き残った**（独立レビューの実測）。
     * 消えると来訪者は #803 以前の「聞き直しループ」へ静かに戻る。
     */
    expect(localVoiceMemoBody()).toContain('kioskDirectoryToUnavailableDirectory(directory)');
  });

  /**
   * 🔴 **空配列リテラルへ戻さない。** それが元の姿で、「配線は正しいが入力が空」なので
   * 読んでも気づけない。素通し（写像を経由しない）も同じく通さない ── 不在の担当者を
   * 音声だけが呼べるようになる（理由は `voice-directory.ts` の doc）。
   */
  it('空の EntityDirectory を渡さない', () => {
    const body = localVoiceMemoBody();
    expect(body).not.toMatch(/staff:\s*\[\s*\]/);
    expect(body).not.toMatch(/departments:\s*\[\s*\]/);
  });

  /**
   * Directory は取得が非同期で、初期値は空。依存に directory が無いと**空のまま固定される**
   * （実質、元の不具合へ戻る）。
   */
  it('directory の変化で音声セッションを組み直す', () => {
    expect(localVoiceMemoDeps()).toMatch(/\bdirectory\b/);
  });

  /**
   * 🔴 **担当者が 0 人でも音声レイヤは出す。** `if (directory.staff.length === 0) return undefined`
   * の類を足すと、在席者ゼロ・取得失敗の端末で音声レイヤごと消える。**E2E は踏めない**
   * （E2E の Directory は必ず担当者を含むため、この変異は実測で生存した）。
   * 早期 return はフラグ判定の 1 本だけに保つ。
   */
  it('フラグ以外の理由で音声セッションを undefined にしない', () => {
    // 個数だけ数える。文面（`if (!localVoiceEnabled) return undefined;`）の完全一致は、
    // prettier の折り返しや三項演算子への書き換えで**振る舞い不変のまま**落ちる。
    const returns = localVoiceMemoBody().match(/return undefined/g) ?? [];
    expect(returns).toHaveLength(1);
  });
});

/**
 * 不在告知が**実際に声へ出る**配線 (#803)。
 *
 * 🔴 **`aria-live` では代用できない。** スクリーンリーダの提示と端末の発話は別物で、
 * 前者だけを見て「読み上げている」と主張していた（独立レビューの指摘）。ここは
 * `VoiceSessionLayer` → `KioskFlow` → `speak()` が繋がっていることを固定する。
 * 効果（`useEffect`）は node 環境で回せないので、#788 と同じくソースで縛る。
 */
describe('不在告知の読み上げ配線 (#803)', () => {
  const LAYER = readFileSync('src/components/kiosk/VoiceSessionLayer.tsx', 'utf8');

  it('レイヤは告知を onAnnounce へ渡す', () => {
    expect(LAYER).toContain('announcementFor');
    expect(LAYER).toContain('onAnnounce?.(phrase)');
  });

  it('KioskFlow は onAnnounce を既存の speak() へ繋ぐ', () => {
    expect(SOURCE).toContain('onAnnounce={speakVoiceAnnouncement}');
    // 別経路を作らない（音量・言語設定が片方だけ効かない形にしない）。
    expect(SOURCE).toContain('speak(phrase, { ...speakSettings, language })');
  });
});

/**
 * 不在辞書が **local factory から bridge まで** 落ちずに届く配線 (#803)。
 *
 * 🔴 **振る舞いでは踏めない。** `createLocalVoiceSessionFactory` の合成発話は
 * `directory.staff[0]`（＝**在席側**）から選ばれるので、mock 駆動では不在照合に到達しない
 * （実 STT 待ち。#65）。よってこの 1 行の転送は**ソースで固定するしかない** ——
 * 独立レビューの実測で、消しても全緑のまま生き残ることを確認済み。
 */
describe('不在辞書の転送（local factory）(#803)', () => {
  const LOCAL = readFileSync('src/lib/voice-session/local-mode.ts', 'utf8');

  it('factory の第 2 引数を bridge deps へ渡している', () => {
    expect(LOCAL).toContain('unavailableDirectory?: EntityDirectory');
    expect(LOCAL).toContain('...(unavailableDirectory ? { unavailableDirectory } : {})');
  });

  /**
   * 合成発話は在席側から選ぶ（不在の相手を勝手に喋らせない）。ここが崩れると、
   * 端末が**選べない相手を自分から名乗り出す**ことになる。
   */
  it('合成発話は在席側の辞書から選ぶ', () => {
    expect(LOCAL).toContain('const spoken = directory.staff[0]?.displayName');
  });
});
