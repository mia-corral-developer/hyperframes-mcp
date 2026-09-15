# hyperframes-mcp

**Self-hosted MCP server** that exposes the [HyperFrames](https://github.com/heygen-com/hyperframes)
CLI as agent tools. Runs on our own infra — agents connect to **our** endpoint,
not HeyGen's hosted connector (`mcp.heygen.com`) nor the browser-only WebMCP
surface of the Studio.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | Lists HyperFrames projects in the workspace |
| `list_compositions` | Lists a project's compositions (JSON) |
| `lint_project` | Runs the HyperFrames linter (a11y/layout/motion) |
| `render_video` | Renders a project/composition → mp4/webm/mov/gif/png-sequence |
| `snapshot_frames` | Captures PNG frames for visual QA |
| `create_project` | Scaffolds a new project from an example |
| `get_job` | Status + log of a render/snapshot job |
| `list_jobs` | Recent jobs and queue state |
| `wait_job` | Blocks until a job finishes (or times out) |
| `cancel_job` | Cancels a queued or running job |

Rendering runs inside the container (chrome-headless-shell + ffmpeg bundled), so
no external accounts or credits are needed.

### Heavy ops are queued

`render_video` and `snapshot_frames` **enqueue** the work and return a `job_id`
immediately — a render takes minutes and must not hold the HTTP request open.
Follow it with `get_job` / `wait_job` / `list_jobs` / `cancel_job`, or pass
`wait: true` for short clips. Jobs are persisted to disk (`HF_JOBS_DIR`) so their
status survives restarts; render concurrency is capped by `HF_JOB_CONCURRENCY`.

## Transports

- **HTTP (hosted):** `MCP_TRANSPORT=http`, served at `POST /mcp`
  (Streamable HTTP, stateless). Rendered files are downloadable at
  `GET /files/<path-relative-to-workspace>`.
- **stdio (local):** `MCP_TRANSPORT=stdio` — for Claude Code / Cursor / Codex.

### Hosted (this deployment)

Live: **https://hyperframes-mcp.lab.whitelabel.lat**

```json
{
  "mcpServers": {
    "hyperframes": {
      "type": "http",
      "url": "https://hyperframes-mcp.lab.whitelabel.lat/mcp"
    }
  }
}
```

If `MCP_AUTH_TOKEN` is set, add `"headers": { "Authorization": "Bearer <token>" }`.

### Local (stdio)

```json
{
  "mcpServers": {
    "hyperframes": {
      "command": "docker",
      "args": ["run","-i","--rm","-e","MCP_TRANSPORT=stdio","hyperframes-mcp:latest"]
    }
  }
}
```

## Endpoints

- `POST /mcp` — MCP (Streamable HTTP)
- `GET /health` — liveness (public; includes queue state)
- `GET /jobs` — list jobs (queue state + recent)
- `GET /jobs/<id>` — single job status/log
- `POST /jobs/<id>/cancel` — cancel a job
- `GET /files/<path>` — download rendered artifacts
- `GET /` — tool index

## Env

| Var | Default | Meaning |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `8080` | HTTP port |
| `MCP_AUTH_TOKEN` | _(empty)_ | If set, require `Authorization: Bearer *** (CSV = rotation). `/health` stays public |
| `HF_WORKSPACE` | `/data/projects` | Where projects live |
| `HF_JOBS_DIR` | `/data/jobs` | Where job records are persisted |
| `HF_JOB_CONCURRENCY` | `1` | Max renders/snapshots running at once |
| `HF_JOB_TAIL_LINES` | `200` | Log lines kept per job |
| `HF_WAIT_MAX_MS` | `600000` | Cap for `wait:true` / `wait_job` |
| `HF_ROOT` / `HF_CLI` | `/app/hf` | Upstream checkout / CLI entry |
| `HF_RENDER_TIMEOUT_MS` | `1800000` | Render timeout (30 min) |

## Notes / roadmap

- Rendering is CPU/RAM heavy → it runs through a **persistent job queue**
  (`src/jobs.js`) with capped concurrency, so the MCP request returns instantly.
- The image is large (Chrome + ffmpeg + the full toolchain) and the build clones
  upstream at a pinned commit (`HF_REF`) for reproducibility.
- Not a fork of upstream — this repo carries only the server + deployment recipe.
