import { describe, expect, it } from 'vitest';

import {
  type UrlGateObservation,
  classifyLighthouseExit,
  classifyZapExit,
  planUrlGateChecks,
} from './url-gate-tooling';

const ALL_PRESENT: UrlGateObservation = {
  dockerCli: true,
  dockerDaemon: true,
};

const absent = (over: Partial<UrlGateObservation>): UrlGateObservation => ({
  ...ALL_PRESENT,
  ...over,
});

describe('planUrlGateChecks', () => {
  it('道具が揃っていれば zap は run', () => {
    expect(planUrlGateChecks(ALL_PRESENT, { strict: false }).zap.kind).toBe('run');
  });

  /**
   * `scripts/quality-gate.sh` の `skip_or_fail` と同じ規約 —— 任意ツール未導入は
   * 既定 SKIP、`--strict` で FAIL。
   */
  it('docker CLI が無ければ zap は skip', () => {
    expect(planUrlGateChecks(absent({ dockerCli: false }), { strict: false }).zap.kind).toBe(
      'skip',
    );
  });

  /**
   * 🔴 **実インシデント。** クラウドサンドボックスには docker CLI があるがデーモンが
   * 動いていない。CLI の有無だけを見ると実行してしまい、`docker run` が exit 1 で落ちる。
   */
  it('docker CLI があってもデーモンが落ちていれば zap は skip', () => {
    expect(
      planUrlGateChecks(absent({ dockerDaemon: false }), { strict: false }).zap.kind,
    ).toBe('skip');
  });

  it('--strict では未導入が skip ではなく fail になる', () => {
    expect(planUrlGateChecks(absent({ dockerDaemon: false }), { strict: true }).zap.kind).toBe(
      'fail',
    );
  });

  /**
   * **下界も縛る。** 「skip になる」だけを主張すると reason を空にする変異が素通りする。
   */
  it('skip / fail は理由を持ち、欠けている道具を名指しする', () => {
    const plan = planUrlGateChecks(absent({ dockerDaemon: false }), { strict: false });
    if (plan.zap.kind === 'run') throw new Error('前提が崩れている');
    expect(plan.zap.reason).toMatch(/docker/i);
  });

  it('run には reason が付かない', () => {
    expect(planUrlGateChecks(ALL_PRESENT, { strict: false }).zap).toEqual({ kind: 'run' });
  });

  /**
   * 🔴 **lighthouse を事前判定で門前払いしない（2026-09-05 の退行）。**
   *
   * 以前ここには `chrome` の観測があり、`command -v google-chrome` 等 **Linux の
   * コマンド名だけ**を見ていた。macOS の Chrome は
   * `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` にあり PATH に
   * 現れないので、**Chrome が入っている Mac でも必ず SKIP** していた ―― runbook が
   * 「ローカル macOS で回せ」と言っている当の環境で、検査を黙って止めていた。
   *
   * lhci は chrome-launcher で OS ごとの探索を自前で持っている。こちらに写せば
   * 必ずドリフトする（本 PR 群が繰り返し踏んだ「同じ規則の写し」の型）。
   * **探索は lhci に任せ、こちらは結果を解釈する。**
   */
  it('lighthouse を plan で門前払いしない（探索は lhci に委ねる）', () => {
    const plan = planUrlGateChecks(absent({ dockerCli: false, dockerDaemon: false }), {
      strict: false,
    });
    expect(plan).not.toHaveProperty('lighthouse');
  });
});

describe('classifyZapExit', () => {
  it('レポートが無ければ exit 1 でも high-risk とは言わない', () => {
    expect(classifyZapExit(1, false)).toBe('unverified');
  });

  it('レポートがあれば exit 1 は high-risk', () => {
    expect(classifyZapExit(1, true)).toBe('high-risk');
  });

  it('exit 0 は pass', () => {
    expect(classifyZapExit(0, true)).toBe('pass');
  });

  it('exit 2 は warn', () => {
    expect(classifyZapExit(2, true)).toBe('warn');
  });

  it('未知の終了コードは unverified（pass へ倒さない）', () => {
    expect(classifyZapExit(137, true)).toBe('unverified');
  });

  it('レポートが無ければ exit 0 でも pass とは言わない', () => {
    expect(classifyZapExit(0, false)).toBe('unverified');
  });
});

describe('classifyLighthouseExit', () => {
  /**
   * ZAP と同じ形にする。**lhci の文言に依存しない** —— 「Chrome installation not found」
   * のような英文を照合すると版で変わる。レポートを書けたかどうかは版に依らない事実。
   */
  it('レポートが無ければ、失敗しても閾値未達とは言わない', () => {
    expect(classifyLighthouseExit(1, false)).toBe('unverified');
  });

  it('レポートがあって失敗なら閾値未達', () => {
    expect(classifyLighthouseExit(1, true)).toBe('threshold');
  });

  it('exit 0 は pass', () => {
    expect(classifyLighthouseExit(0, true)).toBe('pass');
  });

  /**
   * 🔴 **これが macOS 退行と、クラウドの CHROME_INTERSTITIAL_ERROR の両方を覆う。**
   * Chrome が無い / 対象に到達できない、のどちらでも lhci はレポートを書けない。
   * どちらも「測れなかった」であって「dev が悪い」ではない。
   */
  it('Chrome 不在も到達不能も、レポート無しとして unverified に落ちる', () => {
    expect(classifyLighthouseExit(1, false)).toBe('unverified');
    expect(classifyLighthouseExit(127, false)).toBe('unverified');
  });

  it('レポートが無ければ exit 0 でも pass とは言わない', () => {
    expect(classifyLighthouseExit(0, false)).toBe('unverified');
  });
});
