import { Button, Icon } from "../ui/ds";

// THE EDITOR'S ERROR CARD when the document is missing (wrong link,
// deleted document, different workspace). A dead end with a single clear
// exit: the Home.

export function DocUnavailable({ notFound, message }: { notFound: boolean; message?: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-canvas p-6 text-fg">
      <div role="alert" className="flex w-full max-w-[360px] flex-col items-center gap-2 rounded-xl bg-surface px-6 py-8 text-center shadow-[var(--shadow-bar)]">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-warn-soft text-warn">
          <Icon name="warning" size={20} />
        </span>
        <h1 className="text-[15px] font-semibold">{notFound ? "Document not found" : "Unable to open the document"}</h1>
        <p className="text-[13px] leading-relaxed text-fg-muted">
          {notFound
            ? "The link may be wrong, or the document has been deleted."
            : (message ?? "Something went wrong while connecting to the server.")}
        </p>
        <Button variant="primary" icon="page" className="mt-2 h-8" onPress={() => { location.hash = ""; }}>
          Back to Home
        </Button>
      </div>
    </div>
  );
}
