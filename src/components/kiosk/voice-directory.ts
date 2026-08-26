/**
 * 受付端末の Directory → 音声 Entity 解決の入力 (#788)。
 *
 * ## なぜ要るか
 *
 * `KioskFlow` はローカル音声 orchestrator に **空の `EntityDirectory`** を渡していた。
 * 配線（音声候補 → `voiceCandidateToTarget` → `SELECT_TARGET`）自体は正しく、コードを読むと
 * タッチと等価に見えるのに、entity 解決の入力が空なので**音声では誰も選べない**状態だった。
 *
 * ## 素通しにはしない — タッチが押させない相手を音声に呼ばせない
 *
 * 相手選択画面は**不在の担当者もカードとして出す**が、押せない（`aria-disabled`、
 * 「本日不在」バッジ）。一方 `SELECT_TARGET` から先に在席チェックは無く、選ばれた相手は
 * そのまま呼び出しへ進む。つまり Directory をそのまま渡すと、**音声だけが不在の相手を
 * 呼べる**——タッチが塞いだ経路を音声が開ける形になる。
 *
 * そこで在席の担当者だけを解決対象にする。「音声とタッチの等価性」は
 * *タッチで押せるものが音声でも選べる* ことであって、*音声の方が多く選べる* ことではない。
 *
 * ## 不在の相手を名指しされたとき
 *
 * 現状は候補ゼロ → 聞き直し（`bridgeCommittedTurn`）になる。タッチが出す「本日不在です」に
 * 相当する応答は音声側に無く、来訪者は同じ名前を言い直し続けうる。**この非対称は残る**が、
 * 塞ぐべき穴（音声だけが呼べる）とは別問題で、応答の追加は音声 UI の語彙を増やす変更なので
 * 分けて扱う。
 *
 * ## enabled をどう埋めるか
 *
 * `Directory` は受付端末へ出す最小形で `enabled` を持たない。`/api/kiosk/directory` も
 * 実効構成も**有効な部署・担当者だけ**を返すので、ここに届いた時点で全件 enabled である。
 * `resolveStaffEntities` / `resolveDepartmentEntities` の `enabled` フィルタを素通しさせる
 * ために `true` を置く（在席の絞り込みは上の `available` で明示的に行い、`enabled` に
 * 兼ねさせない——読んだ人が「無効な担当者を隠している」と誤読する）。
 */
import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';
import type { Staff } from '@/domain/staff/types';
import type { Department } from '@/domain/department/types';
import type { Directory } from './useEffectiveConfiguration';

/**
 * 受付端末が保持する Directory を、音声 Entity 解決の入力へ写像する。
 *
 * PII を増やさない: 写すのは組織が管理する表示名・かな・別名だけで、呼び出し先
 * （電話番号等）は持ち込まない（`callTargets` は空のまま）。
 */
export function kioskDirectoryToEntityDirectory(directory: Directory): EntityDirectory {
  const staff: Staff[] = directory.staff
    .filter((s) => s.available)
    .map((s) => ({
      id: s.id,
      displayName: s.displayName,
      kana: s.kana,
      aliases: s.aliases,
      departmentId: s.departmentId,
      enabled: true,
      available: true,
      callTargets: [],
      fallbackStaffIds: [],
    }));
  // `displayOrder` は Entity 解決が読まない（`resolveDepartmentEntities` は enabled と
  // name/kana/aliases しか見ない）。型が要求するので Directory の並び順をそのまま置く。
  const departments: Department[] = directory.departments.map((d, index) => ({
    id: d.id,
    name: d.name,
    displayOrder: index,
    enabled: true,
  }));
  return { staff, departments };
}
