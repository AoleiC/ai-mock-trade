// 六池共享实现（pipeline 买链专属通道，零 LLM、零 token 进会话上下文；设计文档 §6.2）：
// 候选行结构 + 配置驱动的池拉取；机械剔除（按 engine-config 开关）在 pipeline/pool.ts fetchAndEliminate
// 分层纪律：池清单 / 剔除开关是策略知识 → memory/engine-config.json（用户可变层）；
//   方法白名单 / 涨停物理阈值表 / 合并去重算术是机械知识 → 留代码（§9：代码不发明数字，也不发明来源）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import * as market from "../../../skills/mock/market.ts";

// 候选行紧凑结构（合并去重后）
export interface Candidate {
  code: string;
  name: string;
  zdf: number | null;
  turnZ: string;
  amount: string;
  mainAmount: string;
  mainAmountNum: number; // 解析成元的数值（排序用；缺失为 0）
  hotCategories: string; // 逗号分隔；空串 = 未归类
  pools: string[]; // 池来源标签
  watchForbidden: boolean; // 命中交易所重点监管名单（固定拉取 + 事实标记；是否禁买由核验会话按心法整册终审，代码不做剔除决策）
}

// 主力净额字符串解析为元（"2.20亿"→2.2e8，"-5300万"→-5.3e7，"--"/空→0）
export function parseAmountCn(s: unknown): number {
  const str = String(s ?? "").trim();
  if (!str || str === "--" || str === "-") return 0;
  const m = str.replace(/,/g, "").match(/^(-?\d+(?:\.\d+)?)(亿|万)?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  if (m[2] === "亿") return n * 1e8;
  if (m[2] === "万") return n * 1e4;
  return n;
}

// 按代码前缀判涨停判定阈值（%）：创业/科创 20、北交所 30、其余主板 10（留 0.2 容差）
export function ztThreshold(code: string): number {
  if (/^(30|68)/.test(code)) return 19.8;
  if (/^(43|83|87|92)/.test(code)) return 29.8;
  return 9.8;
}

// ── 策略引擎配置（memory/engine-config.json；解析失败/非法回退默认并告警，不中断） ──
// 池条目（method ∈ 白名单；trend 必带 sid；label 用于池来源标签）
export interface PoolConfigEntry {
  method: "trend" | "main_inflow" | "amount" | "hourly_hot";
  sid?: number;
  label?: string;
}
export interface EngineConfig {
  pools: PoolConfigEntry[];
  pool_limit: number; // 池拉取条数上限（钳 1~200；服务端按实时涨幅降序截断——上限越高覆盖越广，token / 批次成本同比涨）
  eliminate: {
    already_limit_up: boolean; // 剔除已涨停（阈值表是交易所物理规则，固定在代码）
    retreat_direction: boolean; // 剔除撤退方向归属（方向名与热点分类字符串交集）
    price_band: { zdf_max: number; zdf_min: number } | null; // 涨幅带粗筛：当日涨幅 >zdf_max 或 <zdf_min 不进 LLM 批（null=关闭；数值是用户配置的粗筛口径，更细的买点区间判定仍在选股会话）
  };
  batch_size: number; // 蛇形分批每批候选数（钳 5~50）
  concurrency: number; // 批初选（s3a）的批间并发请求数（钳 1~5；过高易触发供应商 429 限流，llm.ts 有退避兜底）
  account_gate: { min_available_yuan: number; max_position_pct: number }; // 拉池前账户物理硬闸：可用资金下限（元）/ 实际仓位上限（%）——用户显式数字，代码只比较
}
// 涨幅带粗筛默认值（配置缺位 / 非法时的回退口径）
const DEFAULT_PRICE_BAND = { zdf_max: 10, zdf_min: -5 };
// 内置默认 = 现行六池（配置缺位/非法时的回退值，保证引擎永远可跑）
export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  pools: [
    { method: "trend", sid: 10, label: "今日趋势" },
    { method: "trend", sid: 4, label: "今日异动拉升" },
    { method: "trend", sid: 5, label: "近期异动上涨" },
    { method: "main_inflow", label: "主力净流入" },
    { method: "amount", label: "成交额" },
    { method: "hourly_hot", label: "小时热度" },
  ],
  pool_limit: 50,
  eliminate: { already_limit_up: true, retreat_direction: true, price_band: { ...DEFAULT_PRICE_BAND } },
  batch_size: 20,
  concurrency: 2,
  account_gate: { min_available_yuan: 2000, max_position_pct: 98 },
};

