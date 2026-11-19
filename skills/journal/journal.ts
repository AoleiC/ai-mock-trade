// 状态读写 SDK：出手台账（跨轮记忆层）、动态策略读写
// 纯本地文件读写，不依赖网络。文件存储约定（相对项目根）：
// data/trade-journal-{date}.json、memory/dynamic-strategy.md
//
// ⚠ 市场节点判定已全面云端化（2026-11-14 改造）：本地 regime 阶段状态机（regime-state.json /
//   regime_advance / regime_rebuild / read_regime_state）整体退役，节点唯一权威 = 云端
//   market.read_market_node（盘中实时节点 + 日级链组合，见 skills/mock/market.ts）；
//   本模块不再持有任何节点状态与转移规则。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot, loadEnv } from "../env.ts";

loadEnv();
const DATA_DIR = join(findProjectRoot(), "data");
const MEMORY_DIR = join(findProjectRoot(), "memory");

// ==================== 动态策略 ====================

// 读取动态交易策略（memory/dynamic-strategy.md 全文；不存在返回空串）
export function readDynamicStrategy(): string {
  const path = join(MEMORY_DIR, "dynamic-strategy.md");
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

// 写入动态交易策略（整文件覆盖）
export function writeDynamicStrategy(content: string): void {
  writeFileSync(join(MEMORY_DIR, "dynamic-strategy.md"), content, "utf-8");
}

// ==================== 日期与时间工具（跨模块共用） ====================

// 本地日期 YYYY-MM-DD（与 datetime.now().strftime 对齐，本地时区）
export function localDateString(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 本地时间 HH:MM
function localHM(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ==================== 出手台账（当日买入 / 否决记录，跨轮记忆层） ====================

// 台账动作枚举：buy=买入 / veto=候选否决
const TRADE_JOURNAL_ACTIONS = ["buy", "veto"];

// 成交状态语义（台账只记"计划与语义"，成交事实以服务端为准——AGENTS 数据口径）：
//   pending   = 委托已报、成交未确认（不计笔数；等服务端成交回报升级为 filled）
//   filled    = 已成交（计笔数；成交价量以服务端成交回报为准）
//   cancelled = 委托未成交（撤单 / 废单 / 到收盘未成；不计笔数）
const TRADE_JOURNAL_STATUSES = ["pending", "filled", "cancelled"];

// 读取记录状态（旧文件无 status 字段 → 视为 filled，保持向后兼容）
function statusOf(record: Record<string, unknown>): string {
  return String(record.status ?? "filled");
}

// 记录一条当日出手决策（append-only 事件流；同键更新用 updateDecision，不做去重——重复防护由调用方对账逻辑承担）
// stopLossPct：买入时声明的止损计划（占买入价百分比，正数）——卖链会话失败时的机械兜底执行该记录值
// status：成交状态（默认 filled；委托未确认成交时记 pending，不计笔数）
export function recordDecision(
  tradeDate: string,
  action: string,
  stockCode: string,
  stockName = "",
  direction: string | null = null,
  price: number | string = 0,
  volume: number | string = 0,
  reason = "",
  timeStr: string | null = null,
  source = "agent",
  stopLossPct: number | null = null,
  status = "filled",
): Record<string, unknown> {
  if (!TRADE_JOURNAL_ACTIONS.includes(action)) {
    return { code: 400, error: `action 必须是 ${TRADE_JOURNAL_ACTIONS.join(" / ")}，实际 ${JSON.stringify(action)}` };
  }
  if (!stockCode) {
    return { code: 400, error: "stock_code 必传" };
  }
  if (!TRADE_JOURNAL_STATUSES.includes(status)) {
    return { code: 400, error: `status 必须是 ${TRADE_JOURNAL_STATUSES.join(" / ")}，实际 ${JSON.stringify(status)}` };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || Number.isNaN(Date.parse(`${tradeDate}T00:00:00Z`))) {
    return { code: 400, error: `trade_date ${JSON.stringify(tradeDate)} 格式非法，应为 YYYY-MM-DD` };
  }

  const path = join(DATA_DIR, `trade-journal-${tradeDate}.json`);
  let data: { trade_date: string; records: Array<Record<string, unknown>> } = { trade_date: tradeDate, records: [] };
  if (existsSync(path)) {
    try {
      const loaded = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      if (loaded && typeof loaded === "object" && Array.isArray(loaded.records)) {
        data = loaded as typeof data;
      }
    } catch {
      // 文件损坏 → 从空台账重建（append-only 事件流，损失可由机械层对账补录兜回）
    }
  }
const record = {
    time: timeStr ?? localHM(),
    action,
    stock_code: String(stockCode),
    stock_name: stockName ?? "",
    direction: direction ?? null,
    price: Number(price) || 0,
    volume: Math.trunc(Number(volume) || 0),
    reason: reason ?? "",
    source,
    status,
    ...(stopLossPct !== null && Number.isFinite(Number(stopLossPct)) && Number(stopLossPct) > 0 ? { stop_loss_pct: Number(stopLossPct) } : {}),
  };
  data.records.push(record);
  // 原子覆盖写（tmp + rename，防中断写坏）
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, path);
  const buys = data.records.filter((r) => r.action === "buy");
  const vetoes = data.records.filter((r) => r.action === "veto");
  return {
    code: 200,
    trade_date: tradeDate,
    recorded: record,
    buy_count: buys.length,
    veto_count: vetoes.length,
    total_records: data.records.length,
  };
}

// 更新一条已有台账记录（原地覆盖，不新增行——成交升级 / 方向补正 / 止损计划补记共用）
// 匹配规则：同 action + 同 stock_code，优先命中仍为 pending 的最后一行；否则命中最后一行
export function updateDecision(
  tradeDate: string,
  action: string,
  stockCode: string,
  patch: {
    status?: string;
    price?: number | string;
    volume?: number | string;
    time?: string;
    direction?: string | null;
    reason?: string;
    stop_loss_pct?: number | null;
  } = {},
  opts: { onlyStatus?: string } = {},
): Record<string, unknown> {
  if (!TRADE_JOURNAL_ACTIONS.includes(action)) {
    return { code: 400, error: `action 必须是 ${TRADE_JOURNAL_ACTIONS.join(" / ")}，实际 ${JSON.stringify(action)}` };
  }
  if (!stockCode) {
    return { code: 400, error: "stock_code 必传" };
  }
  if (patch.status !== undefined && !TRADE_JOURNAL_STATUSES.includes(patch.status)) {
    return { code: 400, error: `status 必须是 ${TRADE_JOURNAL_STATUSES.join(" / ")}，实际 ${JSON.stringify(patch.status)}` };
  }
  const path = join(DATA_DIR, `trade-journal-${tradeDate}.json`);
  if (!existsSync(path)) {
    return { code: 404, error: `trade-journal-${tradeDate}.json 不存在` };
  }
  let data: { trade_date: string; records: Array<Record<string, unknown>> };
  try {
    const loaded = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    data = { trade_date: tradeDate, records: ((loaded.records ?? []) as Array<Record<string, unknown>>) };
  } catch (exc) {
    return { code: 404, error: `trade-journal-${tradeDate}.json 读取 / 解析失败: ${exc instanceof Error ? exc.message : String(exc)}` };
  }
  const code = String(stockCode);
  const idxs = data.records
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.action === action && String(x.r.stock_code ?? "") === code)
    .map((x) => x.i)
    .filter((i) => (opts.onlyStatus === undefined ? true : statusOf(data.records[i]!) === opts.onlyStatus));
  if (idxs.length === 0) {
    return { code: 404, error: `台账无匹配记录（action=${action}, code=${code}${opts.onlyStatus ? `, status=${opts.onlyStatus}` : ""}）` };
  }
  const pendingIdx = idxs.filter((i) => statusOf(data.records[i]!) === "pending");
  const target = (pendingIdx.length > 0 ? pendingIdx[pendingIdx.length - 1]! : idxs[idxs.length - 1]!);
  const old = data.records[target]!;
  const next: Record<string, unknown> = { ...old };
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.price !== undefined) next.price = Number(patch.price) || 0;
  if (patch.volume !== undefined) next.volume = Math.trunc(Number(patch.volume) || 0);
  if (patch.time !== undefined) next.time = patch.time;
  if (patch.direction !== undefined) next.direction = patch.direction;
  if (patch.reason !== undefined) next.reason = patch.reason;
  if (patch.stop_loss_pct !== undefined) {
    if (patch.stop_loss_pct === null || !Number.isFinite(Number(patch.stop_loss_pct)) || Number(patch.stop_loss_pct) <= 0) {
      delete next.stop_loss_pct;
    } else {
      next.stop_loss_pct = Number(patch.stop_loss_pct);
    }
  }
  data.records[target] = next;
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, path);
  return { code: 200, trade_date: tradeDate, updated: next, index: target };
}

