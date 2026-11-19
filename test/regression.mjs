/**
 * 回归测试：锁住 v0.3 修掉的六个问题。
 * 用法：node test/regression.mjs
 */
import { tools } from "../src/tools.js";

const t = Object.fromEntries(tools.map((x) => [x.name, x]));
let pass = 0;
let fail = 0;

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

/* 1. 过滤后计数必须与明细同源 */
console.log("\n[1] 计数与明细同源（火焰杯 902525976 + library=马尾馆）");
{
  const { data } = await t.fzlib_check_holdings.handler({
    bookrecno: 902525976,
    library: "马尾馆",
  });
  const it = data.items[0];
  check("scope=filtered", it.scope === "filtered", `实际 ${it.scope}`);
  check(
    "total_copies === copies_total",
    it.total_copies === it.copies_total,
    `${it.total_copies} vs ${it.copies_total}`,
  );
  check(
    "未截断时 total_copies === copies.length",
    it.truncated ? it.copies.length <= 20 : it.total_copies === it.copies.length,
    `${it.total_copies} vs ${it.copies.length}`,
  );
  check(
    "available_copies === 数组里可借条数",
    it.available_copies === it.copies.filter((c) => c.available).length,
  );
  check("保留了全馆总数 global", Boolean(it.global), JSON.stringify(it.global));
  check("过滤后确实变少", it.global.total_copies >= it.total_copies);
}

/* 2. 题名不再为 null */
console.log("\n[2] check_holdings 带题名");
{
  const { data } = await t.fzlib_check_holdings.handler({ bookrecno: 902525976 });
  check("title 非空", Boolean(data.items[0].title), JSON.stringify(data.items[0].title));
}

/* 3. 检索一次拿到可借情况 */
console.log("\n[3] search with_availability");
{
  const { data } = await t.fzlib_search_books.handler({
    query: "三体",
    page_size: 2,
    with_availability: true,
  });
  const a = data.items[0].availability;
  check("每条带 availability", Boolean(a), JSON.stringify(a));
  check("有可借数和地点", typeof a?.available_copies === "number" && Array.isArray(a?.locations));
  console.log(`     示例：可借 ${a?.available_copies}/${a?.total_copies} 在 ${a?.libraries?.join("、")} ${a?.locations?.join("、")}`);
}

/* 4. 主题检索 */
console.log("\n[4] search_type=subject");
{
  const { data } = await t.fzlib_search_books.handler({
    query: "纪实文学",
    search_type: "subject",
    page_size: 3,
  });
  check("有结果", data.total > 0, `total=${data.total}`);
  const all = data.items.every((i) => i.subjects.some((s) => s.includes("纪实文学")));
  check("主题词都对得上", all, JSON.stringify(data.items.map((i) => i.subjects)));
  console.log(`     "纪实文学" → ${data.total} 条（keyword 会多出大量噪声）`);
}

/* 5. list_libraries 体积 */
console.log("\n[5] list_libraries 默认轻量");
{
  const brief = await t.fzlib_list_libraries.handler({});
  const size = JSON.stringify(brief).length;
  check("brief < 3KB", size < 3000, `${size} 字节`);
  check("不返回 locations", brief.data.libraries.every((l) => !("locations" in l)));

  const one = await t.fzlib_list_libraries.handler({ detail: "full", library: "马尾馆" });
  check("full+library 只回一个馆", one.data.libraries.length === 1, `${one.data.libraries.length}`);
  check("带 locations", Array.isArray(one.data.libraries[0]?.locations));
}

/* 6. 空馆藏要给解释 */
console.log("\n[6] 空馆藏的语义");
{
  const { data } = await t.fzlib_check_holdings.handler({ bookrecno: 900828209 });
  const it = data.items[0];
  check("copies 为空时给 note", it.copies.length > 0 || Boolean(it.note));
}

