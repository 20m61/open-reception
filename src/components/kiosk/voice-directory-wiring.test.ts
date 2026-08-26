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

describe('KioskFlow が実 Directory を音声へ渡す (#788)', () => {
  it('EntityDirectory は端末が保持する directory から作る', () => {
    expect(SOURCE).toContain("from './voice-directory'");
    expect(localVoiceMemoBody()).toContain('kioskDirectoryToEntityDirectory(directory)');
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
    const returns = localVoiceMemoBody().match(/return undefined/g) ?? [];
    expect(returns).toHaveLength(1);
    expect(localVoiceMemoBody()).toContain('if (!localVoiceEnabled) return undefined;');
  });
});
