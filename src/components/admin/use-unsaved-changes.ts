'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 「まだサーバへ送っていない変更があるか」を追う (#912 / 課題 12)。
 *
 * 対象の設定画面は同じ形をしている —— サーバから読んだ設定オブジェクト 1 つを state に
 * 持ち、`patch` で書き換え、保存すると応答で置き換える。だから dirty は
 * **「いま持っている値が、最後にサーバと同期した値と違うこと」**で決まる。
 *
 * 最初に値が入った時点（＝読み込み完了）を基準にする。保存に成功したら `markSaved` で
 * 基準を進める。
 *
 * 比較は JSON の文字列化で行う。同じ形の入出力を往復するだけなのでキー順は安定しており、
 * 深い比較を自前で書くより読みやすい。**取り違えると「保存したのに未保存と言われる」
 * 側に倒れる**（安全側）ので、この単純さで足りる。
 *
 * **「未設定」と空文字は同じものとして見る (#913)。** 設定が `{}` で読み込まれる画面
 * （ブランド設定は実測でそう）では入力欄が `value={x ?? ''}` で描かれるので、打って消すと
 * 「キーが無い」から `''` へ移る。素の JSON 比較では別物になり、**見た目は元どおりなのに
 * 確認が出て**いた。
 *
 * 決めた方針は #913 の候補 2（**比較側で正規化する**）。根拠は実測で、
 * **サーバ側のストアがすでに両者を同一視している** —— 区別していたのはこの述語だけだった:
 *
 *   - `lib/branding/branding-store.ts` の `resolve()` … 「空/null はクリア」
 *   - `lib/voice/voice-store.ts` … `privacyNotice` 等はいずれも `.trim() || undefined`
 *
 * よって「`''` を意味のある値として扱う設定」は現状 1 つも無く、候補 1（読み込み時に
 * 正規化して PUT の payload を変える）を採る理由が無い。**送るものは一切変えない。**
 */
/**
 * 未保存かどうかの述語（純関数）。
 *
 * 🔴 **フックの外へ出しておく。** node 環境ではフックを回せないので、判定を
 * テスト側へ書き写すと**テストと実装が同じ誤りを共有する**（このリポジトリが
 * 繰り返し踏んでいる型）。実物を import して縛れるようにする。
 */
/**
 * 比較のための正規化。**値の違いではないもの**を落として同じ土俵へ乗せる。
 *
 * 1. **オブジェクトの空文字 / `undefined` のキーを落とす** … 「未設定」と同一視する（#913）。
 *    落とすのはキーそのものなので、「元から未設定だったものが空文字になった」だけが
 *    消える。**値が入っていたものを空にした場合は基準側にキーが残るので dirty のまま**
 *    ——「消した」を握り潰さない（下界としてテストで縛ってある）。
 * 2. **キーを整列する** … `{...prev, x}` は新しいキーを末尾へ足すので、未設定だった項目を
 *    初めて設定すると順序が変わる。順序で dirty を立てると #913 と同じ
 *    「見た目は元どおりなのに出る」型になる。
 *
 * 🔴 **配列は中身に触らない。** 要素の空文字を落とすと**位置がずれて別の値になる**。
 * 要素がオブジェクトなら再帰するだけに留める。
 */
function normalizeForCompare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (typeof value !== 'object' || value === null) return value;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, normalizeForCompare(v)]));
}

function serializeForCompare(value: unknown): string {
  return JSON.stringify(normalizeForCompare(value));
}

export function isDirty(baseline: string | null, current: unknown): boolean {
  if (baseline === null || current === null || current === undefined) return false;
  /*
   * 基準は「サーバから来た JSON」をそのまま持っている（`markSaved` / 読み込み時に
   * `JSON.stringify` したもの）。**両側を同じ正規化に通す**ので、基準の持ち方は
   * 変えなくてよい。壊れた JSON は起こらない（自分で stringify したものしか入らない）が、
   * 読めなければ生の文字列比較へ落として**未保存を握り潰さない**側に倒す。
   */
  let baselineValue: unknown;
  try {
    baselineValue = JSON.parse(baseline);
  } catch {
    return JSON.stringify(current) !== baseline;
  }
  return serializeForCompare(current) !== serializeForCompare(baselineValue);
}

export function useUnsavedChanges<T>(current: T | null | undefined): {
  dirty: boolean;
  markSaved: (value: T) => void;
} {
  const [baseline, setBaseline] = useState<string | null>(null);
  const serialized = current === null || current === undefined ? null : JSON.stringify(current);

  // 読み込み完了（null → 値）で基準を置く。以降は `markSaved` でしか動かさない。
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || serialized === null) return;
    seeded.current = true;
    setBaseline(serialized);
  }, [serialized]);

  const markSaved = useCallback((value: T) => {
    seeded.current = true;
    setBaseline(JSON.stringify(value));
  }, []);

  return { dirty: isDirty(baseline, current), markSaved };
}
