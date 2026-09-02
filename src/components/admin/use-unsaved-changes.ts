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
 * 🔴 **既知の粗さ (#913)**: 設定が `{}` で読み込まれる画面（ブランド設定は実測でそう）
 * では、入力欄が `value={x ?? ''}` で描かれているため、**打って消すと「未設定」から
 * `''` へ移り JSON としては別物**になる。見た目は元どおりでも確認が出る。
 * 倒れる先は安全側（確認を出す）なので、そのまま置いて別で扱う。
 */
/**
 * 未保存かどうかの述語（純関数）。
 *
 * 🔴 **フックの外へ出しておく。** node 環境ではフックを回せないので、判定を
 * テスト側へ書き写すと**テストと実装が同じ誤りを共有する**（このリポジトリが
 * 繰り返し踏んでいる型）。実物を import して縛れるようにする。
 */
export function isDirty(baseline: string | null, current: unknown): boolean {
  const serialized = current === null || current === undefined ? null : JSON.stringify(current);
  return baseline !== null && serialized !== null && serialized !== baseline;
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
