import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_ACCOUNT_ID } from './dev-account';

/**
 * #1238: dev のアカウント ID の本物の値を、リポジトリの決まった場所にだけ置く。
 *
 * 置いてよいのは `dev-account.ts` と、owner が手で適用する IAM policy の JSON
 * （`scripts/aws-policies/*.json`。2026-10-27 の owner 判断で置き換えを見送った）だけ。
 * 文書とコメントは `<DEV_ACCOUNT_ID>`、テストはダミーか、この module の import を使う。
 */
const ROOT = join(__dirname, '../../..');
const MODULE = 'src/domain/governance/dev-account.ts';
const POLICY_DIR = 'scripts/aws-policies/';

const trackedFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);

const filesContaining = (needle: string): string[] =>
  trackedFiles().filter((f) => {
    try {
      return readFileSync(join(ROOT, f), 'utf8').includes(needle);
    } catch {
      return false; // submodule・削除済み等。読めないものは数えない
    }
  });

describe('dev のアカウント ID の置き場所 (#1238)', () => {
  it('12 桁の数字である', () => {
    expect(DEV_ACCOUNT_ID).toMatch(/^\d{12}$/);
  });

  it('本物の値は module と IAM policy の JSON にだけある', () => {
    const holders = filesContaining(DEV_ACCOUNT_ID);
    const unexpected = holders.filter((f) => f !== MODULE && !(f.startsWith(POLICY_DIR) && f.endsWith('.json')));
    expect(unexpected).toEqual([]);
    // 下界: 走査が何も読めていない（全部 catch に落ちる等）なら、上の主張は空虚に通る。
    expect(holders).toContain(MODULE);
    expect(holders.filter((f) => f.startsWith(POLICY_DIR)).length).toBeGreaterThanOrEqual(5);
  });

  it('negative test のスクリプトは、検査するアカウントをこの module から取る', () => {
    // 変更前から、ここを別の値に変えても既存のテストは落ちなかった（変異 M5 が生存）。配線を直接縛る。
    const source = readFileSync(join(ROOT, 'scripts/aws-negative-tests.ts'), 'utf8');
    expect(source).toMatch(/^const ACCOUNT = DEV_ACCOUNT_ID;$/m);
    expect(source).toContain("from '../src/domain/governance/dev-account'");
  });

  it('短命 credential の発行スクリプトは、値を書かずにこの module から読む', () => {
    const script = readFileSync(join(ROOT, 'scripts/aws-issue-credentials.sh'), 'utf8');
    expect(script).not.toMatch(/\b\d{12}\b/);
    expect(script).toContain('src/domain/governance/dev-account.ts');
    // スクリプトの sed と同じ形で、module の宣言行から値が取り出せる（書式を変えたら落ちる）。
    const line = readFileSync(join(ROOT, MODULE), 'utf8')
      .split('\n')
      .map((l) => /^export const DEV_ACCOUNT_ID = '(\d{12})';$/.exec(l)?.[1])
      .find(Boolean);
    expect(line).toBe(DEV_ACCOUNT_ID);
  });
});
