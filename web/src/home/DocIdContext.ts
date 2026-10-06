import { createContext, useContext } from "react";

/** The id of the document the editor was mounted for (from the `/doc/$docId` route). */
export const DocIdContext = createContext<string | null>(null);

export const useRouteDocId = (): string | null => useContext(DocIdContext);
