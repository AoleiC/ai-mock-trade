// sdk_call 工具：进程内直调 skills TS SDK（market/trading/journal 只读方法）+ 白名单 + 60s 去重缓存
// + 写操作缓存失效（设计文档 §6.1；v3 技术栈收敛后不再子进程调 CLI——单 Node 进程零冷启动开销）
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { log } from "../log.ts";
import * as market from "../../../skills/mock/market.ts";
import * as trading from "../../../skills/mock/trading.ts";

// 每方法参数规格：类型与约束（默认值 = 原 CLI 约束表收敛值；参数名以 SDK 方法签名为准）
interface ParamSpec {
  type: "string" | "integer" | "number";
  required?: boolean;
  default?: string | number;
  min?: number;
  max?: number;
  pattern?: string;
}
// 方法实现：接收规范化参数对象，返回业务对象（信封原样序列化给模型）
type MethodImpl = (args: Record<string, unknown>) => unknown | Promise<unknown>;

// 方法白名单（设计文档 §6.1；参数名逐一对照 skills 签名注册，实现为进程内直调）
const METHOD_SPECS: Record<string, { params: Record<string, ParamSpec>; impl: MethodImpl }> = {
  // 盘中
  "market.get_intraday_analysis": { params: {}, impl: () => market.getIntradayAnalysis() },
  "market.get_key_watch_stocks": { params: {}, impl: () => market.getKeyWatchStocks() },
  "market.get_hot_spot_list": {
    params: { sort_by: { type: "string", default: "zt_count" }, limit: { type: "integer", default: 10, min: 1, max: 20 } },
    impl: (a) => market.getHotSpotList(String(a.sort_by), "desc", a.limit as number),
  },
  "market.get_top_hot_spots": {
    params: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, limit: { type: "integer", default: 10, min: 1, max: 20 } },
    impl: (a) => market.getTopHotSpots(a.date as string | undefined, a.limit as number),
  },
  "market.get_stock_info": {
    params: { stock_code: { type: "string", required: true } },
    impl: (a) => market.getStockInfo(String(a.stock_code)),
  },
  "market.get_daily_k_data": {
    params: { code: { type: "string", required: true }, days: { type: "integer", default: 10, min: 5, max: 15 } },
    impl: (a) => market.getDailyKData(String(a.code), a.days as number),
  },
  "market.get_stock_trendline": {
    params: { code: { type: "string", required: true } },
    impl: (a) => market.getStockTrendline(String(a.code)),
  },
  "market.get_stock_minute_trendline": {
    params: { code: { type: "string", required: true } },
    impl: (a) => market.getStockMinuteTrendline(String(a.code)),
  },
  "market.get_hot_spot_rotation": {
    params: { days: { type: "integer", default: 5, min: 1, max: 15 }, top_n: { type: "integer", default: 9, min: 1, max: 20 } },
    impl: (a) => market.getHotSpotRotation(a.days as number, a.top_n as number),
  },
  "market.get_daily_indicators_history": { params: {}, impl: () => market.getDailyIndicatorsHistory() },
  "market.get_summary": { params: {}, impl: () => market.getSummary() },
  "market.get_daily_summary": {
    params: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
    impl: (a) => market.getDailySummary(a.date as string | undefined),
  },
  "market.get_indicator_trendline": {
    params: { code: { type: "string", required: true } },
    impl: (a) => market.getIndicatorTrendline(String(a.code)),
  },
  "market.get_consecutive_board_ladder": {
    params: { end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
    impl: (a) => market.getConsecutiveBoardLadder(a.end_date as string | undefined),
  },
  "trading.get_positions": { params: {}, impl: () => trading.getPositions() },
  "trading.get_account": { params: {}, impl: () => trading.getAccount() },
  "trading.get_orders": { params: {}, impl: () => trading.getOrders() },
  "trading.get_stock_price": {
    params: { stock_code: { type: "string", required: true } },
    impl: (a) => trading.getStockPrice(String(a.stock_code)),
  },
  "market.read_market_node": {
    params: {},
    impl: () => market.readMarketNode(),
  },
  "market.get_market_node_series": {
    params: { days: { type: "number" } },
    impl: (a) => market.getMarketNodeSeries((a.days as number | undefined) ?? 90),
  },
};

// 子代理允许的三个只读方法（verify_stocks 子会话工具面）
export const SUBAGENT_METHODS = ["market.get_stock_info", "market.get_daily_k_data", "market.get_stock_minute_trendline"] as const;

// sdk_call 调用参数（模型侧统一形状：method + 扁平参数）
export interface SdkCallArgs {
  method: string;
  [key: string]: unknown;
}

// 60s 去重缓存：key=方法+参数 JSON；写操作后强制失效持仓/账户/委托（防下单后核验读旧数据）
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; text: string }>();
const WRITES_INVALIDATE = new Set(["trading.get_positions", "trading.get_account", "trading.get_orders"]);

// 写操作后失效持仓/账户/委托缓存（order_* 工具调用）
export function invalidateTradeCache(): void {
  for (const key of [...cache.keys()]) {
    if (WRITES_INVALIDATE.has(key.split("|")[0]!)) cache.delete(key);
  }
}

