/**
 * 代替導線の文言が、システムが実際にすることと一致していること (#736 Gate A)。
 *
 * ## 事実
 *
 * `POST /api/kiosk/receptions/:id/fallback` がすることは `recordFallback` だけで、その中身は
 * 受付履歴の `fallbackUsed` を立てることに尽きる。**通知は 1 件も飛ばない**:
 *
 *   - `fallbackUsed` の本番消費者は集計・履歴のみ（`dashboard-summary` / `usage-summary`）
 *   - `src/app/api/kiosk/**` から通知モジュールへの import はゼロ
 *   - `src/server/notification/handler.ts` の本番呼び出し元もゼロ（worker Lambda 未デプロイ）
 *   - 常時見張るスタッフ画面も無い（`src/app/staff` は `calls/[id]` の 1 枚だけ）
 *
 * それなのに文言は「代表窓口にお繋ぎします。受付スタッフが対応いたしますので、しばらく
 * お待ちください。」だった。**来訪者は待てば人が来ると読んで待ち、誰も来ない。**
 * `unrouted`（#738）と `out_of_hours` で塞いだのと同型の嘘。
 *
 * ## なぜ語彙で縛らないか
 *
 * 「お繋ぎします」を禁止語にする書き方は**言い換えで壊れる**（この周回で 2 度踏んだ）。
 * 代わりに **実装と文言を組にして**縛る:
 *
 *   「代替導線ルートが通知を配線していない限り、文言は来訪者を**人へ向かわせ**、
 *    かつ**待てと言わない**こと」
 *
 * 通知を配線した人は最初の assertion で落ちるので、そのとき文言を見直す判断が要る。
 *
 * 🔴 **「人に言及しているか」だけでは足りなかった。** 元の文言
 * 「代表窓口にお繋ぎします。**受付スタッフ**が対応いたしますので、しばらくお待ちください。」は
 * 「スタッフ」を含むので素通りする（実測）。嘘の本体は人への言及ではなく
 * **「待っていれば人が来る」と指示していること**なので、そちらを縛る。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeT, type Locale } from '@/lib/i18n';

const FALLBACK_ROUTE = 'src/app/api/kiosk/receptions/[id]/fallback/route.ts';

/** 来訪者を人へ向かわせているか（各ロケールで「人に声をかける」に相当する語）。 */
const DIRECTS_TO_PERSON: Record<Locale, RegExp> = {
  ja: /スタッフ|係|人/,
  en: /staff|attendant|someone/i,
  ko: /직원|담당자/,
  zh: /人员|工作人员|前台/,
  'ja-simple': /スタッフ|受付の 人|人/,
};

/**
 * 「待っていれば人が来る」と指示していないか。**誰にも通知が飛ばないので、待たせると
 * そのまま放置になる。** ここが嘘の本体。
 */
const TELLS_VISITOR_TO_WAIT: Record<Locale, RegExp> = {
  ja: /お待ち|お待ち下さい|しばらく/,
  en: /\bwait\b|shortly|momentarily|in a moment/i,
  ko: /기다려|잠시만/,
  zh: /稍候|等候|请稍|稍等/,
  'ja-simple': /お待ち|まって|まっ て/,
};

describe('代替導線の約束と実装の一致 (#736)', () => {
  /**
   * 🔴 これが赤くなったら「通知が配線された」ということ。
   * そのとき文言を「お待ちください」系へ戻してよいかを**人が判断する**。
   */
  it('代替導線ルートは通知を配線していない（配線したら文言を見直す）', () => {
    const source = readFileSync(FALLBACK_ROUTE, 'utf8');
    expect(source).not.toMatch(/notification|notify/i);
  });

  it('🔴 文言は来訪者を人へ向かわせる', () => {
    for (const locale of Object.keys(DIRECTS_TO_PERSON) as Locale[]) {
      const text = makeT(locale)('reception.fallbackBody');
      expect(text, `${locale} の文言が人へ向かわせていない: ${text}`).toMatch(
        DIRECTS_TO_PERSON[locale],
      );
    }
  });

  /**
   * 🔴 **ここが本体。** 通知が飛ばない以上、待たせるとそのまま放置になる。
   * 「人」に言及していても「お待ちください」が付いていたら嘘のままなので、別に見る。
   */
  it('🔴 文言は来訪者に待てと言わない（誰にも通知が飛ばないため）', () => {
    for (const locale of Object.keys(TELLS_VISITOR_TO_WAIT) as Locale[]) {
      const text = makeT(locale)('reception.fallbackBody');
      expect(text, `${locale} の文言が待つよう指示している: ${text}`).not.toMatch(
        TELLS_VISITOR_TO_WAIT[locale],
      );
    }
  });

  it('全 locale で文言が引ける（未翻訳のキーを作らない）', () => {
    for (const locale of Object.keys(DIRECTS_TO_PERSON) as Locale[]) {
      const text = makeT(locale)('reception.fallbackBody');
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toBe('reception.fallbackBody');
    }
  });
});
