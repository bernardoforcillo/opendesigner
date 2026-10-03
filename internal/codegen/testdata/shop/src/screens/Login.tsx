// Esportato da opendesigner (opendesigner export): schermata "Login" (rotta /login) del documento "Negozio" (shop). NON modificare a mano:
// rigenerare con `opendesigner export`. L'attributo data-node-id lega ogni elemento al nodo del design.
import { useNavigate } from "react-router-dom";

export function Login() {
  const navigate = useNavigate();
  return (
    <div data-node-id="login" className="relative w-[360px] h-[560px] overflow-hidden bg-[#f7f7fc]">
      <div
        data-node-id="loginTitle"
        className="absolute left-[24px] top-[48px] w-[312px] whitespace-pre-wrap break-words [font-family:Inter,_sans-serif] text-[28px] font-bold leading-[1.2] text-[#1a1a1f]"
      >
        {"Accedi al negozio"}
      </div>
      <div
        data-node-id="loginEmail"
        className="absolute left-[24px] top-[120px] w-[312px] h-[48px] rounded-[10px] bg-[#fff] shadow-[inset_0_0_0_1px_#ccccd9]"
      />
      <div
        data-node-id="loginPass"
        className="absolute left-[24px] top-[184px] w-[312px] h-[48px] rounded-[10px] bg-[#fff] shadow-[inset_0_0_0_1px_#ccccd9]"
      />
      <div
        // flow: t1
        // guard: credenziali valide
        // effect: sessione attiva
        data-node-id="loginBtn"
        data-testid="login-submit"
        className="absolute left-[24px] top-[264px] w-[312px] h-[52px] flex justify-center items-center bg-[#3366f2] cursor-pointer"
        role="button"
        tabIndex={0}
        aria-label="Accedi"
        onClick={() => navigate("/home")}
        onKeyDown={(e) => { if (e.key === "Enter") navigate("/home"); }}
      >
        <div
          data-node-id="loginBtnLabel"
          className="relative shrink-0 w-[120px] whitespace-pre-wrap break-words h-[20px] [font-family:Inter,_sans-serif] text-[16px] font-semibold leading-[1.2] text-center text-[#fff]"
        >
          {"Entra"}
        </div>
      </div>
    </div>
  );
}
