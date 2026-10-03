import type { CodeFile, CodeTarget } from "./codegen";
import { makeZip } from "./zip";
import { slugOf } from "./readiness";

// SPEDIRE: il nome dello zip, i comandi da copiare, i nomi dei tool per gli
// agenti. Tutto testo puro (e lo zip), così la vista resta sottile e i comandi
// si provano senza montare niente.

/** `<doc>-react.zip` / `<doc>-html.zip`: il nome del documento in slug (ASCII, senza spazi). */
export function zipName(docName: string, target: CodeTarget): string {
  return `${slugOf(docName.trim() === "" ? "design" : docName)}-${target}.zip`;
}

/** Lo zip del progetto generato: tutti i file, nei loro percorsi. */
export function projectZip(files: readonly CodeFile[], when?: Date): Uint8Array {
  return makeZip(files.map((f) => ({ path: f.path, data: f.bytes })), when);
}

/** Virgolette per la shell: solo se servono (spazi o caratteri speciali). */
export function shq(s: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface CommandStep {
  id: string;
  title: string;
  command: string;
  hint: string;
}

/** I comandi, nell'ordine in cui si usano. `docName` serve ai comandi della CLI (-doc). */
export function shipCommands(docName: string, zip: string): CommandStep[] {
  const dir = zip.replace(/\.zip$/, "");
  const doc = shq(docName.trim() === "" ? "Untitled" : docName);
  return [
    {
      id: "run", title: "Avvia l'app", hint: "Scompatta, installa e apri il dev server.",
      command: `unzip ${shq(zip)} -d ${shq(dir)} && cd ${shq(dir)} && npm i && npm run dev`,
    },
    { id: "e2e", title: "Esegui i test e2e", hint: "I test dei flussi sono già nello zip (tests/flows.spec.ts).", command: "npx playwright test" },
    { id: "check", title: "Controlla i flussi", hint: "Dal workspace del design: nessun vicolo cieco, nessuna schermata orfana.", command: `opendesigner flow check -doc ${doc}` },
    { id: "coverage", title: "Copertura nel codice", hint: "Quali schermate e quali archi mancano ancora nel repo.", command: `opendesigner flow coverage -doc ${doc} -repo ./${dir}` },
  ];
}

/** I comandi come uno script incollabile (un commento e un comando per passo). */
export function shipScript(steps: readonly CommandStep[]): string {
  return steps.map((s) => `# ${s.title}\n${s.command}`).join("\n\n");
}

/** I tool MCP per un agente, con a cosa servono. */
export const AGENT_TOOLS: readonly { name: string; hint: string }[] = [
  { name: "get_flow_spec", hint: "la specifica Markdown dei flussi, da usare come requisito" },
  { name: "export_code", hint: "genera il progetto (react o html) in una cartella" },
  { name: "analyze_flows", hint: "problemi e percorsi dei flussi" },
];

export const AGENT_PROMPT =
  "Leggi la specifica con get_flow_spec, realizza le schermate mancanti, scrivi code.route e code.component " +
  "con set_node_meta, poi verifica con analyze_flows e chiudi il giro con `opendesigner flow tests` e `coverage`.";
