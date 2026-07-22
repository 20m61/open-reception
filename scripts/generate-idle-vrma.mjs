#!/usr/bin/env node
/**
 * 待機用アイドルモーション `public/avatar/idle.vrma` を生成する (issue #31)。
 *
 * 外部モーションアセットはライセンス確認と配布可否が重く、待機の「呼吸 + ゆるい体の揺れ +
 * 腕を下ろした立ち姿」程度なら数トラックで足りるため、**本スクリプトで自作して同梱**する
 * （自作 = CC0 相当・出所明確、`public/avatar/README.md` 参照）。
 *
 * 形式: glTF 2.0 バイナリ (GLB) + `VRMC_vrm_animation` 拡張（VRM Animation 1.0）。
 * `@pixiv/three-vrm-animation` の `VRMAnimationLoaderPlugin` が読める最小構成:
 *   - humanoid ボーンに対応する node 階層（rest 回転は恒等 = 出力回転が正規化空間の回転になる）
 *   - LINEAR サンプラの rotation トラック（呼吸=chest 前後・揺れ=hips/head ヨー・腕=定数で下ろす）
 *
 * 再生中は VrmAvatarViewer の手続き的 A-pose が適用されないため、腕を下ろす回転は
 * `vrm-idle.ts` の IDLE_REST_POSE と同じ値をトラックとして焼き込む。
 *
 * 実行: node scripts/generate-idle-vrma.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/avatar/idle.vrma');

/** 小角オイラー(単軸)→クォータニオン。 */
const qx = (a) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
const qy = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const qz = (a) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];

// ---- トラック定義(8 秒ループ) --------------------------------------------
const DURATION = 8;
const STEPS = 32; // 0.25s 刻み
const times = Array.from({ length: STEPS + 1 }, (_, i) => (i * DURATION) / STEPS);

// vrm-idle.ts と同じ趣: 呼吸(chest x, 周期~4.5s, ±0.025rad)・揺れ(hips y, 周期~10s, ±0.03rad)
const tracks = [
  { bone: 'hips', values: times.map((t) => qy(Math.sin((t * 2 * Math.PI) / 8) * 0.03)) },
  { bone: 'chest', values: times.map((t) => qx(Math.sin(t * 1.4) * 0.025)) },
  { bone: 'head', values: times.map((t) => qy(Math.sin((t * 2 * Math.PI) / 8 + 1.2) * 0.02)) },
  // 腕は IDLE_REST_POSE と同値の定数(下ろした A-pose)。
  { bone: 'leftUpperArm', values: times.map(() => qz(1.25)) },
  { bone: 'rightUpperArm', values: times.map(() => qz(-1.25)) },
  { bone: 'leftLowerArm', values: times.map(() => qz(0.15)) },
  { bone: 'rightLowerArm', values: times.map(() => qz(-0.15)) },
];

// ---- humanoid node 階層(rest 回転は恒等・translation のみ) -----------------
const nodes = [
  { name: 'hips', translation: [0, 0.95, 0], children: [1] },
  { name: 'spine', translation: [0, 0.1, 0], children: [2] },
  { name: 'chest', translation: [0, 0.15, 0], children: [3, 5, 7] },
  { name: 'neck', translation: [0, 0.25, 0], children: [4] },
  { name: 'head', translation: [0, 0.08, 0] },
  { name: 'leftUpperArm', translation: [0.18, 0.2, 0], children: [6] },
  { name: 'leftLowerArm', translation: [0.26, 0, 0] },
  { name: 'rightUpperArm', translation: [-0.18, 0.2, 0], children: [8] },
  { name: 'rightLowerArm', translation: [-0.26, 0, 0] },
];
const nodeIndex = Object.fromEntries(nodes.map((n, i) => [n.name, i]));

// ---- バッファ構築 -----------------------------------------------------------
const chunks = [];
let byteOffset = 0;
const bufferViews = [];
const accessors = [];
const pushF32 = (arr, type) => {
  const f32 = new Float32Array(arr.flat());
  const buf = Buffer.from(f32.buffer);
  bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.length });
  chunks.push(buf);
  byteOffset += buf.length;
  const flat = arr.flat();
  const comp = type === 'SCALAR' ? 1 : 4;
  const count = flat.length / comp;
  const acc = {
    bufferView: bufferViews.length - 1,
    componentType: 5126,
    count,
    type,
  };
  if (type === 'SCALAR') {
    acc.min = [Math.min(...flat)];
    acc.max = [Math.max(...flat)];
  }
  accessors.push(acc);
  return accessors.length - 1;
};

const timeAccessor = pushF32(times, 'SCALAR');
const samplers = [];
const channels = [];
for (const track of tracks) {
  const out = pushF32(track.values, 'VEC4');
  samplers.push({ input: timeAccessor, output: out, interpolation: 'LINEAR' });
  channels.push({
    sampler: samplers.length - 1,
    target: { node: nodeIndex[track.bone], path: 'rotation' },
  });
}

const gltf = {
  asset: { version: '2.0', generator: 'open-reception scripts/generate-idle-vrma.mjs' },
  extensionsUsed: ['VRMC_vrm_animation'],
  extensions: {
    VRMC_vrm_animation: {
      specVersion: '1.0',
      humanoid: {
        humanBones: Object.fromEntries(
          nodes.map((n, i) => [n.name, { node: i }]),
        ),
      },
    },
  },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes,
  animations: [{ name: 'idle', samplers, channels }],
  bufferViews,
  accessors,
  buffers: [{ byteLength: byteOffset }],
};

// ---- GLB 書き出し -----------------------------------------------------------
const pad4 = (buf, fill) => {
  const rem = buf.length % 4;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem, fill)]);
};
const jsonChunk = pad4(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20);
const binChunk = pad4(Buffer.concat(chunks), 0x00);
const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // 'glTF'
header.writeUInt32LE(2, 4);
header.writeUInt32LE(total, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonChunk.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binChunk.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4); // 'BIN'
writeFileSync(OUT, Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]));
console.log(`wrote ${OUT} (${total} bytes, ${tracks.length} tracks, ${times.length} keys)`);
