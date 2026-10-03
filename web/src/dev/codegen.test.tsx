import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useScene } from "../store/store";
import { baseScene, transition, withFlows, flowOf } from "../flow/testSupport";
import {
  CODEGEN_DEBOUNCE_MS, fileForNode, groupFiles, groupOf, nodeIdOfFile, refreshCode, resetCodegen, setCodeFetcher,
  textOf, useCodeExport, useCodegen, type CodeFetcher, type CodeFile, type CodeTarget,
} from "./codegen";

const enc = (s: string) => new TextEncoder().encode(s);
const file = (path: string, text = ""): CodeFile => ({ path, bytes: enc(text) });
const result = (...paths: string[]) => ({ files: paths.map((p) => file(p, `// ${p}`)), warnings: [] as string[] });

function Probe({ enabled = true, targets = ["react"] as CodeTarget[] }) {
  useCodeExport(enabled, targets);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetCodegen();
  useScene.setState({ gesture: null });
  useScene.getState().setScene(withFlows(baseScene(), [flowOf("f1", "A")], [transition("t1", "f1", "A", "B")]));
});
afterEach(() => {
  cleanup();
  setCodeFetcher();
  vi.useRealTimers();
});

describe("raggruppamento dei file", () => {
  it.each<[string, CodeTarget, string]>([
    ["src/screens/Login.tsx", "react", "screens"],
    ["src/App.tsx", "react", "app"],
    ["index.html", "react", "app"],
    ["README.md", "react", "app"],
    ["package.json", "react", "config"],
    ["vite.config.ts", "react", "config"],
    ["playwright.config.ts", "react", "config"],
    ["tests/flows.spec.ts", "react", "tests"],
    ["public/assets/ab.png", "react", "assets"],
    ["login.html", "html", "screens"],
    ["index.html", "html", "screens"],
    ["assets/ab.png", "html", "assets"],
  ])("%s (%s) -> %s", (path, target, want) => expect(groupOf(path, target)).toBe(want));

  it("i gruppi escono nell'ordine Schermate, App, Configurazione, Test, Risorse, con i file ordinati; i gruppi vuoti spariscono", () => {
    const g = groupFiles(
      [file("tests/b.spec.ts"), file("package.json"), file("src/screens/B.tsx"), file("src/screens/A.tsx"), file("src/main.tsx")],
      "react",
    );
    expect(g.map((x) => x.id)).toEqual(["screens", "app", "config", "tests"]);
    expect(g[0].files.map((f) => f.path)).toEqual(["src/screens/A.tsx", "src/screens/B.tsx"]);
    expect(g[0].label).toBe("Schermate");
  });
});

describe("legame schermata <-> file (data-node-id)", () => {
  const files = [
    file("src/screens/Carrello.tsx", '<div data-node-id="s1" className="x">'),
    file("src/screens/Pagamento.tsx", '<div data-node-id="s2"><i data-node-id="b2"/>'),
    file("src/App.tsx", 'import Carrello; // data-node-id="s1" citato altrove'),
  ];
  it("fileForNode: solo fra i file di schermata", () => {
    expect(fileForNode(files, "react", "s1")?.path).toBe("src/screens/Carrello.tsx");
    expect(fileForNode(files, "react", "s2")?.path).toBe("src/screens/Pagamento.tsx");
    expect(fileForNode(files, "react", "zz")).toBeUndefined();
  });
  it("nodeIdOfFile: la radice è il primo data-node-id", () => {
    expect(nodeIdOfFile(files[1])).toBe("s2");
    expect(nodeIdOfFile(file("a.tsx", "niente"))).toBeNull();
  });
  it("textOf: UTF-8, memoizzato; i binari non si decodificano", () => {
    const f = file("a.tsx", "Città");
    expect(textOf(f)).toBe("Città");
    expect(textOf(f)).toBe(textOf(f));
    expect(textOf({ path: "x.png", bytes: new Uint8Array([137, 80]) })).toBe("");
  });
});

