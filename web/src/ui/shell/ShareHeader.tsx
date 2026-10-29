import type { ReactNode } from "react";
import { Button } from "@/ui/ds";
import { useShareDialog } from "@/store/dialogs";

// THE PEOPLE ROW at the top of the right panel (Figma-style workspace): who is here -- your avatar and the
// others, with the nickname and the link in the popover (`presence`, the PresenceBar) -- and the Share button,
// which opens the Share dialog (links with a role). Present stays in the tool dock, in Flows, where it starts
// from the screen that is open.
export function ShareHeader({ presence }: { presence: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line pl-1.5 pr-2" role="group" aria-label="People and sharing">
      {presence}
      <span className="ml-auto flex items-center gap-1.5">
        <Button variant="primary" aria-label="Share document" onPress={() => useShareDialog.getState().setOpen(true)}>
          Share
        </Button>
      </span>
    </div>
  );
}
