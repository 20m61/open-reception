import { describe, expect, it } from 'vitest';
import type { FlowField } from '@/domain/reception/custom-flow';
import { VISITOR_NAME_MAX_LENGTH } from '@/domain/reception/session';
import { applyVoiceName, canSubmitFlowValues, initialFieldValues, isNameFieldTooLong } from './field-values';

/** カスタムフローの氏名の欄 (#1290)。合成データだけを使う。 */
const name: FlowField = { key: 'name', label: 'お名前', type: 'text', required: true };
const company: FlowField = { key: 'company', label: '会社名', type: 'text', required: false };
const host: FlowField = { key: 'host', label: '訪問先', type: 'select', required: true, options: ['A', 'B'] };
const agree: FlowField = { key: 'agree', label: '同意', type: 'checkbox', required: true };

describe('氏名の上限（キーボードにも音声と同じ値）', () => {
  it('上限ちょうどは送信でき、1 文字超えると送信できない', () => {
    const fields = [name];
    expect(canSubmitFlowValues(fields, { name: 'あ'.repeat(VISITOR_NAME_MAX_LENGTH) })).toBe(true);
    expect(isNameFieldTooLong(fields, { name: 'あ'.repeat(VISITOR_NAME_MAX_LENGTH + 1) })).toBe(true);
    expect(canSubmitFlowValues(fields, { name: 'あ'.repeat(VISITOR_NAME_MAX_LENGTH + 1) })).toBe(false);
  });

  it('code point で数える（サロゲートペアの字を 2 と数えない）', () => {
    expect(canSubmitFlowValues([name], { name: '𠮷'.repeat(VISITOR_NAME_MAX_LENGTH) })).toBe(true);
  });

  it('前後の空白・ゼロ幅文字は数えない', () => {
    expect(canSubmitFlowValues([name], { name: `​ ${'あ'.repeat(VISITOR_NAME_MAX_LENGTH)} ​` })).toBe(true);
  });

  it('氏名の欄が無いフローには上限をかけない（他の欄の長さで送信を止めない）', () => {
    expect(isNameFieldTooLong([company], { company: 'あ'.repeat(200) })).toBe(false);
  });

  it('任意の氏名の欄でも、超えたら送信できない', () => {
    const optionalName = { ...name, required: false };
    expect(canSubmitFlowValues([optionalName], { name: '' })).toBe(true);
    expect(canSubmitFlowValues([optionalName], { name: 'あ'.repeat(VISITOR_NAME_MAX_LENGTH + 1) })).toBe(false);
  });
});

describe('applyVoiceName（ADR 0011 §5）', () => {
  it('必須が氏名だけなら、入れたら送信できる', () => {
    const fields = [name, company];
    const result = applyVoiceName(fields, initialFieldValues(fields), '受付 太郎');
    expect(result).toEqual({ values: { name: '受付 太郎', company: '' }, complete: true });
  });

  it('ほかの必須の欄が残っていれば送信しない（complete: false）。ほかの欄の値は変えない', () => {
    const fields = [name, host, agree];
    const values = { name: '', host: 'B', agree: false };
    expect(applyVoiceName(fields, values, '受付')).toEqual({
      values: { name: '受付', host: 'B', agree: false },
      complete: false,
    });
    expect(applyVoiceName(fields, { ...values, agree: true }, '受付').complete).toBe(true);
  });

  it('前後のゼロ幅文字は欄へ入れない', () => {
    expect(applyVoiceName([name], { name: '' }, '​受付​').values.name).toBe('受付');
  });

  it('氏名の欄が無いフローでは何も入れない', () => {
    expect(applyVoiceName([company], { company: '' }, '受付')).toEqual({ values: { company: '' }, complete: false });
  });
});