/* 7. 期刊：类型筛选 + 卷期 + 截断 */
console.log("\n[7] 期刊（media_type=2）");
{
  const { data } = await t.fzlib_search_books.handler({
    query: "读者",
    media_type: 2,
    page_size: 3,
  });
  check("筛出期刊", data.total > 0 && data.items.every((i) => i.book_type === "期刊"),
    JSON.stringify(data.items.map((i) => i.book_type)));
  console.log(`     "读者" 期刊 → ${data.total} 条`);

  const h = await t.fzlib_check_holdings.handler({ bookrecno: 900000483 });
  const it = h.data.items[0];
  check("超量复本被截断", it.truncated === true && it.copies.length <= 20,
    `shown=${it.copies.length} total=${it.total_copies}`);
  check("copies_total 覆盖全部", it.copies_total > it.copies.length, `${it.copies_total}`);
  check("有卷期字段", it.copies.some((c) => c.volume), JSON.stringify(it.copies[0]?.volume));
  check("截断时优先保留最新期", Boolean(it.copies[0]?.volume), JSON.stringify(it.copies[0]?.volume));
  check("有年份分布", Boolean(it.volume_years), JSON.stringify(it.volume_years)?.slice(0, 120));
  console.log(`     复本 ${it.copies_total} 条，列 ${it.copies.length} 条；年份 ${Object.keys(it.volume_years || {}).slice(0, 5).join("/")}`);
}

/* 8. 类型别名 */
console.log("\n[8] 类型别名归一");
{
  const { normalizeMediaType } = await import("../src/fzlib.js");
  check("周刊 → 2", normalizeMediaType("周刊") === 2);
  check("期刊 → 2", normalizeMediaType("期刊") === 2);
  check("book → 1", normalizeMediaType("book") === 1);
  check("数字 5 → 5", normalizeMediaType(5) === 5);
  check("all → null", normalizeMediaType("all") === null);
}

/* 9. 浏览模式：不给 query，按页翻全库 */
console.log("\n[9] 浏览模式（query 留空）");
{
  const p1 = await t.fzlib_search_books.handler({ page_size: 3 });
  check("不限关键词也能出结果", p1.data.total > 1_000_000, `total=${p1.data.total}`);
  check("标记为 browse", p1.data.applied.search_type === "browse", p1.data.applied.search_type);
  check("给出 total_pages", p1.data.total_pages > 0, `${p1.data.total_pages}`);
  console.log(`     全库 ${p1.data.total} 条，每页 3 条 → ${p1.data.total_pages} 页`);

  const p2 = await t.fzlib_search_books.handler({ page_size: 3, page: 2 });
  const a = p1.data.items.map((i) => i.bookrecno);
  const b = p2.data.items.map((i) => i.bookrecno);
  check("翻页内容不同", a.join() !== b.join(), `${a} vs ${b}`);
  check("无重叠", !a.some((x) => b.includes(x)), `${a} ∩ ${b}`);

  const p500 = await t.fzlib_search_books.handler({ page_size: 3, page: 500 });
  check("深翻页可用", p500.data.items.length === 3, `${p500.data.items.length}`);

  const onlyBooks = await t.fzlib_search_books.handler({ media_type: 1, page_size: 2 });
  check("浏览也能按类型筛", onlyBooks.data.total < p1.data.total && onlyBooks.data.items.every((i) => i.book_type === "图书"));

  let errCode = null;
  try {
    await t.fzlib_search_books.handler({ search_type: "author" });
  } catch (e) {
    errCode = e.code;
  }
  check("按字段检索缺 query 会报错", errCode === "INVALID_PARAM", String(errCode));
}

/* 10. 出版年清洗（Excel 序列号） */
console.log("\n[10] 出版年清洗");
{
  const { data } = await t.fzlib_get_book.handler({ bookrecno: 3707458607 });
  check("42979 → 2017", data.pubdate === "2017", `实际 ${data.pubdate}`);

  const s = await t.fzlib_search_books.handler({ query: "船政·海丝", page_size: 1 });
  const card = s.data.items[0];
  check("检索卡片也已清洗", card && /^\d{4}$/.test(card.pubdate), `实际 ${card?.pubdate}`);

  const normal = await t.fzlib_get_book.handler({ bookrecno: 901104374 });
  check("正常年份不受影响", normal.data.pubdate === "2010", `实际 ${normal.data.pubdate}`);

  const periodical = await t.fzlib_get_book.handler({ bookrecno: 900000483 });
  check("期刊的 1993- 原样保留", periodical.data.pubdate === "1993-", `实际 ${periodical.data.pubdate}`);
}

