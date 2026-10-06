import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";

/**
 * Navigate inside the app: `to` is a path with an optional query
 * (`/doc/<id>`, `/?templates=true`). Without a router around (a component
 * rendered on its own) it falls back to a plain page load.
 */
export function useAppNavigate(): (to: string) => void {
  const router = useRouter({ warn: false });
  return useCallback(
    (to: string) => {
      if (router) router.history.push(to);
      else window.location.assign(to);
    },
    [router],
  );
}
