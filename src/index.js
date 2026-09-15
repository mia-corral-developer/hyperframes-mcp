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

const HF_ROOT = process.env.HF_ROOT || "/app/hf";
const HF_CLI =
  process.env.HF_CLI || path.join(HF_ROOT, "packages/cli/bin/hyperframes.mjs");
const WORKSPACE = path.resolve(process.env.HF_WORKSPACE || "/data/projects");
const TRANSPORT = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
const PORT = parseInt(process.env.PORT || "8080", 10);
const TOKEN = process.env.MCP_AUTH_TOKEN || "";
const NODE = process.execPath;

const RENDER_TIMEOUT_MS = parseInt(process.env.HF_RENDER_TIMEOUT_MS || "1800000", 10);

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
        "Puede tardar minutos. Devuelve la ruta del archivo generado dentro del workspace.",
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
      },
    },
    async ({ project, composition, output, fps, quality, format }) => {
      const dir = await resolveProject(project);
      const args = ["render", dir];
      if (composition) args.push("-c", composition);
      if (output) args.push("-o", output);
      if (fps) args.push("-f", fps);
      if (quality) args.push("-q", quality);
      if (format) args.push("--format", format);
      const r = await runHF(args, RENDER_TIMEOUT_MS);
      const body = combined(r);
      if (r.code !== 0) return fail(body);
      const rendersDir = path.join(dir, "renders");
      const files = await fs.readdir(rendersDir).catch(() => []);
      return ok(
        `${body}\n\nArchivos en ${rel(rendersDir)}/: ${files.join(", ") || "(ninguno)"}`
      );
    }
  );

  server.registerTool(
    "snapshot_frames",
    {
      description:
        "Captura frames PNG de una composición para control visual de calidad. " +
        "Devuelve la carpeta de snapshots.",
      inputSchema: {
        project: z.string().describe("Nombre del proyecto"),
        frames: z.string().optional().describe("Nº de frames equiespaciados (def 5)"),
        at: z.string().optional().describe("Timestamps en segundos, ej '3.0,10.5,18.0'"),
      },
    },
    async ({ project, frames, at }) => {
      const dir = await resolveProject(project);
      const args = ["snapshot", dir];
      if (frames) args.push("--frames", frames);
      if (at) args.push("--at", at);
      const r = await runHF(args, 900000);
      const body = combined(r);
      if (r.code !== 0) return fail(body);
      const snapDir = path.join(dir, "snapshots");
      const files = await fs.readdir(snapDir).catch(() => []);
      return ok(`${body}\n\nSnapshots en ${rel(snapDir)}/: ${files.join(", ") || "(ninguno)"}`);
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

    // Auth
    if (TOKEN) {
      const h = req.headers["authorization"] || "";
      if (h !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end('{"jsonrpc":"2.0","error":{"code":-32001,"message":"unauthorized"}}');
      }
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"status":"ok"}');
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
            ],
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
