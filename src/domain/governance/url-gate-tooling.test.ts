import { describe, expect, it } from 'vitest';

import {
  type UrlGateObservation,
  classifyZapExit,
  planUrlGateChecks,
} from './url-gate-tooling';

const ALL_PRESENT: UrlGateObservation = {
  dockerCli: true,
  dockerDaemon: true,
  chrome: true,
};

const absent = (over: Partial<UrlGateObservation>): UrlGateObservation => ({
  ...ALL_PRESENT,
  ...over,
});

describe('planUrlGateChecks', () => {
  it('道具が揃っていれば両方 run', () => {
    const plan = planUrlGateChecks(ALL_PRESENT, { strict: false });
    expect(plan.lighthouse.kind).toBe('run');
    expect(plan.zap.kind).toBe('run');
  });

  /**
   * `scripts/quality-gate.sh` の `skip_or_fail` と同じ規約 —— 任意ツール未導入は
   * 既定 SKIP、`--strict` で FAIL。**FAIL ではなく SKIP** にするのは
   * 「その検査を持っていない」だけだからで、`docs/quality-gate.md` の既定。
   */
  it('docker CLI が無ければ zap は skip（lighthouse は巻き込まない）', () => {
    const plan = planUrlGateChecks(absent({ dockerCli: false }), { strict: false });
    expect(plan.zap.kind).toBe('skip');
    expect(plan.lighthouse.kind).toBe('run');
  });

  /**
   * 🔴 **これが今回の実インシデントそのもの。** クラウドサンドボックスには docker CLI が
   * あるがデーモンが動いていない（`/var/run/docker.sock` が無い）。CLI の有無だけを見ると
   * 「ある」と判定して実行してしまい、`docker run` が exit 1 で落ちる。
   */
  it('docker CLI があってもデーモンが落ちていれば zap は skip', () => {
    const plan = planUrlGateChecks(absent({ dockerDaemon: false }), { strict: false });
    expect(plan.zap.kind).toBe('skip');
  });

  it('Chrome が解決できなければ lighthouse は skip（zap は巻き込まない）', () => {
    const plan = planUrlGateChecks(absent({ chrome: false }), { strict: false });
    expect(plan.lighthouse.kind).toBe('skip');
    expect(plan.zap.kind).toBe('run');
  });

  it('--strict では未導入が skip ではなく fail になる', () => {
    const plan = planUrlGateChecks(
      absent({ dockerDaemon: false, chrome: false }),
      { strict: true },
    );
    expect(plan.zap.kind).toBe('fail');
    expect(plan.lighthouse.kind).toBe('fail');
  });

  /**
   * **下界も縛る。** 「skip になる」だけを主張すると、reason を空文字にする変異が
   * 素通りする。運用者が SKIP を読んで対処できることまでを要求する
   * （`CLAUDE.md`「検証の作法」の「下界を併せて縛る」）。
   */
  it('skip / fail は理由を必ず持ち、欠けている道具を名指しする', () => {
    const plan = planUrlGateChecks(
      absent({ dockerDaemon: false, chrome: false }),
      { strict: false },
    );
    expect(plan.zap.kind).toBe('skip');
    expect(plan.lighthouse.kind).toBe('skip');
    if (plan.zap.kind === 'run' || plan.lighthouse.kind === 'run') {
      throw new Error('前提が崩れている');
    }
    expect(plan.zap.reason).toMatch(/docker/i);
    expect(plan.lighthouse.reason).toMatch(/chrome/i);
  });

  it('run には reason が付かない（skip 理由を run へ流用しない）', () => {
    const plan = planUrlGateChecks(ALL_PRESENT, { strict: false });
    expect(plan.zap).toEqual({ kind: 'run' });
    expect(plan.lighthouse).toEqual({ kind: 'run' });
  });
});

describe('classifyZapExit', () => {
  /**
   * 🔴 **これが誤ラベルの本体。** `zap-baseline.py` は 1=高リスク / 2=WARN を返すが、
   * **`docker run` 自体が失敗したときも 1 を返す**（デーモン停止・イメージ pull 失敗）。
   * 実測: デーモンを落とした状態の `docker run --rm hello-world` は rc=1。
   * 終了コードだけを見る旧実装は、インフラ障害を `zap(high-risk)` と報告していた ――
   * **セキュリティ指摘に見える沈黙の誤動作**である。
   *
   * 区別できる観測は「zap がレポートを書いたか」。書いていなければ zap は
   * 一度も走っていないので、`high-risk` ではなく `unverified`。
   */
  it('レポートが無ければ exit 1 でも high-risk とは言わない', () => {
    expect(classifyZapExit(1, false)).toBe('unverified');
  });

  it('レポートがあれば exit 1 は high-risk', () => {
    expect(classifyZapExit(1, true)).toBe('high-risk');
  });

  it('exit 0 は pass', () => {
    expect(classifyZapExit(0, true)).toBe('pass');
  });

  it('exit 2 は warn（-I で無視するが high-risk ではない）', () => {
    expect(classifyZapExit(2, true)).toBe('warn');
  });

  /**
   * 未知の終了コードを pass 側へ落とさない。`aws-preflight` 系と同じ fail-closed。
   */
  it('未知の終了コードは unverified（pass へ倒さない）', () => {
    expect(classifyZapExit(137, true)).toBe('unverified');
    expect(classifyZapExit(3, true)).toBe('unverified');
  });

  /**
   * レポートが無いのに exit 0 なら、zap は走らずに成功したことになる。
   * 「落ちなかった」を「通った」と読まない（#640 と同型）。
   */
  it('レポートが無ければ exit 0 でも pass とは言わない', () => {
    expect(classifyZapExit(0, false)).toBe('unverified');
  });
});
