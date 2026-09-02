import { describe, expect, it, vi } from 'vitest';
import type { VRM, VRMHumanBoneName, VRMLookAt } from '@pixiv/three-vrm';
import type { Vector3 } from 'three';
import {
  measureHeadHeight,
  prepareLoadedVrm,
  VRM_LOOK_AT_PROXY_NAME,
  type VrmPrepareDeps,
} from './vrm-prepare';

/**
 * three / three-vrm を**実行時に読まずに**配線を固定する。
 *
 * 「VRMUtils を全部呼んでいる」「frustumCulled を切っている」「lookAt proxy を名前付きで
 * 足している」は、いずれも落としても描画は"それらしく"見えるので画素検査では捕まらない
 * （combineMorphs を落とすと iPad でだけシェーダエラーになる、等）。呼び出しの有無と順序を
 * ここで縛る。
 */
type FakeObject = { frustumCulled: boolean; name?: string };

function fakeVrm(input: { withLookAt: boolean; objects?: FakeObject[] }) {
  const objects = input.objects ?? [{ frustumCulled: true }, { frustumCulled: true }];
  const children: unknown[] = [];
  const scene = {
    traverse: (cb: (o: FakeObject) => void) => objects.forEach(cb),
    add: (o: unknown) => {
      children.push(o);
    },
    children,
  };
  const lookAt = input.withLookAt ? ({ marker: 'lookAt' } as unknown as VRMLookAt) : undefined;
  return { vrm: { scene, lookAt } as unknown as VRM, objects, children, lookAt };
}

function fakeDeps() {
  const calls: string[] = [];
  const utils: VrmPrepareDeps['utils'] = {
    removeUnnecessaryVertices: vi.fn(() => calls.push('removeUnnecessaryVertices')),
    combineSkeletons: vi.fn(() => calls.push('combineSkeletons')),
    combineMorphs: vi.fn(() => calls.push('combineMorphs')),
    rotateVRM0: vi.fn(() => calls.push('rotateVRM0')),
  };
  class LookAtProxy {
    name = '';
    constructor(readonly vrmLookAt: VRMLookAt) {
      calls.push('LookAtProxy');
    }
  }
  return { calls, deps: { utils, LookAtProxy } as unknown as VrmPrepareDeps, LookAtProxy };
}

describe('prepareLoadedVrm (three-vrm 公式例の読込後手順)', () => {
  it('VRMUtils の最適化 3 種と rotateVRM0 を全部、公式例の順で呼ぶ', () => {
    const { vrm } = fakeVrm({ withLookAt: false });
    const { calls, deps } = fakeDeps();
    prepareLoadedVrm(vrm, deps);
    expect(calls).toEqual(['removeUnnecessaryVertices', 'combineSkeletons', 'combineMorphs', 'rotateVRM0']);
    expect(deps.utils.removeUnnecessaryVertices).toHaveBeenCalledWith(vrm.scene);
    expect(deps.utils.combineSkeletons).toHaveBeenCalledWith(vrm.scene);
    expect(deps.utils.combineMorphs).toHaveBeenCalledWith(vrm);
    expect(deps.utils.rotateVRM0).toHaveBeenCalledWith(vrm);
  });

  it('scene 配下の全オブジェクトの frustumCulled を false にする', () => {
    const { vrm, objects } = fakeVrm({ withLookAt: false });
    prepareLoadedVrm(vrm, fakeDeps().deps);
    expect(objects.every((o) => o.frustumCulled === false)).toBe(true);
  });

  it('lookAt があれば名前付きの VRMLookAtQuaternionProxy を scene に 1 つ足す', () => {
    const { vrm, children, lookAt } = fakeVrm({ withLookAt: true });
    const { deps, LookAtProxy } = fakeDeps();
    const result = prepareLoadedVrm(vrm, deps);
    expect(children).toHaveLength(1);
    const proxy = children[0] as InstanceType<typeof LookAtProxy>;
    expect(proxy).toBeInstanceOf(LookAtProxy);
    expect(proxy.vrmLookAt).toBe(lookAt);
    // 名前が空だと createVRMAnimationClip が警告して自動命名する。明示的に付ける。
    expect(proxy.name).toBe(VRM_LOOK_AT_PROXY_NAME);
    expect(result.lookAtProxyAdded).toBe(true);
  });

  it('lookAt が無いモデルには proxy を足さない（コンストラクタも呼ばない）', () => {
    const { vrm, children } = fakeVrm({ withLookAt: false });
    const { calls, deps } = fakeDeps();
    const result = prepareLoadedVrm(vrm, deps);
    expect(children).toHaveLength(0);
    expect(calls).not.toContain('LookAtProxy');
    expect(result.lookAtProxyAdded).toBe(false);
  });
});

describe('measureHeadHeight', () => {
  // three を実行時に読まない: 書き込まれる x/y/z だけを持つ器を Vector3 として渡す。
  const makeVector = (() => ({ x: 0, y: 0, z: 0 })) as unknown as () => Vector3;
  function humanoidWithHead(y: number | undefined) {
    const node =
      y === undefined
        ? null
        : { getWorldPosition: (v: { x: number; y: number; z: number }) => ((v.y = y), v) };
    const humanoid = {
      getNormalizedBoneNode: vi.fn((name: VRMHumanBoneName) => (name === 'head' ? node : null)),
    };
    return { humanoid } as unknown as VRM;
  }

  it('head の正規化ボーンのワールド Y を返す', () => {
    expect(measureHeadHeight(humanoidWithHead(1.42), makeVector)).toBe(1.42);
  });

  it('head が無ければ undefined（0 を返してカメラを原点へ埋めない）', () => {
    expect(measureHeadHeight(humanoidWithHead(undefined), makeVector)).toBeUndefined();
  });

  it('非有限・非正の高さは undefined に倒す', () => {
    expect(measureHeadHeight(humanoidWithHead(Number.NaN), makeVector)).toBeUndefined();
    expect(measureHeadHeight(humanoidWithHead(0), makeVector)).toBeUndefined();
    expect(measureHeadHeight(humanoidWithHead(-1), makeVector)).toBeUndefined();
  });
});
