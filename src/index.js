#!/usr/bin/env node
/**
 * hyperframes-mcp — self-hosted MCP server that exposes the HyperFrames CLI
 * (render / snapshot / lint / compositions / init) as agent tools.
 *
 * Our own server (not HeyGen's hosted connector, not the browser WebMCP
 * surface): it runs on OUR infra and our agents connect to OUR endpoint.
 *
 * Transports:
 *   - stdio  (MCP_TRANSPORT=stdio)  → for local agents (Claude Code, Cursor…)
 *   - http   (MCP_TRANSPORT=http)   → hosted, multi-agent (Dokploy + Traefik)
 *
 * Env:
 *   HF_ROOT       upstream checkout (default /app/hf)
 *   HF_CLI        CLI entry (default $HF_ROOT/packages/cli/bin/hyperframes.mjs)
 *   HF_WORKSPACE  where projects live (default /data/projects)
 *   MCP_TRANSPORT stdio | http (default stdio)
 *   PORT          HTTP port (default 8080)
 *   MCP_AUTH_TOKEN  if set, HTTP requires "Authorization: Bearer <token>"
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { JobQueue } from "./jobs.js";
import { isAuthorized, authEnabled } from "./auth.js";

const HF_ROOT = process.env.HF_ROOT || "/app/hf";
const HF_CLI =
  process.env.HF_CLI || path.join(HF_ROOT, "packages/cli/bin/hyperframes.mjs");
const WORKSPACE = path.resolve(process.env.HF_WORKSPACE || "/data/projects");
const TRANSPORT = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
const PORT = parseInt(process.env.PORT || "8080", 10);
const NODE = process.execPath;

const RENDER_TIMEOUT_MS = parseInt(process.env.HF_RENDER_TIMEOUT_MS || "1800000", 10);
const WAIT_MAX_MS = parseInt(process.env.HF_WAIT_MAX_MS || "600000", 10);

// Single shared job queue for the whole process: renders are CPU-bound, so we
// enqueue and return a job_id instead of holding the HTTP request open.
const queue = new JobQueue({
  node: NODE,
  cli: HF_CLI,
  workspace: WORKSPACE,
  defaultTimeoutMs: RENDER_TIMEOUT_MS,
});

// ── CLI runner ───────────────────────────────────────────────────────────────
function runHF(args, timeoutMs = 600000) {
  return new Promise((resolve) => {
    execFile(
      NODE,
      [HF_CLI, ...args],
      {
        cwd: WORKSPACE,
        timeout: timeoutMs,
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, HF_WORKSPACE: WORKSPACE },
      },
      (err, stdout, stderr) => {
        const timedOut = !!(err && (err.killed || err.signal === "SIGTERM"));
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: stdout || "",
          stderr: stderr || "",
          timedOut,
          error: err,
        });
      }
    );
  });
}

const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

function combined(r) {
  const out = `${r.stdout}\n${r.stderr}`.trim();
  if (r.timedOut) return `⏱ timeout tras ${RENDER_TIMEOUT_MS / 1000}s\n\n${out}`;
  return out || "(sin salida)";
}

/** Resolve a project name/path and confine it to the workspace. */
async function resolveProject(nameOrPath) {
  const raw = nameOrPath ? String(nameOrPath) : "";
  const p = raw
    ? path.isAbsolute(raw)
      ? raw
      : path.join(WORKSPACE, raw)
    : WORKSPACE;
  const rp = path.resolve(p);
  if (rp !== WORKSPACE && !rp.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`Proyecto fuera del workspace permitido: ${rp}`);
  }
  await fs.access(rp);
  return rp;
}

const rel = (abs) => path.relative(WORKSPACE, abs) || ".";

// ── Job helpers ──────────────────────────────────────────────────────────────
function jobFiles(job) {
  if (!job.outputDir || !job.outputs || job.outputs.length === 0) return [];
  const relDir = path.relative(WORKSPACE, job.outputDir);
  return job.outputs.map((f) => `/files/${relDir}/${f}`);
}

