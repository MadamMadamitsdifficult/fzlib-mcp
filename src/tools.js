/**
 * 工具定义：JSON Schema + 参数校验收口 + 领域层调用。
 * schema 手写而非从代码生成 —— 第一代刻意保持零构建、零额外依赖。
 *
 * 六个工具：search_books / get_book / check_holdings /
 *          browse_classification / list_libraries / get_rankings
 *
 * 三条约定：
 *   1) 参数先进来就归一：分馆名→代码、文献类型→booktype 码、中文大类→中图法字母。
 *      归一不了的立刻抛 INVALID_PARAM 并带 hint，别让脏参数打到上游去浪费一次往返。
 *   2) handler 只返回 { data, meta }；成功/失败的包装在 server.js 里统一做。
 *   3) description 是给模型看的说明书，不是给人看的注释 —— 改了行为必须同步改它，
 *      否则模型照着旧说明用，错的是我们不是它。
 */
import { UpstreamError } from "./upstream.js";
import {
  searchBooks,
  getBook,
  checkHoldings,
  browseClassification,
  listLibraries,
  resolveLibrary,
  getRankings,
  normalizeMediaType,
} from "./fzlib.js";

/* ---------------- 参数校验小工具 ---------------- */

function required(args, name, type) {
  const v = args?.[name];
  if (v === undefined || v === null || v === "") {
    throw new UpstreamError("INVALID_PARAM", `缺少必填参数 ${name}`, {
      hint: `${name} 为${type}`,
    });
  }
  return v;
}

function asInt(v, name, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n)) {
    throw new UpstreamError("INVALID_PARAM", `${name} 必须是整数，收到：${JSON.stringify(v)}`);
  }
  if (n < min || n > max) {
    throw new UpstreamError("INVALID_PARAM", `${name} 需在 ${min}~${max} 之间，收到 ${n}`);
  }
  return n;
}

function asEnum(v, name, allowed, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  if (!allowed.includes(v)) {
    throw new UpstreamError("INVALID_PARAM", `${name} 只能是 ${allowed.join(" / ")}，收到：${v}`);
  }
  return v;
}

/* ---------------- 工具定义 ---------------- */