describe("refreshCode", () => {
  it("salva i file per target, con il documento a cui appartengono", async () => {
    setCodeFetcher(async () => result("a.tsx"));
    await refreshCode("react");
    const st = useCodegen.getState().byTarget;
    expect(st.react).toMatchObject({ status: "idle", docId: "doc", error: null });
    expect(st.react.files.map((f) => f.path)).toEqual(["a.tsx"]);
    expect(st.html.files).toEqual([]);
  });

  it("un errore del server diventa stato (e i file precedenti restano)", async () => {
    setCodeFetcher(async () => result("a.tsx"));
    await refreshCode("react");
    setCodeFetcher(async () => { throw new Error("boom"); });
    await refreshCode("react");
    expect(useCodegen.getState().byTarget.react).toMatchObject({ status: "error", error: "boom" });
    expect(useCodegen.getState().byTarget.react.files).toHaveLength(1);
  });

  it("una richiesta nuova ANNULLA la vecchia, e la risposta vecchia non vince", async () => {
    const signals: AbortSignal[] = [];
    let releaseOld!: () => void;
    const f1: CodeFetcher = (_d, _t, signal) => {
      signals.push(signal);
      return new Promise((res) => { releaseOld = () => res(result("vecchio.tsx")); });
    };
    setCodeFetcher(f1);
    const first = refreshCode("react");
    setCodeFetcher(async (_d, _t, signal) => { signals.push(signal); return result("nuovo.tsx"); });
    await refreshCode("react");
    expect(signals[0].aborted).toBe(true);
    releaseOld();
    await first;
    expect(useCodegen.getState().byTarget.react.files.map((f) => f.path)).toEqual(["nuovo.tsx"]);
  });

  it("senza scena non chiede nulla", async () => {
    const fetcher = vi.fn(async () => result());
    setCodeFetcher(fetcher);
    useScene.setState({ scene: null });
    await refreshCode("react");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("useCodeExport (debounce, gesti, annullamento)", () => {
  it("chiede subito; una raffica di cambi del confermato ne produce UNA sola, a debounce scaduto", async () => {
    const fetcher = vi.fn<CodeFetcher>(async () => result("a.tsx"));
    setCodeFetcher(fetcher);
    render(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toBe("react");

    const base = useScene.getState().scene!;
    for (let i = 0; i < 3; i++) {
      act(() => {
        useScene.getState().setScene({ ...base, transitions: { ...base.transitions, [`n${i}`]: transition(`n${i}`, "f1", "A", "C") } });
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(CODEGEN_DEBOUNCE_MS / 3); });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(CODEGEN_DEBOUNCE_MS); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("non chiede mentre un gesto è aperto", async () => {
    const fetcher = vi.fn<CodeFetcher>(async () => result());
    setCodeFetcher(fetcher);
    useScene.setState({ gesture: { selection: [], preview: new Map() } });
    render(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(CODEGEN_DEBOUNCE_MS * 3); });
    expect(fetcher).not.toHaveBeenCalled();
    useScene.setState({ gesture: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(CODEGEN_DEBOUNCE_MS * 2); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("disabilitato: nessun lavoro. Smontando: la richiesta in volo viene annullata", async () => {
    const fetcher = vi.fn<CodeFetcher>(async () => result());
    setCodeFetcher(fetcher);
    const off = render(<Probe enabled={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(CODEGEN_DEBOUNCE_MS * 3); });
    expect(fetcher).not.toHaveBeenCalled();
    off.unmount();

    let signal!: AbortSignal;
    setCodeFetcher((_d, _t, s) => { signal = s; return new Promise(() => {}); });
    const on = render(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(signal.aborted).toBe(false);
    on.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("più target: uno per target; un cambio del documento li rifà tutti", async () => {
    const fetcher = vi.fn<CodeFetcher>(async () => result());
    setCodeFetcher(fetcher);
    render(<Probe targets={["react", "html"]} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher.mock.calls.map((c) => c[1]).sort()).toEqual(["html", "react"]);
  });

  it("un target già caldo (stesso documento) non si rifà subito, solo dopo il debounce", async () => {
    const fetcher = vi.fn<CodeFetcher>(async () => result("a.tsx"));
    setCodeFetcher(fetcher);
    await refreshCode("react");
    fetcher.mockClear();
    render(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(CODEGEN_DEBOUNCE_MS / 2); });
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(CODEGEN_DEBOUNCE_MS); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