// 校验并规范化参数：白名单方法 + 参数规格（未知参数剔除、数值钳制、必填校验）
function validateArgs(
  method: string,
  args: Record<string, unknown>,
): { ok: true; norm: Record<string, unknown>; normKey: string } | { ok: false; error: string } {
  const spec = METHOD_SPECS[method];
  if (!spec) return { ok: false, error: `方法 ${method} 不在白名单（可用: ${Object.keys(METHOD_SPECS).join(", ")}）` };
  const norm: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(spec.params)) {
    let v: unknown = args[name];
    if (v === undefined || v === null || v === "") {
      if (p.required) return { ok: false, error: `参数 ${name} 必填` };
      if (p.default === undefined) continue;
      v = p.default;
    }
    if (p.type === "integer" || p.type === "number") {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) return { ok: false, error: `参数 ${name} 期望数值，传入 ${JSON.stringify(v)}` };
      if (p.type === "integer" && !Number.isInteger(n)) return { ok: false, error: `参数 ${name} 期望整数，传入 ${n}` };
      if (p.min !== undefined && n < p.min) v = p.min;
      else if (p.max !== undefined && n > p.max) v = p.max;
      else v = n;
    } else {
      const s = String(v);
      if (p.pattern && !new RegExp(p.pattern).test(s)) return { ok: false, error: `参数 ${name} 格式非法（需匹配 ${p.pattern}）: ${s}` };
      v = s;
    }
    norm[name] = v;
  }
  const unknown = Object.keys(args).filter((k) => k !== "method" && !(k in spec.params));
  if (unknown.length > 0) return { ok: false, error: `方法 ${method} 不存在参数 ${unknown.join(",")}（勿传多余参数）` };
  return { ok: true, norm, normKey: JSON.stringify(norm) };
}

// 执行一次白名单内的只读 sdk 调用（进程内直调，带 60s 去重缓存）
export async function callSdk(
  args: SdkCallArgs,
  _projectRoot: string,
  opts: { useCache?: boolean; timeoutMs?: number } = {},
): Promise<{ ok: boolean; text: string; cached?: boolean }> {
  const method = String(args.method ?? "");
  const validated = validateArgs(method, args as Record<string, unknown>);
  if (!validated.ok) return { ok: false, text: `参数校验失败: ${validated.error}` };
  const spec = METHOD_SPECS[method]!;
  const key = `${method}|${validated.normKey}`;
  if (opts.useCache !== false) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, text: hit.text, cached: true };
  }
  try {
    const result = await withTimeout(Promise.resolve().then(() => spec.impl(validated.norm)), opts.timeoutMs ?? 60_000, method);
    const text = JSON.stringify(result ?? null);
    cache.set(key, { at: Date.now(), text });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: `调用失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// 带超时的 Promise 包装（接口层 fetch 已有 10s 超时，此处兜底防意外挂死）
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`执行超时(${ms}ms): ${label}`)), ms);
      t.unref?.();
    }),
  ]);
}

// sdk_call 参数 schema（固定形状；方法枚举在 description 中随白名单裁剪，严格校验在 validateArgs）
const SDK_CALL_SCHEMA = Type.Object({
  method: Type.String({ description: "接口方法名（可用方法见描述清单）" }),
  stock_code: Type.Optional(Type.String({ description: "股票代码（纯数字，get_stock_info / get_stock_price 必填）" })),
  code: Type.Optional(Type.String({ description: "股票/指标代码（get_daily_k_data / get_stock_trendline / get_stock_minute_trendline / get_indicator_trendline 必填）" })),
  days: Type.Optional(Type.Integer({ description: "天数，默认 10 钳 5~15（get_daily_k_data / get_hot_spot_rotation）" })),
  limit: Type.Optional(Type.Integer({ description: "数量，默认 10 钳 1~20（hot_spot 系列）" })),
  top_n: Type.Optional(Type.Integer({ description: "轮动展示数量，默认 9（get_hot_spot_rotation）" })),
  date: Type.Optional(Type.String({ description: "日期 YYYY-MM-DD（get_top_hot_spots / get_daily_summary）" })),
  end_date: Type.Optional(Type.String({ description: "截止日期 YYYY-MM-DD（get_consecutive_board_ladder）" })),
  sort_by: Type.Optional(Type.String({ description: "排序字段，默认 zt_count（get_hot_spot_list）" })),
  
});

// 组装 sdk_call 工具定义（allowedMethods 为空 = 全白名单；子会话传 SUBAGENT_METHODS 子集）
export function makeSdkTool(projectRoot: string, allowedMethods?: readonly string[]): ToolDefinition<typeof SDK_CALL_SCHEMA> {
  const descLines = ["调用行情/持仓/状态机只读接口（参数与默认值已固化，勿传多余参数）。可用方法与参数："];
  for (const [m, spec] of Object.entries(METHOD_SPECS)) {
    if (allowedMethods && !allowedMethods.includes(m)) continue;
    const ps = Object.entries(spec.params)
      .map(([n, p]) => (p.required ? `${n}(必填)` : p.default !== undefined ? `${n}=${p.default}` : n))
      .join(" ");
    descLines.push(`- ${m}${ps ? `: ${ps}` : "（无参数）"}`);
  }
  return {
    name: "sdk_call",
    label: "SDK 只读接口",
    description: descLines.join("\n"),
    parameters: SDK_CALL_SCHEMA,
    execute: async (_id, params) => {
      const started = Date.now();
      const result = await callSdk({ ...params, method: String(params.method) }, projectRoot, { useCache: true });
      log("sdk_call", `${String(params.method)} ${result.ok ? "ok" : "FAIL"} ${Date.now() - started}ms${result.cached ? " (cached)" : ""}`);
      const prefix = result.cached ? "【60s 内重复调用，返回缓存】" : "";
      return { content: [{ type: "text" as const, text: prefix + result.text }], details: {} };
    },
  };
}
