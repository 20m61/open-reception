/**
 * WebGL/three.js リソースの解放トラッカー (issue #36)。
 * VrmAvatarViewer の unmount 時に geometry/material/texture/renderer を確実に破棄するため、
 * 破棄対象を登録し一括 dispose する。three.js に依存しない純ロジックでテスト可能にする。
 */
export type Disposable = { dispose: () => void };

export class ResourceTracker {
  private resources = new Set<Disposable>();

  track<T extends Disposable>(resource: T): T {
    this.resources.add(resource);
    return resource;
  }

  /** 登録済みリソースをすべて破棄し、トラッカーを空にする。 */
  disposeAll(): void {
    for (const resource of this.resources) {
      try {
        resource.dispose();
      } catch {
        /* 破棄失敗は無視して継続（受付画面を壊さない） */
      }
    }
    this.resources.clear();
  }

  get size(): number {
    return this.resources.size;
  }
}
