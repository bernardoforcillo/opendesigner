import { Button, ToggleButton } from "react-aria-components";

export function App() {
  return (
    <div className="flex h-screen flex-col">
      <div role="toolbar" aria-label="Strumenti" className="flex gap-2 border-b border-neutral-200 p-2">
        <ToggleButton id="select" className="rounded px-3 py-1 text-sm data-[selected]:bg-neutral-800 data-[selected]:text-white">Seleziona</ToggleButton>
        <ToggleButton id="rect" className="rounded px-3 py-1 text-sm data-[selected]:bg-neutral-800 data-[selected]:text-white">Rettangolo</ToggleButton>
        <Button className="rounded px-3 py-1 text-sm hover:bg-neutral-100">Nuovo documento</Button>
      </div>
      <canvas id="scene" className="block flex-1" />
    </div>
  );
}
