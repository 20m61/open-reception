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

export type BvhFrame = {
  values: number[];
};

export type ParsedBvh = {
  joints: BvhJoint[];
  frames: BvhFrame[];
  frameTimeSec: number;
};

export type BvhJointSample = {
  position?: [number, number, number];
  rotationDeg?: [number, number, number];
};

export type NormalizedBvhFrame = Record<string, BvhJointSample>;

export type BvhQaOptions = {
  /** Joint aliases used to estimate runtime gaze conflicts. */
  headJointNames?: readonly string[];
  neckJointNames?: readonly string[];
  /** Degrees/frame-step below which a joint is considered still. */
  stillnessVelocityDegPerSec?: number;
  /** Degrees of head/neck motion above which a frame is considered gaze-conflicting. */
  gazeAnimatedVelocityDegPerSec?: number;
  /** Optional externally-computed framing overflow ratio from rendered frames. */
  framingOverflowRatio?: number;
};

const ROTATION_CHANNEL_INDEX: Record<Extract<BvhChannel, `${string}rotation`>, number> = {
  Xrotation: 0,
  Yrotation: 1,
  Zrotation: 2,
};

function tokenizeHierarchyLine(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

/**
 * Minimal deterministic BVH parser for mocopi and other conventional BVH exports.
 * Supports ROOT / JOINT / End Site, OFFSET, CHANNELS and MOTION frames.
 */
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

    const tokens = tokenizeHierarchyLine(line);
    if (tokens[0] === 'ROOT' || tokens[0] === 'JOINT') {
      const name = tokens.slice(1).join(' ');
      if (!name) throw new Error(`BVH joint name missing at line ${i + 1}`);
      pendingJoint = {
        name,
        parent: stack.at(-1),
        offset: [0, 0, 0],
        channels: [],
      };
      joints.push(pendingJoint);
      continue;
    }
    if (tokens[0] === 'End' && tokens[1] === 'Site') {
      inEndSite = true;
      pendingJoint = null;
      continue;
    }
    if (line === '{') {
      if (pendingJoint) {
        stack.push(pendingJoint.name);
        pendingJoint = null;
      }
      continue;
    }
    if (line === '}') {
      if (inEndSite) {
        inEndSite = false;
      } else {
        stack.pop();
      }
      continue;
    }
    if (inEndSite) continue;

    const current = joints.find((joint) => joint.name === stack.at(-1));
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

  const framesLine = lines.slice(motionLine + 1).findIndex((line) => /^\s*Frames\s*:/i.test(line));
  const frameTimeLine = lines.slice(motionLine + 1).findIndex((line) => /^\s*Frame\s+Time\s*:/i.test(line));
  if (framesLine < 0 || frameTimeLine < 0) throw new Error('BVH motion metadata missing');

  const framesAbsolute = motionLine + 1 + framesLine;
  const frameTimeAbsolute = motionLine + 1 + frameTimeLine;
  const expectedFrames = Number(lines[framesAbsolute].split(':')[1]?.trim());
  const frameTimeSec = Number(lines[frameTimeAbsolute].split(':')[1]?.trim());
  if (!Number.isFinite(expectedFrames) || expectedFrames < 1) throw new Error('Invalid BVH frame count');
  if (!Number.isFinite(frameTimeSec) || frameTimeSec <= 0) throw new Error('Invalid BVH frame time');

  const totalChannels = joints.reduce((sum, joint) => sum + joint.channels.length, 0);
  const frames: BvhFrame[] = [];
  for (let i = frameTimeAbsolute + 1; i < lines.length && frames.length < expectedFrames; i += 1) {
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

export function normalizeBvhFrames(parsed: ParsedBvh): NormalizedBvhFrame[] {
  return parsed.frames.map((frame) => {
    let cursor = 0;
    const normalized: NormalizedBvhFrame = {};
    for (const joint of parsed.joints) {
      const position: [number, number, number] = [0, 0, 0];
      const rotation: [number, number, number] = [0, 0, 0];
      let hasPosition = false;
      let hasRotation = false;
      for (const channel of joint.channels) {
        const value = frame.values[cursor++];
        if (channel.endsWith('position')) {
          hasPosition = true;
          position[channel[0] === 'X' ? 0 : channel[0] === 'Y' ? 1 : 2] = value;
        } else if (channel.endsWith('rotation')) {
          hasRotation = true;
          rotation[ROTATION_CHANNEL_INDEX[channel as Extract<BvhChannel, `${string}rotation`>]] = value;
        }
      }
      normalized[joint.name] = {
        ...(hasPosition ? { position } : {}),
        ...(hasRotation ? { rotationDeg: rotation } : {}),
      };
    }
    return normalized;
  });
}

function magnitude3(v: readonly number[]): number {
  return Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
}

function angularDeltaDeg(a: readonly number[], b: readonly number[]): number {
  const wrapped = a.map((value, i) => {
    const raw = value - (b[i] ?? 0);
    return ((raw + 180) % 360 + 360) % 360 - 180;
  });
  return magnitude3(wrapped);
}

function maxRotationError(frame: NormalizedBvhFrame, reference?: NormalizedBvhFrame): number {
  let max = 0;
  for (const [name, sample] of Object.entries(frame)) {
    if (!sample.rotationDeg) continue;
    const referenceRotation = reference?.[name]?.rotationDeg ?? [0, 0, 0];
    max = Math.max(max, angularDeltaDeg(sample.rotationDeg, referenceRotation));
  }
  return max;
}

function frameAngularVelocity(
  previous: NormalizedBvhFrame,
  current: NormalizedBvhFrame,
  frameTimeSec: number,
  jointNames?: ReadonlySet<string>,
): number {
  let max = 0;
  for (const [name, sample] of Object.entries(current)) {
    if (jointNames && !jointNames.has(name.toLowerCase())) continue;
    if (!sample.rotationDeg) continue;
    const before = previous[name]?.rotationDeg;
    if (!before) continue;
    max = Math.max(max, angularDeltaDeg(sample.rotationDeg, before) / frameTimeSec);
  }
  return max;
}

/** Convert parsed motion into the metrics consumed by Motion Lab QA gates. */
export function deriveBvhQaMetrics(parsed: ParsedBvh, options: BvhQaOptions = {}): MotionQaMetrics {
  const frames = normalizeBvhFrames(parsed);
  if (frames.length === 0) throw new Error('BVH contains no frames');

  const durationSec = frames.length * parsed.frameTimeSec;
  const neutralStartErrorDeg = maxRotationError(frames[0]);
  const neutralEndErrorDeg = maxRotationError(frames.at(-1)!);
  const loopSeamErrorDeg = maxRotationError(frames.at(-1)!, frames[0]);

  let maxJointAngleDeg = 0;
  for (const frame of frames) maxJointAngleDeg = Math.max(maxJointAngleDeg, maxRotationError(frame));

  const velocities: number[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    velocities.push(frameAngularVelocity(frames[i - 1], frames[i], parsed.frameTimeSec));
  }
  const accelerations: number[] = [];
  for (let i = 1; i < velocities.length; i += 1) {
    accelerations.push((velocities[i] - velocities[i - 1]) / parsed.frameTimeSec);
  }
  const jerks: number[] = [];
  for (let i = 1; i < accelerations.length; i += 1) {
    jerks.push(Math.abs(accelerations[i] - accelerations[i - 1]) / parsed.frameTimeSec);
  }
  const peakJerkDegPerSec3 = jerks.length ? Math.max(...jerks) : 0;

  const stillThreshold = options.stillnessVelocityDegPerSec ?? 8;
  const stillnessRatio = velocities.length
    ? velocities.filter((velocity) => velocity <= stillThreshold).length / velocities.length
    : 1;

  const aliases = [...(options.headJointNames ?? ['head']), ...(options.neckJointNames ?? ['neck'])]
    .map((name) => name.toLowerCase());
  const gazeSet = new Set(aliases);
  const gazeThreshold = options.gazeAnimatedVelocityDegPerSec ?? 12;
  let animatedHeadNeckFrames = 0;
  for (let i = 1; i < frames.length; i += 1) {
    if (frameAngularVelocity(frames[i - 1], frames[i], parsed.frameTimeSec, gazeSet) > gazeThreshold) {
      animatedHeadNeckFrames += 1;
    }
  }
  const headNeckAnimatedRatio = frames.length > 1 ? animatedHeadNeckFrames / (frames.length - 1) : 0;

  return {
    durationSec,
    neutralStartErrorDeg,
    neutralEndErrorDeg,
    loopSeamErrorDeg,
    maxJointAngleDeg,
    peakJerkDegPerSec3,
    stillnessRatio,
    framingOverflowRatio: options.framingOverflowRatio ?? 0,
    headNeckAnimatedRatio,
  };
}
