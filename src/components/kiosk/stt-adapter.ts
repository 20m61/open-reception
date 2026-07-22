/**
 * KioskFlow が使う音声認識(STT)の注入点 (issue #370 injection point 2)。
 *
 * 従来は担当者検索の音声入力が `MockSttAdapter` 直結だった。これを外部注入可能なファクトリに
 * 切り出し、既定は現行の Mock 実装で **無変更動作**を保つ。将来 #370 の `StreamingSttProvider`
 * などを接続できるよう、ここでは中立の `SttAdapter` interface のみに依存し、実 provider を
 * 直接 import しない（音声トランスポート/実機依存は #65 で検証）。
 */
import type { SttAdapter } from '@/adapters/speech/types';
import { MockSttAdapter } from '@/adapters/speech/mock-stt';

export type { SttAdapter };

/**
 * 認識候補の生成元（在席担当者名など）を受け取り STT アダプタを生成するファクトリ。
 * デモ再現・テスト・実 provider 接続はこのファクトリ差し替えで行う。
 */
export type SttAdapterFactory = (phrases: string[]) => SttAdapter;

/** 既定ファクトリ: 従来どおり MockSttAdapter を生成する（注入しない時の挙動を固定）。 */
export const defaultSttAdapterFactory: SttAdapterFactory = (phrases) => new MockSttAdapter(phrases);
