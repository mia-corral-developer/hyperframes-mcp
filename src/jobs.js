/**
 * jobs.js — persistent, concurrency-limited job queue for heavy HyperFrames
 * operations (render, snapshot). Keeps the HTTP request short: the MCP tool
 * enqueues a job and returns a job_id; the agent polls get_job / wait_job.
 *
 * State lives on disk (one JSON file per job) under HF_JOBS_DIR so status
 * survives container restarts, plus a bounded in-memory tail of the CLI log.
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const JOBS_DIR = path.resolve(process.env.HF_JOBS_DIR || "/data/jobs");
const CONCURRENCY = Math.max(1, parseInt(process.env.HF_JOB_CONCURRENCY || "1", 10));
const TAIL_LINES = Math.max(20, parseInt(process.env.HF_JOB_TAIL_LINES || "200", 10));

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

function nowIso() {
  return new Date().toISOString();
}

export class JobQueue extends EventEmitter {
  constructor({ node, cli, workspace, defaultTimeoutMs = 1800000 }) {
    super();
    this.node = node;
    this.cli = cli;
    this.workspace = workspace;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.jobs = new Map();
    this.pending = [];
    this.running = 0;
    this.children = new Map(); // jobId -> ChildProcess
    this.ready = this.#init();
  }

  async #init() {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    const files = await fs.readdir(JOBS_DIR).catch(() => []);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await fs.readFile(path.join(JOBS_DIR, f), "utf8"));
        // A job left "running" cannot have survived the restart.
        if (rec.status === "running" || rec.status === "queued") {
          rec.status = "failed";
          rec.error = "interrumpido por reinicio del servidor";
          rec.finishedAt = rec.finishedAt || nowIso();
          await this.#persist(rec);
        }
        this.jobs.set(rec.id, rec);
      } catch {
        /* ignore corrupt job files */
      }
    }
    this.emit("ready");
  }

  async #persist(rec) {
    const fp = path.join(JOBS_DIR, `${rec.id}.json`);
    const tmp = `${fp}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(rec, null, 2)).catch(() => {});
    await fs.rename(tmp, fp).catch(() => {});
  }

  #tail(rec, chunk) {
    rec.tail = rec.tail || [];
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      rec.tail.push(line);
    }
    if (rec.tail.length > TAIL_LINES) rec.tail = rec.tail.slice(-TAIL_LINES);
  }

  enqueue({ kind, project, argv, cwd, timeoutMs, outputDir }) {
    const rec = {
      id: randomUUID(),
      kind,
      project: project || null,
      argv,
      cwd: cwd || this.workspace,
      status: "queued",
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
      outputDir: outputDir || null,
      outputs: [],
      tail: [],
      timeoutMs: timeoutMs || this.defaultTimeoutMs,
    };
    this.jobs.set(rec.id, rec);
    this.pending.push(rec.id);
    this.#persist(rec);
    this.emit("enqueued", rec);
    this.#drain();
    return rec;
  }

  #drain() {
    while (this.running < CONCURRENCY && this.pending.length > 0) {
      const id = this.pending.shift();
      const rec = this.jobs.get(id);
      if (!rec || rec.status !== "queued") continue;
      this.#run(rec);
    }
  }

  async #run(rec) {
    this.running += 1;
    rec.status = "running";
    rec.startedAt = nowIso();
    await this.#persist(rec);
    this.emit("started", rec);

    const finish = async (status, { exitCode = null, error = null } = {}) => {
      rec.status = status;
      rec.exitCode = exitCode;
      rec.error = error;
      rec.finishedAt = nowIso();
      if (rec.status === "succeeded" && rec.outputDir) {
        rec.outputs = await fs.readdir(rec.outputDir).catch(() => []);
      }
      await this.#persist(rec);
      this.children.delete(rec.id);
      this.running -= 1;
      this.emit("finished", rec);
      this.#drain();
    };

    try {
      await fs.mkdir(rec.cwd, { recursive: true });
      const child = spawn(this.node, [this.cli, ...rec.argv], {
        cwd: rec.cwd,
        env: { ...process.env, HF_WORKSPACE: this.workspace },
      });
      this.children.set(rec.id, child);

      const timer = setTimeout(() => {
        this.#tail(rec, `⏱ timeout tras ${rec.timeoutMs / 1000}s — matando proceso`);
        child.kill("SIGKILL");
      }, rec.timeoutMs);
      timer.unref?.();

      child.stdout.on("data", (c) => this.#tail(rec, c));
      child.stderr.on("data", (c) => this.#tail(rec, c));

      child.on("error", (err) => {
        clearTimeout(timer);
        finish("failed", { error: String(err) });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (rec.status === "canceled") return finish("canceled");
        if (signal) return finish("failed", { error: `terminado por señal ${signal}` });
        if (code === 0) return finish("succeeded", { exitCode: 0 });
        finish("failed", { exitCode: code });
      });
    } catch (err) {
      await finish("failed", { error: String(err) });
    }
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  list(limit = 50) {
    return [...this.jobs.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, Math.max(1, limit));
  }

  cancel(id) {
    const rec = this.jobs.get(id);
    if (!rec) return { ok: false, reason: "job no encontrado" };
    if (TERMINAL.has(rec.status)) return { ok: false, reason: `job ya ${rec.status}` };
    if (rec.status === "queued") {
      this.pending = this.pending.filter((x) => x !== id);
      rec.status = "canceled";
      rec.finishedAt = nowIso();
      this.#persist(rec);
      this.emit("finished", rec);
      return { ok: true, status: "canceled" };
    }
    rec.status = "canceled";
    const child = this.children.get(id);
    if (child) child.kill("SIGKILL");
    return { ok: true, status: "canceling" };
  }

  /** Block until a job reaches a terminal state or the timeout elapses. */
  waitFor(id, timeoutMs = 600000) {
    const rec = this.jobs.get(id);
    if (!rec) return Promise.resolve(null);
    if (TERMINAL.has(rec.status)) return Promise.resolve(rec);
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const cur = this.jobs.get(id);
        if (!cur || TERMINAL.has(cur.status)) return resolve(cur);
        if (Date.now() - started >= timeoutMs) return resolve(cur);
        setTimeout(tick, 500).unref?.();
      };
      tick();
    });
  }

  stats() {
    return {
      concurrency: CONCURRENCY,
      running: this.running,
      queued: this.pending.length,
      total: this.jobs.size,
    };
  }
}
