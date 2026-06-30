/**
 * 永続化バックエンドの抽象 (docs/persistence-design.md)。
 *
 * ストア（directory/reception/kiosk/asset/motion/security/voice/log）は、ここで定義する
 * Collection / Singleton / LogStore のハンドルを通じてデータを読み書きする。
 * バックエンド実装は in-memory（dev/test/CI）と DynamoDB（本番）の 2 つ。
 * 切替は getBackend()（DATA_BACKEND 環境変数）で行う。
 */

/** id を持つアイテムの集合（部署・担当者・端末・アセット・受付セッション）。 */
export interface Collection<T extends { id: string }> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | undefined>;
  /** 作成または上書き（read-modify-write は呼び出し側で行う）。 */
  put(item: T): Promise<void>;
  /**
   * 条件付き書込（compare-and-swap）。**現在保存されている**アイテムが `expected` の全フィールドに
   * 一致するときのみ `item` で上書きし `true` を返す。一致しない / 対象が存在しないなら書き込まず
   * `false`。read→write 間の競合（例: 使い捨てトークンの二重消費）を原子的に防ぐために使う。
   * memory は単一スレッドの同期 check+set、dynamo は PutItem の ConditionExpression で実現する。
   */
  putIfMatches(item: T, expected: Partial<T>): Promise<boolean>;
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