// 池方法白名单（机械层能力面：系统有哪些选股数据源；新增数据源 = 扩这里 + market.ts）
const POOL_METHODS = new Set(["trend", "main_inflow", "amount", "hourly_hot"]);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// 解析涨幅带粗筛配置：null=显式关闭；缺省=默认带；数值非法 / 上下限倒置回退默认带，越界钳到 ±30%（A 股涨跌幅物理边界）——均告警留痕
function parsePriceBand(raw: unknown, warnings: string[]): EngineConfig["eliminate"]["price_band"] {
  if (raw === null) return null;
  if (raw === undefined) return { ...DEFAULT_PRICE_BAND };
  const fallback = (): { zdf_max: number; zdf_min: number } => {
    warnings.push(`eliminate.price_band=${JSON.stringify(raw)} 非法（需 {"zdf_max":数值,"zdf_min":数值} 且 max>min，或 null 关闭），已回退默认 ${DEFAULT_PRICE_BAND.zdf_min}~${DEFAULT_PRICE_BAND.zdf_max}%`);
    return { ...DEFAULT_PRICE_BAND };
  };
  if (typeof raw !== "object") return fallback();
  const r = raw as Record<string, unknown>;
  const max = Number(r.zdf_max);
  const min = Number(r.zdf_min);
  if (!Number.isFinite(max) || !Number.isFinite(min) || max <= min) return fallback();
  const band = { zdf_max: clamp(max, 0, 30), zdf_min: clamp(min, -30, 0) };
  if (band.zdf_max !== max || band.zdf_min !== min) warnings.push(`eliminate.price_band(${min}~${max}%) 越界已钳制为 ${band.zdf_min}~${band.zdf_max}%`);
  return band;
}

// 读取并校验策略引擎配置（单轮进程一次；任何问题回退默认值并告警——总纲 §九 单点失败不断链）
// warnings：配置漂移/非法事实（池跳过/回退默认/数值钳制）——调用方据此记 attention，让复盘能发现"用户忘改配置"
export function loadEngineConfig(projectRoot: string): { cfg: EngineConfig; warnings: string[] } {
  try {
    const raw = JSON.parse(readFileSync(join(projectRoot, "memory", "engine-config.json"), "utf-8")) as Record<string, unknown>;
    const poolsIn = Array.isArray(raw.pools) ? raw.pools : [];
    const pools: PoolConfigEntry[] = [];
    for (const [i, p] of poolsIn.entries()) {
      const method = String((p as Record<string, unknown>).method ?? "");
      if (!POOL_METHODS.has(method)) {
        log("pool", `engine-config 第 ${i + 1} 池 method="${method}" 不在白名单，跳过`);
        continue;
      }
      if (method === "trend" && !Number.isInteger((p as Record<string, unknown>).sid)) {
        log("pool", `engine-config 第 ${i + 1} 池 method=trend 缺 sid，跳过`);
        continue;
      }
      pools.push({
        method: method as PoolConfigEntry["method"],
        ...(method === "trend" ? { sid: Number((p as Record<string, unknown>).sid) } : {}),
        ...(typeof (p as Record<string, unknown>).label === "string" ? { label: String((p as Record<string, unknown>).label) } : {}),
      });
    }
    const warnings: string[] = [];
    if (pools.length === 0) {
      log("pool", "engine-config 无有效池，回退内置默认六池");
      return { cfg: DEFAULT_ENGINE_CONFIG, warnings: ["engine-config 无有效池，已回退内置默认六池——若非有意留空请检查 memory/engine-config.json"] };
    }
    const elim = (raw.eliminate ?? {}) as Record<string, unknown>;
    const cfg: EngineConfig = {
      pools,
      pool_limit: clamp(Math.floor(Number(raw.pool_limit ?? DEFAULT_ENGINE_CONFIG.pool_limit) || DEFAULT_ENGINE_CONFIG.pool_limit), 1, 200),
      eliminate: {
        already_limit_up: typeof elim.already_limit_up === "boolean" ? elim.already_limit_up : true,
        retreat_direction: typeof elim.retreat_direction === "boolean" ? elim.retreat_direction : true,
        price_band: parsePriceBand(elim.price_band, warnings),
      },
      batch_size: clamp(Math.floor(Number(raw.batch_size ?? DEFAULT_ENGINE_CONFIG.batch_size) || DEFAULT_ENGINE_CONFIG.batch_size), 5, 50),
      concurrency: clamp(Math.floor(Number(raw.concurrency ?? DEFAULT_ENGINE_CONFIG.concurrency) || DEFAULT_ENGINE_CONFIG.concurrency), 1, 5),
      account_gate: {
        min_available_yuan: clamp(Number((raw.account_gate as Record<string, unknown> | undefined)?.min_available_yuan ?? DEFAULT_ENGINE_CONFIG.account_gate.min_available_yuan) || DEFAULT_ENGINE_CONFIG.account_gate.min_available_yuan, 0, 1_000_000),
        max_position_pct: clamp(Number((raw.account_gate as Record<string, unknown> | undefined)?.max_position_pct ?? DEFAULT_ENGINE_CONFIG.account_gate.max_position_pct) || DEFAULT_ENGINE_CONFIG.account_gate.max_position_pct, 50, 100),
      },
    };
    if (pools.length !== poolsIn.length) {
      log("pool", `engine-config 生效 ${pools.length}/${poolsIn.length} 池`);
      warnings.push(`engine-config 有 ${poolsIn.length - pools.length} 个池 method 非法被跳过（白名单: trend/main_inflow/amount/hourly_hot）`);
    }
    const rawLimit = Number(raw.pool_limit ?? 0);
    if (rawLimit > 0 && (rawLimit < 1 || rawLimit > 200) && cfg.pool_limit !== Math.floor(rawLimit)) warnings.push(`pool_limit=${rawLimit} 越界已钳制为 ${cfg.pool_limit}`);
    const rawConc = Number(raw.concurrency ?? 0);
    if (rawConc > 0 && (rawConc < 1 || rawConc > 5) && cfg.concurrency !== Math.floor(rawConc)) warnings.push(`concurrency=${rawConc} 越界已钳制为 ${cfg.concurrency}（批间并发只接受 1~5）`);
    return { cfg, warnings };
  } catch (e) {
    log("pool", `engine-config 读取失败（${e instanceof Error ? e.message : String(e)}），回退内置默认`);
    return { cfg: DEFAULT_ENGINE_CONFIG, warnings: [`engine-config 读取失败（${e instanceof Error ? e.message : String(e)}），已回退内置默认六池`] };
  }
}

