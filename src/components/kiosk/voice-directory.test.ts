import { describe, expect, it } from 'vitest';
import { resolveEntities } from '@/domain/voice-stt/entity-resolver';
import { kioskDirectoryToEntityDirectory } from './voice-directory';
import type { Directory, DirStaff } from './useEffectiveConfiguration';

/**
 * 受付端末の Directory → 音声 Entity 解決の入力 (#788)。
 *
 * ここが空だと「配線は正しいのに音声で相手を選べない」（実際にそうなっていた）。逆に
 * 素通しすると**タッチが押させない不在の担当者を音声だけが呼べる**（`SELECT_TARGET` の
 * 先に在席チェックは無い）。両側から縛る。
 */

function staff(over: Partial<DirStaff> & Pick<DirStaff, 'id' | 'displayName'>): DirStaff {
  return {
    aliases: [],
    departmentId: 'dept-1',
    available: true,
    ...over,
  };
}

const DIRECTORY: Directory = {
  departments: [
    { id: 'dept-1', name: '営業部' },
    { id: 'dept-2', name: '技術部' },
  ],
  staff: [
    staff({ id: 'staff-1', displayName: '山田 太郎', kana: 'やまだ たろう', aliases: ['ヤマタロ'] }),
    staff({ id: 'staff-2', displayName: '鈴木 花子', kana: 'すずき はなこ', available: false }),
    staff({ id: 'staff-3', displayName: '佐藤 次郎', departmentId: 'dept-2' }),
  ],
};

/** その表示名で音声解決したときに得られる候補 id（top3 の中に居るか）。 */
function resolvedIds(directory: Directory, query: string): string[] {
  return resolveEntities(kioskDirectoryToEntityDirectory(directory), query).top3.map((c) => c.id);
}

describe('kioskDirectoryToEntityDirectory (#788)', () => {
  /**
   * **上界**: 音声で解決できる担当者は、タッチで押せる担当者を超えない。
   *
   * 在席の組合せを総当たりする。不在の担当者を 1 人でも通すと、音声だけが
   * 「不在です」と表示されているカードの相手を呼べてしまう。
   */
  it('不在の担当者は、在席の組合せが何であっても音声から解決できない', () => {
    const names = DIRECTORY.staff.map((s) => s.displayName);
    for (let mask = 0; mask < 1 << 3; mask += 1) {
      const directory: Directory = {
        departments: DIRECTORY.departments,
        staff: DIRECTORY.staff.map((s, i) => ({ ...s, available: (mask & (1 << i)) !== 0 })),
      };
      directory.staff.forEach((s, i) => {
        const ids = resolvedIds(directory, names[i]!);
        expect(ids.includes(s.id), `mask=${mask} ${s.displayName} available=${s.available}`).toBe(
          s.available,
        );
      });
    }
  });

  /**
   * **下界**: 上界だけなら「全部落とす」実装（＝いまの空配列）で空虚に満たせる。
   * タッチで押せる担当者は必ず音声からも解決できることを併せて縛る。
   */
  it('在席の担当者は表示名・かな・別名のいずれでも解決できる', () => {
    expect(resolvedIds(DIRECTORY, '山田 太郎')).toContain('staff-1');
    expect(resolvedIds(DIRECTORY, 'やまだ')).toContain('staff-1');
    expect(resolvedIds(DIRECTORY, 'ヤマタロ')).toContain('staff-1');
  });

  it('部署も名前から解決できる', () => {
    expect(resolvedIds(DIRECTORY, '営業部')).toContain('dept-1');
    expect(resolvedIds(DIRECTORY, '技術部')).toContain('dept-2');
  });

  /** 取得前（初期値）・取得失敗時。ここで落ちると音声セッションごと起動しない。 */
  it('空の Directory でも例外にならず、候補ゼロを返す', () => {
    const empty = kioskDirectoryToEntityDirectory({ departments: [], staff: [] });
    expect(empty).toEqual({ staff: [], departments: [] });
    expect(resolveEntities(empty, '山田').top1).toBeNull();
  });

  /**
   * 担当者が 1 人も居ない（全員不在・未登録）ときに**部署まで巻き込んで落とさない**。
   * 「担当者が空なら早期 return」で書くと部署が黙って消え、来訪者は部署名を言っても
   * 聞き直され続ける。
   */
  it('担当者が居なくても部署は解決できる', () => {
    const withAbsentOnly: Directory = {
      departments: [{ id: 'dept-1', name: '営業部' }],
      staff: [staff({ id: 'staff-1', displayName: '山田 太郎', available: false })],
    };
    expect(resolvedIds(withAbsentOnly, '営業部')).toContain('dept-1');
    // 🔴 **生の配列が空**のケースも別に縛る。上だけだと「フィルタ後が空」しか見ておらず、
    // `if (directory.staff.length === 0) return {staff:[],departments:[]}` を素通しする
    // （担当者を 1 人も登録していない拠点で、部署が音声から消える）。
    const noStaffAtAll: Directory = { departments: [{ id: 'dept-1', name: '営業部' }], staff: [] };
    expect(resolvedIds(noStaffAtAll, '営業部')).toContain('dept-1');
  });

  /**
   * 呼び出し先（電話番号等）を音声側へ持ち込まない
   * （`.claude/rules/pii-secret-minimization.md`）。いまは `DirStaff` が持たないので実害は
   * 無いが、`Directory` がリッチになったときに黙って通らないよう主張として固定する。
   */
  it('呼び出し先・代替担当者を写さない', () => {
    const mapped = kioskDirectoryToEntityDirectory(DIRECTORY);
    expect(mapped.staff.every((s) => s.callTargets.length === 0)).toBe(true);
    expect(mapped.staff.every((s) => s.fallbackStaffIds.length === 0)).toBe(true);
  });

  /** 旧経路（`/api/kiosk/directory`）は kana/affiliation を持たないことがある。 */
  it('kana が無くても表示名で解決できる', () => {
    const directory: Directory = {
      departments: [],
      staff: [staff({ id: 'staff-9', displayName: '高橋 三郎' })],
    };
    expect(resolvedIds(directory, '高橋 三郎')).toContain('staff-9');
  });
});
