import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_FAMILY_PATTERNS,
  PINNED_FONTCONFIG_FILE,
  REQUIRED_FAMILIES,
  missingPinnedFamilies,
  pinnedFontEnv,
  unexpectedFamilies,
} from "./vrt-font-pin";

/**
 * VRT の撮影フォントを固定する設定 (#1289) の静的メタテスト。
 *
 * Cloud の環境には baseline を撮った環境に無いフォント（IPA ゴシック・Noto Sans CJK・
 * Unifont・システムの Inter）が入っていて、日本語の描画が変わり VRT 14 件が落ちていた。
 * 許可リスト（`tests/e2e/fonts/fonts.conf`）を chromium にだけ渡して、baseline の描画に戻す。
 */

const IMPORT_TIMEOUT_MS = 30_000;
const ROOT = join(import.meta.dirname, "../..");

function confDirs(): string[] {
  const xml = readFileSync(PINNED_FONTCONFIG_FILE, "utf8");
  return [...xml.matchAll(/<dir>([^<]+)<\/dir>/g)].map((m) => m[1] ?? "");
}

describe("許可リスト（fonts.conf）", () => {
  it("リポジトリ内の固定パスに置かれている", () => {
    expect(PINNED_FONTCONFIG_FILE).toBe(
      join(ROOT, "tests/e2e/fonts/fonts.conf"),
    );
    expect(existsSync(PINNED_FONTCONFIG_FILE)).toBe(true);
  });

  it("フォントの置き場所は許可したディレクトリだけで、システム全体（/usr/share/fonts）を読まない", () => {
    const dirs = confDirs();
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      // 親ディレクトリを丸ごと指すと、拒否したいフォントも再帰で入ってしまう。
      expect(dir).toMatch(/^\/usr\/share\/fonts\/(truetype|opentype)\/[^/]+$/);
    }
    const xml = readFileSync(PINNED_FONTCONFIG_FILE, "utf8");
    expect(xml).not.toMatch(
      /<include[^>]*>\s*\/etc\/fonts\/fonts\.conf\s*<\/include>/,
    );
  });

  it("baseline の描画を変えるフォントのディレクトリを含まない", () => {
    for (const dir of confDirs()) {
      expect(dir).not.toMatch(/ipafont|unifont|inter|cjk/i);
      // Noto Sans CJK は opentype/noto に、Noto Color Emoji は truetype/noto に居る。
      expect(dir).not.toBe("/usr/share/fonts/opentype/noto");
    }
  });

  it("描画の規則（ヒンティング・合成ボールド）は system の conf.d から読む", () => {
    // conf.d を外すと合成ボールドとヒンティングが変わり、14 件中 14 件が落ちる（実測）。
    const xml = readFileSync(PINNED_FONTCONFIG_FILE, "utf8");
    expect(xml).toMatch(/<include[^>]*>\s*\/etc\/fonts\/conf\.d\s*<\/include>/);
  });
});

describe("pinnedFontEnv", () => {
  it("linux では chromium に FONTCONFIG_FILE を渡す", () => {
    expect(pinnedFontEnv("linux", {})).toEqual({
      FONTCONFIG_FILE: PINNED_FONTCONFIG_FILE,
    });
  });

  it("darwin では何も渡さない（CoreText は fontconfig を読まない。darwin baseline を変えない）", () => {
    expect(pinnedFontEnv("darwin", {})).toEqual({});
    expect(pinnedFontEnv("win32", {})).toEqual({});
  });

  it("利用者が FONTCONFIG_FILE を明示したときは上書きしない", () => {
    expect(
      pinnedFontEnv("linux", { FONTCONFIG_FILE: "/x/fonts.conf" }),
    ).toEqual({});
  });
});

