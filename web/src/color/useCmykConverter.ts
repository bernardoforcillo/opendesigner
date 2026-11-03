import { useEffect, useSyncExternalStore } from "react";
import { activeConverter, subscribeActiveProfile, syncActiveProfile, type CmykConverter } from "@/color/activeProfile";
import { fetchAssetDataUrl } from "@/export/exportScene";
import { useScene } from "@/store/store";

/** Keeps the active output profile in step with the open document and re-renders when it changes. */
export function useCmykConverter(): CmykConverter {
  const docId = useScene((s) => s.scene?.id ?? "");
  const hash = useScene((s) => s.scene?.settings?.iccProfileAsset ?? "");
  useEffect(() => { if (docId) void syncActiveProfile(docId, hash, fetchAssetDataUrl); }, [docId, hash]);
  return useSyncExternalStore(subscribeActiveProfile, activeConverter);
}
