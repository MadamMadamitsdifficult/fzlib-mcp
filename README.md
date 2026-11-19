# fzlib-mcp v0.11.0

福州市图书馆（福州地区图书馆联合检索平台）OPAC 的 MCP 服务器。
**只读**、公开数据、无登录态。底层对接图创 Interlib 3 的 Web 接口。

传输层两种，同一进程同时提供：

| 传输 | 端点 | 适用 |
|---|---|---|
| Streamable HTTP（推荐） | `POST /mcp` | 新版客户端，会话制（`Mcp-Session-Id`） |
| Legacy SSE | `GET /sse` + `POST /message` | 只认 SSE 的老客户端 |
| stdio | `node src/index.js` | 本地调试 / 只支持 stdio 的客户端 |

```
fzlib-mcp/
├─ src/
│  ├─ server.js    工具注册与调用编排（与传输无关）
│  ├─ http.js      HTTP 入口：Streamable HTTP + SSE + /health
│  ├─ index.js     stdio 入口
│  ├─ tools.js     6 个工具的 schema 与参数校验
│  ├─ fzlib.js     领域层：上游脏字段 → 稳定模型
│  └─ upstream.js  HTTP 客户端：cookie、限流、单飞、TTL 缓存
├─ test/
│  ├─ selfcheck.mjs  自包含：自己起服务 → 两种传输各测一遍 → 关掉
│  ├─ protocol.mjs   stdio 协议链路
│  ├─ smoke.mjs      绕过协议直接跑工具
│  ├─ regression.mjs 回归测试（76 项，锁住各版修过的问题）
│  └─ static.mjs     离线自检（语法/工具清单/版本一致性，CI 用）
└─ docs/API-NOTES.md 上游接口笔记（维护用）
```

## 安装（Termux）

```bash
pkg install -y nodejs
cd ~/fzlib-mcp && npm install
```

`npm install` 慢就换源：`npm install --registry=https://registry.npmmirror.com`

## 启动

```bash
# 前台（Ctrl-C 退出）
npm run http

# 后台常驻
nohup node src/http.js > ~/fzlib.log 2>&1 &
termux-wake-lock            # 防止安卓休眠杀进程（可选，会常驻通知）

# 换端口 / 允许局域网访问
FZLIB_HTTP_PORT=8899 FZLIB_HTTP_HOST=0.0.0.0 FZLIB_HTTP_TOKEN=你的口令 node src/http.js
```

启动成功会打印：

```
[fzlib-mcp] v0.5.0 ready (http) · http://127.0.0.1:8788/mcp
[fzlib-mcp] 上游 https://opcs.fzlib.org:8082 · 鉴权 未开启
```

### 自检

```bash
node test/selfcheck.mjs      # 自己起服务、测两种传输、自动关掉，不占用端口
curl -s http://127.0.0.1:8788/health
```

## 接入客户端

**Streamable HTTP（优先）**

```json
{
  "mcpServers": {
    "fzlib": { "type": "http", "url": "http://127.0.0.1:8788/mcp" }
  }
}
```

有些客户端字段名不同，按它的写法取其一：`"type": "streamable-http"` / `"transport": "http"` / 只有 `"url"`。
命令行（Claude Code 一类）：`claude mcp add --transport http fzlib http://127.0.0.1:8788/mcp`

**Legacy SSE（上面连不上时再试）**

```json
{
  "mcpServers": {
    "fzlib": { "type": "sse", "url": "http://127.0.0.1:8788/sse" }
  }
}
```

**stdio（不推荐，但保留）**

```json
{
  "mcpServers": {
    "fzlib": {
      "command": "/data/data/com.termux/files/usr/bin/node",
      "args": ["/data/data/com.termux/files/home/fzlib-mcp/src/index.js"]
    }
  }
}
```

