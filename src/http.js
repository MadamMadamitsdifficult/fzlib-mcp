#!/usr/bin/env node
/**
 * HTTP 入口：同一进程同时提供
 *   1) Streamable HTTP（新版协议，端点 /mcp，会话制）—— 推荐
 *   2) 旧版 SSE（/sse + /message）—— 兼容只认 SSE 的客户端
 *
 * 路由：POST /mcp（会话制）· GET /sse + POST /message（老客户端）· GET /health · GET /（自述）
 *
 * 为什么是会话制而不是无状态：
 * SDK 1.32 的 stateless transport 不允许跨请求复用，而每请求新建 server
 * 又会丢掉「已初始化」状态（客户端只在开头 initialize 一次）。
 * 所以按 Mcp-Session-Id 维护会话，是唯一同时满足规范与真实客户端行为的做法。
 *
 * 安全：设了 FZLIB_HTTP_TOKEN 后，除 /health 外都要 `Authorization: Bearer <token>`；
 * 没设就是完全开放。这意味着它只该绑 127.0.0.1 —— 要从别的机器访问请用 ssh -L 隧道，
 * 不要改 FZLIB_HTTP_HOST。上游是别人家的服务器，别让自己成了一台免费的爬虫跳板。
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer, VERSION } from "./server.js";
import { config } from "./upstream.js";

const log = (...a) => console.error("[fzlib-mcp]", ...a);

const PORT = Number(process.env.FZLIB_HTTP_PORT || process.env.PORT || 8788);
const HOST = process.env.FZLIB_HTTP_HOST || "127.0.0.1";
const TOKEN = process.env.FZLIB_HTTP_TOKEN || "";
const MAX_BODY = 1_000_000;
const SESSION_TTL_MS = Number(process.env.FZLIB_SESSION_TTL_MS || 30 * 60_000);

/* ---------------- 基础工具 ---------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("请求体过大"), { code: "TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

const rpcError = (code, message) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

function applyCors(req, res) {
  res.setHeader("access-control-allow-origin", req.headers.origin || "*");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type, accept, authorization, x-fzlib-token, mcp-session-id, mcp-protocol-version, last-event-id",
  );
  res.setHeader("access-control-expose-headers", "mcp-session-id");
  res.setHeader("access-control-max-age", "86400");
}

function authorized(req, path) {
  // /health 供平台探活、/ 是说明页，都不含书目数据，一律放行
  if (!TOKEN || path === "/health" || path === "/") return true;

  // 自定义头优先：前面挂了反向代理（如魔搭创空间网关）时，Authorization
  // 常被平台自己占用（它要用 Bearer 放自己的令牌），这时本服务的令牌走
  // X-Fzlib-Token，两者互不打架。
  const custom = req.headers["x-fzlib-token"] || "";
  if (custom && (custom === TOKEN || custom === `Bearer ${TOKEN}`)) return true;

  const h = req.headers.authorization || "";
  if (h === `Bearer ${TOKEN}` || h === TOKEN) return true;

  // 鉴权失败时打一行诊断：只报头名与长度，不落任何令牌明文。
  // 部署在网关后面时，最常见的两种翻车是「令牌不一致」和「自定义头被网关吞掉」，
  // 这行日志能一眼分清。
  log(
    `401 ${req.method} ${path} · 收到的头=[${Object.keys(req.headers).join(",")}]` +
      ` · 期望令牌长度=${TOKEN.length} · x-fzlib-token长度=${custom.length} · authorization长度=${h.length}`,
  );
  return false;
}

/* ---------------- 会话表 ---------------- */

const mcpSessions = new Map(); // sessionId -> { transport, server, lastUsed, label }
const sseSessions = new Map();

function touch(session) {
  session.lastUsed = Date.now();
}

function dropSession(id, why) {
  const s = mcpSessions.get(id);
  if (!s) return;
  mcpSessions.delete(id);
  s.transport.close().catch(() => {});
  s.server.close().catch(() => {});
  log(`session ${id.slice(0, 8)} 关闭（${why}）`);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of mcpSessions) {
    if (now - s.lastUsed > SESSION_TTL_MS) dropSession(id, "超时");
  }
}, 60_000).unref();

/* ---------------- Streamable HTTP ---------------- */

