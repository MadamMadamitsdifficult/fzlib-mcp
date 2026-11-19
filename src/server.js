/**
 * 服务器装配：把 tools.js 的工具注册成 MCP tools，并统一调用编排。
 *
 * 全项目只有这里决定「成功/失败长什么样」，两种传输共用：
 *   成功 → { ok: true, data, meta: { source, elapsed_ms, ...工具自带 meta } }
 *   失败 → { ok: false, error: { code, message, retryable?, hint?, retry_after_ms? } }
 * 上游异常统一抛 UpstreamError，带 code 与 hint 原样透给模型 —— hint 是给模型看的
 * 纠正提示（比如「分类检索不能和出版年混用」），写清楚了它就能自己改参数重试。
 *
 * 与传输层解耦：不 import http、不碰 socket；stdio 与 HTTP 都只是调 createServer()。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { tools } from "./tools.js";
import { UpstreamError, config } from "./upstream.js";

export const SERVER_NAME = "fzlib-mcp";
export const VERSION = "0.11.0";

const log = (...a) => console.error("[fzlib-mcp]", ...a);
const upstreamHost = config.BASE.replace(/^https?:\/\//, "");

export function createServer() {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params ?? {};
    const tool = tools.find((t) => t.name === name);
    const startedAt = Date.now();

    if (!tool) {
      return {
        content: [{ type: "text", text: `未知工具：${name}` }],
        isError: true,
      };
    }

    try {
      const { data, meta } = await tool.handler(args ?? {});
      const payload = {
        ok: true,
        data,
        meta: { ...meta, source: upstreamHost, elapsed_ms: Date.now() - startedAt },
      };
      log(`ok ${name} ${Date.now() - startedAt}ms`);
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (err) {
      const known = err instanceof UpstreamError;
      const error = {
        code: known ? err.code : "INTERNAL",
        message: err?.message ?? String(err),
        retryable: Boolean(known && err.retryable),
        ...(known && err.hint ? { hint: err.hint } : {}),
        ...(known && err.retry_after_ms ? { retry_after_ms: err.retry_after_ms } : {}),
      };
      log(`ERR ${name} ${error.code}: ${error.message}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: false, error, meta: { source: upstreamHost, elapsed_ms: Date.now() - startedAt } },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