// 读取当日出手台账（含预聚合：buy 方向分组、veto 清单）
// 计数口径：只有 status=filled（已成交）计入笔数——成交事实以服务端为准，pending / cancelled 不计
export function readDecisions(tradeDate?: string): Record<string, unknown> {
  const td = tradeDate ?? localDateString();
  const path = join(DATA_DIR, `trade-journal-${td}.json`);
  if (!existsSync(path)) {
    return {
      code: 200,
      trade_date: td,
      records: [],
      buy_count: 0,
      pending_count: 0,
      cancelled_count: 0,
      veto_count: 0,
      buy_by_direction: {},
      veto_list: [],
    };
  }
  let records: Array<Record<string, unknown>>;
  try {
    records = ((JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>).records ?? []) as Array<Record<string, unknown>>;
  } catch (exc) {
    return {
      code: 404,
      error: `trade-journal-${td}.json 读取 / 解析失败: ${exc instanceof Error ? exc.message : String(exc)}`,
      trade_date: td,
      records: [],
      buy_count: 0,
      pending_count: 0,
      cancelled_count: 0,
      veto_count: 0,
      buy_by_direction: {},
      veto_list: [],
    };
  }
  const buys = records.filter((r) => r.action === "buy");
  const vetoes = records.filter((r) => r.action === "veto");
  const filledBuys = buys.filter((r) => statusOf(r) === "filled");
  const buyByDirection: Record<string, number> = {};
  for (const r of filledBuys) {
    const key = (r.direction as string) || "方向待确认";
    buyByDirection[key] = (buyByDirection[key] ?? 0) + 1;
  }
  return {
    code: 200,
    trade_date: td,
    records,
    buy_count: filledBuys.length,
    pending_count: buys.filter((r) => statusOf(r) === "pending").length,
    cancelled_count: buys.filter((r) => statusOf(r) === "cancelled").length,
    veto_count: vetoes.length,
    buy_by_direction: buyByDirection,
    veto_list: vetoes.map((r) => ({
      stock_code: r.stock_code ?? null,
      stock_name: (r.stock_name as string) ?? "",
      time: (r.time as string) ?? "",
      reason: (r.reason as string) ?? "",
    })),
  };
}
