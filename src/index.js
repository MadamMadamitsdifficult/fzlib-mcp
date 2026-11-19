#!/usr/bin/env node
/**
 * stdio 入口：给只支持 stdio 的客户端用，或本机调试。
 *
 * 与 http.js 的分工：stdio 一进程一条连接，没有端口、没有会话、也没有鉴权问题；
 * 需要多客户端或远程访问时才用 http.js —— 那边是同一份 server.js，只换了传输。
 *
 * 注意：日志一律写 stderr，stdout 留给 JSON-RPC，混了协议就废了。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";
import { config } from "./upstream.js";

const log = (...a) => console.error("[fzlib-mcp]", ...a);

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`v${VERSION} ready (stdio) · upstream=${config.BASE}`);

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      log(`收到 ${sig}，退出`);
      try {
        await server.close();
      } finally {
        process.exit(0);
      }
    });
  }
}

process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.message ?? e));

main().catch((e) => {
  log("启动失败:", e?.stack ?? e);
  process.exit(1);
});
