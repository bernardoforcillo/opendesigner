// Exported by opendesigner (opendesigner export): screen "Screen" (route /screen) of document "Test" (doc). DO NOT edit by hand:
// regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.
export function Screen() {
  return (
    <div data-node-id="scr" className="relative w-[400px] h-[300px] bg-[#fff]">
      <div
        data-node-id="h"
        className="absolute left-[10px] top-[10px] w-[300px] h-[80px] flex justify-start items-start gap-[10px] p-[12px] bg-[#e5e5e5] shadow-[inset_0_0_0_2px_#000]"
      >
        <div
          data-node-id="h1"
          className="relative shrink-0 w-[50px] h-[30px] rotate-[10deg] rounded-[8px] bg-[#e54d4d]"
        />
      </div>
      <div
        data-node-id="t"
        className="absolute left-[10px] top-[120px] w-[200px] whitespace-pre-wrap break-words [font-family:Inter,_sans-serif] text-[18px] font-bold leading-[1.2] text-center text-[#1a1a1a]"
      >
        {"Hello \"world\"\non two lines"}
      </div>
      <svg
        data-node-id="v"
        width="100"
        height="60"
        className="absolute left-[10px] top-[170px] w-[100px] h-[60px] overflow-visible max-w-none"
      >
        <defs>
          <linearGradient id="g-v" x1="0" y1="0" x2="100" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#f00" />
            <stop offset="1" stopColor="#00f" />
          </linearGradient>
        </defs>
        <path d="M0 0L100 0L50 60L0 0Z" fill="url(#g-v)" fillRule="evenodd" />
        <path
          d="M0 0L100 0L50 60L0 0Z"
          fill="none"
          stroke="#f00"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
