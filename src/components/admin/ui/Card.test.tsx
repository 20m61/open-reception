import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MetricCard } from './Card';

/**
 * `MetricCard` の **placeholder 表示** (#895 / 課題 07)。
 *
 * platform コンソールは `MetricCard` を自前で持っており、値が無いときに
 * **「未接続」と言葉で出していた**（#90「偽の安心を与えない」）。共有版へ寄せるとき
 * この性質を落とすと、**未接続が「0 件」や「集計中」と見分けられない空欄に退化する**。
 *
 * 縛るのは「文言を出せること」だけでなく、**指定していないときは出さないこと**（下界）。
 * 下界が無いと「常に未接続と出す」実装（実データがあるのに未接続と言う＝逆向きの嘘）が
 * 素通りする。
 */

function render(props: Parameters<typeof MetricCard>[0]): string {
  return renderToStaticMarkup(<MetricCard {...props} />);
}

describe('MetricCard の placeholder 表示', () => {
  it('placeholder かつ文言指定なら、値の位置に文言が出る', () => {
    const html = render({ label: '受付端末上限', placeholder: true, placeholderText: '未接続' });
    expect(html).toContain('ui-metric-placeholder');
    expect(html).toContain('未接続');
  });

  it('下界: 文言を指定していなければ出さない（従来の空欄挙動）', () => {
    const html = render({ label: '今月の利用量', placeholder: true, note: '未集計' });
    expect(html).not.toContain('ui-metric-placeholder');
  });

  it('下界: placeholder でなければ出さない（実データがあるのに未接続と言わない）', () => {
    const html = render({ label: '全テナント数', value: 12, placeholderText: '未接続' });
    expect(html).not.toContain('ui-metric-placeholder');
    expect(html).not.toContain('未接続');
    expect(html).toContain('12');
  });

  it('下界: 値が無くても placeholder でなければ出さない', () => {
    /*
     * 🔴 値がある場合だけで下界を張ると、**値の分岐が先に勝つので placeholder の判定に
     * 到達しない**。`placeholder` を無視して常に文言を出す変異はそこを素通りした（実測）。
     * 値も placeholder も無い世界で見る。
     */
    const html = render({ label: '集計中の指標', placeholderText: '未接続' });
    expect(html).not.toContain('ui-metric-placeholder');
    expect(html).not.toContain('未接続');
  });

  it('値があるときは値が勝つ（文言で覆い隠さない）', () => {
    const html = render({ label: '全テナント数', value: 0, placeholder: true, placeholderText: '未接続' });
    expect(html).toContain('>0<');
    expect(html).not.toContain('未接続');
  });
});
