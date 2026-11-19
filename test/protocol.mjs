/**
 * 协议测试：以真实 MCP 客户端身份通过 stdio 连接本服务器，
 * 走完 initialize → tools/list → tools/call 全流程。
 * 用法：node test/protocol.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../src/index.js", import.meta.url).pathname],
  stderr: "pipe",
});

const client = new Client({ name: "fzlib-probe", version: "0.0.1" });
await client.connect(transport);
console.log("connected:", JSON.stringify(client.getServerVersion()));

const { tools } = await client.listTools();
console.log(`\n${tools.length} tools:`);
for (const t of tools) {
  const props = t.inputSchema?.properties ?? {};
  console.log(`  - ${t.name}(${Object.keys(props).join(", ")})`);
}

const r = await client.callTool({ name: "fzlib_search_books", arguments: { query: "三体", page_size: 2 } });
const payload = JSON.parse(r.content[0].text);
console.log(`\ncallTool ok=${payload.ok} total=${payload.data.total} first=${payload.data.items[0].title}`);
console.log("structuredContent 存在:", Boolean(r.structuredContent));

const bad = await client.callTool({ name: "fzlib_get_book", arguments: { bookrecno: 1 } });
console.log(`\n错误路径 isError=${bad.isError}: ${JSON.parse(bad.content[0].text).error.code}`);

await client.close();
console.log("\n✅ 协议链路正常");
