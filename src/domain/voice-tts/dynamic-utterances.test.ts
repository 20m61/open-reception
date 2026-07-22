import { describe, it, expect } from 'vitest';
import {
  buildStaffCalledAnnouncement,
  buildDepartmentGuidanceAnnouncement,
  buildExceptionAnnouncement,
} from './dynamic-utterances';

describe('buildStaffCalledAnnouncement (issue #371 AC: 動的な担当者名を含む案内を生成できる)', () => {
  it('embeds the staff name in the display text', () => {
    const text = buildStaffCalledAnnouncement({ staffName: '田中太郎' });
    expect(text.displayText).toContain('田中太郎');
  });

  it('uses the reading for speechText when provided, separate from the kanji display text', () => {
    const text = buildStaffCalledAnnouncement({ staffName: '田中太郎', staffNameReading: 'たなか たろう' });
    expect(text.speechText).toContain('たなか たろう');
    expect(text.speechText).not.toContain('田中太郎');
  });

  it('falls back to the display name for speech when no reading is given', () => {
    const text = buildStaffCalledAnnouncement({ staffName: 'Taro' });
    expect(text.speechText).toContain('Taro');
  });

  it('includes the department name when provided (dynamic な部門名を含む案内)', () => {
    const text = buildStaffCalledAnnouncement({ staffName: '田中太郎', departmentName: '総務部' });
    expect(text.displayText).toContain('総務部');
    expect(text.displayText).toContain('田中太郎');
  });

  it('two different staff names produce two different display texts (not a canned/static phrase)', () => {
    const a = buildStaffCalledAnnouncement({ staffName: '田中太郎' });
    const b = buildStaffCalledAnnouncement({ staffName: '鈴木花子' });
    expect(a.displayText).not.toBe(b.displayText);
  });
});

describe('buildDepartmentGuidanceAnnouncement (動的な部門名の案内, issue #371 AC)', () => {
  it('embeds the department name in both display and speech text', () => {
    const text = buildDepartmentGuidanceAnnouncement({ departmentName: '経理部' });
    expect(text.displayText).toContain('経理部');
    expect(text.speechText).toContain('経理部');
  });

  it('uses the reading when provided', () => {
    const text = buildDepartmentGuidanceAnnouncement({ departmentName: '経理部', departmentNameReading: 'けいりぶ' });
    expect(text.speechText).toContain('けいりぶ');
    expect(text.speechText).not.toContain('経理部');
  });
});

describe('buildExceptionAnnouncement (例外案内, issue #371 契約: 動的生成は担当者名・部門名・例外案内へ限定)', () => {
  it('embeds a free-form reason into the guidance text', () => {
    const text = buildExceptionAnnouncement({ reason: 'ただいま担当者が不在です' });
    expect(text.displayText).toContain('ただいま担当者が不在です');
  });

  it('has no PII beyond what the caller explicitly passed in (no hidden enrichment)', () => {
    const text = buildExceptionAnnouncement({ reason: 'しばらくお待ちください' });
    expect(text.displayText).not.toMatch(/[0-9]{4,}/); // 電話番号等の混入がないことの簡易チェック
  });
});
