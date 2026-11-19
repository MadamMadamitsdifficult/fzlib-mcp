/**
 * 领域层：把图创 Interlib 的脏数据翻译成稳定模型。上游字段一旦改名，只改这里。
 *
 * 分工一览：
 *   searchBooks           /opac/search（标准 / advance 复杂检索 / 新书通报）→ 书目卡片
 *   getBook               /opac/api/book/{id} → 详情（可选 MARC）
 *   checkHoldings         /opac/api/holdings?bookrecnos= → 复本级馆藏（条码/索书号/状态/卷期）
 *   summarizeHoldings     同一个批量接口，只聚合「几本可借、在哪些馆」，供检索结果附带
 *   browseClassification  / classChildren  分类树与子类书目量（/opac/browse/*）
 *   listLibraries / resolveLibrary         分馆与馆藏地字典（常驻）
 *   getRankings           /opac/ranking/*、/opac/hotsearch
 *
 * 两条硬约定，改之前先看：
 *   1) 上游没有可信的「只看可借」筛选（hasholding 常年不准），available_only 一律本地按页核实；
 *   2) 那几张状态/分馆/馆藏地字典只有单本接口 /opac/api/holding/{id} 才带，
 *      批量接口不带 —— 所以字典 harvest 一次常驻（getHoldingMaps），复本仍走批量，
 *      一次请求拿完，别退回去一本一发。
 */
import { getJson, getText, postText, UpstreamError, config } from "./upstream.js";

const { BASE } = config;

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

const s = (v) => (v === null || v === undefined ? "" : String(v));

/** 从 /opac/search 的嵌套结构里挖出书目数组（结构在不同馆略有差异） */
function extractDocs(payload) {
  const qr = payload?.queryResponse?.response;
  if (!Array.isArray(qr)) return [];
  for (const node of qr) {
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node.response)) return node.response;
    if (Array.isArray(node.response?.docs)) return node.response.docs;
  }
  return [];
}

