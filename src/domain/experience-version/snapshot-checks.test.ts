/**
 * 公開前スナップショット検証の単体テスト (issue #420「公開前の schema・asset・call route 検証」)。
 *
 * ここで固定するのは **「公開を止める（error）」と「記録するだけ（warning）」の線引き**。
 * 端末で確実に壊れるものだけを error にする。運用者が公開できなくなる代償が大きいため、
 * 「たぶん意図と違う」程度は warning に留める。
 */
import { describe, expect, it } from 'vitest';
import {
  checkAssets,
  checkLanguageFallback,
  checkMotionMapping,
  runSnapshotChecks,
} from './snapshot-checks';

const findingsOf = (list: { check: string; severity: string }[]) =>
  list.map((f) => `${f.check}:${f.severity}`);

describe('checkAssets', () => {
  it('相対パス・https・data URI は問題なし', () => {
    expect(
      checkAssets({
        avatar: {
          backgroundUrl: '/assets/bg.png',
          vrmUrl: 'https://cdn.example.com/avatar.vrm',
          fallbackImageUrl: 'data:image/png;base64,AAAA',
        },
      }),
    ).toEqual([]);
  });

  it('http: のアセットは error（https の端末画面では混在コンテンツで読めない）', () => {
    const findings = checkAssets({ avatar: { backgroundUrl: 'http://example.com/bg.png' } });
    expect(findingsOf(findings)).toEqual(['asset:error']);
    // 運用者が直せるように、どのキーが問題かは示す（値そのものは載せる必要がない）。
    expect(findings[0]?.message).toContain('backgroundUrl');
  });

  it('URL として解釈できない値は error', () => {
    expect(findingsOf(checkAssets({ avatar: { vrmUrl: 'not a url' } }))).toEqual(['asset:error']);
  });

  it('VRM の拡張子が .vrm でなければ warning（読み込めない可能性はあるが断定はしない）', () => {
    const findings = checkAssets({ avatar: { vrmUrl: '/assets/avatar.glb' } });
    expect(findingsOf(findings)).toEqual(['asset:warning']);
  });

  it('未設定（セクションなし・空文字）は指摘しない', () => {
    expect(checkAssets({})).toEqual([]);
    expect(checkAssets({ avatar: {} })).toEqual([]);
    expect(checkAssets({ avatar: { backgroundUrl: '' } })).toEqual([]);
  });

  it('avatar セクションが object でなければ warning（既定へ落ちる）', () => {
    expect(findingsOf(checkAssets({ avatar: 'nope' }))).toEqual(['asset:warning']);
  });
});

describe('checkMotionMapping', () => {
  it('既知のモーションキーと配信可能な URL は問題なし', () => {
    expect(
      checkMotionMapping({
        motions: { motions: { idle: '/m/idle.vrma', greeting: '/m/greeting.vrma' } },
      }),
    ).toEqual([]);
  });

  it('未知のモーションキーは warning（端末は無視して既定へ落ちる）', () => {
    const findings = checkMotionMapping({ motions: { motions: { dancing: '/m/x.vrma' } } });
    expect(findingsOf(findings)).toEqual(['motion_mapping:warning']);
    expect(findings[0]?.message).toContain('dancing');
  });

  it('アバターが設定済みでモーションが 1 つも無ければ warning（静止する）', () => {
    expect(
      findingsOf(
        checkMotionMapping({ avatar: { vrmUrl: '/a.vrm' }, motions: { motions: {} } }),
      ),
    ).toEqual(['motion_mapping:warning']);
    // defaultUrl が在れば静止しないので指摘しない。
    expect(
      checkMotionMapping({
        avatar: { vrmUrl: '/a.vrm' },
        motions: { motions: {}, defaultUrl: '/m/d.vrma' },
      }),
    ).toEqual([]);
  });

  it('アバターを使わない拠点では空のモーションを指摘しない（常時鳴る警告を作らない）', () => {
    // アバター機能が無効な拠点ではローダが常に `{ motions: {} }` を返す。無条件に警告すると
    // 毎回の下書き保存で必ず鳴り、警告そのものが読まれなくなる。
    expect(checkMotionMapping({ motions: { motions: {} } })).toEqual([]);
  });

  it('モーション URL も配信可能性を検査する（http: は error）', () => {
    expect(
      findingsOf(checkMotionMapping({ motions: { motions: { idle: 'http://x/m.vrma' } } })),
    ).toEqual(['motion_mapping:error']);
  });

  it('セクションが無ければ指摘しない（アバター機能を使わない拠点）', () => {
    expect(checkMotionMapping({})).toEqual([]);
  });
});

describe('checkLanguageFallback', () => {
  it('既定 locale が有効な言語に含まれていれば問題なし', () => {
    expect(
      checkLanguageFallback({ languages: { enabledLocales: ['ja', 'en'], defaultLocale: 'ja' } }),
    ).toEqual([]);
  });

  // 言語系は**すべて warning**。`sanitizeLanguageSettings` が実行時に必ず補正するため、
  // どの不整合でも端末は壊れない。壊れないもので公開を止めない。
  it('有効な言語が 0 件でも warning（既定の言語へ補正されて配信される）', () => {
    expect(
      findingsOf(checkLanguageFallback({ languages: { enabledLocales: [], defaultLocale: 'ja' } })),
    ).toEqual(['language_fallback:warning']);
  });

  it('既定 locale が選択肢に無ければ warning（先頭の言語が既定になる）', () => {
    const findings = checkLanguageFallback({
      languages: { enabledLocales: ['en'], defaultLocale: 'ja' },
    });
    expect(findingsOf(findings)).toEqual(['language_fallback:warning']);
    expect(findings[0]?.message).toContain('ja');
  });

  it('セクションが無い/型不正は warning（既定の ja へ落ちる）', () => {
    expect(findingsOf(checkLanguageFallback({}))).toEqual(['language_fallback:warning']);
    expect(findingsOf(checkLanguageFallback({ languages: 42 }))).toEqual([
      'language_fallback:warning',
    ]);
  });
});

describe('runSnapshotChecks', () => {
  it('全チェックの指摘をまとめて返す', () => {
    const findings = runSnapshotChecks({
      avatar: { backgroundUrl: 'http://x/bg.png' },
      motions: { motions: { dancing: '/m/x.vrma' } },
      languages: { enabledLocales: [], defaultLocale: 'ja' },
    });
    expect(findingsOf(findings).sort()).toEqual([
      'asset:error',
      'language_fallback:warning',
      'motion_mapping:warning',
    ]);
  });

  it('健全なスナップショットでは何も指摘しない', () => {
    expect(
      runSnapshotChecks({
        avatar: { backgroundUrl: '/bg.png', vrmUrl: '/a.vrm' },
        motions: { motions: { idle: '/m/idle.vrma' } },
        languages: { enabledLocales: ['ja'], defaultLocale: 'ja' },
      }),
    ).toEqual([]);
  });

  it('指摘メッセージに秘匿値・PII を持ち込まない（キー名と分類のみ）', () => {
    const findings = runSnapshotChecks({
      avatar: { backgroundUrl: 'http://example.com/secret-token-in-path.png' },
    });
    for (const finding of findings) {
      expect(finding.message).not.toContain('secret-token-in-path');
    }
  });
});