// 单池拉取计数（funnel 观测：fetched=接口实际返回行数（趋势池受 pool_limit 截断）/ added=合并去重新增 / dup=与他池重叠 / failed=拉取失败原因）
export interface PoolCount {
  label: string;
  fetched: number;
  added: number;
  dup: number;
  failed?: string;
}

// 六池并行拉取（按 engine-config 的池清单进程内直调；榜单方法无参、limit 仅趋势池生效），合并去重。
// 注意：池方法不在 sdk_call 白名单内——池拉取是 pipeline 买链的专属通道（单一实现，无第二套）
export async function fetchPools(projectRoot: string): Promise<{ merged: Map<string, Candidate>; poolCounts: PoolCount[] }> {
  const { cfg } = loadEngineConfig(projectRoot);
  const limit = cfg.pool_limit;
  const poolJobs: Array<{ label: string; call: Promise<Record<string, unknown>> }> = cfg.pools.map((p) => {
    switch (p.method) {
      case "trend":
        // sort_by="pool" = 策略池自身顺序（成分表插入序）：不做实时涨幅重排——
        // 池超 limit 时按默认涨幅降序会永远只取到当日最高的前 N 只（追高不可买还挤占名额），取无偏样本交给会话按手册判定
        return { label: p.label ?? `趋势${p.sid}`, call: market.getStrategyTrendStocks(p.sid!, "", limit, false, "pool") };
      case "main_inflow":
        return { label: p.label ?? "主力净流入", call: market.getMainInflowTop() };
      case "amount":
        return { label: p.label ?? "成交额", call: market.getAmountTop() };
      case "hourly_hot":
        return { label: p.label ?? "小时热度", call: market.getHourlyHotTop() };
    }
  });
  const merged = new Map<string, Candidate>();
  const poolCounts = new Map<string, PoolCount>();
  const countOf = (label: string): PoolCount => {
    let c = poolCounts.get(label);
    if (!c) {
      c = { label, fetched: 0, added: 0, dup: 0 };
      poolCounts.set(label, c);
    }
    return c;
  };
  const results = await Promise.all(
    poolJobs.map(async (j) => {
      try {
        return { label: j.label, env: await j.call };
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        log("screen_pools", `池 ${j.label} 拉取失败: ${err}`);
        return { label: j.label, env: null, err };
      }
    }),
  );
  for (const { label, env, err } of results) {
    if (!env || env.code !== 200) {
      countOf(label).failed = err ?? (env ? `接口 code=${String(env.code)}` : "未知错误");
      continue;
    }
    const rows = (env.data ?? []) as Array<Record<string, unknown>>;
    const cnt = countOf(label);
    cnt.fetched = rows.length;
    for (const row of rows) {
      const code = String(row.stock_code ?? "").trim();
      if (!code) continue;
      const existing = merged.get(code);
      if (existing) {
        cnt.dup += 1;
        if (!existing.pools.includes(label)) existing.pools.push(label);
        // 趋势池字段更全（换手/成交额/热点分类），榜单行不覆盖已有字段
        continue;
      }
      cnt.added += 1;
      const mainAmount = String(row.main_amount ?? "");
      merged.set(code, {
        code,
        name: String(row.stock_name ?? ""),
        zdf: typeof row.zdf === "number" ? row.zdf : null,
        turnZ: row.turn_z != null && row.turn_z !== "" ? String(row.turn_z) : "-",
        amount: row.amount != null && row.amount !== "" ? String(row.amount) : "-",
        mainAmount: mainAmount || "-",
        mainAmountNum: parseAmountCn(mainAmount),
        hotCategories: String(row.hot_categories ?? "").trim(),
        pools: [label],
        watchForbidden: false, // 名单标记由 pool.ts fetchAndEliminate 统一拉名单回填（数据注入点收口在一处）
      });
    }
  }
  return { merged, poolCounts: [...poolCounts.values()] };
}
