/**
 * DemoStudio の初期レンダリング配線テスト (issue #363 Inc3 公開/共有パネル)。
 *
 * 既存コンポーネントテスト（`kiosk/VoiceReadbackConfirm.test.tsx`）と同じ方針で
 * `renderToStaticMarkup` による初期状態の静的描画のみを検証する（`useEffect` は走らないため
 * fetch/window のモックは不要）。状態遷移を伴う相互作用（保存済みシナリオ選択後の公開パネル
 * 表示等）は `./publish-panel.test.ts`（純ロジック）と各 API route の統合テストで担保する。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DemoStudio } from './DemoStudio';

describe('DemoStudio 初期描画（issue #363 公開/共有パネル配線）', () => {
  it('公開/共有パネルを描画し、未選択時は案内文を出す（組込テンプレートのみでは公開対象が無い）', () => {
    const html = renderToStaticMarkup(<DemoStudio siteId="tenant-demo" />);
    expect(html).toContain('data-testid="demo-pub-panel"');
    expect(html).toContain('data-testid="demo-pub-empty"');
    expect(html).not.toContain('data-testid="demo-pub-create"');
    expect(html).not.toContain('data-testid="demo-pub-status"');
  });

  it('canWrite 未指定（既定 true）では viewer 抑止注記を出さない', () => {
    const html = renderToStaticMarkup(<DemoStudio siteId="tenant-demo" />);
    expect(html).not.toContain('data-testid="demo-pub-viewer-note"');
  });

  it('canWrite=false では viewer 抑止注記を出す（API 403 前提の UI 側抑止）', () => {
    const html = renderToStaticMarkup(<DemoStudio siteId="tenant-demo" canWrite={false} />);
    expect(html).toContain('data-testid="demo-pub-viewer-note"');
    expect(html).toContain('閲覧のみの権限です');
  });

  it('sandbox note・テンプレート一覧など既存 UI は非退行で残る', () => {
    const html = renderToStaticMarkup(<DemoStudio siteId="tenant-demo" />);
    expect(html).toContain('data-testid="demo-studio"');
    expect(html).toContain('data-testid="demo-sandbox-note"');
    expect(html).toContain('data-testid="demo-templates"');
    expect(html).toContain('data-testid="demo-preview-pane"');
  });
});
