import type { MotionQaMetrics } from './qa';

export type BvhChannel =
  | 'Xposition'
  | 'Yposition'
  | 'Zposition'
  | 'Xrotation'
  | 'Yrotation'
  | 'Zrotation';

export type BvhJoint = {
  name: string;
  parent?: string;
  offset: [number, number, number];
  channels: BvhChannel[];
};

export type BvhFrame = { values: number[] };

export type ParsedBvh = {
  joints: BvhJoint[];
  frames: BvhFrame[];
  frameTimeSec: number;
};

type Quaternion = [number, number, number, number];

export type BvhJointSample = {
  position?: [number, number, number];
  /** XYZ values are retained for diagnostics/display only. */
  rotationDeg?: [number, number, number];
  /** Rotation composed in the BVH-declared channel order. */
  rotationQuaternion?: Quaternion;
};

export type NormalizedBvhFrame = Record<string, BvhJointSample>;

export type BvhQaOptions = {
  headJointNames?: readonly string[];
  neckJointNames?: readonly string[];
  stillnessVelocityDegPerSec?: number;
  gazeAnimatedVelocityDegPerSec?: number;
  /** Measured after retarget/render. Omit until that stage exists. */
  framingOverflowRatio?: number;
  /** Calibrated rest/reference pose. Omit until capture calibration is available. */
  neutralReference?: NormalizedBvhFrame;
};

const ROTATION_CHANNEL_INDEX: Record<Extract<BvhChannel, `${string}rotation`>, number> = {
  Xrotation: 0,
  Yrotation: 1,
  Zrotation: 2,
};

/** Minimal deterministic BVH parser for mocopi and conventional BVH exports. */
export function parseBvh(source: string): ParsedBvh {
  const lines = source.replace(/\r/g, '').split('\n');
  const joints: BvhJoint[] = [];
  const stack: string[] = [];
  let pendingJoint: BvhJoint | null = null;
  let inEndSite = false;
  let motionLine = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line === 'MOTION') {
      motionLine = i;
      break;
    }

    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens[0] === 'ROOT' || tokens[0] === 'JOINT') {
      const name = tokens.slice(1).join(' ');
      if (!name) throw new Error(`BVH joint name missing at line ${i + 1}`);
      pendingJoint = { name, parent: stack.at(-1), offset: [0, 0, 0], channels: [] };
      joints.push(pendingJoint);
      continue;
    }
    if (tokens[0] === 'End' && tokens[1] === 'Site') {
      inEndSite = true;
      pendingJoint = null;
      continue;
    }
    if (line === '{') {
      if (!inEndSite && pendingJoint) {
        stack.push(pendingJoint.name);
        pendingJoint = null;
      }
      continue;
    }
    if (line === '}') {
      if (inEndSite) inEndSite = false;
      else stack.pop();
      continue;
    }
    if (inEndSite) continue;

    const currentName = stack.at(-1);
    const current = currentName ? joints.find((joint) => joint.name === currentName) : undefined;
    if (!current) continue;

    if (tokens[0] === 'OFFSET' && tokens.length >= 4) {
      current.offset = [Number(tokens[1]), Number(tokens[2]), Number(tokens[3])];
      continue;
    }
    if (tokens[0] === 'CHANNELS') {
      const count = Number(tokens[1]);
      const channels = tokens.slice(2, 2 + count) as BvhChannel[];
      if (channels.length !== count) throw new Error(`BVH channel count mismatch at line ${i + 1}`);
      current.channels = channels;
    }
  }

  if (motionLine < 0) throw new Error('BVH MOTION section not found');
  if (joints.length === 0) throw new Error('BVH contains no joints');

  const motionLines = lines.slice(motionLine + 1);
  const framesOffset = motionLines.findIndex((line) => /^\s*Frames\s*:/i.test(line));
  const frameTimeOffset = motionLines.findIndex((line) => /^\s*Frame\s+Time\s*:/i.test(line));
  if (framesOffset < 0 || frameTimeOffset < 0) throw new Error('BVH motion metadata missing');

  const framesLine = motionLine + 1 + framesOffset;
  const frameTimeLine = motionLine + 1 + frameTimeOffset;
  const expectedFrames = Number(lines[framesLine].split(':')[1]?.trim());
  const frameTimeSec = Number(lines[frameTimeLine].split(':')[1]?.trim());
  if (!Number.isFinite(expectedFrames) || expectedFrames < 1) throw new Error('Invalid BVH frame count');
  if (!Number.isFinite(frameTimeSec) || frameTimeSec <= 0) throw new Error('Invalid BVH frame time');

  const totalChannels = joints.reduce((sum, joint) => sum + joint.channels.length, 0);
  const frames: BvhFrame[] = [];
  for (let i = frameTimeLine + 1; i < lines.length && frames.length < expectedFrames; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = line.split(/\s+/).map(Number);
    if (values.some((value) => !Number.isFinite(value))) throw new Error(`Invalid BVH frame at line ${i + 1}`);
    if (values.length !== totalChannels) {
      throw new Error(`BVH frame channel mismatch at line ${i + 1}: expected ${totalChannels}, got ${values.length}`);
    }
    frames.push({ values });
  }
  if (frames.length !== expectedFrames) {
    throw new Error(`BVH frame count mismatch: expected ${expectedFrames}, got ${frames.length}`);
  }

  return { joints, frames, frameTimeSec };
}

function multiplyQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function axisQuaternion(channel: Extract<BvhChannel, `${string}rotation`>, degrees: number): Quaternion {
  const radians = degrees * Math.PI / 180;
  const half = radians / 2;
  const s = Math.sin(half);
  const c = Math.cos(half);
  if (channel === 'Xrotation') return [s, 0, 0, c];
  if (channel === 'Yrotation') return [0, s, 0, c];
  return [0, 0, s, c];
}

function normalizeQuaternion(q: Quaternion): Quaternion {
  const length = Math.hypot(...q);
  return length === 0 ? [0, 0, 0, 1] : q.map((v) => v / length) as Quaternion;
}

export function normalizeBvhFrames(parsed: ParsedBvh): NormalizedBvhFrame[] {
  return parsed.frames.map((frame) => {
    let cursor = 0;
    const normalized: NormalizedBvhFrame = {};
    for (const joint of parsed.joints) {
      const position: [number, number, number] = [0, 0, 0];
      const rotation: [number, number, number] = [0, 0, 0];
      let quaternion: Quaternion = [0, 0, 0, 1];
      let hasPosition = false;
      let hasRotation = false;
      for (const channel of joint.channels) {
        const value = frame.values[cursor++];
        if (channel.endsWith('position')) {
          hasPosition = true;
          position[channel[0] === 'X' ? 0 : channel[0] === 'Y' ? 1 : 2] = value;
        } else if (channel.endsWith('rotation')) {
          const rotationChannel = channel as Extract<BvhChannel, `${string}rotation`>;
          hasRotation = true;
          rotation[ROTATION_CHANNEL_INDEX[rotationChannel]] = value;
          quaternion = multiplyQuaternion(quaternion, axisQuaternion(rotationChannel, value));
        }
      }
      normalized[joint.name] = {
        ...(hasPosition ? { position } : {}),
        ...(hasRotation ? { rotationDeg: rotation, rotationQuaternion: normalizeQuaternion(quaternion) } : {}),
      };
    }
    return normalized;
  });
}

function quaternionAngularDistanceDeg(a: Quaternion, b: Quaternion): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  const clamped = Math.min(1, Math.max(-1, dot));
  return 2 * Math.acos(clamped) * 180 / Math.PI;
}

function jointRotationDistanceDeg(a?: BvhJointSample, b?: BvhJointSample): number | undefined {
  if (!a?.rotationQuaternion || !b?.rotationQuaternion) return undefined;
  return quaternionAngularDistanceDeg(a.rotationQuaternion, b.rotationQuaternion);
}

function maxRotationError(frame: NormalizedBvhFrame, reference: NormalizedBvhFrame): number {
  let max = 0;
  for (const [name, sample] of Object.entries(frame)) {
    const error = jointRotationDistanceDeg(sample, reference[name]);
    if (error != null) max = Math.max(max, error);
  }
  return max;
}

