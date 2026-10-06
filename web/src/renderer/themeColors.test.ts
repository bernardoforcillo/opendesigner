import { afterEach, describe, expect, it, vi } from "vitest";
import { LIGHT_FALLBACK, resetThemeColors, subscribeTheme, themeColors, withAlpha } from "./themeColors";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  resetThemeColors();
});

describe("themeColors", () => {
  it("without CSS variables (jsdom) it falls back to the light theme: never an empty string", () => {
    const c = themeColors();
    expect(c).toEqual(LIGHT_FALLBACK);
    for (const v of Object.values(c)) expect(v).not.toBe("");
  });

  it("reads the tokens from the root element and keeps them in cache", () => {
    document.documentElement.style.setProperty("--accent", "#5b8cff");
    resetThemeColors();
    const a = themeColors();
    expect(a.accent).toBe("#5b8cff");
    // a manual change is NOT seen until the cache is invalidated
    document.documentElement.style.setProperty("--accent", "#000000");
    expect(themeColors()).toBe(a);
    expect(themeColors().accent).toBe("#5b8cff");
  });

  it("changing data-theme invalidates the cache, notifies subscribers and triggers a redraw", async () => {
    themeColors(); // avvia l'osservazione
    const fn = vi.fn();
    const off = subscribeTheme(fn);
    const onResize = vi.fn();
    window.addEventListener("resize", onResize);
    document.documentElement.style.setProperty("--accent", "#123456");
    document.documentElement.setAttribute("data-theme", "dark");
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    expect(onResize).toHaveBeenCalled();
    const c = themeColors();
    expect(c.dark).toBe(true);
    expect(c.accent).toBe("#123456");
    expect(c.guide).not.toBe(LIGHT_FALLBACK.guide);
    off();
    window.removeEventListener("resize", onResize);
  });
});

describe("withAlpha", () => {
  it("converte #rrggbb e #rgb in rgba", () => {
    expect(withAlpha("#2563eb", 0.5)).toBe("rgba(37, 99, 235, 0.5)");
    expect(withAlpha("#fff", 0.1)).toBe("rgba(255, 255, 255, 0.1)");
  });
  it("leaves untouched what it cannot read", () => {
    expect(withAlpha("rgb(1, 2, 3)", 0.5)).toBe("rgb(1, 2, 3)");
  });
});