/** 在未知结构里尽力找出「记录数组」（排行榜等接口返回结构不稳定） */
function findRecords(node, depth = 0) {
  if (!node || depth > 4) return null;

  const hasTitle = (x) =>
    x && typeof x === "object" && ["title_meta", "title", "bookName", "bookname"].some((k) => k in x);
  // 上游「榜单未生成」时也会带一个 libcodeList（分馆清单），形如 [{libcode, name, address}]
  const isLibEntry = (x) => x && typeof x === "object" && "libcode" in x && !hasTitle(x);

  if (Array.isArray(node)) {
    if (
      node.length &&
      node.every((x) => x && typeof x === "object") &&
      node.some(hasTitle) &&
      !node.every(isLibEntry)
    ) {
      return node;
    }
    for (const item of node) {
      const r = findRecords(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node)) {
      const r = findRecords(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

const BOOKTYPE_FALLBACK = {
  1: "图书", 2: "期刊", 3: "非书资料", 4: "西文图书", 5: "报纸",
  6: "乡镇图书", 7: "仓山中文图书", 8: "日文图书", 9: "仓山图书", 10: "学校自有图书",
};
let learnedBooktypeMap = { ...BOOKTYPE_FALLBACK };

function booktypeName(code) {
  return learnedBooktypeMap[String(code)] || `类型${code}`;
}

export const permalink = (bookrecno) => `${BASE}/opac/book/${bookrecno}`;

/**
 * 出版年清洗：部分记录是从 Excel 导入的，日期列被存成序列号（如 42979 = 2017-09-01）。
 * 合法年份最多 4 位，所以「5 位纯数字」必然是序列号，可以直接换算。
 */
export function normalizePubdate(v) {
  let raw = s(v).trim();

  // ① Excel 日期序列号：42979 → 2017（合法年份最多 4 位，5 位纯数字必然是序列号）
  if (/^\d{5}(\.\d+)?$/.test(raw)) {
    const serial = Math.floor(Number(raw));
    if (serial >= 10000 && serial <= 80000) {
      const ms = Date.UTC(1899, 11, 30) + serial * 86_400_000;
      const year = new Date(ms).getUTCFullYear();
      if (year >= 1900 && year <= 2100) return String(year);
    }
  }

  // ② 年份首位敲错：2993.7 / 2986.12 是 1993.7 / 1986.12（多打了一个 2）
  const m = /^(2\d{3})(\..*)?$/.exec(raw);
  if (m) {
    const y = Number(m[1]);
    if (y >= 2900 && y <= 2999) return `19${m[1].slice(2)}${m[2] || ""}`;
  }

  return raw;
}

/* ------------------------------------------------------------------ */
/* 封面                                                                 */
/* ------------------------------------------------------------------ */

const COVER_URL = "https://www.bookcovers.cn/indexb.php";
const COVER_REFERER = "https://opcs.fzlib.org:8082/";
const coverCache = new Map(); // isbn -> url | null

/**
 * 批量取封面链接。上游书目里的 coverUrl 基本是空的，
 * 第三方封面服务又要求 Referer + 浏览器 UA，否则 403。
 */
async function fetchCovers(isbns) {
  const clean = [...new Set(isbns.map((x) => String(x || "").replace(/[^0-9Xx]/g, "")).filter(Boolean))];
  const out = new Map();
  const missing = [];
  for (const isbn of clean) {
    if (coverCache.has(isbn)) {
      const v = coverCache.get(isbn);
      if (v) out.set(isbn, v);
    } else missing.push(isbn);
  }
  if (!missing.length) return out;

  try {
    const url = `${COVER_URL}?client=fzlib&isbns=${encodeURIComponent(missing.join(","))}&callback=showCovers`;
    const res = await fetch(url, {
      headers: {
        referer: COVER_REFERER,
        "user-agent":
          "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36",
        accept: "*/*",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    const m = /showCovers\(([\s\S]*)\)/.exec(text);
    const json = m ? JSON.parse(m[1]) : {};
    const got = new Set();
    for (const r of json.result || []) {
      const isbn = String(r.isbn || "");
      if (r.coverlink) {
        out.set(isbn, r.coverlink);
        coverCache.set(isbn, r.coverlink);
        got.add(isbn);
      }
    }
    for (const isbn of missing) if (!got.has(isbn)) coverCache.set(isbn, null);
  } catch {
    /* 封面是加分项，失败就留空，不连累主结果 */
  }
  return out;
}

/** 给一批卡片补封面：优先用上游 coverUrl，没有再去第三方取 */
async function attachCovers(items) {
  const need = items.filter((i) => !i.cover_url && i.isbn);
  if (!need.length) return 0;
  const map = await fetchCovers(need.map((i) => i.isbn));
  let filled = 0;
  for (const item of need) {
    const isbn = String(item.isbn || "").replace(/[^0-9Xx]/g, "");
    const url = map.get(isbn);
    if (url) {
      item.cover_url = url;
      filled++;
    }
  }
  return filled;
}

/* ------------------------------------------------------------------ */
/* 书目卡片                                                             */
/* ------------------------------------------------------------------ */

function toCard(doc) {
  const id = Number(doc.id ?? doc.bookrecno);
  return {
    bookrecno: id,
    title: s(doc.title_meta ?? doc.title),
    author: s(doc.author_meta ?? doc.author),
    publisher: s(doc.publisher_meta ?? doc.publisher),
    pubdate: normalizePubdate(doc.pubdate_meta ?? doc.pubdate),
    isbn: s(doc.isbn_meta ?? doc.isbn),
    class_no: s(doc.classno_meta ?? doc.classNo),
    call_no: s(doc.callno_sort ?? doc.callno),
    price: s(doc.price_meta ?? doc.price),
    pages: s(doc.page_meta ?? doc.page),
    subjects: s(doc.subject_meta ?? doc.subject)
      .split(/[;,；、]/)
      .map((x) => x.trim())
      .filter(Boolean),
    book_type: booktypeName(doc.booktype_meta ?? doc.booktype),
    has_holding: s(doc.hasholding) === "y",
    loan_count: Number(s(doc.loannum_sort).replace(/\.\d+$/, "")) || 0,
    indate: doc.indate ? new Date(Number(doc.indate)).toISOString().slice(0, 10) : null,
    cover_url: "",
    permalink: permalink(id),
  };
}

/* ------------------------------------------------------------------ */
/* 检索                                                                 */
/* ------------------------------------------------------------------ */

const SEARCH_WAY = {
  keyword: null,
  title: "title",
  author: "author",
  publisher: "publisher",
  subject: "subject",
  isbn: "isbn",
  class: "class",
};

/** 高级检索（q0/q1/q2）里各检索途径对应的字段名 */
const ADV_FIELD = {
  keyword: "marc",
  title: "title",
  author: "author",
  publisher: "publisher",
  subject: "subject",
  isbn: "marc",
  class: "class",
};
const CLASS_ALIASES = {
  马列: "A", 哲学: "B", 宗教: "B", 社会科学: "C", 政治: "D", 法律: "D", 军事: "E",
  经济: "F", 文化: "G", 教育: "G", 体育: "G", 语言: "H", 文学: "I", 艺术: "J",
  历史: "K", 地理: "K", 自然科学: "N", 数学: "O", 物理: "O", 化学: "O",
  天文: "P", 地球科学: "P", 生物: "Q", 医学: "R", 医药: "R", 卫生: "R",
  农业: "S", 工业: "T", 计算机: "TP", 交通: "U", 航空: "V", 航天: "V",
  环境: "X", 综合: "Z", 百科全书: "Z",
};

/** 「文学类」「计算机类图书」→ I / TP；映射不上原样返回 */
export function mapClassAlias(query) {
  const raw = String(query || "").trim().replace(/[类书籍图书目]+$/, "");
  if (!raw || /^[A-Za-z]/.test(raw)) return { classNo: query, mappedFrom: null };
  const hit = CLASS_ALIASES[raw];
  return hit ? { classNo: hit, mappedFrom: raw } : { classNo: query, mappedFrom: null };
}

/* ------------------------------------------------------------------ */
/* 文献类型                                                             */
/* ------------------------------------------------------------------ */

/** 上游 booktype 取值（与检索页的 booktype 参数一致） */
const MEDIA_TYPES = {
  1: "图书",
  2: "期刊",
  3: "非书资料",
  4: "西文图书",
  5: "报纸",
  7: "仓山中文图书",
  8: "日文图书",
  9: "仓山图书",
  10: "学校自有图书",
};

const MEDIA_ALIASES = {
  book: 1, 图书: 1, 普通图书: 1, 书: 1,
  periodical: 2, journal: 2, magazine: 2, 期刊: 2, 杂志: 2, 周刊: 2, 报刊: 2,
  av: 3, 非书资料: 3, 音像: 3,
  western: 4, 西文图书: 4, 外文: 4,
  newspaper: 5, 报纸: 5,
  all: null, 全部: null,
};

/** 数字、数字字符串、中文/英文别名，统一成 booktype 码 */
export function normalizeMediaType(v) {
  if (v === undefined || v === null || v === "" || v === "all") return null;
  const asNum = Number(v);
  if (Number.isInteger(asNum)) {
    if (asNum === 0) return null;
    if (!(asNum in MEDIA_TYPES)) {
      throw new UpstreamError("INVALID_PARAM", `未知文献类型 ${v}`, {
        hint: `可用：${Object.entries(MEDIA_TYPES).map(([k, n]) => `${k}=${n}`).join("，")}`,
      });
    }
    return asNum;
  }
  const key = String(v).trim().toLowerCase();
  if (!(key in MEDIA_ALIASES)) {
    throw new UpstreamError("INVALID_PARAM", `未知文献类型「${v}」`, {
      hint: "可填 1=图书 2=期刊 3=非书资料 4=西文 5=报纸，或 图书/期刊/报纸/杂志",
    });
  }
  return MEDIA_ALIASES[key];
}

/* ------------------------------------------------------------------ */
/* 跨调用小缓存                                                         */
/* ------------------------------------------------------------------ */

/** bookrecno -> {title, author, call_no}；检索时顺手记下，馆藏时免费复用 */
const bookMetaCache = new Map();
const META_CACHE_MAX = 500;

function rememberBook(card) {
  if (bookMetaCache.size >= META_CACHE_MAX) {
    const oldest = bookMetaCache.keys().next().value;
    bookMetaCache.delete(oldest);
  }
  bookMetaCache.set(card.bookrecno, {
    title: card.title,
    author: card.author,
    call_no: card.call_no,
  });
}

/** 分馆/馆藏地中文名，懒加载并常驻 */
let nameMapsPromise = null;
function getNameMaps() {
  if (!nameMapsPromise) {
    nameMapsPromise = loadRawDirectory()
      .then(({ libcodeList, localMap }) => {
        const lib = {};
        for (const l of libcodeList) if (l.libcode) lib[s(l.libcode)] = s(l.name);
        const loc = {};
        for (const [code, areas] of Object.entries(localMap || {})) {
          for (const a of areas) if (a.localcode) loc[s(a.localcode)] = s(a.name);
        }
        return { lib, loc };
      })
      .catch((err) => {
        nameMapsPromise = null; // 失败不缓存，下次重试
        throw err;
      });
  }
  return nameMapsPromise;
}

/**
 * @param {object} o
 * @param {string} o.query
 * @param {"keyword"|"title"|"author"|"publisher"|"subject"|"class"} o.searchType
 * @param {string|null} o.libraryCode
 * @param {boolean} o.availableOnly
 * @param {"relevance"|"callno"} o.sort
 * @param {number} o.page
 * @param {number} o.pageSize
 * @param {number|null} o.mediaType 文献类型码（1图书 2期刊 5报纸…），null=不限
 * @param {boolean} o.withAvailability 是否顺带查每本书的可借情况（多一次上游请求）
 */
export async function searchBooks(o) {
  const isBrowse = !o.query || o.query === "*";

  // 「文学类」这类中文说法 → 中图法字母；已经是字母/数字的类号原样用
  let effectiveQuery = o.query;
  let classMappedFrom = null;
  if (!isBrowse && o.searchType === "class") {
    const m = mapClassAlias(o.query);
    effectiveQuery = m.classNo;
    classMappedFrom = m.mappedFrom;
  }

  const conditions = Array.isArray(o.conditions) ? o.conditions.slice(0, 2) : [];
  const hasRange = Boolean(o.pubdateFrom || o.pubdateTo);
  const isAdvance = conditions.length > 0 || hasRange;

  if (isAdvance && o.searchType === "class") {
    throw new UpstreamError("INVALID_PARAM", "分类检索不支持与复杂条件/出版年混用", {
      hint: "先用 search_type=class 单独查类目，或在 conditions 里用 subject/author 等字段",
    });
  }

  const params = {
    searchType: isAdvance ? "advance" : "standard",
    isFacet: "false",
    view: "standard",
    rows: String(o.pageSize),
    page: String(o.page),
    sortWay: o.sort === "callno" ? "callno_sort" : "score",
    sortOrder: "desc",
    return_fmt: "json",
  };

  if (isAdvance) {
    // 高级检索：q0/q1/q2 + searchWay0/1/2 + logical0/1 + 出版年区间
    params.q0 = isBrowse ? "" : effectiveQuery;
    params.searchWay0 = ADV_FIELD[o.searchType] || "marc";
    conditions.forEach((c, i) => {
      params[`q${i + 1}`] = String(c.query ?? "");
      params[`searchWay${i + 1}`] = ADV_FIELD[c.searchType] || "marc";
      params[`logical${i}`] = String(c.logic || "AND").toUpperCase();
    });
    if (conditions.length === 1) params.logical0 = String(conditions[0].logic || "AND").toUpperCase();
    if (o.pubdateFrom) params.startPubdate = String(o.pubdateFrom);
    if (o.pubdateTo) params.endPubdate = String(o.pubdateTo);
  } else {
    params.q = isBrowse ? "*:*" : effectiveQuery;
    params.searchWay0 = "marc";
    params.logical0 = "AND";
    const way = isBrowse ? null : SEARCH_WAY[o.searchType];
    if (way) {
      params.searchWay = way;
      if (way === "class") params.classname = effectiveQuery;
    }
  }
  if (o.libraryCode) params.curlibcode = o.libraryCode;
  // 注意：上游的 hasholding=y 筛选不可信（结果集会被换成另一批、且多为不可借），
  // 所以「只看可借」完全靠本地按页核实，不给上游传这个参数
  if (o.mediaType) params.booktype = String(o.mediaType);

  // 新书通报：同一个检索接口，靠 queryType/searchType/limitDays 切换
  if (o.newArrivalsDays) {
    params.queryType = "search_newpublications";
    params.searchType = "newpub";
    params.scWay = "full";
    params.limitDays = String(o.newArrivalsDays);
  }

  let payload;
  let cached = false;
  let docs = [];
  let total = 0;
  let items = [];
  let dropped = 0;
  let scanned = 0;
  let cursor = o.page;

  // available_only 的上游筛选不可靠（筛出来的记录 hasholding 仍可能是 'n'），
  // 所以按页用馆藏接口复核；本页不够就继续翻，最多 3 页
  const maxScan = o.availableOnly ? 3 : 1;

  for (let attempt = 0; attempt < maxScan; attempt++) {
    const res = await getJson("/opac/search", { ...params, page: String(cursor) }, { ttl: 60_000 });
    payload = res.value;
    cached = cached || res.cached;

    if (payload.booktypeMap) learnedBooktypeMap = { ...learnedBooktypeMap, ...payload.booktypeMap };

    docs = extractDocs(payload);
    total = Number(payload.numFound ?? docs.length) || 0;
    scanned++;

    const cards = docs.map(toCard);
    for (const card of cards) rememberBook(card);

    if (o.withAvailability || o.availableOnly) {
      const summaries = await summarizeHoldings(cards.map((c) => c.bookrecno));
      for (const card of cards) {
        const av = summaries.get(card.bookrecno) || null;
        card.availability = av;
        if (av) card.has_holding = av.available_copies > 0;
      }
    }

    if (o.availableOnly) {
      const kept = cards.filter((c) => c.has_holding);
      dropped += cards.length - kept.length;
      items.push(...kept);
      if (items.length >= o.pageSize || cards.length === 0) break;
      cursor++;
      continue;
    }

    items = cards;
    break;
  }

  items = items.slice(0, o.pageSize);
  const availabilityMeta =
    o.withAvailability || o.availableOnly
      ? "availability 来自批量馆藏查询，统计的是该书全部可借复本"
      : null;

  // 粗分类（I / I2）额外给出子类分布，让读者先挑一支再往下看
  let classBreakdown = null;
  if (
    !isAdvance &&
    o.searchType === "class" &&
    /^[A-Z]\d{0,1}$/i.test(String(effectiveQuery || ""))
  ) {
    try {
      classBreakdown = await classChildren(effectiveQuery);
    } catch {
      /* 分布是加分项，失败不影响主结果 */
    }
  }


  // 封面（可选）：上游 coverUrl 基本为空，走第三方批量接口
  let coversFilled = 0;
  if (o.includeCover) coversFilled = await attachCovers(items);

  return {
    data: {
      total,
      total_pages: Math.ceil(total / o.pageSize),
      page: o.page,
      page_size: o.pageSize,
      has_more: cursor * o.pageSize < total,
      next_page: cursor * o.pageSize < total ? cursor + 1 : null,
      ...(scanned > 1 ? { pages_scanned: scanned } : {}),
      ...(docs.length === 0 && o.page > 1
        ? {
            note: `第 ${o.page} 页没有结果。总记录 ${total} 条，按每页 ${o.pageSize} 条算共 ${Math.ceil(total / o.pageSize)} 页。`,
          }
        : {}),
      items,
      applied: {
        search_type: isBrowse ? "browse" : o.searchType,
        media_type: o.mediaType ? `${o.mediaType}=${MEDIA_TYPES[o.mediaType]}` : null,
        library: o.libraryCode || null,
        available_only: Boolean(o.availableOnly),
        with_availability: Boolean(o.withAvailability),
        sort: o.sort,
        ...(o.newArrivalsDays ? { new_arrivals_days: o.newArrivalsDays } : {}),
        ...(classMappedFrom ? { class_mapped_from: `${classMappedFrom} → ${effectiveQuery}` } : {}),
        ...(isAdvance
          ? {
              conditions: conditions.map((c) => ({
                query: c.query,
                search_type: c.searchType,
                logic: String(c.logic || "AND").toUpperCase(),
              })),
              ...(o.pubdateFrom || o.pubdateTo
                ? { pubdate_range: [o.pubdateFrom || null, o.pubdateTo || null] }
                : {}),
            }
          : {}),
      },
      ...(availabilityMeta ? { availability_note: availabilityMeta } : {}),
      ...(o.includeCover ? { covers_filled: coversFilled } : {}),
      ...(classBreakdown
        ? {
            class_children: classBreakdown,
            hint:
              `「${classBreakdown.name}」下分 ${classBreakdown.children.length} 个子类。` +
              `建议先把子类分布摆给读者挑一支，再用 search_type=class + 具体类号下钻；` +
              `直接列第 1 页意义不大。`,
          }
        : {}),
      ...(o.availableOnly && items.length === 0
        ? {
            hint:
              "本页/相邻几页核实后都没有可借复本。浏览模式（不带关键词）命中大量未编目或无馆藏记录，" +
              "建议：①去掉 available_only，改用 with_availability 看每条明细；②或加 media_type；③或给关键词/分类号。",
          }
        : {}),
      ...(dropped
        ? {
            filtered_out: dropped,
            note:
              `已剔除 ${dropped} 条实际无可借复本的记录（上游没有可靠的可借筛选，按页用馆藏接口核实）。` +
              `total 是检索命中的总数，不等于可借数量。`,
          }
        : {}),
    },
    meta: { cached, degraded: false },
  };
}

/** 一次批量馆藏请求，聚合出「几本可借、在哪些馆/库位」，最多各列 3 个 */
async function summarizeHoldings(ids) {
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;

  let payload;
  try {
    payload = (await getJson("/opac/api/holdings", { bookrecnos: ids.join(",") }, { ttl: 60_000 })).value;
  } catch {
    return out; // 聚合只是锦上添花，失败就留空，不要连累主结果
  }
  const names = await getNameMaps().catch(() => ({ lib: {}, loc: {} }));

  for (const id of ids) {
    const copies = payload?.holdings?.[String(id)] || [];
    const avail = copies.filter((c) => Number(c.state) === 2);
    out.set(Number(id), {
      total_copies: copies.length,
      available_copies: avail.length,
      libraries: uniq(avail.map((c) => names.lib[s(c.curlib)] || s(c.curlib))).slice(0, 3),
      locations: uniq(avail.map((c) => names.loc[s(c.curlocal)] || s(c.curlocal))).slice(0, 3),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 书目详情                                                             */
/* ------------------------------------------------------------------ */

export async function getBook(bookrecno, { includeMarc = false, includeCover = false } = {}) {
  const { value: payload, cached } = await getJson(`/opac/api/book/${bookrecno}`, null, {
    ttl: 300_000,
  });
  const b = payload?.biblios;
  if (!b) throw new UpstreamError("NOT_FOUND", `未找到书目记录 ${bookrecno}`);

  const copies = Array.isArray(payload.holdings) ? payload.holdings : [];
  const available = copies.filter((c) => Number(c.state) === 2).length;

  let coverUrl = s(b.coverUrl);
  if (!coverUrl && includeCover) {
    const isbnKey = s(b.isbn).replace(/[^0-9Xx]/g, "");
    if (isbnKey) {
      const map = await fetchCovers([isbnKey]);
      coverUrl = map.get(isbnKey) || "";
    }
  }

  const data = {
    bookrecno: Number(b.bookrecno),
    title: s(b.title),
    author: s(b.author),
    publisher: s(b.publisher),
    pubplace: s(b.pubplace),
    pubdate: normalizePubdate(b.pubdate),
    isbn: s(b.isbn),
    issn: s(b.issn),
    class_no: s(b.classNo),
    pages: s(b.page),
    price: s(b.price),
    language: s(b.language),
    subjects: s(b.subject).split(/[;,；、]/).map((x) => x.trim()).filter(Boolean),
    summary: s(b.summary).slice(0, 600),
    catalog_name: s(b.cataname),
    frequency: s(b.frequency) || null,
    control_no: s(b.controlNo) || null,
    cover_url: coverUrl,
    attachments: Array.isArray(b.attachment) ? b.attachment : [],
    holding_summary: {
      total_copies: copies.length,
      available_copies: available,
      note: "available_copies 依据复本状态码 2(在馆) 统计，精确到馆请用 fzlib_check_holdings",
    },
    permalink: permalink(b.bookrecno),
    marc: includeMarc ? s(b.marcContent) : null,
  };
  return { data, meta: { cached, degraded: false } };
}

/* ------------------------------------------------------------------ */
/* 馆藏                                                                 */
/* ------------------------------------------------------------------ */

const FALLBACK_STATE = {
  0: "流通还回上架中", 1: "编目", 2: "在馆", 3: "借出", 32: "已签收",
  33: "已通还", 34: "报废",
};

/* 状态 / 文献类型 / 分馆 / 馆藏地这四张是**全局字典**：不同书的单本馆藏接口
   返回的内容逐字节一致，但批量接口 /opac/api/holdings 不带。
   所以只 harvest 一次并常驻 6 小时，而不是每次查馆藏都重新学一遍。 */
const MAP_TTL_MS = 6 * 3600_000;
const TITLE_WAIT_MS = 1_200; // 题名回填的等待上限（毫秒）
let mapCache = { at: 0, value: null };

async function getHoldingMaps(seedId) {
  if (mapCache.value && Date.now() - mapCache.at < MAP_TTL_MS) return mapCache.value;
  try {
    const { value } = await getJson(`/opac/api/holding/${seedId}`, null, { ttl: MAP_TTL_MS });
    mapCache = {
      at: Date.now(),
      value: {
        state: { ...FALLBACK_STATE, ...(value?.holdStateMap || {}) },
        lib: value?.libcodeMap || {},
        loc: value?.localMap || {},
        cir: value?.pBCtypeMap || {},
      },
    };
  } catch {
    // 拿不到字典不影响出结果：状态名回落到内置表，分馆名再走 getNameMaps
    mapCache = {
      at: Date.now(),
      value: { state: { ...FALLBACK_STATE }, lib: {}, loc: {}, cir: {} },
    };
  }
  return mapCache.value;
}

export async function checkHoldings(
  bookrecnos,
  { libraryCode = null, onlyAvailable = false, includeTitles = true, maxCopies = 20 } = {},
) {
  const ids = (Array.isArray(bookrecnos) ? bookrecnos : [bookrecnos]).slice(0, 10);

  // 一次批量拿全部复本：字段与单本接口逐项相同（含 barcode / callno / shelfno /
  // totalLoanNum / volInfo），只是不带那几张字典表。10 本实测 ~0.19s，
  // 取代原先 10 次单本请求（受 400ms 最小间隔串行，约 4.5s）。
  const batch = await getJson("/opac/api/holdings", { bookrecnos: ids.join(",") }, { ttl: 60_000 });
  const maps = ids.length ? await getHoldingMaps(ids[0]) : { state: {}, lib: {}, loc: {}, cir: {} };
  const payloads = ids.map((id) => ({
    id,
    value: {
      holdingList: batch.value?.holdings?.[String(id)] || [],
      holdStateMap: maps.state,
      libcodeMap: maps.lib,
      localMap: maps.loc,
      pBCtypeMap: maps.cir,
    },
    cached: batch.cached,
  }));

  // 题名：优先用检索时记下的；没记下才问书目接口（单本一条，是这一步最慢的地方）。
  // 冷启动时只给 1.2 秒预算，按顺序补，补不完就留空——不并发、也不留后台请求，
  // 免得把全局限流链占满，拖慢用户的下一次调用。
  const titles = new Map();
  if (includeTitles) {
    const deadline = Date.now() + TITLE_WAIT_MS;
    const missing = [];
    for (const { id } of payloads) {
      const hit = bookMetaCache.get(Number(id));
      if (hit?.title) titles.set(Number(id), hit.title);
      else missing.push(id);
    }
    for (const id of missing) {
      if (Date.now() >= deadline) break;
      try {
        const { value } = await getJson(`/opac/api/book/${id}`, null, { ttl: 300_000 });
        const t = s(value?.biblios?.title);
        if (t) {
          titles.set(Number(id), t);
          bookMetaCache.set(Number(id), { title: t, author: s(value.biblios.author), call_no: "" });
        }
      } catch {
        /* 题名只是装饰，拿不到就算了 */
      }
    }
  }

  const filtered = Boolean(libraryCode || onlyAvailable);

  const items = payloads.map(({ id, value }) => {
    const stateMap = { ...FALLBACK_STATE, ...(value.holdStateMap || {}) };
    const libNames = value.libcodeMap || {};
    const localNames = value.localMap || {};
    const bcMap = value.pBCtypeMap || {};

    const copies = (value.holdingList || []).map((h) => {
      const code = Number(h.state);
      const name = stateMap[code]?.stateName ?? stateMap[code] ?? `状态${code}`;
      return {
        holding_recno: Number(h.recno),
        barcode: s(h.barcode),
        call_no: s(h.callno),
        library: s(h.curlib),
        library_name: s(libNames[h.curlib]) || s(h.curlib),
        location: s(h.curlocal),
        location_name: s(localNames[h.curlocal]) || s(h.curlocal),
        status_code: code,
        status: String(name),
        available: code === 2,
        checkin_date: s(h.indate),
        volume: s(h.volInfo) || null, // 期刊的卷期年，如 v.1,no.9,2025
        cir_type: s(h.cirtype) || null,
        cir_type_name: bcMap[h.cirtype]?.name || null, // 中文图书 / 中文期刊 / 阅读本…
        reserved: Number(h.totalResNum) || 0,
        shelf_no: s(h.shelfno) || null,
        loan_count: Number(h.totalLoanNum) || 0,
        renew_count: Number(h.totalRenewNum) || 0,
        price: h.singlePrice ?? null,
      };
    });

    const globalTotal = copies.length;
    const globalAvailable = copies.filter((c) => c.available).length;

    // 关键：明细与计数必须同源。过滤后计数重算，免得「说 4 本只列 1 条」
    const scoped = copies.filter(
      (c) => (!libraryCode || c.library === libraryCode) && (!onlyAvailable || c.available),
    );
    const totalCopies = scoped.length;
    const availableShown = scoped.filter((c) => c.available).length;

    // 期刊：把最新的期放在前面，截断时保住的是「最近到馆」而不是随机 20 条
    if (scoped.some((c) => c.volume)) {
      const volKey = (c) => {
        const v = c.volume || "";
        const year = Number((/(\d{4})/.exec(v) || [])[1] || 0);
        const issue = Number((/no\.(\d+)/.exec(v) || [])[1] || 0);
        return [year, issue];
      };
      scoped.sort((a, b) => {
        const [ya, na] = volKey(a);
        const [yb, nb] = volKey(b);
        return yb - ya || nb - na;
      });
    }

    const truncated = totalCopies > maxCopies;
    const shown = truncated ? scoped.slice(0, maxCopies) : scoped;

    // 期刊复本动辄上百，按年份给个分布，比平铺更有用
    const years = {};
    for (const c of scoped) {
      const m = /(\d{4})/.exec(c.volume || "");
      if (!m) continue;
      years[m[1]] ??= { total: 0, available: 0 };
      years[m[1]].total++;
      if (c.available) years[m[1]].available++;
    }
    const volumeYears = Object.keys(years).length
      ? Object.fromEntries(
          Object.entries(years)
            .sort((a, b) => b[0].localeCompare(a[0]))
            .slice(0, 10),
        )
      : null;

    return {
      bookrecno: Number(id),
      title: titles.get(Number(id)) ?? null,
      scope: filtered ? "filtered" : "global",
      total_copies: totalCopies,
      available_copies: availableShown,
      copies_total: totalCopies,
      ...(truncated ? { truncated: true, copies_shown: shown.length } : {}),
      ...(filtered ? { global: { total_copies: globalTotal, available_copies: globalAvailable } } : {}),
      ...(volumeYears ? { volume_years: volumeYears } : {}),
      ...(copies.length === 0
        ? {
            note:
              "该书目在馆藏接口下没有复本记录。多见于复本全部落在剔除/不外借库位，或该记录本身不挂实体馆藏；" +
              "检索结果里的 has_holding 不能反推馆藏明细。",
          }
        : truncated
          ? {
              note: `复本共 ${totalCopies} 条，每条明细太长，只列前 ${maxCopies} 条（copies_total/volume_years 覆盖全部）。`,
            }
          : {}),
      permalink: permalink(id),
      copies: shown,
    };
  });

  return {
    data: {
      scope_legend: {
        global: "counts 覆盖该书全部复本",
        filtered: "counts 只覆盖 copies 数组里列出的复本；全馆总数见 global",
      },
      items,
    },
    meta: { cached: payloads.some((p) => p.cached), degraded: false },
  };
}

/* ------------------------------------------------------------------ */
/* 分类树                                                               */
/* ------------------------------------------------------------------ */

const CLASS_NODES_CACHE = new Map();

async function browseNodes(nodeId, category) {
  const key = `${category}:${nodeId}`;
  if (CLASS_NODES_CACHE.has(key)) return CLASS_NODES_CACHE.get(key);
  const xml = await getText("/opac/browse/query", { category, id: nodeId }, { ttl: 3_600_000, key });
  const nodes = parseTreeXml(xml);
  CLASS_NODES_CACHE.set(key, nodes);
  return nodes;
}

/**
 * 粗分类（I / I2）→ 子类分布 + 各自书目量。
 * 走 browse/query 拿子节点、browse/count 一次拿全部计数（POST，classnos 用 ]] 拼）。
 * 全部缓存 1 小时。
 */
export async function classChildren(classNo, { category = "cls" } = {}) {
  const target = String(classNo || "").trim().toUpperCase();
  if (!target) return null;

  let nodes = await browseNodes("0", category);
  let prefix = "";
  let node = null;
  for (const ch of target) {
    prefix += ch;
    node = nodes.find((n) => String(n.name).toUpperCase() === prefix);
    if (!node) return null;
    nodes = await browseNodes(node.id, category);
  }

  const kids = nodes;
  if (!kids.length) return null;

  let counts = [];
  try {
    const xml = await postText(
      "/opac/browse/count",
      { category, classnos: kids.map((k) => k.name).join("]]"), libcode: "", booktype: "", curlocal: "" },
      { ttl: 600_000 },
    );
    counts = [...xml.matchAll(/<record\d+>(\d+)<\/record\d+>/g)].map((m) => Number(m[1]));
  } catch {
    /* 计数拿不到就留空，不影响主结果 */
  }

  return {
    class_no: node.name,
    name: node.category_desc,
    children: kids.map((k, i) => ({
      class_no: k.name,
      name: k.category_desc,
      count: counts[i] ?? null,
    })),
  };
}

function parseTreeXml(xml) {
  const records = [];
  const re = /<record>([\s\S]*?)<\/record>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const pick = (tag) => {
      const r = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`).exec(body);
      return r ? r[1].trim() : "";
    };
    records.push({
      id: pick("id"),
      parent_id: pick("parentId"),
      name: pick("name"),
      category_desc: pick("categoryDesc"),
      children_count: Number(pick("childrenCount")) || 0,
    });
  }
  return records;
}

export async function browseClassification({ parentId = "0", category = "cls" } = {}) {
  const text = await getText("/opac/browse/query", { category, id: parentId }, { ttl: 3_600_000 });
  const nodes = parseTreeXml(text);
  return {
    data: {
      parent_id: parentId,
      category,
      count: nodes.length,
      children: nodes,
      hint: nodes.length
        ? "用 fzlib_browse_classification 继续下钻（parent_id 传子节点 id），或用 fzlib_search_books 的 search_type=class + query=类号 直接检索该类全部书目"
        : "该节点下无子类目；它本身就是一个可检索的类号",
    },
    meta: { cached: true, degraded: false },
  };
}

/* ------------------------------------------------------------------ */
/* 分馆与馆藏地                                                         */
/* ------------------------------------------------------------------ */

/** 取分馆清单 + 馆藏地映射（原始形态，两处共用） */
async function loadRawDirectory() {
  const [{ value: meta }, { value: localMap }] = await Promise.all([
    getJson("/opac/newpub/tree/cls", { return_fmt: "json" }, { ttl: 3_600_000 }),
    getJson("/opac/api/libcode2localMap", null, { ttl: 3_600_000 }),
  ]);
  return {
    libcodeList: Array.isArray(meta?.libcodeList) ? meta.libcodeList : [],
    localMap: localMap || {},
  };
}

/**
 * @param {{detail?: "brief"|"full", libraryCode?: string|null}} o
 * detail=brief 只给分馆与馆藏地数量（几百字节）；full 才展开全部馆藏地（几十 KB）
 */
export async function listLibraries({ detail = "brief", libraryCode = null } = {}) {
  const { libcodeList, localMap } = await loadRawDirectory();

  const fromUpstream = libcodeList;
  const codes = new Set([...fromUpstream.map((x) => s(x.libcode)), ...Object.keys(localMap || {})]);

  let libraries = [...codes].filter(Boolean).map((code) => {
    const info = fromUpstream.find((x) => s(x.libcode) === code) || {};
    const areas = (localMap?.[code] || []).map((l) => ({
      code: s(l.localcode),
      name: s(l.name),
      cir_type: s(l.cirType),
    }));
    const base = {
      code,
      name: s(info.name) || code,
      short_name: s(info.simpleName) || null,
      address: s(info.address) || null,
      location_count: areas.length,
    };
    return detail === "full" ? { ...base, locations: areas } : base;
  });

  if (libraryCode) libraries = libraries.filter((l) => l.code === libraryCode);

  return {
    data: {
      detail,
      total_libraries: libraries.length,
      total_locations: libraries.reduce((n, l) => n + l.location_count, 0),
      libraries,
      ...(detail === "brief" && !libraryCode
        ? { hint: "需要某馆的馆藏地明细时，传 detail=full 或 library=<代码>" }
        : {}),
    },
    meta: { cached: true, degraded: libraries.some((l) => !l.name) },
  };
}

/** 把「马尾馆 / MWQ / 马尾」解析成 libcode；解析不出就报错并给候选 */
export async function resolveLibrary(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  const { data } = await listLibraries();
  const exact = data.libraries.find(
    (l) => l.code.toLowerCase() === raw.toLowerCase() || l.name === raw || l.short_name === raw,
  );
  if (exact) return exact.code;
  const fuzzy = data.libraries.filter(
    (l) => l.name.includes(raw) || (l.short_name && l.short_name.includes(raw)),
  );
  if (fuzzy.length === 1) return fuzzy[0].code;
  if (fuzzy.length > 1) {
    throw new UpstreamError(
      "INVALID_PARAM",
      `「${raw}」匹配到多个分馆：${fuzzy.map((l) => `${l.name}(${l.code})`).join("、")}`,
      { hint: "请改用分馆代码" },
    );
  }
  throw new UpstreamError(
    "INVALID_PARAM",
    `未找到分馆「${raw}」`,
    { hint: `可用分馆：${data.libraries.map((l) => `${l.name}(${l.code})`).join("、")}` },
  );
}

/* ------------------------------------------------------------------ */
/* 排行榜                                                               */
/* ------------------------------------------------------------------ */

const RANK_PATH = {
  hot: "/opac/ranking/bookHotRank",
  loan: "/opac/ranking/bookLoanRank",
  reader: "/opac/ranking/readerLoanRank",
};

export async function getRankings({ type = "loan", periodDays = 30, limit = 20 } = {}) {
  // 热门检索词是另一套接口（/opac/hotsearch），返回的是「词」不是「书」
  if (type === "search") {
    const { value, cached } = await getJson("/opac/hotsearch", { return_fmt: "json" }, {
      ttl: 600_000,
    });
    const list =
      periodDays === "all" ? value.hotSearchKeywordListAll : value.hotSearchKeywordList;
    const items = (list || []).slice(0, limit).map((x, i) => ({
      rank: i + 1,
      keyword: s(x.searchKey),
      count: Number(x.searchCount) || 0,
    }));
    return {
      data: {
        type: "search",
        period_days: periodDays,
        count: items.length,
        items,
        note: "这是读者检索词的次数统计（大家最近在搜什么），不是书目排行",
      },
      meta: { cached, degraded: items.length === 0 },
    };
  }

  const path = RANK_PATH[type] || RANK_PATH.loan;
  const params = { return_fmt: "json" };
  if (periodDays && periodDays !== "all") params.limitDays = String(periodDays);

  const { value: payload, cached } = await getJson(path, params, { ttl: 600_000 });

  // 上游用 200 + message 表示「批处理还没生成」，必须识别，否则会返回空榜单
  if (payload?.message) {
    throw new UpstreamError("RANKING_NOT_READY", String(payload.message), {
      retryable: true,
      retry_after_ms: 600_000,
      hint: "排行榜是馆方定时批处理的产物，非实时。可先用 fzlib_search_books 检索，或稍后再试。",
    });
  }

  const records = findRecords(payload);
  if (!records) {
    // 只有分馆清单、没有书目数组 —— 就是「还没生成」
    throw new UpstreamError(
      "RANKING_NOT_READY",
      String(payload?.message || "榜单尚未生成（上游只返回了分馆列表）"),
      {
        retryable: true,
        retry_after_ms: 600_000,
        hint: "排行榜是馆方定时批处理的产物，非实时。可先用 fzlib_search_books 检索，或稍后再试。",
      },
    );
  }
  return {
    data: {
      type,
      period_days: periodDays,
      count: records.length,
      items: records.slice(0, limit).map((r, i) => ({
        rank: i + 1,
        bookrecno: Number(r.id ?? r.bookrecno ?? 0) || null,
        title: s(r.title_meta ?? r.title ?? r.bookName ?? r.name),
        author: s(r.author_meta ?? r.author),
        call_no: s(r.callno_sort ?? r.callno),
        loan_count: Number(r.loanCount ?? r.loannum ?? r.count ?? 0) || null,
      })),
    },
    meta: { cached, degraded: records.length === 0 },
  };
}
