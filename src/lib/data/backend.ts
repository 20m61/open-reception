/**
 * 永続化バックエンドの抽象 (docs/persistence-design.md)。
 *
 * ストア（directory/reception/kiosk/asset/motion/security/voice/log）は、ここで定義する
 * Collection / Singleton / LogStore のハンドルを通じてデータを読み書きする。
 * バックエンド実装は in-memory（dev/test/CI）と DynamoDB（本番）の 2 つ。
 * 切替は getBackend()（DATA_BACKEND 環境変数）で行う。
 */

/**
 * Collection.list() の既定上限（#274 inc1）。パーティション内の無境界読みを防ぐ安全弁であり、
 * これを超える集合は「増加し得る一覧」なので、呼び出し側で limit を明示するか、境界付き
 * クエリ（GSI / 維持カウンタ、#284）へ移行する。上限超過時は各バックエンドが warn を出して
 * 切り詰める（サイレントに欠落させない）。
 */
export const DEFAULT_COLLECTION_LIST_LIMIT = 500;

/** Collection.list() のオプション（#274 inc1）。 */
export interface ListOptions {
  /** 返す最大件数。省略時は DEFAULT_COLLECTION_LIST_LIMIT。0 以下は空配列。 */
  limit?: number;
}

/** id を持つアイテムの集合（部署・担当者・端末・アセット・受付セッション）。 */
export interface Collection<T extends { id: string }> {
  /**
   * パーティション内の全件を返す — ただし**上限つき**（options.limit、既定
   * DEFAULT_COLLECTION_LIST_LIMIT）。上限を超えた分は切り詰められ warn が出る（#274）。
   * 切り詰めが業務上許されない集合は、境界付きクエリへの移行（#284）を計画すること。
   */
  list(options?: ListOptions): Promise<T[]>;
  get(id: string): Promise<T | undefined>;
  /** 作成または上書き（read-modify-write は呼び出し側で行う）。 */
  put(item: T): Promise<void>;
  /**
   * 条件付き**部分更新**（atomic compare-and-set）。対象 id の**現在値**が `expected` の全フィールドに
   * 一致するときのみ、`changes` のフィールドだけを更新し `true` を返す。値が `undefined` の changes は
   * 属性削除（REMOVE）。一致しない / 対象が存在しないなら何もせず `false`。
   *
   * アイテム**全体を置換しない**ため、read→write 間に別フィールドへ並行更新が入っても失われない
   * （lost-update を避ける）。使い捨てトークンの二重消費防止などに使う。memory は単一スレッドの同期
   * read-modify-write、dynamo は UpdateItem(SET/REMOVE) + ConditionExpression で実現する。
   */
  updateIf(id: string, changes: Partial<T>, expected: Partial<T>): Promise<boolean>;
  remove(id: string): Promise<void>;
  /** テスト/seed 用に初期状態へ戻す（memory のみ実効、dynamo は no-op）。 */
  reset(): Promise<void>;
}

/** 単一アイテムの設定（active assets / motion mapping / security / voice）。 */
export interface Singleton<T> {
  /** 未保存なら undefined。呼び出し側が DEFAULTS にフォールバックする。 */
  get(): Promise<T | undefined>;
  put(value: T): Promise<void>;
  reset(): Promise<void>;
}

/** 時系列で追記するログ（受付履歴・監査ログ）。キーは <timestamp>#id。 */
export interface LogStore<T extends { id: string }> {
  /** 作成または上書き（同一 id は置換）。 */
  put(item: T): Promise<void>;
  /** 新しい順（timestampField 降順）で返す。 */
  list(): Promise<T[]>;
  /**
   * `timestampField >= sinceIso`（含む）のログのみを新しい順で返す (issue #254)。全件走査を避け、
   * ダッシュボード等の「直近 N 日/当月」集計を境界付きクエリで取得するために使う。dynamo は SK 範囲
   * クエリ（`SK >= :since`）、memory は走査フィルタで実現する。
   */
  listSince(sinceIso: string): Promise<T[]>;
  /** 指定フィールド一致の最初の 1 件（dynamo は GSI、memory は走査）。 */
  findBy(field: keyof T & string, value: string): Promise<T | undefined>;
  reset(): Promise<void>;
}

export interface CollectionOpts<T extends { id: string }> {
  /** memory バックエンド専用の初期データ。dynamo は無視する。 */
  seed?: () => T[];
  /** dynamo の TTL 秒数（put 時に ttl 属性を付与）。memory は無視。 */
  ttlSeconds?: number;
}

export interface LogOpts<T extends { id: string }> {
  /** 並び替えに使うタイムスタンプフィールド（ISO 文字列、新しい順に降順）。 */
  timestampField: keyof T & string;
  /** findBy で使うインデックス対象フィールド（dynamo は GSI1 を使用）。 */
  indexedField?: keyof T & string;
}

export interface DataBackend {
  collection<T extends { id: string }>(name: string, opts?: CollectionOpts<T>): Collection<T>;
  singleton<T>(name: string, opts?: { default?: () => T }): Singleton<T>;
  log<T extends { id: string }>(name: string, opts: LogOpts<T>): LogStore<T>;
}