## 工具清单

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `fzlib_search_books` | 检索 / 浏览 / 新书通报 | `query`(**可空=浏览**)、`search_type`、`media_type`、`library`、`available_only`、`with_availability`、**`new_arrivals_days`**、`page` |
| `fzlib_get_book` | 书目详情 | `bookrecno`、`include_marc` |
| `fzlib_check_holdings` | 查哪馆能借 | `bookrecno`（可数组，≤10）、`library`、`only_available`、`include_titles`、**`max_copies`** |
| `fzlib_browse_classification` | 中图法分类树 | `parent_id`（`0`=一级大类）、`category`(cls/sci) |
| `fzlib_list_libraries` | 分馆与馆藏地 | `detail`(brief/full，默认 brief)、`library` |
| `fzlib_get_rankings` | 榜单 / 热门检索词 | `type`(hot/loan/reader/**search**)、`period_days`、`limit` |

### 复杂检索（多条件 + 出版年）

```json
{
  "query": "三体",
  "search_type": "title",
  "conditions": [{ "query": "刘慈欣", "search_type": "author", "logic": "AND" }],
  "pubdate_from": 2015,
  "pubdate_to": 2026
}
```

上游用的是 `searchType=advance` 那套三行表单：`q0/q1/q2` + `searchWay0/1/2` + `logical0/1`
+ `startPubdate/endPubdate`。硬限制：**最多 3 个条件、无括号嵌套、逻辑只有 AND/OR（没有 NOT）**。

实测：书名=三体 82 条 → 加作者 AND 31 条 → 改 OR 324 条。

> 注意：advance 模式**不套** standard 模式那层默认的库位排除，空条件时的总数会略大
> （1,771,964 vs 1,611,060）。拿它比对"馆藏总量"时别混用。

### 粗分类会先给子类分布

`search_type=class` 传 1~2 位的类号（`I`、`I2`）时，返回里多一个 `class_children`：

```json
"class_children": {
  "class_no": "I", "name": "I 文学",
  "children": [
    {"class_no": "I0", "name": "I0 文学理论", "count": 2997},
    {"class_no": "I2", "name": "I2 中国文学", "count": 309592}
  ]
}
```

数据来自 `browse/query`（子节点）+ `browse/count`（一次拿全部计数，POST，`classnos` 用 `]]` 拼）。

### 浏览模式（不给关键词）

`query` 留空就是浏览全库，一次一页：

```json
{"page": 500, "page_size": 20, "media_type": 1}
```

返回里带 `total_pages`，超出范围会给 `note` 说明实际页数，不会静默返回空数组。
实测全库 1,611,060 条；`page=80000` 仍 5.2 秒返回，是线性退化没有硬墙。
`page` 上限 5000（配合 `page_size=30` 最深 15 万条）——再深对对话没有意义。

要点：这是**按页浏览**，不是全量导出。真要全量请找馆方要 MARC 导出（详见 `docs/API-NOTES.md`）。

### 期刊 / 报纸

`media_type` 直接对应馆方的 `booktype`，数字和名称都收：
`1`图书 `2`期刊 `3`非书资料 `4`西文 `5`报纸，也可写「期刊」「杂志」「周刊」「报纸」。

期刊的「册」就是「期」，`check_holdings` 会多给两个字段：

```json
"volume": "2026,no.12",          // 卷期年
"volume_years": {                 // 按年分布（最多 10 年）
  "2026": {"total": 14, "available": 7},
  "2025": {"total": 31, "available": 22}
}
```

实测《读者》有 **311 条复本**，全列出来要 90KB。所以：

- `copies` 最多列 `max_copies` 条（默认 20），按**最新一期在前**排序
- 超出时 `truncated=true`、`copies_shown` 给出实际条数
- `total_copies` / `copies_total` / `volume_years` **仍覆盖全部**，不受截断影响

问「今年这一期到了吗」→ `check_holdings` 看 `volume` 最新的几条；问「哪几年有」→ 看 `volume_years`。

### 统计口径（重要）

`fzlib_check_holdings` 的 `total_copies` / `available_copies` **永远等于 `copies` 数组的条数**。
传了 `library` 或 `only_available` 时 `scope=filtered`，全馆总数另放在 `global` 里；
未过滤时 `scope=global`。汇报"能借几本"前先看 `scope`，别把某馆的数当全馆。

`fzlib_search_books` 加 `with_availability=true` 时，每条会带：

```json
"availability": { "total_copies": 3, "available_copies": 3,
                  "libraries": ["马尾区图书馆"], "locations": ["中文书库"] }
```

「现在能借吗」这类问题一次就能答，不必再调 `check_holdings`。

统一返回信封：

```json
{ "ok": true, "data": {…}, "meta": { "cached": false, "degraded": false, "source": "…", "elapsed_ms": 412 } }
```

失败时 `ok:false` + `error.code`，且 `isError:true`：

| code | 含义 | 处理 |
|---|---|---|
| `INVALID_PARAM` | 参数不合法（含分馆名解析失败） | 按 `hint` 修正 |
| `NOT_FOUND` | 书目不存在 | 重新检索 |
| `UPSTREAM_TIMEOUT` | 上游慢/超时 | 稍后重试 |
| `UPSTREAM_PARSE_ERROR` | 拿到 HTML（风控挑战/掉登录页） | 稍等再试 |
| `RANKING_NOT_READY` | 排行榜批处理未完成 | **正常状态**，非故障 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `FZLIB_HTTP_PORT` | `8788` | 监听端口（也认 `PORT`） |
| `FZLIB_HTTP_HOST` | `127.0.0.1` | 改 `0.0.0.0` 才能被局域网/其它设备访问 |
| `FZLIB_HTTP_TOKEN` | 空 | 设置后要求 `Authorization: Bearer <token>` |
| `FZLIB_SESSION_TTL_MS` | `1800000` | MCP 会话闲置回收时间（30 分钟） |
| `FZLIB_DEBUG` | `0` | `1` 打印每个上游请求 |
| `FZLIB_TIMEOUT_MS` | `45000` | 上游超时（这站偶尔很慢，别调小） |
| `FZLIB_MIN_INTERVAL_MS` | `400` | 请求最小间隔（≈2.5 rps 礼貌限流） |
| `FZLIB_BASE` | `https://opcs.fzlib.org:8082` | 换馆时改这里 |

## 会话模型（为什么要会话）

MCP 流式 HTTP 规范里，客户端只在开头 `initialize` 一次，之后所有请求靠 `Mcp-Session-Id` 复用。
SDK 1.32 的 stateless transport 禁止跨请求复用，而每请求新建 server 又会丢掉「已初始化」状态
（表现为 `tools/list` 直接 500）。所以本服务按会话维护 `server+transport`：

- `POST /mcp` 首次带 `initialize` → 新建会话，响应头返回 `Mcp-Session-Id`
- 后续请求带该头复用；30 分钟闲置自动回收
- `DELETE /mcp` 主动结束
- `GET /mcp` 带会话则打开 SSE 通知流（本服务不发通知，可不用）

单实例内存态，够 Termux 用；要横向扩容得换成外部会话存储。

## 性能：一次调用打几次上游

全局限流是 400ms/次、全局串行（见 `upstream.js`），所以**延迟 ≈ 请求数 × 400ms**。
优化方向永远是「少发请求」，不是「发得快」—— `Promise.all` 在这层不会提速，只会排队。

| 场景 | 上游请求数 | 典型耗时 |
|---|---|---|
| `search_books`（不查可借） | 1 | 0.3–0.8 s |
| `search_books` + `with_availability` | 2 | 1.0–2.2 s（随 page_size 增长） |
| `check_holdings`（1–10 本，缓存已热） | 1 | 0.2–0.6 s |
| `check_holdings`（进程冷启动，含字典与题名回填） | 1 + 1 + 若干题名 | ≤ 3 s，每个进程只发生一次 |
| `get_book` | 1 | 0.2–0.6 s |

三个关键实现：

- 复本一律走批量 `/opac/api/holdings?bookrecnos=`，一次拿 10 本，字段与单本接口逐项相同；
- 状态/文献类型/分馆/馆藏地四张字典是**全局**的，`getHoldingMaps()` harvest 一次常驻 6 小时；
- 题名没有批量接口，冷启动时按 1.2 秒预算顺序回填，补不完留 `null`，不在后台残留请求。

## 变更记录

**v0.11.1（未发布）** — 馆藏查询改批量

- `check_holdings` 从「每本一次单本请求」改为一次批量 `/opac/api/holdings?bookrecnos=`：
  复本字段（条码/索书号/状态/卷期/借阅次数）与单本接口逐项相同，10 本从 ~4.5 s 降到 ~0.2 s，
  对上游的请求数也从 10 次降到 1 次
- 新增 `getHoldingMaps()`：四张全局字典 harvest 一次、缓存 6 小时
  （批量接口不带这些表，原先靠单本接口顺带取得）
- 题名回填加 1.2 秒预算：冷启动按顺序补，补不完留空，避免把限流链占满拖慢下一次调用
- 回归测试 76 项全过

**v0.11.0** — 封面 + 补齐被漏掉的字段

- 新增 `include_cover`：走 `bookcovers.cn` 批量接口（需 Referer + 浏览器 UA，否则 403）。
  检索默认关（一次请求补整页），`get_book` 默认开
- 卡片新增 `indate`（到馆日期），可直接判断新旧
- 详情新增 `frequency`（期刊出版频率）、`control_no`（书目控制号）
- 副本新增 `cir_type_name`（中文图书/中文期刊/阅读本）、`reserved`（预约数）、`shelf_no`（排架号）
- 回归测试 76 项

**v0.10.0** — 复杂检索 + 子类导航

- `search_books` 新增 `conditions`（最多 2 条附加条件，AND/OR 组合）与 `pubdate_from/to`，
  走上游的 `searchType=advance`（`q0/q1/q2` + `logical0/1` + `startPubdate/endPubdate`）
- 粗分类（`I`、`I2`）额外返回 `class_children`：子类 + 各自书目量，
  配 `hint` 引导模型先让读者挑一支
- 分类检索与复杂条件互斥（上游 advance 表单没有 class 字段），会明确报 `INVALID_PARAM`
- 回归测试 69 项

**v0.9.0** — 「听懂人话」的一版

- `search_type` 新增 `isbn`（实测 `searchWay=isbn` 可用，9787536692930 → 5 条）
- **中文大类自动映射**：`search_type=class` 传「文学」「计算机类」会换成 `I` / `TP`，
  返回里用 `applied.class_mapped_from` 标明
- **`with_availability` 默认开启**：一次往返就能答「能借吗」，关掉可省一次请求
- 排行榜加固：未生成时除看 `message`，还排除「长得像书目数组的 `libcodeList`」
- 出版年二次清洗：`2993.7` / `2986.12`（年份首位多敲 2）→ 1993.7 / 1986.12
- description 加入「常见说法 → 参数」对照
- 回归测试 60 项

**v0.8.0**

- `search_books` 新增 `new_arrivals_days`：新书通报（原来就是 `/opac/search` 加
  `queryType=search_newpublications&searchType=newpub&limitDays=N`，不是独立接口）
- 可与 `media_type` / `library` / `search_type=class` 叠加
- 回归测试 51 项

**v0.7.0**

- `get_rankings` 新增 `type=search`：热门检索词（`/opac/hotsearch`，最近30天 / 所有时间），
  返回 `{keyword, count}`，回答「大家最近在搜什么」
- 新增 `limit` 参数（1–50）
- 回归测试 47 项

**v0.6.0**

- **`available_only` 重做**：上游 `hasholding=y` 筛选不可信（结果集会被换成另一批、且多为不可借），
  改成本地按页用馆藏接口核实，不够就继续翻页（最多 3 页）
- **出版年清洗**：Excel 序列号 `42979` → `2017`
- 回归测试 43 项

**v0.5.0** — 浏览模式

1. `search_books` 的 `query` 改为可选；不填即按 `q=*:*` 逐页浏览全库（161 万条）
2. 返回新增 `total_pages`；页码超界时给 `note` 而不是空数组
3. `page` 上限放宽到 5000（每页 30 条 → 最深 15 万条）
4. 回归测试扩到 35 项

**v0.4.0** — 期刊/报纸接入（合并进现有工具，没加新工具）

1. `search_books` 新增 `media_type`，直通上游 `booktype`（1图书 2期刊 5报纸…）
2. `check_holdings` 暴露 `volume`（卷期年）与 `volume_years`（按年可借分布）
3. 期刊复本超量时截断（默认 20 条），按最新一期在前排序，总额与年份分布不受影响
4. 回归测试扩到 27 项

**v0.3.0** — 全部来自真实使用反馈

1. `check_holdings` 计数与明细同源：过滤后重算，`scope` 标明 scope，全馆总数移到 `global`
2. `check_holdings` 恢复 `title`（检索时缓存题名，冷启动才回源）
3. `search_books` 新增 `with_availability`，一次往返拿到「几本可借、在哪些馆」
4. `search_books` 新增 `search_type=subject`（主题词检索，噪声远小于 keyword）
5. `list_libraries` 默认 `detail=brief`，输出从 67KB 降到 ~1KB
6. 回归测试 `test/regression.mjs` 把这 6 条锁死

**v0.2.0** — 加 HTTP 传输（Streamable HTTP 会话制 + 旧版 SSE），`/health`

**v0.1.0** — 只读检索/馆藏/分类/排行，stdio

## v0.2 的已知边界

1. **只读**。不做登录、预约、续借、书单。
2. **没有新书通报**。`newpub` 列表由前端二次加载，数据源未定位；不编造近似实现。
3. **排序只有相关度和索书号**。上游 `sortWay` 仅支持 `score` / `callno_sort`，其它值 500。
4. **没有分面**。`isFacet=true` 会让上游 JSON 自引用递归，只能关掉。
5. **分类树按数字节点 id 下钻**，不是类号；按类号检索用 `search_type=class`。
6. **单进程单实例**。会话在内存里，重启后客户端需重新 initialize。

## 部署到带网关的平台（如魔搭创空间）

平台网关往往已经占用了 `Authorization` 头来校验它自己的令牌，本服务的令牌因此改走自定义头，两者互不打架：

| 请求头 | 用途 |
|---|---|
| `Authorization: Bearer <平台令牌>` | 平台网关（如魔搭账号令牌） |
| `X-Fzlib-Token: <本服务令牌>` | 本服务（值等于 `FZLIB_HTTP_TOKEN`） |

`/`（说明页）与 `/health`（探活）免鉴权，可直接被平台探测和公开访问。

容器部署要求：监听 `0.0.0.0`、端口与平台声明一致（创空间为 7860），令牌通过平台的环境变量注入，不要写进镜像。

## 使用边界

这是给**个人自用**的工具，不是公共服务：

- **不要**把它部署成开放给所有人调用的查询入口。上游是图书馆的一台服务器，每一次检索都由它承担。
  本项目已刻意做了 400ms 串行限流（`FZLIB_MIN_INTERVAL_MS`），请不要调低，也不要改造成并发抓取。
- **不要**把 MCP 端点暴露成免鉴权的公开地址。自托管请设 `FZLIB_HTTP_TOKEN`；
  托管在平台上（如魔搭创空间）请设为私有空间。
- **不要**用它做全库导出或定时批量抓取。需要成批数据请直接联系馆方。
- `docs/API-NOTES.md` 只保留行为约定；具体的接口路径与参数不随仓库公开。

## 开发说明

人机分工写明如下，便于判断代码可信度：

- **作者（MadamMadamitsdifficult）**：需求、选型、所有对外行为的决策与验收；
- **AI 助手（`deepseek-flash`，DeepSeek）**：代码实现、上游接口适配与文档草稿，在作者指导下完成。

所有结论均以实测为准；未能验证的一律在文档里标为「未验证」，不写推测。

## 免责声明

**本项目非官方。** 它是一个第三方个人开发的只读工具，与福州市图书馆、福州地区图书馆联合检索平台及其运维方**没有任何隶属、合作或授权关系**，亦不代表其立场。

**数据来源与准确性。** 全部书目与馆藏信息来自该平台对公众开放的 OPAC 接口（`opcs.fzlib.org:8082`）。这类数据可能滞后、缺失、重复或录入有误（例如题名与内容不符、卡片索书号与实体书脊不一致）。**一切以馆内实际馆藏与工作人员答复为准**；因信息偏差导致的跑空、借不到、预约失败等情形，本项目不承担责任。

**按原样提供。** 软件依 MIT 许可「AS IS」提供，不附带任何明示或默示担保，包括但不限于适销性与特定用途适用性。使用者在部署、调用、二次分发时，应自行确保符合所在地法律法规及上游平台的服务条款，并自行承担由此产生的后果。

**只读与节制。** 本项目不涉及登录、借阅、预约、续借，不获取也不存储读者证号、借阅记录等个人信息。内置串行限流（`FZLIB_MIN_INTERVAL_MS`，默认 400ms）与 TTL 缓存，**请勿调低该值或改造为批量抓取**；如需对外提供服务，请设置 `FZLIB_HTTP_TOKEN` 并限制来源地址，避免成为他人向公共服务施压的免费跳板。

**权利归属与侵权处理。** 文中涉及的图书馆名称、平台标识与书目数据，其权利归各自所有者；本项目仅出于技术研究与个人使用目的进行接口适配。若权利人认为本项目不当使用其接口或数据，请通过 Issue 联系，作者核实后将及时调整或移除相关代码与文档。

## 许可证

MIT © 2026 MadamMadamitsdifficult。可自由使用、修改、分发，保留版权与许可声明即可；完整条款见 [LICENSE](LICENSE)。
