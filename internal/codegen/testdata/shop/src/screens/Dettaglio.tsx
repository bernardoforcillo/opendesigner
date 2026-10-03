// Esportato da opendesigner (opendesigner export): schermata "Dettaglio" (rotta /dettaglio) del documento "Negozio" (shop). NON modificare a mano:
// rigenerare con `opendesigner export`. L'attributo data-node-id lega ogni elemento al nodo del design.
import { useNavigate } from "react-router-dom";

export function Dettaglio() {
  const navigate = useNavigate();
  return (
    <div data-node-id="detail" className="relative w-[360px] h-[560px] overflow-hidden bg-[#f7f7fc]">
      <div
        // flow: t4
        data-node-id="detailBack"
        className="absolute left-[24px] top-[40px] w-[80px] h-[32px] rounded-[16px] bg-[#e5e5f0] cursor-pointer"
        role="button"
        tabIndex={0}
        aria-label="Indietro"
        onClick={() => navigate("/home")}
        onKeyDown={(e) => { if (e.key === "Enter") navigate("/home"); }}
      />
      <div
        data-node-id="detailTitle"
        className="absolute left-[24px] top-[96px] w-[312px] whitespace-pre-wrap break-words [font-family:Inter,_sans-serif] text-[24px] font-bold leading-[1.2] text-[#1a1a1f]"
      >
        {"Cuffie wireless"}
      </div>
      <div
        data-node-id="detailBody"
        className="absolute left-[24px] top-[144px] w-[312px] whitespace-pre-wrap break-words [font-family:Inter,_sans-serif] text-[15px] font-normal leading-[1.2] text-[#4d4d59]"
      >
        {"Cancellazione del rumore, 30 ore di autonomia e ricarica rapida."}
      </div>
    </div>
  );
}
