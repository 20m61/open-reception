import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openNextArtifactState, describeArtifactState } from '../lib/build-artifacts';

// 実 fs を相手にする。mtime の前後関係そのものが検査対象なので、モックすると
// 「判定ロジックは正しいが実際のファイルでは逆」を見逃す（#628 で実際に踏んだ形）。
const tmpdirs: string[] = [];

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-next-state-'));
  tmpdirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  return dir;
}

/** `.open-next/` の必須成果物を 4 つとも作る。 */
function buildArtifacts(root: string, mtime: Date): void {
  const d = path.join(root, '.open-next');
  fs.mkdirSync(path.join(d, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(d, 'server-functions', 'default'), { recursive: true });
  fs.mkdirSync(path.join(d, 'image-optimization-function'), { recursive: true });
  fs.writeFileSync(path.join(d, 'open-next.output.json'), '{}');
  fs.writeFileSync(path.join(d, 'server-functions', 'default', 'index.mjs'), '');
  fs.writeFileSync(path.join(d, 'image-optimization-function', 'index.mjs'), '');
  fs.utimesSync(path.join(d, 'open-next.output.json'), mtime, mtime);
}

function writeSrc(root: string, mtime: Date): void {
  const f = path.join(root, 'src', 'page.ts');
  fs.writeFileSync(f, 'export const x = 1;');
  fs.utimesSync(f, mtime, mtime);
}

const OLD = new Date('2026-08-01T00:00:00Z');
const NEW = new Date('2026-08-02T00:00:00Z');

afterEach(() => {
  while (tmpdirs.length) fs.rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

describe('openNextArtifactState (#628)', () => {
  it('.open-next が無ければ absent', () => {
    const root = repo();
    writeSrc(root, NEW);
    expect(openNextArtifactState(root).state).toBe('absent');
  });

  it('成果物が 1 つでも欠けていれば absent（output.json だけでは足りない）', () => {
    const root = repo();
    writeSrc(root, OLD);
    buildArtifacts(root, NEW);
    fs.rmSync(path.join(root, '.open-next', 'server-functions', 'default', 'index.mjs'));
    const s = openNextArtifactState(root);
    expect(s.state).toBe('absent');
    // 何が欠けているかを言えること（「未ビルド」だけでは直せない）
    expect(s.missing).toContain(path.join('server-functions', 'default', 'index.mjs'));
  });

  it('成果物が src より新しければ fresh', () => {
    const root = repo();
    writeSrc(root, OLD);
    buildArtifacts(root, NEW);
    expect(openNextArtifactState(root).state).toBe('fresh');
  });

  it('成果物が src より古ければ stale', () => {
    const root = repo();
    buildArtifacts(root, OLD);
    writeSrc(root, NEW);
    expect(openNextArtifactState(root).state).toBe('stale');
  });

  it('stale は「どれくらい古いか」を両方の時刻で示す', () => {
    const root = repo();
    buildArtifacts(root, OLD);
    writeSrc(root, NEW);
    const s = openNextArtifactState(root);
    expect(s.artifactMtime).toBe(OLD.getTime());
    expect(s.newestSrcMtime).toBe(NEW.getTime());
  });

  it('src が空でも fresh 扱い（比較対象が無いことを stale にしない）', () => {
    const root = repo();
    buildArtifacts(root, OLD);
    expect(openNextArtifactState(root).state).toBe('fresh');
  });

  it('同時刻は stale にしない（ビルド直後の等値で落とさない）', () => {
    const root = repo();
    buildArtifacts(root, OLD);
    writeSrc(root, OLD);
    expect(openNextArtifactState(root).state).toBe('fresh');
  });
});

describe('describeArtifactState (#628): 理由が人間に伝わること', () => {
  it('absent は build コマンドを案内する', () => {
    const root = repo();
    const msg = describeArtifactState(openNextArtifactState(root));
    expect(msg).toContain('npm run build:open-next');
  });

  it('stale は両方の時刻を含み、build コマンドを案内する', () => {
    const root = repo();
    buildArtifacts(root, OLD);
    writeSrc(root, NEW);
    const msg = describeArtifactState(openNextArtifactState(root));
    expect(msg).toContain('npm run build:open-next');
    expect(msg).toContain(OLD.toISOString());
    expect(msg).toContain(NEW.toISOString());
  });

  it('fresh は空文字（表示すべき理由が無い）', () => {
    const root = repo();
    buildArtifacts(root, NEW);
    expect(describeArtifactState(openNextArtifactState(root))).toBe('');
  });
});
