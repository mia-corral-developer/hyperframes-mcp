# hyperframes-mcp — self-hosted MCP server wrapping the HyperFrames CLI
# (render / snapshot / lint / compositions / init) for agents.
#
# Runs on OUR infra: agents connect to our endpoint, not HeyGen's connector.
# Image carries the full hyperframes checkout + built packages + the CLI, plus
# chrome-headless-shell + ffmpeg so rendering happens in-process.
FROM node:22-bookworm-slim

# Pinned upstream commit (heygen-com/hyperframes @ main).
ARG HF_REF=f98b8ead374c20e850995ba071c1da37cdbefe54

# ── System deps: ffmpeg + headless-Chrome libs + fonts ───────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip git ffmpeg \
      libgbm1 libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 libxdamage1 \
      libxrandr2 libcups2 libasound2 libpangocairo-1.0-0 libxshmfence1 libgtk-3-0 \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk fonts-noto-core \
      fonts-noto-extra fonts-noto-ui-core fonts-freefont-ttf fonts-dejavu-core fontconfig \
    && rm -rf /var/lib/apt/lists/* && fc-cache -fv

# ── chrome-headless-shell (deterministic capture) ────────────────────────────
RUN npx --yes @puppeteer/browsers install chrome-headless-shell@148.0.7778.167 \
      --path /opt/puppeteer \
    && CHS="$(find /opt/puppeteer/chrome-headless-shell -name chrome-headless-shell -type f | head -n1)" \
    && mkdir -p /opt/chrome \
    && ln -s "$CHS" /opt/chrome/chrome-headless-shell \
    && /opt/chrome/chrome-headless-shell --version

ENV HYPERFRAMES_CHROME_PATH=/opt/chrome/chrome-headless-shell \
    PRODUCER_HEADLESS_SHELL_PATH=/opt/chrome/chrome-headless-shell \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CONTAINER=true

# ── bun ──────────────────────────────────────────────────────────────────────
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.9"
ENV PATH="/root/.bun/bin:$PATH"

WORKDIR /app

# ── Clone upstream at the pinned ref ─────────────────────────────────────────
RUN git clone https://github.com/heygen-com/hyperframes.git /app/hf \
    && git -C /app/hf checkout "${HF_REF}"

WORKDIR /app/hf
RUN bun install --frozen-lockfile

# ── Build the workspace packages: the CLI + everything it pulls in ───────────
RUN bun run --cwd packages/parsers build \
    && bun run --cwd packages/lint build \
    && bun run --cwd packages/studio-server build \
    && bun run --cwd packages/core build \
    && bun run --cwd packages/core build:hyperframes-runtime:modular \
    && bun run --cwd packages/sdk build \
    && bun run --cwd packages/sdk-playground build \
    && bun run --cwd packages/engine build \
    && (cd packages/producer && bunx tsx scripts/generate-font-data.ts) \
    && bun run --cwd packages/producer build \
    && bun run --cwd packages/cli build

# ── Sample projects seeded into the workspace on first boot ──────────────────
RUN mkdir -p /opt/hf-samples \
    && cp -r registry/examples/kinetic-type /opt/hf-samples/ \
    && cp -r registry/examples/product-promo /opt/hf-samples/ \
    && cp -r registry/examples/swiss-grid /opt/hf-samples/

# ── Our MCP server ───────────────────────────────────────────────────────────
WORKDIR /app/mcp
COPY package.json ./
RUN bun install
COPY src ./src
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint

ENV HF_ROOT=/app/hf \
    HF_WORKSPACE=/data/projects \
    MCP_TRANSPORT=http \
    PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=10 \
    CMD curl -fsS http://localhost:8080/health >/dev/null || exit 1

ENTRYPOINT ["entrypoint"]