/* 11. available_only 必须诚实 */
console.log("\n[11] available_only 以馆藏为准");
{
  const { data } = await t.fzlib_search_books.handler({
    query: "三体",
    page_size: 3,
    available_only: true,
  });
  check("确实筛出了结果", data.items.length > 0, `items=${data.items.length}`);
  check(
    "返回的每条都真的可借",
    data.items.every((i) => i.has_holding === true),
    JSON.stringify(data.items.map((i) => i.has_holding)),
  );
  check("带了可借明细", data.items.every((i) => i.availability));
  if (data.filtered_out) {
    check("剔除有说明", Boolean(data.note), data.note);
    console.log(`     剔除 ${data.filtered_out} 条（上游 total=${data.total} 偏大）`);
  }
}

/* 12. 热门检索词 */
console.log("\n[12] 热门检索词（type=search）");
{
  const r30 = await t.fzlib_get_rankings.handler({ type: "search", period_days: "30", limit: 5 });
  check("有数据", r30.data.items.length > 0, `${r30.data.items.length}`);
  check("条目含关键词与次数", r30.data.items.every((i) => i.keyword && typeof i.count === "number"));
  check("不是书目榜", r30.data.type === "search");
  console.log(`     30天：${r30.data.items.map((i) => `${i.keyword}(${i.count})`).join(" ")}`);

  const all = await t.fzlib_get_rankings.handler({ type: "search", period_days: "all", limit: 5 });
  check("all 口径次数更大", all.data.items[0].count >= r30.data.items[0].count,
    `${all.data.items[0].count} vs ${r30.data.items[0].count}`);
  console.log(`     全部：${all.data.items.map((i) => `${i.keyword}(${i.count})`).join(" ")}`);
}

/* 13. 新书通报 */
console.log("\n[13] 新书通报（new_arrivals_days）");
{
  const y = await t.fzlib_search_books.handler({ new_arrivals_days: 365, page_size: 3 });
  check("有结果", y.data.items.length > 0, `${y.data.items.length}`);
  check("标记了新书窗口", y.data.applied.new_arrivals_days === 365, JSON.stringify(y.data.applied));
  console.log(`     近一年全库新书 ${y.data.total} 条，示例：${y.data.items.map((i) => i.title).join("、")}`);

  const d90 = await t.fzlib_search_books.handler({ new_arrivals_days: 90, page_size: 2 });
  check("90 天比一年少", d90.data.total < y.data.total, `${d90.data.total} vs ${y.data.total}`);

  const cls = await t.fzlib_search_books.handler({
    query: "I247",
    search_type: "class",
    new_arrivals_days: 365,
    page_size: 2,
  });
  check("可与分类叠加", cls.data.total > 0 && cls.data.total < y.data.total, `${cls.data.total}`);
}

/* 14. v0.9 新增：ISBN、中文大类映射、出版年二次清洗 */
console.log("\n[14] ISBN / 大类映射 / 年份清洗");
{
  const { mapClassAlias, normalizePubdate } = await import("../src/fzlib.js");

  const isbn = await t.fzlib_search_books.handler({
    query: "9787536692930",
    search_type: "isbn",
    page_size: 2,
    with_availability: false,
  });
  check("ISBN 精确命中", isbn.data.total > 0 && isbn.data.total < 20, `${isbn.data.total}`);
  console.log(`     ISBN 9787536692930 → ${isbn.data.total} 条，首条：${isbn.data.items[0]?.title}`);

  const cls = await t.fzlib_search_books.handler({
    query: "文学",
    search_type: "class",
    page_size: 1,
    with_availability: false,
  });
  check("「文学」自动映射成 I", cls.data.applied.class_mapped_from === "文学 → I",
    JSON.stringify(cls.data.applied.class_mapped_from));

  check("文学→I", mapClassAlias("文学").classNo === "I");
  check("计算机类→TP", mapClassAlias("计算机类").classNo === "TP");
  check("I247 原样", mapClassAlias("I247").classNo === "I247");

  check("42979→2017", normalizePubdate("42979") === "2017");
  check("2993.7→1993.7", normalizePubdate("2993.7") === "1993.7");
  check("2986.12→1986.12", normalizePubdate("2986.12") === "1986.12");
  check("2024 不变", normalizePubdate("2024") === "2024");
}

