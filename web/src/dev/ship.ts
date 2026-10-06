import type { CodeFile, CodeTarget } from "./codegen";
import { makeZip } from "./zip";
import { slugOf } from "./readiness";

// SHIPPING: the zip's name, the commands to copy, the tools' names for
// agents. All pure text (and the zip), so the view stays thin and the commands
// can be tested without mounting anything.

/** `<doc>-react.zip` / `<doc>-html.zip`: the document's name as a slug (ASCII, no spaces). */
export function zipName(docName: string, target: CodeTarget): string {
  return `${slugOf(docName.trim() === "" ? "design" : docName)}-${target}.zip`;
}

/** The generated project's zip: all the files, at their paths. */
export function projectZip(files: readonly CodeFile[], when?: Date): Uint8Array {
  return makeZip(files.map((f) => ({ path: f.path, data: f.bytes })), when);
}

/** Quotes for the shell: only if needed (spaces or special characters). */
export function shq(s: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface CommandStep {
  id: string;
  title: string;
  command: string;
  hint: string;
}

/** The commands, in the order in which they are used. `docName` serves the CLI commands (-doc). */
export function shipCommands(docName: string, zip: string): CommandStep[] {
  const dir = zip.replace(/\.zip$/, "");
  const doc = shq(docName.trim() === "" ? "Untitled" : docName);
  return [
    {
      id: "run", title: "Start the app", hint: "Unzip, install and open the dev server.",
      command: `unzip ${shq(zip)} -d ${shq(dir)} && cd ${shq(dir)} && npm i && npm run dev`,
    },
    { id: "e2e", title: "Run the e2e tests", hint: "The flow tests are already in the zip (tests/flows.spec.ts).", command: "npx playwright test" },
    { id: "check", title: "Check the flows", hint: "From the design workspace: no dead ends, no orphan screens.", command: `opendesigner flow check -doc ${doc}` },
    { id: "coverage", title: "Coverage in the code", hint: "Which screens and which edges are still missing in the repo.", command: `opendesigner flow coverage -doc ${doc} -repo ./${dir}` },
  ];
}

/** The commands as a pasteable script (a comment and a command per step). */
export function shipScript(steps: readonly CommandStep[]): string {
  return steps.map((s) => `# ${s.title}\n${s.command}`).join("\n\n");
}

/** The MCP tools for an agent, with what they are for. */
export const AGENT_TOOLS: readonly { name: string; hint: string }[] = [
  { name: "get_flow_spec", hint: "the flows' Markdown spec, to use as a requirement" },
  { name: "export_code", hint: "generates the project (react or html) in a folder" },
  { name: "analyze_flows", hint: "flow issues and paths" },
];

export const AGENT_PROMPT =
  "Read the spec with get_flow_spec, build the missing screens, write code.route and code.component " +
  "with set_node_meta, then verify with analyze_flows and close the loop with `opendesigner flow tests` and `coverage`.";