function jobSummary(job, message) {
  return JSON.stringify(
    {
      job_id: job.id,
      kind: job.kind,
      status: job.status,
      project: job.project,
      created_at: job.createdAt,
      message: message || undefined,
    },
    null,
    2
  );
}

function jobDetail(job) {
  const out = {
    job_id: job.id,
    kind: job.kind,
    status: job.status,
    project: job.project,
    created_at: job.createdAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    exit_code: job.exitCode,
    error: job.error,
    files: jobFiles(job),
  };
  const tail = (job.tail || []).slice(-40).join("\n");
  return `${JSON.stringify(out, null, 2)}${
    tail ? `\n\n--- log (últimas líneas) ---\n${tail}` : ""
  }`;
}

// ── MCP server (one instance per session / per HTTP request) ─────────────────
function buildServer() {
  const server = new McpServer({ name: "hyperframes", version: "0.1.0" });

  server.registerTool(
    "list_projects",
    { description: "Lista los proyectos HyperFrames del workspace (cada uno con su index.html)." },
    async () => {
      const entries = await fs.readdir(WORKSPACE, { withFileTypes: true });
      const projects = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const hasIndex = await fs
          .access(path.join(WORKSPACE, e.name, "index.html"))
          .then(() => true)
          .catch(() => false);
        if (hasIndex) projects.push(e.name);
      }
      return ok(JSON.stringify(projects.sort(), null, 2));
    }
  );

  server.registerTool(
    "list_compositions",
    {
      description: "Lista las composiciones de un proyecto (archivos .html). Salida JSON.",
      inputSchema: { project: z.string().describe("Nombre del proyecto dentro del workspace") },
    },
    async ({ project }) => {
      const dir = await resolveProject(project);
      const r = await runHF(["compositions", dir, "--json"], 120000);
      return r.code === 0 ? ok(combined(r)) : fail(combined(r));
    }
  );

  server.registerTool(
    "lint_project",
    {
      description:
        "Corre el linter de HyperFrames sobre un proyecto (accesibilidad, layout, motion). Salida JSON.",
      inputSchema: {
        project: z.string().describe("Nombre del proyecto"),
        verbose: z.boolean().optional().describe("Incluir hallazgos de nivel info"),
      },
    },
    async ({ project, verbose }) => {
      const dir = await resolveProject(project);
      const args = ["lint", dir, "--json"];
      if (verbose) args.push("--verbose");
      const r = await runHF(args, 180000);
      return ok(combined(r));
    }
  );

  server.registerTool(
    "render_video",
    {
      description:
        "Renderiza un proyecto/composición a MP4 (u otro formato: webm, mov, gif, png-sequence). " +
        "Por defecto ENCOLA el trabajo y devuelve un job_id — el render es pesado y no debe " +
        "bloquear la request; sigue el avance con get_job / wait_job. Usa wait=true para clips cortos.",
      inputSchema: {
        project: z.string().describe("Nombre del proyecto"),
        composition: z
          .string()
          .optional()
          .describe("Archivo de composición (ej. compositions/intro.html). Omitir = index.html"),
        output: z.string().optional().describe("Ruta de salida (relativa al proyecto)"),
        fps: z.string().optional().describe("FPS (24,30,60… o racional 30000/1001)"),
        quality: z
          .string()
          .optional()
          .describe("draft | looks (def) | delivery | standard | high"),
        format: z.string().optional().describe("mp4 (def) | webm | mov | gif | png-sequence"),
        wait: z
          .boolean()
          .optional()
          .describe("true = bloquear hasta terminar (máx HF_WAIT_MAX_MS). Def false = encolar."),
        timeout_ms: z.number().optional().describe("Timeout del render en ms (def 1800000)"),
      },
    },
    async ({ project, composition, output, fps, quality, format, wait, timeout_ms }) => {
      const dir = await resolveProject(project);
      const args = ["render", dir];
      if (composition) args.push("-c", composition);
      if (output) args.push("-o", output);
      if (fps) args.push("-f", fps);
      if (quality) args.push("-q", quality);
      if (format) args.push("--format", format);
      const job = queue.enqueue({
        kind: "render",
        project: rel(dir),
        argv: args,
        cwd: dir,
        timeoutMs: timeout_ms || RENDER_TIMEOUT_MS,
        outputDir: path.join(dir, "renders"),
      });
      if (!wait) return ok(jobSummary(job, "Encolado. Consulta con get_job / wait_job."));
      const done = await queue.waitFor(job.id, Math.min(timeout_ms || WAIT_MAX_MS, WAIT_MAX_MS));
      return done && done.status === "succeeded" ? ok(jobDetail(done)) : fail(jobDetail(done || job));
    }
  );

  server.registerTool(
    "snapshot_frames",
    {
      description:
        "Captura frames PNG de una composición para control visual de calidad. " +
        "Por defecto ENCOLA y devuelve un job_id (get_job / wait_job).",
      inputSchema: {
        project: z.string().describe("Nombre del proyecto"),
        frames: z.string().optional().describe("Nº de frames equiespaciados (def 5)"),
        at: z.string().optional().describe("Timestamps en segundos, ej '3.0,10.5,18.0'"),
        wait: z.boolean().optional().describe("true = bloquear hasta terminar. Def false = encolar."),
        timeout_ms: z.number().optional().describe("Timeout en ms (def 900000)"),
      },
    },
    async ({ project, frames, at, wait, timeout_ms }) => {
      const dir = await resolveProject(project);
      const args = ["snapshot", dir];
      if (frames) args.push("--frames", frames);
      if (at) args.push("--at", at);
      const job = queue.enqueue({
        kind: "snapshot",
        project: rel(dir),
        argv: args,
        cwd: dir,
        timeoutMs: timeout_ms || 900000,
        outputDir: path.join(dir, "snapshots"),
      });
      if (!wait) return ok(jobSummary(job, "Encolado. Consulta con get_job / wait_job."));
      const done = await queue.waitFor(job.id, Math.min(timeout_ms || WAIT_MAX_MS, WAIT_MAX_MS));
      return done && done.status === "succeeded" ? ok(jobDetail(done)) : fail(jobDetail(done || job));
    }
  );

  server.registerTool(
    "create_project",
    {
      description:
        "Crea un proyecto HyperFrames nuevo a partir de un ejemplo. Devuelve el nombre del proyecto.",
      inputSchema: {
        name: z.string().describe("Nombre del proyecto nuevo"),
        example: z
          .string()
          .optional()
          .describe("Ejemplo base (blank, warm-grain, swiss-grid, kinetic-type, product-promo…)"),
      },
    },
    async ({ name, example }) => {
      const args = ["init", name];
      if (example) args.push("-e", example);
      const r = await runHF(args, 300000);
      return r.code === 0 ? ok(combined(r)) : fail(combined(r));
    }
  );

  server.registerTool(
    "get_job",
    {
      description: "Estado y log de un job (render o snapshot) por su job_id.",
      inputSchema: { job_id: z.string().describe("ID devuelto por render_video / snapshot_frames") },
    },
    async ({ job_id }) => {
      const job = queue.get(job_id);
      if (!job) return fail(`job no encontrado: ${job_id}`);
      return ok(jobDetail(job));
    }
  );

  server.registerTool(
    "list_jobs",
    {
      description: "Lista los jobs recientes (más nuevos primero) y el estado de la cola.",
      inputSchema: { limit: z.number().optional().describe("Máximo de jobs (def 20)") },
    },
    async ({ limit }) => {
      const jobs = queue.list(limit || 20).map((j) => ({
        job_id: j.id,
        kind: j.kind,
        status: j.status,
        project: j.project,
        created_at: j.createdAt,
        finished_at: j.finishedAt,
      }));
      return ok(JSON.stringify({ queue: queue.stats(), jobs }, null, 2));
    }
  );

  server.registerTool(
    "wait_job",
    {
      description: "Bloquea hasta que el job termine (o se agote el timeout). Útil para agentes sin polling.",
      inputSchema: {
        job_id: z.string(),
        timeout_ms: z.number().optional().describe("Máxima espera en ms (def 600000)"),
      },
    },
    async ({ job_id, timeout_ms }) => {
      const cap = Math.min(timeout_ms || WAIT_MAX_MS, WAIT_MAX_MS);
      const job = await queue.waitFor(job_id, cap);
      if (!job) return fail(`job no encontrado: ${job_id}`);
      return job.status === "succeeded" ? ok(jobDetail(job)) : fail(jobDetail(job));
    }
  );

  server.registerTool(
    "cancel_job",
    {
      description: "Cancela un job en cola o en ejecución.",
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }) => {
      const r = queue.cancel(job_id);
      return r.ok ? ok(JSON.stringify(r)) : fail(JSON.stringify(r));
    }
  );

  return server;
}

