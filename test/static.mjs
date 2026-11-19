/**
 * 离线自检：不碰上游、不发任何网络请求，适合放进 CI。
 * 检查项：语法、工具清单、schema 完整性、版本号一致性。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tools } from "../src/tools.js";
import { VERSION } from "../src/server.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
};

console.log("\n[1] 语法检查");
const files = fs.readdirSync("src").filter((f) => f.endsWith(".js"));
for (const f of files) {
  try { execFileSync(process.execPath, ["--check", path.join("src", f)], { stdio: "pipe" }); ok(f, true); }
  catch (e) { ok(f, false, String(e.stderr || e.message).slice(0, 120)); }
}

console.log("\n[2] 工具清单");
const EXPECTED = [
  "fzlib_search_books", "fzlib_get_book", "fzlib_check_holdings",
  "fzlib_browse_classification", "fzlib_list_libraries", "fzlib_get_rankings",
];
const names = tools.map((t) => t.name);
ok("六个工具齐全", EXPECTED.every((n) => names.includes(n)), `实际 ${names.join(",")}`);
ok("没有多余工具", names.length === EXPECTED.length, `实际 ${names.length} 个`);

console.log("\n[3] schema 与描述");
for (const t of tools) {
  ok(`${t.name} 有 description`, typeof t.description === "string" && t.description.length > 40);
  ok(`${t.name} 有 inputSchema`, t.inputSchema && t.inputSchema.type === "object");
  ok(`${t.name} 有 handler`, typeof t.handler === "function");
}

console.log("\n[4] 版本号一致");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
ok("package.json 与 server.js 一致", pkg === VERSION, `${pkg} vs ${VERSION}`);
ok("README 标题同步", fs.readFileSync("README.md", "utf8").includes(`v${pkg}`), `README 里没有 v${pkg}`);

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
