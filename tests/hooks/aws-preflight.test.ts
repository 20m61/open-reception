/**
 * `scripts/aws-preflight.ts` の振る舞い検証。
 *
 * このスクリプトは（`aws-negative-tests.ts` や wrapper と違い）AWS 資格情報を必要としない
 * ―― 入力は JSON ファイル 1 つで、判定は `deploy-preflight.ts` の純関数に委譲するだけの
 * 薄い CLI。**実行に AWS が要らないので、直接子プロセスとして実行してテストできる**
 * （「実走しないコードをテスト無しで置かない」の裏返し: 実走できるものはテストする）。
 *
 * Important 4（2026-08-12 レビュー）で追加した「公開された argv 契約」の実行時検証を固定する。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const CLI = resolve(process.cwd(), 'scripts/aws-preflight.ts');

const validObservation = {
  callerArn: 'arn:aws:sts::822063948773:assumed-role/OpenReceptionClaudeDeploy-dev/cloud-session',
  accountId: '822063948773',
  region: 'ap-northeast-1',
  qualifier: 'orcloud01',
  environment: 'dev',
  credentialSecondsRemaining: 3600,
  workingTreeClean: true,
  headCommitPushed: true,
  gateStampSatisfied: true,
  negativeTestsPassed: true,
};

function writeObservation(value: unknown): string {
  const path = join(tmpdir(), `aws-preflight-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function run(args: ReadonlyArray<string>) {
  const result = spawnSync('npx', ['tsx', CLI, ...args], { encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}


/**
 * 🔴 **既定の 5s では足りない。** このファイルのテストは `tsx` を子プロセスとして起動する
 * （1 件あたり素の状態でも 1〜2 秒）。ゲート実行中はマシンの負荷が上がるため ―― `--fast` 自身が
 * load を押し上げる ―― **5.1〜7.8s でタイムアウトし、アサーションに到達する前に落ちる**。
 * 2026-08-18 の 1 セッションで 6 回観測し、毎回**別のテスト**が落ちた（＝内容ではなく時間）。
 * 単独実行では全 PASS する。
 *
 * これは検査の弱体化ではない。**同じアサーションに、到達するまでの時間を与えるだけ**。
 * 実際に壊れているものは 30s あっても落ちる。
 */
vi.setConfig({ testTimeout: 30_000 });

describe('引数の検証', () => {
  it('observation パスが無いと usage を出して非ゼロ', () => {
    const { status, stderr } = run([]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('Usage');
  });

  it('minCredentialSeconds が数値でないと拒否する（NaN で閾値チェックを無効化させない）', () => {
    const path = writeObservation(validObservation);
    const { status, stderr } = run([path, 'not-a-number']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('minCredentialSeconds');
  });
});

describe('observation の形式検証（公開された argv 契約）', () => {
  it('JSON オブジェクトでなければ拒否する', () => {
    const path = writeObservation('just a string');
    const { status, stderr } = run([path]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('observation の形式が不正です');
  });

  it('文字列フィールドが欠落していれば拒否する', () => {
    const { callerArn: _drop, ...rest } = validObservation;
    const path = writeObservation(rest);
    const { status, stderr } = run([path]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('callerArn');
  });

  it('boolean フィールドが文字列だと拒否する', () => {
    const path = writeObservation({ ...validObservation, workingTreeClean: 'true' });
    const { status, stderr } = run([path]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('workingTreeClean');
  });

  // 🔴 Minor 9（2026-08-12 全体レビュー）: 新しい boolean を型に足しただけでは、
  // フィールドが丸ごと欠落した観測 JSON を CLI が素通りさせてしまう
  // （`deploy-preflight.ts` 側の `!observed.headCommitPushed` は undefined を拾うが、
  // 「形式が不正」と「値が false」は診断として別物）。境界でも拒否することを固定する。
  it('headCommitPushed が欠落していれば形式エラーとして拒否する', () => {
    const { headCommitPushed: _drop, ...rest } = validObservation;
    const path = writeObservation(rest);
    const { status, stderr } = run([path]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('observation の形式が不正です');
    expect(stderr).toContain('headCommitPushed');
  });

  it('credentialSecondsRemaining が欠落していれば拒否する（undefined を通さない）', () => {
    const { credentialSecondsRemaining: _drop, ...rest } = validObservation;
    const path = writeObservation(rest);
    const { status, stderr } = run([path]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('credentialSecondsRemaining');
  });

  it('credentialSecondsRemaining が null なら形式としては正当（判定不能として preflight 側で止まる）', () => {
    const path = writeObservation({ ...validObservation, credentialSecondsRemaining: null });
    const { status, stderr } = run([path]);
    expect(status).not.toBe(0);
    expect(stderr).not.toContain('observation の形式が不正です');
    expect(stderr).toContain('credentialSecondsRemaining');
  });
});

describe('正常系', () => {
  it('全項目そろっていれば exit 0', () => {
    const path = writeObservation(validObservation);
    const { status, stdout } = run([path]);
    expect(status).toBe(0);
    expect(stdout).toContain('PASS');
  });

  it('不一致があれば非ゼロで理由を出す', () => {
    const path = writeObservation({ ...validObservation, workingTreeClean: false });
    const { status, stderr } = run([path]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('workingTreeClean');
  });
});
