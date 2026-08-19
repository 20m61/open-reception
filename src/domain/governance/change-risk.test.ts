import { describe, expect, it } from 'vitest';
import {
  addedDependencyNames,
  CHANGE_BOUNDARIES,
  classifyChangeRisk,
  type ChangeBoundary,
} from './change-risk';

/** その境界に当たった根拠パスを取り出す（無ければ null）。 */
function hit(paths: ReadonlyArray<string>, boundary: ChangeBoundary) {
  return classifyChangeRisk({ paths }).hits.find((h) => h.boundary === boundary) ?? null;
}

function boundaries(paths: ReadonlyArray<string>): ReadonlyArray<ChangeBoundary> {
  return classifyChangeRisk({ paths }).hits.map((h) => h.boundary);
}

describe('classifyChangeRisk: 停止境界の機械判定 (#424)', () => {
  it('収集できたうえで変更が無ければ、何も当たらず承認も要らない', () => {
    // **`measurement: 'complete'` の申告が要る。** 申告が無い空集合は「収集に失敗した
    // 可能性」と読む（下の #709 の describe を参照）。
    const assessment = classifyChangeRisk({ paths: [], measurement: 'complete' });
    expect(assessment.hits).toEqual([]);
    expect(assessment.requiresHumanApproval).toBe(false);
    expect(assessment.assessable).toBe(true);
  });

  describe('測れていないことを「触れていない」と言わない (#709)', () => {
    /**
     * `change-scope.ts:50` は同じ状況に明示的なガードを持つ:
     *
     * > 変更ゼロは `code` にする。「何も変わっていない」のではなく「収集に失敗した」
     * > 可能性があり、そこで検証を省くと最悪の方向へ倒れる。
     *
     * `change-risk` にはこれが無く、`git diff` が失敗して空集合になっても
     * 「停止境界に触れていません（人間承認は不要）」と断定していた。
     */
    it('収集失敗を申告したら、判定不能として承認が要る側へ倒れる', () => {
      const assessment = classifyChangeRisk({ paths: [], measurement: 'incomplete' });
      expect(assessment.assessable).toBe(false);
      // 偽陰性は境界を素通りさせる。測れていないなら人へ回す。
      expect(assessment.requiresHumanApproval).toBe(true);
    });

    it('申告が無い空集合は判定不能として扱う（既定で安全側）', () => {
      // 呼び出し側が申告を忘れても、黙って「触れていない」にはしない。
      const assessment = classifyChangeRisk({ paths: [] });
      expect(assessment.assessable).toBe(false);
      expect(assessment.requiresHumanApproval).toBe(true);
    });

    it('部分的にでも集まったパスは、判定不能でも根拠として残す', () => {
      // 測れた分は捨てない。「判定は不完全だが、少なくともこれには当たっている」を伝える。
      const assessment = classifyChangeRisk({
        paths: ['src/domain/reception/state.ts'],
        measurement: 'incomplete',
      });
      expect(assessment.assessable).toBe(false);
      expect(assessment.requiresHumanApproval).toBe(true);
      expect(assessment.hits.map((h) => h.boundary)).toContain('journeyOrStateModel');
    });

    it('申告が無くてもパスがあれば判定できたものとして扱う（既存の呼び出しを壊さない）', () => {
      const assessment = classifyChangeRisk({ paths: ['docs/scope.md'] });
      expect(assessment.assessable).toBe(true);
      expect(assessment.requiresHumanApproval).toBe(false);
    });

    it('パスが空でも依存の追加を検出できていれば、判定できたものとして扱う', () => {
      // 依存名が採れている＝マニフェストは読めている。空集合＝未測定とは限らない。
      const assessment = classifyChangeRisk({ paths: [], addedDependencies: ['new-lib'] });
      expect(assessment.assessable).toBe(true);
      expect(assessment.hits.map((h) => h.boundary)).toContain('dependency');
    });
  });

  it('文書だけの変更は境界に当たらない（この判定が緩すぎると毎回承認待ちになる）', () => {
    expect(boundaries(['docs/loop-queue.md', 'docs/ai-development-loop.md', 'CLAUDE.md'])).toEqual(
      [],
    );
  });

  it('CDK スタックは本番デプロイと継続費用の両方に当たる', () => {
    const paths = ['infra/lib/stacks/web-stack.ts'];
    expect(boundaries(paths)).toContain('productionDeploy');
    expect(boundaries(paths)).toContain('recurringCost');
  });

  it('認可の純関数・認証ライブラリ・端末許可ルートは認可境界に当たる', () => {
    for (const path of [
      'src/domain/tenant/authorization.ts',
      'src/lib/auth/entra.ts',
      'src/app/api/kiosk/authorize/route.ts',
    ]) {
      expect(boundaries([path]), path).toContain('authBoundary');
    }
  });

  it('永続化ストアと API ルートは永続スキーマ/公開 API に当たる', () => {
    for (const path of [
      'src/lib/data-stores/reception-store.ts',
      'src/app/api/admin/tenants/route.ts',
    ]) {
      expect(boundaries([path]), path).toContain('persistenceOrPublicApi');
    }
  });

  it('secret ストアと監査ログ定義は secret/PII に当たる', () => {
    for (const path of [
      'src/domain/provider-config/secret.ts',
      'src/lib/platform/tenant-secret-store.ts',
      'src/domain/reception/log.ts',
    ]) {
      expect(boundaries([path]), path).toContain('secretOrPii');
    }
  });

  it('外部プロバイダのアダプタは新しい外部送信に当たる', () => {
    for (const path of [
      'src/lib/notification/vonage-adapter.ts',
      'src/server/notification/polly-adapter.ts',
    ]) {
      expect(boundaries([path]), path).toContain('externalTransmission');
    }
  });

  it('受付/QR の遷移表と表示契約、体験設計の正本は Journey/state に当たる', () => {
    for (const path of [
      'src/domain/reception/state.ts',
      'src/domain/reception/ui-contract.ts',
      'src/domain/checkin/state.ts',
      'docs/experience/README.md',
    ]) {
      expect(boundaries([path]), path).toContain('journeyOrStateModel');
    }
  });

  it('package.json / lockfile の変更は依存に当たり、追加依存名が根拠に載る', () => {
    const assessment = classifyChangeRisk({
      paths: ['package.json', 'package-lock.json'],
      addedDependencies: ['some-new-lib'],
    });
    const dependency = assessment.hits.find((h) => h.boundary === 'dependency');
    expect(dependency).toBeTruthy();
    expect(dependency?.evidence).toContain('some-new-lib');
  });

  it('lockfile が動いていれば追加依存名が無くても当てる（版上げ・推移的依存の変化も #105 の対象）', () => {
    expect(boundaries(['package-lock.json'])).toContain('dependency');
    expect(boundaries(['infra/package-lock.json'])).toContain('dependency');
  });

  it('**scripts だけ触った package.json は当てない**（依存木が動いていない）', () => {
    // ドッグフーディングで見つけた偽陽性。npm script を 1 行足しただけで
    // 「新規依存・ライセンス判断」が出ると、毎回出る警告になって読まれなくなる。
    // 依存木が実際に動いたかは lockfile が判別できる（npm は両者を同期させる）。
    expect(boundaries(['package.json'])).not.toContain('dependency');
    // ただし追加依存名が渡されたなら、lockfile 無しでも当てる。
    expect(
      classifyChangeRisk({ paths: ['package.json'], addedDependencies: ['new-lib'] }).hits.map(
        (h) => h.boundary,
      ),
    ).toContain('dependency');
  });

  it('根拠には当たったパスが載る（人が確認できないと判定を信用できない）', () => {
    const found = hit(['src/domain/tenant/authorization.ts', 'docs/scope.md'], 'authBoundary');
    expect(found?.evidence).toEqual(['src/domain/tenant/authorization.ts']);
  });

  it('テストファイルも除外しない（ガードを弱めて green にする変更を見逃さない）', () => {
    // `.claude/rules/opus5-autonomous-loop.md`「テスト削除、skip、弱体化で green にしない」。
    // 認可テストの書き換えは正当な追加とガードの弱体化が同じ形をしているので、機械判定では
    // 区別せず人へ回す（偽陽性は人が一目で流せるが、偽陰性は境界を素通りさせる）。
    expect(boundaries(['src/domain/tenant/authorization.test.ts'])).toContain('authBoundary');
  });

  it('1 つでも当たれば承認が必要、当たらなければ不要', () => {
    expect(classifyChangeRisk({ paths: ['docs/scope.md'] }).requiresHumanApproval).toBe(false);
    expect(
      classifyChangeRisk({ paths: ['src/domain/reception/state.ts'] }).requiresHumanApproval,
    ).toBe(true);
  });

  it('同じ境界に複数当たっても 1 件にまとめ、根拠を全部残す', () => {
    const found = hit(
      ['src/domain/reception/state.ts', 'src/domain/checkin/state.ts'],
      'journeyOrStateModel',
    );
    expect(found?.evidence).toEqual([
      'src/domain/reception/state.ts',
      'src/domain/checkin/state.ts',
    ]);
  });

  it('全境界に検出規則が在る（語彙だけ増やして検出器を書き忘れない）', () => {
    // 消費者ゼロの導出を作らないためのメタテスト。境界を語彙に足したら、それを当てる
    // パターンと、当たることを示すこのテストの代表パスも足す。
    const representative: Record<ChangeBoundary, string> = {
      productionDeploy: 'infra/lib/stacks/web-stack.ts',
      authBoundary: 'src/domain/tenant/authorization.ts',
      persistenceOrPublicApi: 'src/lib/data-stores/reception-store.ts',
      externalTransmission: 'src/lib/notification/vonage-adapter.ts',
      secretOrPii: 'src/domain/provider-config/secret.ts',
      dependency: 'package-lock.json',
      recurringCost: 'infra/lib/stacks/realtime-runtime-stack.ts',
      journeyOrStateModel: 'src/domain/reception/state.ts',
    };
    for (const boundary of CHANGE_BOUNDARIES) {
      expect(boundaries([representative[boundary]]), boundary).toContain(boundary);
    }
  });
});