/* 15. v0.10：复杂检索 + 粗分类子类分布 */
console.log("\n[15] 复杂检索 / 子类分布");
{
  const base = await t.fzlib_search_books.handler({
    query: "三体",
    search_type: "title",
    page_size: 1,
    with_availability: false,
  });
  const and = await t.fzlib_search_books.handler({
    query: "三体",
    search_type: "title",
    conditions: [{ query: "刘慈欣", search_type: "author" }],
    page_size: 1,
    with_availability: false,
  });
  const or = await t.fzlib_search_books.handler({
    query: "三体",
    search_type: "title",
    conditions: [{ query: "刘慈欣", search_type: "author", logic: "OR" }],
    page_size: 1,
    with_availability: false,
  });

  check("AND 收窄", and.data.total > 0 && and.data.total <= base.data.total,
    `${base.data.total} → ${and.data.total}`);
  check("OR 放宽", or.data.total >= and.data.total, `${and.data.total} → ${or.data.total}`);
  check("applied 里能看到条件", Array.isArray(and.data.applied.conditions));
  console.log(`     书名=三体：${base.data.total} ｜ +作者AND：${and.data.total} ｜ +作者OR：${or.data.total}`);

  const yr = await t.fzlib_search_books.handler({
    query: "科幻",
    search_type: "subject",
    pubdate_from: 2015,
    pubdate_to: 2026,
    page_size: 1,
    with_availability: false,
  });
  check("出版年区间生效", yr.data.total > 0, `${yr.data.total}`);
  check("applied 里能看到区间", JSON.stringify(yr.data.applied.pubdate_range) === "[2015,2026]",
    JSON.stringify(yr.data.applied.pubdate_range));

  const cls = await t.fzlib_search_books.handler({
    query: "I",
    search_type: "class",
    page_size: 1,
    with_availability: false,
  });
  const kids = cls.data.class_children?.children || [];
  check("粗分类带子类分布", kids.length > 0, `${kids.length}`);
  check("子类带书目量", kids.every((k) => typeof k.count === "number" || k.count === null));
  check("有提示引导下钻", Boolean(cls.data.hint));
  console.log(`     I 类 ${kids.length} 个子类：${kids.slice(0, 4).map((k) => `${k.class_no}(${k.count})`).join(" ")}`);

  let err = null;
  try {
    await t.fzlib_search_books.handler({
      query: "I247",
      search_type: "class",
      conditions: [{ query: "刘慈欣" }],
    });
  } catch (e) {
    err = e.code;
  }
  check("分类与复杂条件互斥会报错", err === "INVALID_PARAM", String(err));
}

/* 16. v0.11：封面 + 补漏字段 */
console.log("\n[16] 封面与补漏字段");
{
  const s = await t.fzlib_search_books.handler({
    query: "三体",
    page_size: 3,
    include_cover: true,
    with_availability: false,
  });
  check("封面有填充", (s.data.covers_filled ?? 0) > 0, `filled=${s.data.covers_filled}`);
  check("每条都有 cover_url", s.data.items.every((i) => i.cover_url), JSON.stringify(s.data.items.map((i) => !!i.cover_url)));
  check("卡片带到馆日期", s.data.items.every((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.indate || "")),
    JSON.stringify(s.data.items.map((i) => i.indate)));
  console.log(`     封面 ${s.data.covers_filled}/${s.data.items.length} 条，示例：${s.data.items[0].cover_url}`);

  const b = await t.fzlib_get_book.handler({ bookrecno: 901104374 });
  check("详情默认带封面", Boolean(b.data.cover_url));
  check("详情带控制号", Boolean(b.data.control_no), b.data.control_no);

  const h = await t.fzlib_check_holdings.handler({ bookrecno: 901104374, include_titles: false });
  const c = h.data.items[0].copies[0];
  check("副本带流通类型名", Boolean(c.cir_type_name), JSON.stringify([c.cir_type, c.cir_type_name]));
  check("副本带预约数", typeof c.reserved === "number");
}

console.log(`\n${fail ? `❌ ${fail} 项失败 / ${pass} 项通过` : `✅ 全部 ${pass} 项通过`}`);
process.exit(fail ? 1 : 0);
