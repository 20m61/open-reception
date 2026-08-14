/**
 * 依存コマンドの有無判定 (#680)。
 *
 * `aws` が cloud sandbox に入っておらず、`collect_observation` がそれを
 * 「AWS 認証情報を解決できません」という誤った層のせいにしていた。ここは資格情報より
 * 前の層 ―― コマンドが PATH 上に存在するか ―― だけを判定する。
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateCommandAvailability,
  formatMissingCommandMessage,
  REQUIRED_EXTERNAL_COMMANDS,
} from './command-preflight';

describe('REQUIRED_EXTERNAL_COMMANDS', () => {
  it('aws を含む（今回の実インシデントの当事者）', () => {
    expect(REQUIRED_EXTERNAL_COMMANDS).toContain('aws');
  });
});

describe('evaluateCommandAvailability', () => {
  it('必要なコマンドが全部あれば ok', () => {
    const verdict = evaluateCommandAvailability({ aws: true });
    expect(verdict.ok).toBe(true);
    expect(verdict.missing).toEqual([]);
  });

  it('aws が無ければ ok=false で missing に aws を含める', () => {
    const verdict = evaluateCommandAvailability({ aws: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toContain('aws');
  });

  // 🔴 呼び出し側（CLI）が値を渡し忘れるケース。`observed[cmd]` は `undefined` になる。
  // `== null` 相当の緩い判定に退化させず、`!== true` の厳密比較で拾えることを固定する
  // （`deploy-preflight.ts` の `credentialSecondsRemaining` と同じ設計判断）。
  it('キー自体が欠落（undefined）していても欠落扱いにする（true に丸め込まない）', () => {
    const verdict = evaluateCommandAvailability({});
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toContain('aws');
  });

  it('複数必須コマンドのうち、欠けているものだけを報告する', () => {
    const verdict = evaluateCommandAvailability({ aws: true, foo: false, bar: true }, [
      'aws',
      'foo',
      'bar',
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toEqual(['foo']);
  });

  it('必須コマンドが 0 件なら常に ok（境界値）', () => {
    const verdict = evaluateCommandAvailability({}, []);
    expect(verdict.ok).toBe(true);
    expect(verdict.missing).toEqual([]);
  });
});

describe('formatMissingCommandMessage', () => {
  it('欠落コマンド名を含む', () => {
    expect(formatMissingCommandMessage(['aws'])).toContain('aws');
  });

  it('セットアップスクリプトを指す', () => {
    expect(formatMissingCommandMessage(['aws'])).toContain('cloud-setup.sh');
  });

  // 🔴 これが本 Issue の核心: 資格情報の問題だと誤読させる語を含めない。
  it('「認証情報」という語を含まない（誤った層を名指ししない）', () => {
    expect(formatMissingCommandMessage(['aws'])).not.toContain('認証情報');
  });

  it('複数欠落を列挙する', () => {
    const msg = formatMissingCommandMessage(['aws', 'gitleaks']);
    expect(msg).toContain('aws');
    expect(msg).toContain('gitleaks');
  });
});
