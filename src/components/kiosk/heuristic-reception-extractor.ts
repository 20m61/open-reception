import type { ReceptionPurposeId } from '@/domain/reception/session';
import type {
  ReceptionSlotProposal,
  ReceptionUtteranceExtractor,
  ReceptionUtteranceExtractionRequest,
} from '@/domain/reception/slot-proposal';
import type { Directory } from './useEffectiveConfiguration';

const PURPOSE_PATTERNS: ReadonlyArray<{
  purpose: ReceptionPurposeId;
  pattern: RegExp;
}> = [
  { purpose: 'delivery', pattern: /(納品|配送|配達|荷物)/ },
  { purpose: 'interview', pattern: /(打ち合わせ|打合せ|ミーティング|会議)/ },
  { purpose: 'meeting', pattern: /(面会|会いに|お会い|訪問)/ },
  { purpose: 'other', pattern: /(その他|別の用件)/ },
];

function compact(value: string): string {
  return value.replace(/[\s　]/g, '').toLowerCase();
}

function stripHonorific(value: string): string {
  return value.replace(/(さん|様|さま)$/u, '').trim();
}

function targetQueryFromTranscript(transcript: string, directory: Directory): string | undefined {
  const compactTranscript = compact(transcript);

  // 長い表記を優先。同姓の姓だけが含まれる場合は姓queryを返し、既存resolverへ曖昧性判定を委ねる。
  const candidates: Array<{ query: string; key: string; score: number }> = [];
  for (const staff of directory.staff) {
    const display = compact(staff.displayName);
    if (display && compactTranscript.includes(display)) {
      candidates.push({ query: staff.displayName, key: display, score: display.length + 100 });
    }
    for (const alias of staff.aliases ?? []) {
      const key = compact(alias);
      if (key && compactTranscript.includes(key)) {
        candidates.push({ query: alias, key, score: key.length + 80 });
      }
    }
    const surname = stripHonorific(staff.displayName.trim().split(/[\s　]+/u)[0] ?? '');
    const surnameKey = compact(surname);
    if (surnameKey && compactTranscript.includes(`${surnameKey}さん`)) {
      candidates.push({ query: surname, key: surnameKey, score: surnameKey.length + 20 });
    }
  }
  for (const department of directory.departments) {
    const key = compact(department.name);
    if (key && compactTranscript.includes(key)) {
      candidates.push({ query: department.name, key, score: key.length + 60 });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.query;
}

function purposeFromTranscript(transcript: string): ReceptionPurposeId | undefined {
  return PURPOSE_PATTERNS.find(({ pattern }) => pattern.test(transcript))?.purpose;
}

function extractCompanyAndName(
  transcript: string,
  focus: ReceptionUtteranceExtractionRequest['focus'],
): { company?: string; visitorName?: string; confidence?: number } {
  const text = transcript.trim();
  if (!text) return {};

  // 「株式会社〇〇の張です」「〇〇株式会社の張と申します」の両方を扱う。
  const companyAndName = text.match(
    /((?:(?:株式会社|合同会社|有限会社)[^。、「」]{1,30}|[^。、「」]{1,30}(?:株式会社|合同会社|有限会社)))の([^。、「」]{1,20}?)(?:です|と申します|ともうします)(?:[。！!]|$)/u,
  );
  if (companyAndName) {
    return {
      company: companyAndName[1]?.trim(),
      visitorName: companyAndName[2]?.trim(),
      confidence: 0.96,
    };
  }

  // 明示的な自己紹介。
  const explicit = text.match(
    /(?:私は|わたしは|名前は|お名前は)?\s*([^。、「」]{1,20}?)(?:と申します|ともうします)(?:[。！!]|$)/u,
  );
  if (explicit?.[1]) {
    return { visitorName: explicit[1].trim(), confidence: 0.96 };
  }

  const selfNamed = text.match(
    /(?:私は|わたしは|名前は)\s*([^。、「」]{1,20}?)(?:です|でございます)(?:[。！!]|$)/u,
  );
  if (selfNamed?.[1]) {
    return { visitorName: selfNamed[1].trim(), confidence: 0.94 };
  }

  // 「…来ました。張です」のような最後の短い節。targetの「鈴木さんです」と混同しないよう
  // 「さん/様」を含む候補は除外する。
  const clauses = text.split(/[。！？!?、,]/u).map((part) => part.trim()).filter(Boolean);
  const last = clauses.at(-1) ?? '';
  const shortName = last.match(/^([^\s]{1,12}?)(?:です|でございます)$/u);
  if (shortName?.[1] && !/(さん|様|さま)$/u.test(shortName[1])) {
    return { visitorName: shortName[1].trim(), confidence: focus === 'visitorName' ? 0.92 : 0.84 };
  }

  // visitorNameを聞いている局面なら「張」のような単語だけの返答も受ける。
  if (focus === 'visitorName' && /^[^\s。！？!?、,]{1,12}$/u.test(text) && !/(さん|様|さま)$/u.test(text)) {
    return { visitorName: text, confidence: 0.86 };
  }

  return {};
}

/**
 * 実LLM接続前の決定論的extractor (#1077/#1081)。
 *
 * できることだけを高信頼で提案し、分からないslotは作らない。
 * targetはIDではなくqueryだけ。最終的な実在確認・曖昧性判定は `resolveReceptionSlotProposal`
 * が既存directory resolverを使って行う。
 */
export function createHeuristicReceptionUtteranceExtractor(
  directory: Directory,
): ReceptionUtteranceExtractor {
  return {
    async extract(request): Promise<ReceptionSlotProposal> {
      const purpose = purposeFromTranscript(request.transcript);
      const targetQuery = targetQueryFromTranscript(request.transcript, directory);
      const self = extractCompanyAndName(request.transcript, request.focus);

      return {
        ...(purpose ? { purpose: { value: purpose, confidence: 0.92 } } : {}),
        ...(targetQuery ? { targetQuery: { value: targetQuery, confidence: 0.9 } } : {}),
        ...(self.visitorName
          ? { visitorName: { value: self.visitorName, confidence: self.confidence ?? 0.84 } }
          : {}),
        ...(self.company
          ? { company: { value: self.company, confidence: self.confidence ?? 0.84 } }
          : {}),
      };
    },
  };
}

/**
 * selectingTargetで旧target-only音声経路を抑止してよい発話かの軽いpreflight。
 * 名前/用件などtarget以外の情報を含む時だけmulti-slot側がclaimする。
 */
export function looksLikeMultiSlotReceptionUtterance(text: string): boolean {
  return (
    PURPOSE_PATTERNS.some(({ pattern }) => pattern.test(text)) ||
    /(と申します|ともうします|私は|わたしは|名前は)/u.test(text) ||
    /[。！？!?][^。！？!?]{1,12}(?:です|でございます)(?:[。！？!?]|$)/u.test(text)
  );
}