async function handleMcpPost(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : undefined;
  } catch (err) {
    return json(res, err.code === "TOO_LARGE" ? 413 : 400, rpcError(-32700, "请求体不是合法 JSON"));
  }

  const sid = req.headers["mcp-session-id"];
  const isInit = body && typeof body === "object" && body.method === "initialize";

  // 已有会话：直接复用
  const existing = sid && mcpSessions.get(sid);
  if (existing) {
    touch(existing);
    try {
      await existing.transport.handleRequest(req, res, body);
    } catch (err) {
      log("mcp handler error:", err?.stack ?? err);
      if (!res.headersSent) json(res, 500, rpcError(-32603, "内部错误"));
    }
    return;
  }

  // 新会话只允许从 initialize 开始
  if (!isInit) {
    return json(
      res,
      400,
      rpcError(-32000, sid ? "会话不存在或已过期，请重新 initialize" : "缺少 Mcp-Session-Id，请先发送 initialize"),
      { "mcp-session-id": "" },
    );
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true, // 直接回 JSON，便于 curl 调试
  });
  transport.onerror = (err) => log("transport error:", err?.message ?? err);
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) dropSession(id, "传输层关闭");
  };

  await server.connect(transport);

  try {
    await transport.handleRequest(req, res, body);
  } catch (err) {
    log("initialize 失败:", err?.stack ?? err);
    if (!res.headersSent) json(res, 500, rpcError(-32603, "初始化失败"));
    return;
  }

  const id = transport.sessionId;
  if (id) {
    mcpSessions.set(id, {
      transport,
      server,
      lastUsed: Date.now(),
      label: body?.params?.clientInfo?.name || "unknown",
    });
    log(`session ${id.slice(0, 8)} 建立（${body?.params?.clientInfo?.name ?? "?"}，当前 ${mcpSessions.size} 个）`);
  }
}

async function handleMcpStream(req, res) {
  const sid = req.headers["mcp-session-id"];
  const s = sid && mcpSessions.get(sid);
  if (!s) {
    return json(res, 400, rpcError(-32000, "缺少或无效的 Mcp-Session-Id"));
  }
  touch(s);
  try {
    await s.transport.handleRequest(req, res);
  } catch (err) {
    log("stream error:", err?.message ?? err);
    if (!res.headersSent) json(res, 500, rpcError(-32603, "内部错误"));
  }
}

function handleMcpDelete(req, res) {
  const sid = req.headers["mcp-session-id"];
  if (!sid || !mcpSessions.has(sid)) {
    return json(res, 404, rpcError(-32000, "会话不存在"));
  }
  dropSession(sid, "客户端主动结束");
  res.writeHead(200, { "content-type": "application/json" }).end("{}");
}

/* ---------------- 旧版 SSE ---------------- */

async function handleSseOpen(req, res) {
  const server = createServer();
  const transport = new SSEServerTransport("/message", res);
  sseSessions.set(transport.sessionId, { transport, server, lastUsed: Date.now() });

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* 已断开，交给 cleanup */
    }
  }, 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    sseSessions.delete(transport.sessionId);
    transport.close().catch(() => {});
    server.close().catch(() => {});
  };

  res.on("close", cleanup);
  req.on("aborted", cleanup);

  try {
    await server.connect(transport);
    log(`sse session ${transport.sessionId.slice(0, 8)} 打开（当前 ${sseSessions.size} 个）`);
  } catch (err) {
    log("sse open error:", err?.message ?? err);
    cleanup();
  }
}

async function handleSseMessage(req, res, url) {
  const sessionId = url.searchParams.get("sessionId");
  const session = sessionId && sseSessions.get(sessionId);
  if (!session) return json(res, 400, rpcError(-32000, "未知或已过期的 sessionId"));

  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    return json(res, 400, rpcError(-32700, "请求体不是合法 JSON"));
  }
  try {
    await session.transport.handlePostMessage(req, res, body);
  } catch (err) {
    log("sse message error:", err?.message ?? err);
    if (!res.headersSent) json(res, 500, rpcError(-32603, "内部错误"));
  }
}

