/**
 * アセットストレージの adapter 境界 (issue #27)。
 * 本番では S3 等の実装に差し替え、署名付き URL を発行する。
 */
export type StoredObject = { url: string; sizeBytes: number; contentType: string };

export interface StorageAdapter {
  /** ファイルを保存して参照 URL を返す。 */
  put(key: string, data: ArrayBuffer, contentType: string): Promise<StoredObject>;
  /** 参照 URL を取得する（必要なら署名付き）。 */
  getUrl(key: string): Promise<string>;
}
