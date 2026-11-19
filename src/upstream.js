/**
 * 上游 HTTP 层：cookie 池、限流、单飞、TTL 缓存、错误归一。
 * 只做「怎么拿数据」，不关心「数据是什么」。
 *
 * 三条硬约束，动手之前先读：
 *   1) 全局限流：所有请求走同一条 promise 链，相邻两次至少隔 MIN_INTERVAL_MS（默认 400ms）。
 *      所以 Promise.all 在这层是不提速的 —— 它只会排队。要快就减少请求数，别想着并行。
 *   2) cookie 池是进程级共享的：这站靠 JSESSIONID + __jsluid_s 认人，丢了会被反复挑战。
 *   3) 缓存 key 默认是完整 URL（参数顺序算数）；自定义 key 时要保证唯一，
 *      否则会把不同查询的结果互相污染。
 *
 * 错误码：UPSTREAM_TIMEOUT / UPSTREAM_ERROR（5xx）/ UPSTREAM_PARSE_ERROR（拿到 HTML，
 * 多半被风控或掉登录页）/ NOT_FOUND / INVALID_PARAM。可重试的会带 retryable。
 */
const BASE = (process.env.FZLIB_BASE || "https://opcs.fzlib.org:8082").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.FZLIB_TIMEOUT_MS || 45000);
const MIN_INTERVAL_MS = Number(process.env.FZLIB_MIN_INTERVAL_MS || 400);
const USER_AGENT = "fzlib-mcp/0.1 (MCP; read-only catalogue client)";
const DEBUG = process.env.FZLIB_DEBUG === "1";

export class UpstreamError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "UpstreamError";
    this.code = code;
    this.retryable = extra.retryable ?? false;
    this.retry_after_ms = extra.retry_after_ms;
    this.hint = extra.hint;
    this.status = extra.status;
  }
}

const debug = (...a) => DEBUG && console.error("[upstream]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- cookie 池 ---------------- */
// 这站靠 JSESSIONID + 加速乐 __jsluid_s 识别会话，不保存就会被当成新访客反复挑战。
const cookies = new Map();

function rememberCookies(res) {
  const list =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie")]
        : [];
  for (const line of list) {
    const [pair] = String(line).split(";");
    const i = pair.indexOf("=");
    if (i < 1) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!value || /expires=Thu, 01 Jan 1970/i.test(String(line))) cookies.delete(name);
    else cookies.set(name, value);
  }
}

const cookieHeader = () =>
  [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");

/* ---------------- 限流（串行 + 最小间隔） ---------------- */
let chain = Promise.resolve();
let lastAt = 0;

function scheduled(fn) {
  const run = async () => {
    const wait = lastAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    return fn();
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/* ---------------- 单次请求 ---------------- */
function buildUrl(path, params) {
  if (!params) return BASE + path;
  const usable = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  return BASE + path + "?" + new URLSearchParams(usable).toString();
}

async function fetchOnce(path, params) {
  const url = buildUrl(path, params);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json,text/html;q=0.8,*/*;q=0.5",
        "accept-language": "zh-CN,zh;q=0.9",
        ...(cookies.size ? { cookie: cookieHeader() } : {}),
      },
    });
    rememberCookies(res);
    const text = await res.text();
    debug(res.status, url, `${text.length}B`);
    return { status: res.status, text, url: res.url };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new UpstreamError("UPSTREAM_TIMEOUT", `上游超时（>${TIMEOUT_MS}ms）`, {
        retryable: true,
        hint: "该馆服务器响应较慢，稍后重试或减小 page_size",
      });
    }
    throw new UpstreamError("UPSTREAM_TIMEOUT", `网络错误：${err.message}`, {
      retryable: true,
      hint: "检查 Termux 网络连通性",
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 缓存 & 单飞 ---------------- */
const cache = new Map();
const inflight = new Map();

/**
 * 带缓存与单飞的 JSON 获取。
 * @param {string} path
 * @param {object|null} params
 * @param {{ttl?:number, key?:string}} opts
 */
export function getJson(path, params, opts = {}) {
  const ttl = opts.ttl ?? 60_000;
  const key = opts.key || buildUrl(path, params);

  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) {
    return Promise.resolve({ value: hit.value, cached: true });
  }
  if (inflight.has(key)) return inflight.get(key).then((v) => ({ value: v, cached: true }));

  const task = (async () => {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const { status, text, url } = await scheduled(() => fetchOnce(path, params));
        if (status >= 500) {
          throw new UpstreamError("UPSTREAM_ERROR", `上游返回 HTTP ${status}`, {
            retryable: true,
            status,
          });
        }
        if (status === 404) {
          throw new UpstreamError("NOT_FOUND", "上游 404：记录不存在或路由变更", { status });
        }
        const body = text.trim();
        // 期望 JSON 却拿到 HTML：多半是被加速乐挑战，或掉到了登录页
        if (body.startsWith("<")) {
          throw new UpstreamError(
            "UPSTREAM_PARSE_ERROR",
            "上游返回 HTML 而非 JSON（可能被风控挑战或被重定向到登录页）",
            { retryable: true, hint: "稍等再试；若持续出现说明客户端 cookie 已失效" },
          );
        }
        const parsed = JSON.parse(body);
        cache.set(key, { value: parsed, exp: Date.now() + ttl });
        return parsed;
      } catch (err) {
        const retryable = err instanceof UpstreamError && err.retryable;
        if (attempt < 2 && retryable) {
          await sleep(700 * attempt);
          continue;
        }
        throw err instanceof UpstreamError
          ? err
          : new UpstreamError("INTERNAL", err.message, { retryable: false });
      }
    }
  })();

  inflight.set(key, task);
  task.finally(() => inflight.delete(key));
  return task.then((v) => ({ value: v, cached: false }));
}

/** 取 HTML 页面（首页等），供极少数的兜底场景使用。 */
export async function getText(path, params, opts = {}) {
  const ttl = opts.ttl ?? 300_000;
  const key = opts.key || "text:" + buildUrl(path, params);
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const { text } = await scheduled(() => fetchOnce(path, params));
  cache.set(key, { value: text, exp: Date.now() + ttl });
  return text;
}

/** 表单 POST（browse/count 这类只接受 POST 的接口） */
export async function postText(path, form, opts = {}) {
  const ttl = opts.ttl ?? 600_000;
  const key = opts.key || "post:" + path + JSON.stringify(form);
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;

  const body = new URLSearchParams(
    Object.entries(form).filter(([, v]) => v !== undefined && v !== null),
  ).toString();

  const run = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(BASE + path, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "user-agent": USER_AGENT,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/xml,text/html;q=0.8,*/*;q=0.5",
          "accept-language": "zh-CN,zh;q=0.9",
          ...(cookies.size ? { cookie: cookieHeader() } : {}),
        },
        body,
      });
      rememberCookies(res);
      const text = await res.text();
      debug("POST", res.status, path, `${text.length}B`);
      if (res.status >= 500) {
        throw new UpstreamError("UPSTREAM_ERROR", `上游返回 HTTP ${res.status}`, { retryable: true });
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  };

  const text = await scheduled(run).catch((err) => {
    throw err instanceof UpstreamError
      ? err
      : new UpstreamError("UPSTREAM_TIMEOUT", err?.message || "POST 失败", { retryable: true });
  });
  cache.set(key, { value: text, exp: Date.now() + ttl });
  return text;
}

export const config = { BASE, TIMEOUT_MS };
