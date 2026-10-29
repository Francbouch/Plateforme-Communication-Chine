import { it, expect } from "vitest";
import fr from "../apps/web/src/locales/fr-CA.json";
import en from "../apps/web/src/locales/en.json";
import zh from "../apps/web/src/locales/zh-CN.json";
it("provides the complete UI dictionary in all three locales", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
  expect(Object.keys(zh).sort()).toEqual(Object.keys(fr).sort());
  for (const dictionary of [fr, en, zh])
    expect(Object.values(dictionary).every((v) => v.trim().length > 0)).toBe(
      true,
    );
});
