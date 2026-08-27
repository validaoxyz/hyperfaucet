import "mocha";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { expect } from "chai";

interface AppearanceBootResult {
  theme: string;
  storedTheme: string;
}

function runAppearanceBoot(fileName: string, storedTheme?: string, search = ""): AppearanceBootResult {
  const source = fs.readFileSync(path.resolve(process.cwd(), "static/js", fileName), "utf8");
  const storage = new Map<string, string>();
  if(storedTheme)
    storage.set("hyperfaucet-appearance", JSON.stringify({theme: storedTheme}));

  let appliedTheme = "";
  const documentElement = {
    setAttribute: (name: string, value: string) => {
      if(name === "data-theme")
        appliedTheme = value;
    },
    style: {
      setProperty: () => undefined,
      removeProperty: () => undefined,
    },
  };
  const windowObject: any = {
    matchMedia: () => ({matches: false, addEventListener: () => undefined}),
    dispatchEvent: () => undefined,
  };
  const context = vm.createContext({
    window: windowObject,
    location: { search },
    document: {
      readyState: "complete",
      documentElement,
      createElement: () => ({style: {}}),
      getElementById: () => null,
      head: {appendChild: () => undefined},
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    requestAnimationFrame: (callback: () => void) => callback(),
    getComputedStyle: () => ({getPropertyValue: () => ""}),
    CustomEvent: class {},
    encodeURIComponent,
  });
  vm.runInContext(source, context);

  return {
    theme: appliedTheme,
    storedTheme: windowObject.__getFaucetAppearance().theme,
  };
}

const appearanceBootFiles = ["appearance-boot.js", "appearance-boot.public.js"]
  .filter((fileName) => fs.existsSync(path.resolve(process.cwd(), "static/js", fileName)));

for(const fileName of appearanceBootFiles) {
  const supportsThemeLab = fileName === "appearance-boot.js"
    && fs.readFileSync(path.resolve(process.cwd(), "static/js", fileName), "utf8").includes("THEME_LAB");

  describe(fileName, () => {
    it("starts new visitors in cobalt-mass", () => {
      expect(runAppearanceBoot(fileName)).to.deep.equal({
        theme: "cobalt-mass",
        storedTheme: "cobalt-mass",
      });
    });

    it("normalizes old non-cobalt selections", () => {
      expect(runAppearanceBoot(fileName, "seaglass")).to.deep.equal({
        theme: "cobalt-mass",
        storedTheme: "cobalt-mass",
      });
    });

    it("respects an explicit cobalt selection", () => {
      expect(runAppearanceBoot(fileName, "porcelain-cobalt")).to.deep.equal({
        theme: "porcelain-cobalt",
        storedTheme: "porcelain-cobalt",
      });
    });

    if(supportsThemeLab) {
      it("keeps non-cobalt themes behind the internal lab flag", () => {
        expect(runAppearanceBoot(fileName, "seaglass", "?themelab=1")).to.deep.equal({
          theme: "seaglass",
          storedTheme: "seaglass",
        });
      });
    }
  });
}