/* ---------------- HTTP 服务 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (!authorized(req, path)) {
    return json(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  }

  try {
    if (path === "/health" && req.method === "GET") {
      return json(res, 200, {
        status: "ok",
        name: "fzlib-mcp",
        version: VERSION,
        transports: { "streamable-http": "/mcp", sse: "/sse" },
        sessions: { mcp: mcpSessions.size, sse: sseSessions.size },
        upstream: config.BASE,
        auth_required: Boolean(TOKEN),
      });
    }

    if (path === "/" && req.method === "GET") {
      const authNote = TOKEN
        ? "本服务已启用访问令牌：请把令牌放在 <code>X-Fzlib-Token</code> 头里。" +
          "若前面还有平台网关（如魔搭创空间），它通常占用了 <code>Authorization</code>，" +
          "两个头可以并存、互不干扰。"
        : "本服务未启用访问令牌；请只在可信任的网络中使用。";
      const sample = TOKEN
        ? `{
  "mcpServers": {
    "fzlib": {
      "url": "${url.origin}/mcp",
      "headers": {
        "X-Fzlib-Token": "&lt;本服务令牌&gt;"
      }
    }
  }
}`
        : `{
  "mcpServers": {
    "fzlib": { "url": "${url.origin}/mcp" }
  }
}`;
      const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>fzlib-mcp v${VERSION} · 福州图书馆 OPAC MCP</title>
<style>
:root{color-scheme:light dark}
body{margin:0 auto;padding:2.5rem 1.25rem;max-width:44rem;
  font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans CJK SC",sans-serif}
h1{font-size:1.4rem;margin:0 0 .3rem}
h1 small{font-size:.75rem;font-weight:400;opacity:.55}
p.sub{opacity:.6;margin:0 0 2rem}
table{border-collapse:collapse;width:100%;margin:1rem 0 2rem}
th,td{text-align:left;padding:.55rem .6rem;border-bottom:1px solid rgba(128,128,128,.25);vertical-align:top}
th{font-weight:600;white-space:nowrap;width:9rem}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em}
pre{background:rgba(128,128,128,.12);padding:.85rem 1rem;border-radius:8px;overflow:auto}
h2{font-size:1.05rem;margin:2rem 0 .45rem}
.note{font-size:.88rem;line-height:1.7;opacity:.62;border-left:3px solid rgba(128,128,128,.35);padding-left:.9rem}
</style></head><body>
<h1>fzlib-mcp <small>v${VERSION}</small></h1>
<p class="sub">福州图书馆（福州地区图书馆联合检索平台）OPAC 的只读 MCP 服务器</p>
<table>
<tr><th>Streamable HTTP</th><td><code>POST ${url.origin}/mcp</code><br>先 <code>initialize</code>，后续带 <code>Mcp-Session-Id</code> 复用</td></tr>
<tr><th>Legacy SSE</th><td><code>GET ${url.origin}/sse</code></td></tr>
<tr><th>健康检查</th><td><code>GET ${url.origin}/health</code></td></tr>
</table>
<h2>接入示例</h2>
<pre>${sample}</pre>
<h2>说明</h2>
<p>${authNote}</p>
<p class="note">本项目为第三方非官方工具，与福州市图书馆及其运维方无隶属、合作或授权关系。<br>
书目与馆藏数据来自该馆对公众开放的 OPAC 接口，可能滞后或有误，<b>一切以馆内实际馆藏与工作人员答复为准</b>。<br>
软件按 MIT 许可「AS IS」提供，不附带任何担保；请勿降低内置限流，或用于批量抓取。</p>
</body></html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (path === "/mcp") {
      if (req.method === "POST") return await handleMcpPost(req, res);
      if (req.method === "GET") return await handleMcpStream(req, res);
      if (req.method === "DELETE") return handleMcpDelete(req, res);
      return json(res, 405, rpcError(-32000, "Method not allowed"), { allow: "GET, POST, DELETE, OPTIONS" });
    }

    if (path === "/sse" && req.method === "GET") return await handleSseOpen(req, res);
    if (path === "/message" && req.method === "POST") return await handleSseMessage(req, res, url);

    return json(res, 404, { error: "not found", paths: ["/mcp", "/sse", "/message", "/health"] });
  } catch (err) {
    log("未捕获异常:", err?.stack ?? err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  }
});

// 上游偶有 40s 级慢响应，别让 keepAlive 先把连接掐了
server.keepAliveTimeout = 125_000;
server.headersTimeout = 130_000;
server.requestTimeout = 0;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log(`端口 ${PORT} 已被占用 → 换个端口：FZLIB_HTTP_PORT=8899 node src/http.js`);
  } else {
    log("HTTP 服务错误:", err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // 0.0.0.0 表示监听全部网卡，直接打印原值，别换成易被误解的提示语
  const shown = HOST;
  log(`v${VERSION} ready (http) · http://${shown}:${PORT}/mcp`);
  log(`上游 ${config.BASE} · 鉴权 ${TOKEN ? "已开启 Bearer" : "未开启"}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`收到 ${sig}，关闭 ${mcpSessions.size} 个 MCP 会话 / ${sseSessions.size} 个 SSE 会话`);
    for (const id of [...mcpSessions.keys()]) dropSession(id, "进程退出");
    for (const { transport, server: s } of sseSessions.values()) {
      transport.close().catch(() => {});
      s.close().catch(() => {});
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.message ?? e));