describe('addedDependencyNames: 追加された依存名の抽出 (#424 / #105)', () => {
  it('base に無く head に在るものだけを返す', () => {
    const added = addedDependencyNames(
      { dependencies: { react: '^19.0.0' } },
      { dependencies: { react: '^19.0.0', 'some-new-lib': '^1.0.0' } },
    );
    expect(added).toEqual(['some-new-lib']);
  });

  it('版だけ変わったものは「追加」に含めない（#105 の対象だが新規依存ではない）', () => {
    const added = addedDependencyNames(
      { dependencies: { react: '^19.0.0' } },
      { dependencies: { react: '^19.2.0' } },
    );
    expect(added).toEqual([]);
  });

  it('devDependencies / optionalDependencies も見る（dev 依存もライセンス判断の対象）', () => {
    const added = addedDependencyNames(
      { devDependencies: { vitest: '^4.0.0' } },
      {
        devDependencies: { vitest: '^4.0.0', 'new-dev-tool': '^1.0.0' },
        optionalDependencies: { 'new-optional': '^1.0.0' },
      },
    );
    expect(added).toEqual(['new-dev-tool', 'new-optional']);
  });

  it('削除だけなら空（増えていないので新規ライセンス判断は不要）', () => {
    expect(
      addedDependencyNames({ dependencies: { gone: '^1.0.0' } }, { dependencies: {} }),
    ).toEqual([]);
  });

  it('欠けたフィールドを許容する（package.json に devDependencies が無い場合）', () => {
    expect(addedDependencyNames({}, {})).toEqual([]);
    expect(addedDependencyNames({}, { dependencies: { a: '1' } })).toEqual(['a']);
  });
});
