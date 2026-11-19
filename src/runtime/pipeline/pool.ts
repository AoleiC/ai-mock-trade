// 买链前置：六池拉取 + 配置化剔除（按 engine-config 开关：监管 / 已涨停 / 涨幅带 / 撤退方向归属）+ 蛇形分批（设计文档 §2 / §2.1）
// 分层纪律：剔除"做不做"是策略 → memory/engine-config.json；"怎么做"（名单匹配 / 涨停物理阈值 / 字符串交集 / 上下限比较）是机械 → 代码。
//   追高 / 换手 / 资金面等数值条件一律由核验会话（s4）按买入手册整册判定（§9：代码不发明数字）；涨幅带是唯一例外——数值由用户在 engine-config 显式配置，代码只做比较
import { fetchPools, loadEngineConfig, ztThreshold, type Candidate, type PoolCount } from "../tools/pools.ts";
import * as market from "../../../skills/mock/market.ts";
import { log } from "../log.ts";

// 剔除统计（trace funnel 消费；dropped_* 为逐股代码——判决链留痕用）
export interface ElimStats {
  merged: number;
  pool_counts: PoolCount[]; // 每池拉取计数（fetched/added/dup/failed——截断与重叠可见）
  watch_forbidden_marked: number; // 命中交易所监管名单的总数（固定拉取 + ⚠事实标记；是否禁买由核验会话按心法整册终审）
  dropped_zt: number;
  dropped_band: number; // 涨幅带粗筛剔除数（当日涨幅 >zdf_max 或 <zdf_min）
  dropped_retreat: number;
  after_elim: number;
  retreat_zero_hit: boolean; // 撤退方向非空但零命中——大概率方向名与标签失配（§7 告警项）
  dropped: { zt: Array<{ code: string; name: string }>; band: Array<{ code: string; name: string }>; retreat: Array<{ code: string; name: string }> };
}

// 拉取交易所重点监管名单（必注入的事实数据——如同持仓快照；失败按空名单处理并告警，标记缺席不算错误）
async function fetchForbidden(): Promise<Set<string>> {
  const codes = new Set<string>();
  try {
    const env = (await market.getKeyWatchStocks()) as Record<string, unknown>;
    if (env.code === 200) {
      for (const row of (env.data ?? []) as Array<{ stock_code?: unknown }>) codes.add(String(row.stock_code ?? ""));
    }
  } catch (e) {
    log("pool", `监管名单拉取失败（按空名单标记处理）: ${e instanceof Error ? e.message : String(e)}`);
  }
  return codes;
}

// 六池拉取 + 监管名单标记（事实注入）+ 配置化剔除（监管 / 已涨停 / 涨幅带 / 撤退方向，开关见 engine-config），未归类行保留
export async function fetchAndEliminate(
  projectRoot: string,
  retreatDirections: string[],
): Promise<{ rows: Candidate[]; stats: ElimStats; cfgWarnings: string[]; cfgSummary: string }> {
  const { cfg, warnings } = loadEngineConfig(projectRoot);
  const [{ merged, poolCounts }, forbidden] = await Promise.all([fetchPools(projectRoot), fetchForbidden()]);
  for (const c of merged.values()) c.watchForbidden = forbidden.has(c.code);
  const retreats = cfg.eliminate.retreat_direction ? retreatDirections.map((s) => s.trim()).filter(Boolean) : [];
  const band = cfg.eliminate.price_band; // 涨幅带粗筛（null=关闭；zdf 为空的候选不剔除，留给会话判定）
  const stats: ElimStats = {
    merged: merged.size,
    pool_counts: poolCounts,
    watch_forbidden_marked: 0,
    dropped_zt: 0,
    dropped_band: 0,
    dropped_retreat: 0,
    after_elim: 0,
    retreat_zero_hit: false,
    dropped: { zt: [], band: [], retreat: [] },
  };
  const kept: Candidate[] = [];
  for (const c of merged.values()) {
    if (c.watchForbidden) stats.watch_forbidden_marked += 1; // 监管名单只标记不剔除——回避判定归核验会话（心法整册终审）
    if (cfg.eliminate.already_limit_up && c.zdf !== null && c.zdf >= ztThreshold(c.code)) {
      stats.dropped_zt += 1;
      stats.dropped.zt.push({ code: c.code, name: c.name });
      continue;
    }
    if (band && c.zdf !== null && (c.zdf > band.zdf_max || c.zdf < band.zdf_min)) {
      stats.dropped_band += 1;
      stats.dropped.band.push({ code: c.code, name: c.name });
      continue;
    }
    if (cfg.eliminate.retreat_direction && c.hotCategories && retreats.some((r) => c.hotCategories.includes(r))) {
      stats.dropped_retreat += 1;
      stats.dropped.retreat.push({ code: c.code, name: c.name });
      continue;
    }
    kept.push(c);
  }
  stats.after_elim = kept.length;
  stats.retreat_zero_hit = retreats.length > 0 && stats.dropped_retreat === 0;
  kept.sort((a, b) => b.mainAmountNum - a.mainAmountNum);
  const cfgSummary = `池 ${cfg.pools.length} 个（${cfg.pools.map((p) => p.label ?? p.method).join("/")}）｜剔除：已涨停=${cfg.eliminate.already_limit_up ? "开" : "关"} 涨幅带=${band ? `${band.zdf_min}~${band.zdf_max}%` : "关"} 撤退方向=${cfg.eliminate.retreat_direction ? "开" : "关"}｜监管名单固定标记（⚠，禁买由核验终审）｜批大小 ${cfg.batch_size}｜批间并发 ${cfg.concurrency}`;
  return { rows: kept, stats, cfgWarnings: warnings, cfgSummary };
}

// 蛇形分批（§2.1 定稿）：按主力净额降序排名后蛇形分发——批间强弱均衡，防同方向强票聚堆被"每批出线 ≤3"截断
export function snakeBatch(rows: Candidate[], batchSize = 20): Candidate[][] {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => b.mainAmountNum - a.mainAmountNum);
  const k = Math.max(1, Math.ceil(sorted.length / batchSize));
  const batches: Candidate[][] = Array.from({ length: k }, () => []);
  sorted.forEach((row, rank) => {
    const rowIdx = Math.floor(rank / k); // 蛇形行号
    const pos = rank % k;
    const idx = rowIdx % 2 === 0 ? pos : k - 1 - pos; // 偶数行正序、奇数行倒序（蛇形回卷）
    batches[idx]!.push(row);
  });
  return batches;
}

// 候选行紧凑表文本（批初选 / 终选会话的每股输入；监管列 = 交易所重点监管名单命中的事实标记，禁买判定归核验会话按心法整册终审；
//   持仓列 = 已持仓事实标记（预格式化字符串由 buy.ts 组装）——已持仓标的再次出手的资格裁决归下游会话按手册补足框架判，代码只给事实）
export function renderPoolRows(rows: Candidate[], holdingMarks?: Map<string, string>): string {
  const lines = ["代码\t名称\t涨幅%\t换手%\t成交额\t主力净额\t热点分类\t池来源\t监管\t持仓"];
  for (const c of rows) {
    lines.push(`${c.code}\t${c.name}\t${c.zdf ?? "-"}\t${c.turnZ}\t${c.amount}\t${c.mainAmount}\t${c.hotCategories || "未归类"}\t${c.pools.join("+")}\t${c.watchForbidden ? "⚠名单内" : "-"}\t${holdingMarks?.get(c.code) ?? "-"}`);
  }
  return lines.join("\n");
}
