// Exported by opendesigner (opendesigner export): screen "Home" (route /home) of document "Shop" (shop). DO NOT edit by hand:
// regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.
import { useNavigate } from "react-router-dom";

export function Home() {
  const navigate = useNavigate();
  return (
    <div data-node-id="home" className="relative w-[360px] h-[560px] overflow-hidden bg-[#f7f7fc]">
      <div
        data-node-id="homeTitle"
        className="absolute left-[24px] top-[48px] w-[312px] whitespace-pre-wrap break-words [font-family:Inter,_sans-serif] text-[24px] font-bold leading-[1.2] text-[#1a1a1f]"
      >
        {"Storefront"}
      </div>
      <div
        // flow: t2
        data-node-id="homeCard"
        className="absolute left-[24px] top-[112px] w-[312px] h-[160px] flex flex-col justify-start items-start gap-[8px] p-[16px] bg-[#fff] shadow-[0_0_0_0.5px_#e0e0eb,inset_0_0_0_0.5px_#e0e0eb,0_4px_12px_rgba(0,0,0,0.12)] cursor-pointer"
        role="button"
        tabIndex={0}
        aria-label="Open detail"
        onClick={() => navigate("/detail")}
        onKeyDown={(e) => { if (e.key === "Enter") navigate("/detail"); }}
      >
        <div
          data-node-id="homeCardName"
          className="relative shrink-0 w-[280px] whitespace-pre-wrap break-words h-[24px] [font-family:Inter,_sans-serif] text-[18px] font-semibold leading-[1.2] text-[#1a1a1f]"
        >
          {"Wireless headphones"}
        </div>
        <div
          data-node-id="homeCardPrice"
          className="relative shrink-0 w-[280px] whitespace-pre-wrap break-words h-[20px] [font-family:Inter,_sans-serif] text-[14px] font-normal leading-[1.2] text-[#666673]"
        >
          {"89.00 EUR"}
        </div>
        <div
          data-node-id="homeCardImg"
          role="img"
          aria-label="Photo"
          className="relative shrink-0 w-[280px] h-[72px] bg-[rgba(0,0,0,0.06)] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.35)]"
        >
          <svg width="280" height="72" aria-hidden="true" className="absolute left-0 top-0 max-w-none">
            <path d="M0 0L280 72M280 0L0 72" fill="none" stroke="rgba(0,0,0,0.35)" />
          </svg>
        </div>
      </div>
      <div
        data-node-id="homeNote"
        className="absolute left-[24px] top-[300px] w-[312px] whitespace-pre-wrap break-words [font-family:Inter,_sans-serif] text-[13px] font-normal leading-[1.2] text-[#666673]"
      >
        {"Tap a product for details"}
      </div>
      <nav className="absolute left-0 top-0 z-50 flex flex-col opacity-0" aria-label="Flow navigation">
        {/* flow: t3 */}
        <button type="button" className="block h-px w-px overflow-hidden" onClick={() => navigate("/login")}>Sign out</button>
      </nav>
    </div>
  );
}
