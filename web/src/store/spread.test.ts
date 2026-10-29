import { describe, it, expect } from "vitest";
import { facingPartner, pointOnFacingPage } from "@/store/spread";
import type { PageLite } from "@/store/types";

const page = (id: string, extra: Partial<PageLite> = {}): PageLite => ({ id, name: id, width: 400, height: 600, ...extra });
const book = (facing = true, pages: PageLite[] = [page("p1"), page("p2"), page("p3"), page("p4")]) => ({
  pages: [...pages, page("m", { isMaster: true })],
  settings: facing ? { facingPages: true } : {},
});

describe("facingPartner", () => {
  it("is null without facing pages", () => {
    expect(facingPartner(book(false), "p2")).toBeNull();
  });

  it("pairs a left page with the right page after it, on its right", () => {
    // Page 1 is a right-hand page, so 2 (left) faces 3 (right).
    expect(facingPartner(book(), "p2")).toEqual({ pageId: "p3", dx: 400, partnerIsLeft: false });
  });

  it("pairs a right page with the left page before it, on its left", () => {
    expect(facingPartner(book(), "p3")).toEqual({ pageId: "p2", dx: -400, partnerIsLeft: true });
  });

  it("leaves the first page and an unpaired last page alone, and ignores masters", () => {
    expect(facingPartner(book(), "p1")).toBeNull();
    expect(facingPartner(book(true, [page("p1"), page("p2")]), "p2")).toBeNull();
    expect(facingPartner(book(), "m")).toBeNull();
  });

  it("uses the width of the page that is drawn beside, and needs sized pages", () => {
    const s = book(true, [page("p1"), page("p2", { width: 300 }), page("p3", { width: 500 }), page("p4")]);
    expect(facingPartner(s, "p3")).toMatchObject({ pageId: "p2", dx: -300 });
    expect(facingPartner(s, "p2")).toMatchObject({ pageId: "p3", dx: 300 });
    expect(facingPartner(book(true, [page("p1"), page("p2", { width: 0 }), page("p3")]), "p3")).toBeNull();
  });

  it("does not pair two pages that fall on the same side of the spine", () => {
    // Page 2 is a left page; a section that restarts at 2 makes page 3 a left page as well.
    const s = book(true, [page("p1"), page("p2"), page("p3", { sectionStart: true, numberStart: 2 }), page("p4")]);
    expect(facingPartner(s, "p2")).toBeNull();
  });
});

describe("pointOnFacingPage", () => {
  const s = book();
  const sp = facingPartner(s, "p2")!;
  it("is true on the facing sheet only", () => {
    expect(pointOnFacingPage(s, "p2", sp, { x: 500, y: 100 })).toBe(true);
    expect(pointOnFacingPage(s, "p2", sp, { x: 100, y: 100 })).toBe(false);
    expect(pointOnFacingPage(s, "p2", sp, { x: 500, y: 700 })).toBe(false);
  });
});