describe("missingPinnedFamilies / unexpectedFamilies", () => {
  const full = REQUIRED_FAMILIES.join("\n");

  it("必須のファミリーは実測で決めた 6 つ（DejaVu と WenQuanYi だけにすると 5 件落ちた）", () => {
    // 実装の定数から期待値を導かない（定数から 1 つ消しても、それに合わせて緑になってしまう）。
    expect([...REQUIRED_FAMILIES].sort()).toEqual(
      [
        "DejaVu Sans",
        "FreeSans",
        "Liberation Sans",
        "Loma",
        "Noto Color Emoji",
        "WenQuanYi Zen Hei",
      ].sort(),
    );
  });

  it("必須のファミリーが全部あれば欠けは 0", () => {
    expect(missingPinnedFamilies(full)).toEqual([]);
  });

  it("必須のどれか 1 つが無ければ、そのファミリーを名指しする", () => {
    for (const family of REQUIRED_FAMILIES) {
      const listing = REQUIRED_FAMILIES.filter((f) => f !== family).join("\n");
      expect(missingPinnedFamilies(listing)).toEqual([family]);
    }
  });

  it("fc-list の「別名,別名」の行でも、先頭以外の名前でも拾う", () => {
    const listing = full.replace(
      "WenQuanYi Zen Hei",
      "WenQuanYi Zen Hei,文泉驛正黑,文泉驿正黑",
    );
    expect(missingPinnedFamilies(listing)).toEqual([]);
  });

  it("前方一致で誤って拾わない（Liberation Sans Narrow だけでは Liberation Sans を満たさない）", () => {
    const listing = full.replace(
      /^Liberation Sans$/m,
      "Liberation Sans Narrow",
    );
    expect(missingPinnedFamilies(listing)).toEqual(["Liberation Sans"]);
  });

  it("描画を変えるフォントが混ざっていれば名指しする", () => {
    const listing = `${full}\nIPAPGothic,IPA Pゴシック\nNoto Sans CJK JP\nUnifont\nInter`;
    expect(unexpectedFamilies(listing)).toEqual([
      "IPAPGothic,IPA Pゴシック",
      "Noto Sans CJK JP",
      "Unifont",
      "Inter",
    ]);
    expect(unexpectedFamilies(full)).toEqual([]);
    expect(FORBIDDEN_FAMILY_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("playwright.config への配線", () => {
  it(
    "chromium の全 project が同じ launchOptions を持ち、linux では FONTCONFIG_FILE を渡す",
    async () => {
      const config = (await import("../../playwright.config")).default;
      const chromium = (config.projects ?? []).filter(
        (p) => p.use?.browserName === "chromium",
      );
      expect(chromium.map((p) => p.name)).toContain("pristine-state");
      for (const project of chromium) {
        const env = project.use?.launchOptions?.env;
        if (process.platform === "linux" && !process.env.FONTCONFIG_FILE) {
          expect(env?.FONTCONFIG_FILE, project.name).toBe(
            PINNED_FONTCONFIG_FILE,
          );
          // env は丸ごと置き換わるので、既存の環境変数（PATH 等）を落としていないこと。
          expect(env?.PATH, project.name).toBe(process.env.PATH);
        } else {
          expect(env?.FONTCONFIG_FILE, project.name).toBe(
            process.env.FONTCONFIG_FILE,
          );
        }
      }
    },
    IMPORT_TIMEOUT_MS,
  );
});

const hasFcList = (() => {
  try {
    execFileSync("fc-list", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(process.platform === "linux" && hasFcList)(
  "この環境の fontconfig で実際に解決する",
  () => {
    const run = (args: string[]) =>
      execFileSync("fc-list", args, {
        encoding: "utf8",
        env: { ...process.env, FONTCONFIG_FILE: PINNED_FONTCONFIG_FILE },
      });

    it("許可リストのファミリーが揃い、描画を変えるフォントは 1 つも見えない", () => {
      const listing = run([":", "family"]);
      expect(missingPinnedFamilies(listing)).toEqual([]);
      expect(unexpectedFamilies(listing)).toEqual([]);
    });

    it("日本語の sans-serif は WenQuanYi Zen Hei に解決する", () => {
      const match = execFileSync("fc-match", ["sans-serif:lang=ja"], {
        encoding: "utf8",
        env: { ...process.env, FONTCONFIG_FILE: PINNED_FONTCONFIG_FILE },
      });
      expect(match).toMatch(/WenQuanYi Zen Hei/);
    });
  },
);
