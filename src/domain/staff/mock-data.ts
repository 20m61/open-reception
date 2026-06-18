/**
 * MVP 用の担当者・部署の仮データ (issue #13)。
 * 本番では管理画面 / CSV インポート (issue #25, #26) で置き換える。
 *
 * mockCallOutcome により E2E が成功/未応答/失敗/タイムアウトの分岐を
 * 決定的に検証できる (issue #20, #21)。
 */
import type { Department } from '@/domain/department/types';
import type { Staff } from './types';

export const MOCK_DEPARTMENTS: ReadonlyArray<Department> = [
  { id: 'dept-sales', name: '営業部', kana: 'えいぎょうぶ', displayOrder: 1, enabled: true },
  { id: 'dept-dev', name: '開発部', kana: 'かいはつぶ', displayOrder: 2, enabled: true },
  { id: 'dept-hr', name: '人事部', kana: 'じんじぶ', displayOrder: 3, enabled: true },
  { id: 'dept-old', name: '旧総務部', kana: 'きゅうそうむぶ', displayOrder: 4, enabled: false },
];

export const MOCK_STAFF: ReadonlyArray<Staff> = [
  {
    id: 'staff-sato',
    displayName: '佐藤 太郎',
    kana: 'さとう たろう',
    aliases: ['Sato', 'taro'],
    departmentId: 'dept-sales',
    enabled: true,
    available: true,
    mockCallOutcome: 'success',
  },
  {
    id: 'staff-suzuki',
    displayName: '鈴木 花子',
    kana: 'すずき はなこ',
    aliases: ['Suzuki', 'hanako'],
    departmentId: 'dept-dev',
    enabled: true,
    available: true,
    mockCallOutcome: 'no_answer',
  },
  {
    id: 'staff-takahashi',
    displayName: '高橋 健',
    kana: 'たかはし けん',
    aliases: ['Takahashi', 'ken'],
    departmentId: 'dept-dev',
    enabled: true,
    available: true,
    mockCallOutcome: 'failure',
  },
  {
    id: 'staff-tanaka',
    displayName: '田中 美咲',
    kana: 'たなか みさき',
    aliases: ['Tanaka', 'misaki'],
    departmentId: 'dept-hr',
    enabled: true,
    available: true,
    mockCallOutcome: 'timeout',
  },
  {
    id: 'staff-yamada',
    displayName: '山田 直樹（退職）',
    kana: 'やまだ なおき',
    aliases: ['Yamada'],
    departmentId: 'dept-sales',
    enabled: false,
    available: false,
  },
  {
    id: 'staff-ono',
    displayName: '大野 健一',
    kana: 'おおの けんいち',
    aliases: ['Ono'],
    departmentId: 'dept-hr',
    enabled: true,
    available: false,
    mockCallOutcome: 'success',
  },
];
