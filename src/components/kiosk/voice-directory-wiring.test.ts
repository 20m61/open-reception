/**
 * 受付端末の Directory が音声 orchestrator へ届く配線 (#788)。
 *
 * ## なぜ構造で縛るのか
 *
 * 写像そのものは `voice-directory.test.ts` が両側（上界＝不在を通さない／下界＝在席は必ず
 * 解決できる）から縛っている。残るのは「**`KioskFlow` がそれを通るか**」で、まさにそこが
 * 壊れていた ── 空配列リテラルを渡していたので、配線を読むとタッチと等価に見えるのに
 * 音声では誰も選べなかった。
 *
 * 🔴 **振る舞いで縛れない。** このリポジトリの vitest は node 環境で、jsdom も
 * testing-library も無いため React の効果を実行できない（`checkin-call-wiring.test.ts` と
 * 同じ制約）。E2E からも踏めない ── ローカル音声は `?voiceOrchestrator=1` を付けた端末
 * だけの opt-in で、実 orchestrator の駆動は mock provider のタイマーに乗る。
 *
 * よって「どの値を渡すか」をソースに対して固定する。弱い縛りだが、**今回の回帰そのものは
 * 落ちる**。jsdom が入ったらこのファイルは振る舞いテストへ置き換えてよい。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync('src/components/kiosk/KioskFlow.tsx', 'utf8');

/** `createLocalVoiceSessionFactory(...)` の呼び出し（引数を含む)。 */
function localVoiceFactoryCall(): string {
  const start = SOURCE.indexOf('createLocalVoiceSessionFactory(');
  expect(start, 'ローカル音声セッションの組み立てが見つからない').toBeGreaterThan(-1);
  // import 行ではなく呼び出しを取りたいので、`return` 側の出現から括弧を数える。
  const call = SOURCE.slice(SOURCE.indexOf('return createLocalVoiceSessionFactory('));
  let depth = 0;
  for (let i = call.indexOf('('); i < call.length; i += 1) {
    if (call[i] === '(') depth += 1;
    else if (call[i] === ')') {
      depth -= 1;
      if (depth === 0) return call.slice(0, i + 1);
    }
  }
  throw new Error('createLocalVoiceSessionFactory の呼び出しを閉じられなかった');
}

describe('KioskFlow が実 Directory を音声へ渡す (#788)', () => {
  it('🔴 EntityDirectory は端末が保持する directory から作る', () => {
    expect(SOURCE).toContain("from './voice-directory'");
    expect(localVoiceFactoryCall()).toContain('kioskDirectoryToEntityDirectory(directory)');
  });

  /**
   * 🔴 **空配列リテラルへ戻さない。** それが元の姿で、「配線は正しいが入力が空」なので
   * 読んでも気づけない。写像を経由せず素通しするのも同じく通さない（不在の担当者を
   * 音声だけが呼べるようになる。理由は `voice-directory.ts` の doc）。
   */
  it('🔴 空の EntityDirectory を渡さない', () => {
    const call = localVoiceFactoryCall();
    expect(call).not.toMatch(/staff:\s*\[\s*\]/);
    expect(call).not.toMatch(/departments:\s*\[\s*\]/);
  });

  /**
   * Directory は取得が非同期で、初期値は空。`useMemo` の依存に directory が無いと
   * **空のまま固定される**（実質、元の不具合へ戻る）。依存に載っていることを固定する。
   */
  it('🔴 directory の変化で音声セッションを組み直す', () => {
    const memoEnd = SOURCE.indexOf('const effectiveVoiceSession');
    const memoStart = SOURCE.indexOf('const localVoiceSession = useMemo(');
    expect(memoStart).toBeGreaterThan(-1);
    const deps = SOURCE.slice(memoStart, memoEnd).match(/\}, \[([^\]]*)\]\);/);
    expect(deps, 'useMemo の依存配列が見つからない').not.toBeNull();
    expect(deps?.[1]).toMatch(/\bdirectory\b/);
  });
});
