import { useMemo, type ReactNode } from "react";
import type { RouterHistory } from "@tanstack/react-router";
import { AppRouter, createAppRouter } from "./router";

// THE ROOT: mounts the router (see router.tsx), which chooses between Home and
// editor from the URL path: `/` is the Home, `/doc/<id>` the editor. The shared
// links, the browser's Back button and "Back to Home" all work for the same reason.

export { documentTitleFor } from "./title";

export function Root({ editor, home, history }: { editor?: ReactNode; home?: ReactNode; history?: RouterHistory } = {}) {
  const router = useMemo(() => createAppRouter({ editor, home, history }), []); // eslint-disable-line react-hooks/exhaustive-deps
  return <AppRouter router={router} />;
}
