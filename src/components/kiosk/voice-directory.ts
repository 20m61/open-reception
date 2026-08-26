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
 * ## 不在の相手を名指しされたとき (#803)
 *
 * 「解決対象から外す」と「存在を知らない」は別である。外しただけだと候補ゼロ → 聞き直しになり、
 * 来訪者には「聞き取れなかった」に見えて**同じ名前を言い直し続ける**。そこで不在の担当者を
 * `kioskDirectoryToUnavailableDirectory` として**別の辞書に分けて**渡し、名指しされたことは
 * 認識して理由を伝えられるようにする。**選択肢としては依然として渡さない。**
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
  //
  // 部署は `kana` を持てない。`DirDepartment` は `{id, name}` だけで、サーバ側の
  // `buildVisitorDirectory` も読み仮名を返さない。`search.ts` に漢字→かなの変換は無いので
  // **「えいぎょうぶ」と発話しても「営業部」には当たらない**（担当者は kana が写るので当たる）。
  // demo-studio の合成辞書は kana を持つため、demo だけ解決できる非対称がある。
  const departments: Department[] = directory.departments.map((d, index) => ({
    id: d.id,
    name: d.name,
    displayOrder: index,
    enabled: true,
  }));
  return { staff, departments };
}

/**
 * 受付端末の Directory から、**不在の担当者だけ**の Entity 辞書を作る (#803)。
 *
 * `kioskDirectoryToEntityDirectory` と対になる。あちらは「選ばせてよい相手」、こちらは
 * 「選ばせないが、名指しされたら理由を言う相手」。
 *
 * **部署は含めない。** 部署に「不在」は無い（在席は担当者の属性）。
 *
 * ただし**これが「営業部は現在不在です」を防いでいる本体ではない**。実際に効いているのは
 * `kioskDirectoryToEntityDirectory` が部署を**全件**載せることで、部署名の発話は在席側で
 * 必ず解決され、不在照合まで到達しない（この行を部署入りに変えても振る舞いは変わらない
 * ＝等価変異であることを実測済み）。**在席側の部署フィルタを足す変更が入ったら、ここが
 * 効き始める**ので、そのときのために空にしてある。
 */
export function kioskDirectoryToUnavailableDirectory(directory: Directory): EntityDirectory {
  const staff: Staff[] = directory.staff
    .filter((s) => !s.available)
    .map((s) => ({
      id: s.id,
      displayName: s.displayName,
      kana: s.kana,
      aliases: s.aliases,
      departmentId: s.departmentId,
      enabled: true,
      // 解決器の `available` フィルタを素通りさせるための値で、**在席の意味ではない**
      // （この辞書に居ること自体が「不在」を意味する）。
      available: true,
      callTargets: [],
      fallbackStaffIds: [],
    }));
  return { staff, departments: [] };
}