// ── HTTP transport (hosted) ──────────────────────────────────────────────────
function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, Accept, Last-Event-ID"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

async function startHttp() {
  const srv = createServer(async (req, res) => {
    cors(res);
    const url = new URL(req.url, "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    // /health is public so orchestrators can probe liveness.
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", auth: authEnabled, queue: queue.stats() }));
    }

    // Auth (constant-time bearer) guards everything else.
    if (!isAuthorized(req.headers)) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"jsonrpc":"2.0","error":{"code":-32001,"message":"unauthorized"}}');
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify(
          {
            name: "hyperframes-mcp",
            mcp_endpoint: "/mcp",
            files: "/files/<path-relative-to-workspace>",
            tools: [
              "list_projects",
              "list_compositions",
              "lint_project",
              "render_video",
              "snapshot_frames",
              "create_project",
              "get_job",
              "list_jobs",
              "wait_job",
              "cancel_job",
            ],
            jobs: "/jobs",
            files: "/files/<path-relative-to-workspace>",
          },
          null,
          2
        )
      );
    }

    // Serve rendered artifacts (mp4/png) from the workspace
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const relPath = decodeURIComponent(url.pathname.slice("/files/".length));
      const fp = path.resolve(WORKSPACE, relPath);
      if (fp !== WORKSPACE && !fp.startsWith(WORKSPACE + path.sep)) {
        res.writeHead(403);
        return res.end("forbidden");
      }
      try {
        const st = await fs.stat(fp);
        if (!st.isFile()) throw new Error("not a file");
        res.writeHead(200, { "content-length": st.size });
        createReadStream(fp).pipe(res);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
      return;
    }

    // Job observability (human / dashboard / CI friendly).
    if (req.method === "GET" && url.pathname === "/jobs") {
      const jobs = queue.list(100).map((j) => ({
        job_id: j.id,
        kind: j.kind,
        status: j.status,
        project: j.project,
        created_at: j.createdAt,
        finished_at: j.finishedAt,
        exit_code: j.exitCode,
      }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ queue: queue.stats(), jobs }, null, 2));
    }
    if (req.method === "GET" && /^\/jobs\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.slice("/jobs/".length);
      const job = queue.get(id);
      res.writeHead(job ? 200 : 404, { "content-type": "application/json" });
      return res.end(JSON.stringify(job || { error: "not found", job_id: id }, null, 2));
    }
    if (req.method === "POST" && /^\/jobs\/[^/]+\/cancel$/.test(url.pathname)) {
      const id = url.pathname.slice("/jobs/".length, -"/cancel".length);
      const r = queue.cancel(id);
      res.writeHead(r.ok ? 200 : 409, { "content-type": "application/json" });
      return res.end(JSON.stringify(r));
    }

    if (url.pathname === "/mcp") {
      let parsed;
      try {
        const raw = await readBody(req);
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(
          '{"jsonrpc":"2.0","error":{"code":-32700,"message":"parse error"}}'
        );
      }
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  srv.listen(PORT, "0.0.0.0", () => {
    console.error(`[hyperframes-mcp] HTTP listening on 0.0.0.0:${PORT} (mcp: /mcp)`);
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  if (TRANSPORT === "http") {
    await startHttp();
  } else {
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[hyperframes-mcp] stdio transport ready");
  }
}

main().catch((err) => {
  console.error("[hyperframes-mcp] fatal:", err);
  process.exit(1);
});
