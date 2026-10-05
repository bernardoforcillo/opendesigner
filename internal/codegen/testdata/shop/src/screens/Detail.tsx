// Exported by opendesigner (opendesigner export): screen "Detail" (route /detail) of document "Shop" (shop). DO NOT edit by hand:
// regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.
import { useNavigate } from "react-router-dom";

export function Detail() {
  const navigate = useNavigate();
  return (
    <div data-node-id="detail" className="relative w-[360px] h-[560px] overflow-hidden bg-[#f7f7fc]">
      <div
        // flow: t4
        data-node-id="detailBack"
        className="absolute left-[24px] top-[40px] w-[80px] h-[32px] rounded-[16px] bg-[#e5e5f0] cursor-pointer"
        role="button"
        tabIndex={0}
        aria-label="Back"
        onClick={() => navigate("/home")}
        onKeyDown={(e) => { if (e.key === "Enter") navigate("/home"); }}
      />
      <div
        data-node-id="detailTitle"
        className="absolute left-[24px] top-[96px] w-[312px] whitespace-pre-wrap break-words [font-family:Inter,_sans-serif] text-[24px] font-bold leading-[1.2] text-[#1a1a1f]"
      >
        {"Wireless headphones"}
      </div>
      <div
        data-node-id="detailBody"
        className="absolute left-[24px] top-[144px] w-[312px] whitespace-pre-wrap break-words [font-family:Inter,_sans-serif] text-[15px] font-normal leading-[1.2] text-[#4d4d59]"
      >
        {"Noise cancellation, 30 hours of battery life and fast charging."}
      </div>
    </div>
  );
}
