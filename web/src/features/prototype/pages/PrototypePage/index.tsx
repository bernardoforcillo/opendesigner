import { PrototypePlayer } from "@features/prototype/components/organisms/PrototypePlayer";

export function PrototypePage({ onClose }: { onClose?: () => void }) {
  return <PrototypePlayer onClose={onClose ?? (() => window.history.back())} />;
}
