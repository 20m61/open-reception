/**
 * 管理画面の読み取り状態 (#870 増分 04)。
 *
 * 🔴 **実装は `src/domain/ui/read-state.ts` へ移した**（#1004 増分 2）。来訪者導線が
 * 同じ問題を手で導き直して規則を外したため、両方から使える場所へ置いた。
 * ここは既存 15 箇所の import を変えないための再輸出だけを持つ。
 */
export type { ReadState as AdminReadState, ReadStateInput as AdminReadStateInput } from '@/domain/ui/read-state';
export { resolveReadState as resolveAdminReadState } from '@/domain/ui/read-state';
