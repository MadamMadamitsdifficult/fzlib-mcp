/**
 * HTTP 传输测试：用真实 MCP 客户端连 http://127.0.0.1:8788/mcp
 * 用法：先 `npm run http`，另开终端 `node test/http.mjs`
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL || "http://127.0.0.1:8788/mcp");
console.log("connecting:", url.href);

const client = new Client({ name: "fzlib-probe-http", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(url));
console.log("server:", JSON.stringify(client.getServerVersion()));

const { tools } = await client.listTools();
console.log(`\n${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

const r = await client.callTool({ name: "fzlib_search_books", arguments: { query: "三体", page_size: 2 } });
const payload = JSON.parse(r.content[0].text);
console.log(`\nsearch ok=${payload.ok} total=${payload.data.total}`);
for (const it of payload.data.items) console.log(`  - [${it.bookrecno}] ${it.title} / ${it.call_no}`);

const h = await client.callTool({ name: "fzlib_check_holdings", arguments: { bookrecno: payload.data.items[0].bookrecno } });
const hp = JSON.parse(h.content[0].text);
console.log(`holdings: ${hp.data.items[0].available_copies}/${hp.data.items[0].total_copies} 可借`);

await client.close();
console.log("\n✅ HTTP 传输正常");
