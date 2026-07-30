import { describe, expect, it } from 'vitest';
import { classifyChangeScope, isStepSkippable } from './change-scope';

describe('classifyChangeScope: 変更範囲の分類 (開発速度 / #424)', () => {
  it('文書だけなら docs', () => {
    expect(
      classifyChangeScope([
        'docs/loop-queue.md',
        'docs/ai-development-loop.md',
        'CLAUDE.md',
        'README.md',
        '.github/pull_request_template.md',
        '.github/ISSUE_TEMPLATE/improvement.md',
      ]),
    ).toBe('docs');
  });

  it('ソースが 1 つでも混ざれば code（省略の判断は厳しい方へ倒す）', () => {
    expect(classifyChangeScope(['docs/loop-queue.md', 'src/domain/reception/state.ts'])).toBe(
      'code',
    );
  });

  it('テスト・スクリプト・インフラ・公開アセットも code', () => {
    for (const path of [
      'tests/e2e/kiosk-checkin.spec.ts',
      'scripts/quality-gate.sh',
      'infra/lib/stacks/web-stack.ts',
      'public/avatar/README.md', // public 配下は文書名でもアセット扱い
    ]) {
      expect(classifyChangeScope([path]), path).toBe('code');
    }
  });

  it('設定ファイルと依存マニフェストは code', () => {
    for (const path of [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'next.config.ts',
      'eslint.config.mjs',
      'playwright.config.ts',
    ]) {
      expect(classifyChangeScope([path]), path).toBe('code');
    }
  });

  it('.claude 配下は md でも code（エージェントの挙動を変える設定）', () => {
    for (const path of ['.claude/rules/testing.md', '.claude/settings.json']) {
      expect(classifyChangeScope([path]), path).toBe('code');
    }
  });

  it('**変更ゼロは code**（収集に失敗した可能性があり、そこで省くと最悪へ倒れる）', () => {
    expect(classifyChangeScope([])).toBe('code');
  });

  it('未知の種類のファイルは code へ落ちる（allowlist の補集合で判定している）', () => {
    // docs allowlist を書き忘れて検証が飛ぶ事故を防ぐ設計。将来 `Dockerfile` や
    // `.env.example` が増えても自動的に全ステップが回る。
    for (const path of ['Dockerfile', '.env.example', 'some-new-thing.yaml']) {
      expect(classifyChangeScope([path]), path).toBe('code');
    }
  });
});

describe('isStepSkippable: 省略してよいステップ', () => {
  it('docs ではソースを入力に取る重いステップだけ省略する', () => {
    for (const step of ['build', 'e2e', 'lighthouse', 'sast']) {
      expect(isStepSkippable(step, 'docs'), step).toBe(true);
    }
  });

  it('typecheck / lint / unit は docs でも回す（検出器のバグに対するトリップワイヤ）', () => {
    // ここを省略すると、スコープ誤判定でソースが混ざったときに何も捕まらなくなる。
    for (const step of ['typecheck', 'lint', 'unit']) {
      expect(isStepSkippable(step, 'docs'), step).toBe(false);
    }
  });

  it('secrets / audit は docs でも回す（文書にも鍵は混入しうる）', () => {
    for (const step of ['secrets', 'audit']) {
      expect(isStepSkippable(step, 'docs'), step).toBe(false);
    }
  });

  it('code では何も省略しない', () => {
    for (const step of ['build', 'e2e', 'lighthouse', 'sast', 'typecheck', 'unit']) {
      expect(isStepSkippable(step, 'code'), step).toBe(false);
    }
  });
});
