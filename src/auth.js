/**
 * auth.js — Bearer-token authentication for the hosted HTTP transport.
 *
 * MCP_AUTH_TOKEN may hold one token or a comma-separated list (rotation).
 * Comparison is constant-time to avoid leaking the token via timing.
 * /health is always public so orchestrators can probe liveness.
 */
import { timingSafeEqual } from "node:crypto";

const RAW = process.env.MCP_AUTH_TOKEN || "";
export const TOKENS = RAW.split(",")
  .map((t) => t.trim())
  .filter(Boolean);

function safeEqual(a, b) {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract a bearer token from an Authorization header / x-api-key. */
export function extractToken(headers = {}) {
  const auth = headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  const key = headers["x-api-key"];
  if (typeof key === "string" && key.trim()) return key.trim();
  return "";
}

/** True when the request is authorized. No tokens configured => open. */
export function isAuthorized(headers = {}) {
  if (TOKENS.length === 0) return true;
  const presented = extractToken(headers);
  if (!presented) return false;
  return TOKENS.some((t) => safeEqual(presented, t));
}

export const authEnabled = TOKENS.length > 0;
