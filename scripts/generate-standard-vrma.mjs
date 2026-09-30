#!/usr/bin/env node
/**
 * Open Reception Standard Motion Set のうち、初期3モーションを自作生成する。
 *
 * 生成対象:
 * - public/avatar/greeting.vrma  : 短い会釈 + 控えめな手振り（one-shot想定）
 * - public/avatar/listening.vrma : わずかな前傾 + 小さな相槌（loop）
 * - public/avatar/selecting.vrma : 開いた手で選択肢を示す（loop）
 *
 * 外部モーションアセットを使わず、VRM Animation 1.0 の最小GLBを決定論的に生成する。
 * 表情・口パク・blink・gaze は runtime layer の責務とし、このVRMAには焼き込まない。
 *
 * 実行: node scripts/generate-standard-vrma.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public/avatar');
mkdirSync(OUT_DIR, { recursive: true });

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

/** Euler XYZ -> quaternion. */
function q(x = 0, y = 0, z = 0) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (v) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

function restArmTracks(times) {
  return [
    { bone: 'leftUpperArm', values: times.map(() => q(0, 0, 1.25)) },
    { bone: 'leftLowerArm', values: times.map(() => q(0, 0, 0.15)) },
  ];
}

const specs = {
  greeting: {
    duration: 2.4,
    steps: 24,
    tracks(times) {
      return [
        { bone: 'spine', values: times.map((t) => {
          const p = t / 2.4;
          const bow = p < 0.5 ? smooth(p / 0.5) : smooth((1 - p) / 0.5);
          return q(0.11 * bow, 0, 0);
        }) },
        { bone: 'neck', values: times.map((t) => {
          const p = t / 2.4;
          const bow = p < 0.5 ? smooth(p / 0.5) : smooth((1 - p) / 0.5);
          return q(0.06 * bow, 0, 0);
        }) },
        { bone: 'rightUpperArm', values: times.map((t) => {
          const p = t / 2.4;
          const lift = Math.sin(Math.PI * p);
          return q(0.12 * lift, 0, -1.25 + 0.42 * lift);
        }) },
        { bone: 'rightLowerArm', values: times.map((t) => {
          const p = t / 2.4;
          const envelope = Math.sin(Math.PI * p);
          const wave = Math.sin(p * Math.PI * 5) * 0.18 * envelope;
          return q(0, 0, -0.15 + wave);
        }) },
        ...restArmTracks(times),
      ];
    },
  },
  listening: {
    duration: 6,
    steps: 30,
    tracks(times) {
      return [
        { bone: 'spine', values: times.map((t) => q(0.055 + Math.sin((t * Math.PI * 2) / 6) * 0.008, 0, 0)) },
        { bone: 'chest', values: times.map((t) => q(0, 0, Math.sin((t * Math.PI * 2) / 6) * 0.012)) },
        { bone: 'neck', values: times.map((t) => q(0.035 + Math.sin((t * Math.PI * 4) / 6) * 0.012, 0, 0)) },
        { bone: 'rightUpperArm', values: times.map(() => q(0, 0, -1.25)) },
        { bone: 'rightLowerArm', values: times.map(() => q(0, 0, -0.15)) },
        ...restArmTracks(times),
      ];
    },
  },
  selecting: {
    duration: 4,
    steps: 24,
    tracks(times) {
      return [
        { bone: 'spine', values: times.map((t) => q(0, 0.045 + Math.sin((t * Math.PI * 2) / 4) * 0.008, 0)) },
        { bone: 'rightUpperArm', values: times.map((t) => {
          const breathe = Math.sin((t * Math.PI * 2) / 4) * 0.025;
          return q(0.18, 0, -0.92 + breathe);
        }) },
        { bone: 'rightLowerArm', values: times.map((t) => q(-0.08, 0, -0.42 + Math.sin((t * Math.PI * 2) / 4) * 0.025)) },
        { bone: 'leftUpperArm', values: times.map(() => q(0, 0, 1.25)) },
        { bone: 'leftLowerArm', values: times.map(() => q(0, 0, 0.15)) },
      ];
    },
  },
};

function buildVrma(name, spec) {
  const times = Array.from({ length: spec.steps + 1 }, (_, i) => (i * spec.duration) / spec.steps);
  const tracks = spec.tracks(times);
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
    const acc = { bufferView: bufferViews.length - 1, componentType: 5126, count: flat.length / comp, type };
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
    channels.push({ sampler: samplers.length - 1, target: { node: nodeIndex[track.bone], path: 'rotation' } });
  }

  const gltf = {
    asset: { version: '2.0', generator: 'open-reception scripts/generate-standard-vrma.mjs' },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: { humanBones: Object.fromEntries(nodes.map((n, i) => [n.name, { node: i }])) },
      },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    animations: [{ name, samplers, channels }],
    bufferViews,
    accessors,
    buffers: [{ byteLength: byteOffset }],
  };

  const pad4 = (buf, fill) => {
    const rem = buf.length % 4;
    return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem, fill)]);
  };
  const jsonChunk = pad4(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20);
  const binChunk = pad4(Buffer.concat(chunks), 0x00);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

for (const [name, spec] of Object.entries(specs)) {
  const out = join(OUT_DIR, `${name}.vrma`);
  const buffer = buildVrma(name, spec);
  writeFileSync(out, buffer);
  console.log(`wrote ${out} (${buffer.length} bytes)`);
}
