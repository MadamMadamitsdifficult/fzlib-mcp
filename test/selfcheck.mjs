/**
 * 自包含端到端自检：自己拉起 http.js → 分别用
 *   Streamable HTTP 与 旧版 SSE 两种传输连上去 → 调工具 → 关掉。
 * 不需要预先启动服务，也不需要懂命令。
 *
 * 用法：node test/selfcheck.mjs
 */
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const PORT = Number(process.env.FZLIB_HTTP_PORT || 20000 + Math.floor(Math.random() * 20000));
const BASE = `http://127.0.0.1:${PORT}`;
const ENTRY = new URL("../src/http.js", import.meta.url).pathname;

const child = spawn(process.execPath, [ENTRY], {
  env: { ...process.env, FZLIB_HTTP_PORT: String(PORT) },
  stdio: ["ignore", "ignore", "pipe"],
});
let childLog = "";
child.stderr.on("data", (d) => {
  childLog += d.toString();
});

function shutdown() {
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

async function waitHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪\n${childLog}`);
}

let failed = 0;

async function probe(label, transportFactory) {
  process.stdout.write(`\n=== ${label}\n`);
  const client = new Client({ name: "selfcheck", version: "0.0.1" });
  try {
    await client.connect(transportFactory());
    const { tools } = await client.listTools();
    console.log(`  工具 ${tools.length} 个：${tools.map((t) => t.name).join(", ")}`);

    const r = await client.callTool({
      name: "fzlib_search_books",
      arguments: { query: "三体", page_size: 2 },
    });
    const payload = JSON.parse(r.content[0].text);
    if (!payload.ok) throw new Error(`工具返回失败：${payload.error?.code}`);
    console.log(`  检索「三体」→ ${payload.data.total} 条，首条：${payload.data.items[0].title}`);
    console.log(`  meta.cached=${payload.meta.cached}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${err.message}`);
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}

try {
  const health = await waitHealth();
  console.log(`server up: ${JSON.stringify(health)}`);

  await probe("Streamable HTTP  POST /mcp", () => new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  await probe("Legacy SSE        GET  /sse", () => new SSEClientTransport(new URL(`${BASE}/sse`)));

  // 探活与 404 行为
  const notFound = await fetch(`${BASE}/nope`);
  console.log(`\n=== 路由\n  GET /nope → ${notFound.status}（应为 404）`);
  if (notFound.status !== 404) failed++;

  console.log(`\n${failed ? `❌ ${failed} 项失败` : "✅ HTTP 双栈全部通过"}`);
} catch (err) {
  failed++;
  console.log(`\n❌ ${err.message}`);
} finally {
  shutdown();
}

process.exit(failed ? 1 : 0);
