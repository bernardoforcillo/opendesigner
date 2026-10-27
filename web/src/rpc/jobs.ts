import { docClient } from "@/rpc/client";
import { executeJob } from "@/jobs/editorJobs";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 10_000;

/**
 * Offers this editor to the server as the place where jobs for the document run (see jobs/editorJobs.ts and
 * internal/server/jobs.go): a WatchJobs stream; each job it carries is run and answered with CompleteJob.
 * Jobs run one at a time (they share the editor's notice channel). Like presence, it always retries and
 * never disturbs editing.
 */
export class JobsClient {
  private abort: AbortController | null = null;
  private stopped = true;
  private queue: Promise<void> = Promise.resolve();

  constructor(private docId: string, private clientId: string) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  private async answer(jobId: string, kind: string, options: string, input: { name: string; data: Uint8Array } | null): Promise<void> {
    const r = await executeJob(kind, options, {}, input);
    try {
      await docClient.completeJob({
        docId: this.docId, jobId, clientId: this.clientId, ok: r.ok, message: r.message ?? "", filename: r.filename ?? "",
        contentType: r.contentType ?? "", data: r.data ?? new Uint8Array(), text: r.text ?? "",
      });
    } catch { /* the caller timed out or left; nothing to do */ }
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      this.abort = new AbortController();
      const startedAt = Date.now();
      try {
        for await (const job of docClient.watchJobs({ docId: this.docId, clientId: this.clientId }, { signal: this.abort.signal })) {
          if (job.jobId === "") { attempt = 0; continue; } // the server's "ready"
          this.queue = this.queue.then(() => this.answer(job.jobId, job.kind, job.optionsJson, job.payload.length > 0 ? { name: job.payloadName, data: job.payload } : null));
        }
      } catch { /* abort or network: retry */ }
      if (this.stopped) return;
      attempt = Date.now() - startedAt > 10_000 ? 1 : attempt + 1;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1))));
    }
  }
}
