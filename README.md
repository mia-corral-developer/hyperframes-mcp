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

Rendering runs inside the container (chrome-headless-shell + ffmpeg bundled), so
no external accounts or credits are needed.

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
- `GET /health` — liveness
- `GET /files/<path>` — download rendered artifacts
- `GET /` — tool index

## Env

| Var | Default | Meaning |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `8080` | HTTP port |
| `MCP_AUTH_TOKEN` | _(empty)_ | If set, require `Authorization: Bearer *** |
| `HF_WORKSPACE` | `/data/projects` | Where projects live |
| `HF_ROOT` / `HF_CLI` | `/app/hf` | Upstream checkout / CLI entry |
| `HF_RENDER_TIMEOUT_MS` | `1800000` | Render timeout (30 min) |

## Notes / roadmap

- Rendering is CPU/RAM heavy. v1 runs it synchronously per call (30 min cap).
  **Roadmap:** job queue + status polling so big renders don't block a request.
- The image is large (Chrome + ffmpeg + the full toolchain) and the build clones
  upstream at a pinned commit (`HF_REF`) for reproducibility.
- Not a fork of upstream — this repo carries only the server + deployment recipe.
