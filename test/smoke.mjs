/**
 * 冒烟测试：不经过 MCP 协议，直接调用工具处理器。
 * 用法：node test/smoke.mjs [关键词]
 */
import { tools } from "../src/tools.js";

const kw = process.argv[2] || "三体";
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
let failed = 0;

async function call(name, args, check) {
  process.stdout.write(`\n=== ${name} ${JSON.stringify(args)}\n`);
  try {
    const { data, meta } = await byName[name].handler(args);
    if (check) check(data);
    console.log(`  meta: cached=${meta.cached} degraded=${meta.degraded}`);
    return data;
  } catch (err) {
    if (err.code === "RANKING_NOT_READY") {
      console.log(`  (预期状态) ${err.code}: ${err.message}`);
      return null;
    }
    failed++;
    console.log(`  !! ${err.code || "ERR"}: ${err.message}`);
    if (err.hint) console.log(`     hint: ${err.hint}`);
    return null;
  }
}

const search = await call("fzlib_search_books", { query: kw, page_size: 3 }, (d) => {
  console.log(`  total=${d.total} items=${d.items.length} has_more=${d.has_more}`);
  for (const it of d.items) {
    console.log(`  - [${it.bookrecno}] ${it.title} / ${it.author} / ${it.call_no} / 可借=${it.has_holding}`);
  }
  if (!d.items.length) throw new Error("检索无结果");
});

const firstId = search?.items?.[0]?.bookrecno;
if (firstId) {
  await call("fzlib_get_book", { bookrecno: firstId }, (d) => {
    console.log(`  ${d.title} | ${d.isbn} | ${d.publisher} ${d.pubdate} | 复本 ${d.holding_summary.total_copies}`);
  });

  await call("fzlib_check_holdings", { bookrecno: firstId }, (d) => {
    const it = d.items[0];
    console.log(`  ${it.total_copies} 册，可借 ${it.available_copies}`);
    for (const c of it.copies.slice(0, 3)) {
      console.log(`  - ${c.barcode} ${c.library_name}/${c.location_name} ${c.status}`);
    }
  });
}

await call("fzlib_list_libraries", {}, (d) => {
  console.log(`  ${d.total_libraries} 个分馆 / ${d.total_locations} 个馆藏地`);
  console.log(`  ${d.libraries.slice(0, 4).map((l) => `${l.name}(${l.code})`).join("、")} …`);
});

await call("fzlib_browse_classification", { parent_id: "0" }, (d) => {
  console.log(`  ${d.count} 个一级类目：${d.children.slice(0, 4).map((c) => c.name).join(" ")}`);
});

await call("fzlib_search_books", { query: "I247.55", search_type: "class", page_size: 2 }, (d) => {
  console.log(`  分类检索 total=${d.total}：${d.items.map((i) => i.title).join("、")}`);
});

await call("fzlib_get_rankings", { type: "loan" });

console.log(`\n${failed ? `❌ ${failed} 项失败` : "✅ 全部通过"}`);
process.exit(failed ? 1 : 0);
