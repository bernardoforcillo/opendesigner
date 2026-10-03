import { Button, Icon } from "../ui/ds";

// LA SCHEDA D'ERRORE dell'editor quando il documento non c'è (link sbagliato,
// documento eliminato, workspace diverso). Un vicolo cieco con una sola uscita
// chiara: la Home.

export function DocUnavailable({ notFound, message }: { notFound: boolean; message?: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-canvas p-6 text-fg">
      <div role="alert" className="flex w-full max-w-[360px] flex-col items-center gap-2 rounded-xl bg-surface px-6 py-8 text-center shadow-[var(--shadow-bar)]">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-warn-soft text-warn">
          <Icon name="warning" size={20} />
        </span>
        <h1 className="text-[15px] font-semibold">{notFound ? "Documento non trovato" : "Impossibile aprire il documento"}</h1>
        <p className="text-[13px] leading-relaxed text-fg-muted">
          {notFound
            ? "Il link potrebbe essere sbagliato, oppure il documento è stato eliminato."
            : (message ?? "Qualcosa è andato storto nel collegarsi al server.")}
        </p>
        <Button variant="primary" icon="page" className="mt-2 h-8" onPress={() => { location.hash = ""; }}>
          Torna alla Home
        </Button>
      </div>
    </div>
  );
}