export const tools = [
  {
    name: "fzlib_search_books",
    title: "检索图书",
    description:
      "在福州市图书馆（福州地区图书馆联合检索平台）检索书刊 / 浏览全库 / 查新书通报。" +
      "返回书目卡片（题名/作者/出版社/ISBN/索书号/是否可借），带分页。\n" +
      "常见说法怎么调：\n" +
      "  「有没有《三体》」→ search_type=title\n" +
      "  「刘慈欣的书」→ search_type=author\n" +
      "  「讲育儿的」/「心理学相关的」→ search_type=subject（比 keyword 准一个数量级）\n" +
      "  「文学类的书」/「I 类」→ search_type=class（中文大类名会自动换成中图法字母）\n" +
      "  「9787536692930 是哪本书」→ search_type=isbn\n" +
      "  「随便看看有什么」→ 不填 query\n" +
      "  「最近三个月新到了什么」→ new_arrivals_days=90\n" +
      "注意：这是「书目记录」而非单册；同一本书在不同分馆会有多条记录。" +
      "需要确认某本书现在能不能借、在哪一馆，请用 with_availability 或再调 fzlib_check_holdings。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "检索词。**不填=浏览全库**（按 page 翻页）。search_type=keyword 时填书名/作者/主题词；" +
            "=class 时填中图法分类号（如 I247.55，可用前缀 I247）",
        },
        search_type: {
          type: "string",
          enum: ["keyword", "title", "author", "publisher", "subject", "isbn", "class"],
          default: "keyword",
          description:
            "检索途径。keyword=综合（噪声最大）；subject=按主题词（最精准，如「纪实文学」）；" +
            "title/author/publisher=按字段；isbn=按国际标准书号；class=按中图法分类号或中文大类名（如 I247 / 文学）",
        },
        library: {
          type: "string",
          description: "限定分馆，可填代码（MWQ）或名称（马尾馆）。不填表示全馆",
        },
        media_type: {
          description:
            "文献类型。数字或名称都行：1=图书 2=期刊 3=非书资料 4=西文图书 5=报纸；" +
            "也可写「图书」「期刊」「杂志」「报纸」。不传=全部类型。找周刊/杂志请用 2",
          oneOf: [
            { type: "integer", enum: [1, 2, 3, 4, 5, 7, 8, 9, 10] },
            {
              type: "string",
              enum: ["book", "periodical", "newspaper", "av", "western", "all", "图书", "期刊", "杂志", "报纸", "报刊"],
            },
          ],
        },
        available_only: {
          type: "boolean",
          default: false,
          description:
            "只看「确实有可借复本」的书目。上游的可借筛选不可靠，本工具会按页用馆藏接口核实并剔除不可借的，" +
            "不够就继续翻页补足（最多 3 页），所以 total 是检索命中数、不等于可借数",
        },
        with_availability: {
          type: "boolean",
          default: true,
          description:
            "顺带返回每本书的可借情况（几本可借、在哪些馆/库位）。默认开启——" +
            "一次往返就能回答「能借吗」，关掉可以省一次上游请求",
        },
        conditions: {
          type: "array",
          maxItems: 2,
          description:
            "附加检索条件（复杂检索）。每条形如 {query, search_type, logic}，与主 query 用 AND/OR 组合。" +
            "上游最多支持 3 个条件，所以这里最多 2 条。例：查「刘慈欣写的、书名带三体的书」→ " +
            "query=三体 + search_type=title + conditions=[{query:刘慈欣, search_type:author}]",
          items: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1 },
              search_type: {
                type: "string",
                enum: ["keyword", "title", "author", "publisher", "subject", "isbn"],
                default: "keyword",
              },
              logic: { type: "string", enum: ["AND", "OR"], default: "AND" },
            },
            required: ["query"],
          },
        },
        pubdate_from: {
          type: "integer",
          minimum: 1000,
          maximum: 2100,
          description: "出版年起（含）。只给年份不给条件也可以，等于「某年出版的所有书」",
        },
        pubdate_to: {
          type: "integer",
          minimum: 1000,
          maximum: 2100,
          description: "出版年止（含）",
        },
        include_cover: {
          type: "boolean",
          default: false,
          description:
            "是否返回封面链接（cover_url）。上游书目里这个字段基本是空的，会改走第三方批量接口，" +
            "一次请求补满整页；只有传了 ISBN 的书才有",
        },
        new_arrivals_days: {
          type: "integer",
          minimum: 1,
          maximum: 730,
          description:
            "只看最近 N 天内到馆的新书（新书通报）。给了这个值就进入新书模式，可与 media_type/library/分类检索叠加。\n" +
            "注意：按馆方到馆/编目日期统计，实测最近 90 天全库只有 22 条——编目不是每天更新，" +
            "数量偏少是上游实情，别据此判断「没有新书」",
        },
        sort: {
          type: "string",
          enum: ["relevance", "callno"],
          default: "relevance",
          description: "排序：relevance=相关度，callno=索书号（同架位相邻）",
        },
        page: { type: "integer", minimum: 1, maximum: 5000, default: 1, description: "页码，从 1 开始" },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          default: 8,
          description: "每页条数，默认 8，上限 30",
        },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args) => {
      const query = args.query === undefined || args.query === null ? "" : String(args.query).trim();
      const page = asInt(args.page ?? 1, "page", { min: 1, max: 5000 });
      const pageSize = asInt(args.page_size ?? 8, "page_size", { min: 1, max: 30 });
      const searchType = asEnum(
        args.search_type,
        "search_type",
        ["keyword", "title", "author", "publisher", "subject", "isbn", "class"],
        "keyword",
      );
      const isBrowse = !query || query === "*";
      if (isBrowse && searchType !== "keyword") {
        throw new UpstreamError("INVALID_PARAM", `${searchType} 检索必须提供 query`, {
          hint: "不填 query 只能做全库浏览；按作者/主题/分类找书请给出检索词",
        });
      }
      const sort = asEnum(args.sort, "sort", ["relevance", "callno"], "relevance");
      const libraryCode = await resolveLibrary(args.library);
      const conditions = Array.isArray(args.conditions)
        ? args.conditions.slice(0, 2).map((c, i) => {
            const q = String(c?.query ?? "").trim();
            if (!q) {
              throw new UpstreamError("INVALID_PARAM", `conditions[${i}].query 不能为空`);
            }
            return {
              query: q,
              searchType: asEnum(
                c.search_type,
                `conditions[${i}].search_type`,
                ["keyword", "title", "author", "publisher", "subject", "isbn"],
                "keyword",
              ),
              logic: asEnum(c.logic, `conditions[${i}].logic`, ["AND", "OR"], "AND"),
            };
          })
        : [];

      return searchBooks({
        query,
        searchType,
        libraryCode,
        mediaType: normalizeMediaType(args.media_type),
        availableOnly: Boolean(args.available_only),
        withAvailability: args.with_availability !== false,
        conditions,
        pubdateFrom:
          args.pubdate_from === undefined
            ? null
            : asInt(args.pubdate_from, "pubdate_from", { min: 1000, max: 2100 }),
        pubdateTo:
          args.pubdate_to === undefined
            ? null
            : asInt(args.pubdate_to, "pubdate_to", { min: 1000, max: 2100 }),
        includeCover: Boolean(args.include_cover),
        newArrivalsDays:
          args.new_arrivals_days === undefined
            ? null
            : asInt(args.new_arrivals_days, "new_arrivals_days", { min: 1, max: 730 }),
        sort,
        page,
        pageSize,
      });
    },
  },

  {
    name: "fzlib_get_book",
    title: "书目详情",
    description:
      "按书目记录号（bookrecno）获取详细书目信息：题名、责任者、出版社、出版年、ISBN、分类号、页码、价格、主题词、内容简介、封面，以及馆藏复本数量概览。" +
      "bookrecno 可从 fzlib_search_books 的返回结果中获取。",
    inputSchema: {
      type: "object",
      properties: {
        bookrecno: { type: "integer", minimum: 1, description: "书目记录号" },
        include_marc: {
          type: "boolean",
          default: false,
          description: "是否返回 CNMARC 原始字段串（体积大，通常不需要）",
        },
        include_cover: {
          type: "boolean",
          default: true,
          description: "是否返回封面链接（上游为空时改走第三方接口）",
        },
      },
      required: ["bookrecno"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = asInt(required(args, "bookrecno", "integer"), "bookrecno", { min: 1 });
      return getBook(id, {
        includeMarc: Boolean(args.include_marc),
        includeCover: args.include_cover !== false,
      });
    },
  },

  {
    name: "fzlib_check_holdings",
    title: "查馆藏与可借状态",
    description:
      "查询某书目在各分馆的馆藏复本：题名、条码、索书号、馆藏地、在架状态、历史借阅次数；" +
      "期刊还会带卷期（volume，如 v.1,no.9,2025）与按年份的可借分布（volume_years）。" +
      "回答「这本书现在哪个馆能借到」「今年这一期到了吗」都用这个工具。支持一次最多查 10 个书目。\n" +
      "统计口径：total_copies / available_copies 覆盖全部过滤后的复本；copies 数组最多列 max_copies 条，" +
      "超出时 truncated=true（此时 copies.length < total_copies，不是数据错）。" +
      "scope=filtered 表示计数只覆盖过滤后的范围，全馆总数见 global。" +
      "copies 为空时会有 note 说明，不要把「没有馆藏明细」说成「馆里没有这本书」。",
    inputSchema: {
      type: "object",
      properties: {
        bookrecno: {
          anyOf: [
            { type: "integer", minimum: 1 },
            { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 10 },
          ],
          description: "书目记录号，或记录号数组（最多 10 个）",
        },
        library: {
          type: "string",
          description: "只看某个分馆，可填代码或名称。不填表示全部",
        },
        only_available: {
          type: "boolean",
          default: false,
          description: "只返回在馆可借的复本",
        },
        include_titles: {
          type: "boolean",
          default: true,
          description: "是否补全书名（检索后紧接着调用通常是免费的；冷启动时每本多一次上游请求）",
        },
        max_copies: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description:
            "最多列多少条复本明细。期刊动辄上百册，超出时只列前 N 条，" +
            "总额与年份分布仍覆盖全部（看 copies_total / volume_years）",
        },
      },
      required: ["bookrecno"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const raw = required(args, "bookrecno", "integer 或 integer[]");
      const ids = Array.isArray(raw)
        ? raw.map((x, i) => asInt(x, `bookrecno[${i}]`, { min: 1 }))
        : [asInt(raw, "bookrecno", { min: 1 })];
      const libraryCode = await resolveLibrary(args.library);
      return checkHoldings(ids, {
        libraryCode,
        onlyAvailable: Boolean(args.only_available),
        includeTitles: args.include_titles !== false,
        maxCopies: asInt(args.max_copies ?? 20, "max_copies", { min: 1, max: 100 }),
      });
    },
  },

  {
    name: "fzlib_browse_classification",
    title: "浏览中图法分类",
    description:
      "逐层浏览中图法（CLC）分类树，用于「我想看看某类有什么书」这类探索式提问。" +
      "父节点传 0 得到一级大类（A/B/C…），再把返回的 id 作为 parent_id 下钻。" +
      "要在某个类号下直接检索书目，改用 fzlib_search_books（search_type=class）。",
    inputSchema: {
      type: "object",
      properties: {
        parent_id: {
          type: "string",
          default: "0",
          description: "父节点 id；0 表示根（一级大类）",
        },
        category: {
          type: "string",
          enum: ["cls", "sci"],
          default: "cls",
          description: "cls=中图法，sci=科图法（外文书库）",
        },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      browseClassification({
        parentId: String(args.parent_id ?? "0"),
        category: asEnum(args.category, "category", ["cls", "sci"], "cls"),
      }),
  },

  {
    name: "fzlib_list_libraries",
    title: "列出分馆与馆藏地",
    description:
      "列出福州地区图书馆联合检索平台的分馆（代码、名称、简称、馆藏地数量）。" +
      "当用户问「有哪些馆」「马尾馆的代码是什么」或需要给其他工具填 library 参数时使用。\n" +
      "默认 detail=brief，只回分馆级信息（约 1KB）；要看某馆下辖的馆藏地，传 detail=full 或 library=<代码>。",
    inputSchema: {
      type: "object",
      properties: {
        detail: {
          type: "string",
          enum: ["brief", "full"],
          default: "brief",
          description: "brief=只列分馆；full=展开每个分馆下的全部馆藏地（输出会大几十倍）",
        },
        library: {
          type: "string",
          description: "只看某个分馆，可填代码（MWQ）或名称（马尾馆）。与 detail=full 配合最省",
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const detail = asEnum(args.detail, "detail", ["brief", "full"], "brief");
      const libraryCode = await resolveLibrary(args.library);
      return listLibraries({ detail, libraryCode });
    },
  },

  {
    name: "fzlib_get_rankings",
    title: "排行榜 / 热门检索词",
    description:
      "获取馆方榜单。type=hot 热门书目榜（被检索最多的书）、loan 借阅榜、reader 读者借阅榜、" +
      "search 热门检索词（读者搜的词与次数，回答「大家最近在搜什么」用这个）。\n" +
      "书本类榜单由馆方定时批处理生成，可能处于「正在生成」状态，此时返回 RANKING_NOT_READY 而不是空榜单；" +
      "热门检索词是实时聚合的，不受影响。",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["hot", "loan", "reader", "search"],
          default: "loan",
          description: "hot=热门书目，loan=借阅排行，reader=读者借阅排行，search=热门检索词",
        },
        period_days: {
          type: "string",
          enum: ["7", "30", "90", "all"],
          default: "30",
          description: "统计区间（天）。热门检索词只支持 30（最近30天）与 all（所有时间）",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 20,
          description: "返回条数",
        },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      getRankings({
        type: asEnum(args.type, "type", ["hot", "loan", "reader", "search"], "loan"),
        periodDays: asEnum(args.period_days ?? "30", "period_days", ["7", "30", "90", "all"], "30"),
        limit: asInt(args.limit ?? 20, "limit", { min: 1, max: 50 }),
      }),
  },
];