function identityFrame(frame: NormalizedBvhFrame): NormalizedBvhFrame {
  return Object.fromEntries(
    Object.keys(frame).map((name) => [name, { rotationQuaternion: [0, 0, 0, 1] as Quaternion }]),
  );
}

function jointVelocities(
  previous: NormalizedBvhFrame,
  current: NormalizedBvhFrame,
  frameTimeSec: number,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [name, sample] of Object.entries(current)) {
    const distance = jointRotationDistanceDeg(sample, previous[name]);
    if (distance != null) result.set(name, distance / frameTimeSec);
  }
  return result;
}

function canonicalJointName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchesSemanticJoint(name: string, aliases: readonly string[]): boolean {
  const canonical = canonicalJointName(name);
  return aliases.some((alias) => {
    const candidate = canonicalJointName(alias);
    return canonical === candidate || canonical.endsWith(candidate);
  });
}

/** Convert parsed motion into the metrics consumed by Motion Lab QA gates. */
export function deriveBvhQaMetrics(parsed: ParsedBvh, options: BvhQaOptions = {}): MotionQaMetrics {
  const frames = normalizeBvhFrames(parsed);
  if (frames.length === 0) throw new Error('BVH contains no frames');

  // N frames contain N-1 elapsed intervals.
  const durationSec = Math.max(0, (frames.length - 1) * parsed.frameTimeSec);
  const neutralStartErrorDeg = options.neutralReference
    ? maxRotationError(frames[0], options.neutralReference)
    : undefined;
  const neutralEndErrorDeg = options.neutralReference
    ? maxRotationError(frames.at(-1)!, options.neutralReference)
    : undefined;
  const loopSeamErrorDeg = maxRotationError(frames.at(-1)!, frames[0]);

  let maxJointAngleDeg = 0;
  for (const frame of frames) {
    maxJointAngleDeg = Math.max(maxJointAngleDeg, maxRotationError(frame, identityFrame(frame)));
  }

  const velocityFrames: Map<string, number>[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    velocityFrames.push(jointVelocities(frames[i - 1], frames[i], parsed.frameTimeSec));
  }

  // Derivatives are computed per joint. Taking a frame-wide max first can switch
  // the winning joint between frames and manufacture acceleration/jerk spikes.
  let peakJerkDegPerSec3 = 0;
  const jointNames = new Set(velocityFrames.flatMap((frame) => [...frame.keys()]));
  for (const jointName of jointNames) {
    const velocities = velocityFrames.map((frame) => frame.get(jointName) ?? 0);
    const accelerations = velocities.slice(1).map((value, i) => (value - velocities[i]) / parsed.frameTimeSec);
    const jerks = accelerations.slice(1).map((value, i) => Math.abs(value - accelerations[i]) / parsed.frameTimeSec);
    if (jerks.length) peakJerkDegPerSec3 = Math.max(peakJerkDegPerSec3, ...jerks);
  }

  const stillThreshold = options.stillnessVelocityDegPerSec ?? 8;
  const framePeakVelocities = velocityFrames.map((frame) => Math.max(0, ...frame.values()));
  const stillnessRatio = framePeakVelocities.length
    ? framePeakVelocities.filter((velocity) => velocity <= stillThreshold).length / framePeakVelocities.length
    : 1;

  const gazeAliases = [
    ...(options.headJointNames ?? ['head']),
    ...(options.neckJointNames ?? ['neck']),
  ];
  const gazeThreshold = options.gazeAnimatedVelocityDegPerSec ?? 12;
  let animatedHeadNeckFrames = 0;
  for (const frame of velocityFrames) {
    let peak = 0;
    for (const [name, velocity] of frame.entries()) {
      if (matchesSemanticJoint(name, gazeAliases)) peak = Math.max(peak, velocity);
    }
    if (peak > gazeThreshold) animatedHeadNeckFrames += 1;
  }

  return {
    durationSec,
    neutralStartErrorDeg,
    neutralEndErrorDeg,
    loopSeamErrorDeg,
    maxJointAngleDeg,
    peakJerkDegPerSec3,
    stillnessRatio,
    framingOverflowRatio: options.framingOverflowRatio,
    headNeckAnimatedRatio: velocityFrames.length ? animatedHeadNeckFrames / velocityFrames.length : 0,
  };
}
