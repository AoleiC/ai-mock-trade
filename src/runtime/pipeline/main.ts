#!/usr/bin/env node
// 流水线 runtime 入口（设计文档 §2 / §11；v4.3 起为唯一引擎——classic 已退役）：
//   watch：会话 1 判定 + 卖链 + 买链 + 会话 6 总结 + trace/attention + 轮级墙钟
//   review：机械事实装配（决策档案全文预喂）+ 复盘会话（有界自主）+ 机械骨架兜底（pipeline/review.ts）
// stdout 契约与调度器消费格式一致（summary/mode/usage/wall_ms/engine）；--check 自检（零 LLM）/ --dry 干跑（零 LLM 全链）
import process from "node:process";
import { loadCtx } from "../ctx.ts";
import { runVerdictStage, fetchMarketSource } from "./verdict.ts";
import { runSellStage, type SellDecision, type SellOrderRecord, type PendingOrder, type OrderFact } from "./sell.ts";
import { runBuyChain, type BuyOrderRecord, type CandidateChain } from "./buy.ts";
import { runSummaryStage } from "./summary.ts";
import type { SummaryDigest } from "./summary.ts";
import { runReviewRound } from "./review.ts";
import { RoundTrace, appendAttention } from "./trace.ts";
import { initTranscript, appendTranscript } from "./transcript.ts";
import { join } from "node:path";
import { assembleKit, verdictKitSpec, summaryKitSpec, reviewKitSpec } from "./kit.ts";
import { log } from "../log.ts";
import { exitWith } from "../budget.ts";
import { loadEnv } from "../../../skills/env.ts";
import * as trading from "../../../skills/mock/trading.ts";
import * as market from "../../../skills/mock/market.ts";
import * as report from "../../../skills/mock/report.ts";

// 轮级墙钟（§6/§7）：默认 300s，只截断批次选股；尾部（终选→核验→下单→总结）必走，见下方 TAIL_RESERVE_MS
const DEFAULT_ROUND_WALL_MS = 300_000;
// 尾部必走段时间预留：轮级墙钟只截断批次选股（s3a 循环），终选→核验→下单→总结必走（各段靠自身会话墙钟约束，数值见 buy.ts/summary.ts）。
// 取值 = 尾部现实耗时（实测约 110s：终选 25s + 核验 50s + 终裁 30s + 总结 7s）+ 余量；批次撞线即止、带已出线候选走完尾部。
// 超墙顺延安全：调度器 runPi 串行 await（轮次不重叠），runtime 15 分钟硬杀兜底。
const TAIL_RESERVE_MS = 150_000;
// 首条盘面分析生成时点（总纲 §5.3：约 09:36；此前的盘中轮盘面 LLM 缺位——空仓时无止损对象也无开仓依据，属纯空转）
const PREMARKET_ANALYSIS_TIME = "09:36:00";

// 解析命令行参数（--mode watch / --context 必填；--check 自检；--dry 无 LLM 干跑）
function parseArgs(): { mode?: string; context?: string; check: boolean; dry: boolean; rehearse: boolean } {
  const argv = process.argv.slice(2);
  const out = { mode: undefined as string | undefined, context: undefined as string | undefined, check: false, dry: false, rehearse: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode" && argv[i + 1]) out.mode = argv[++i];
    else if (argv[i] === "--context" && argv[i + 1]) out.context = argv[++i];
    else if (argv[i] === "--check") out.check = true;
    else if (argv[i] === "--dry") out.dry = true;
    else if (argv[i] === "--rehearse") out.rehearse = true;
  }
  return out;
}

// 自检模式（零 LLM）：kit 装配核对（固定件 + 手册整册可读性）+ data 目录可写，供就绪检测与升级后验证
async function runCheck(projectRoot: string): Promise<void> {
  const node = (await market.readMarketNode().catch(() => null)) as Record<string, unknown> | null;
  const nodeWord = node && node.code === 200 ? String(node.effective_node ?? "降温") : "降温";
  const k1 = assembleKit(projectRoot, "s1_verdict(check)", verdictKitSpec(nodeWord));
  const k6 = assembleKit(projectRoot, "s6_summary(check)", summaryKitSpec());
  const kr = assembleKit(projectRoot, "r1_review(check)", reviewKitSpec());
  process.stdout.write(
    `${JSON.stringify({
      check: "ok",
      engine: "pipeline",
      market_node: nodeWord,
      s1_kit: { chars: k1.chars, misses: k1.misses, changed: k1.changedFiles },
      s6_kit: { chars: k6.chars, misses: k6.misses, changed: k6.changedFiles },
      r1_kit: { chars: kr.chars, misses: kr.misses, changed: kr.changedFiles },
    })}\n`,
  );
}

// 解析注入块的机器可读纪律预算节（机械层写入）：在途委托清单 + 当日全部委托事实
//   解析失败按缺位处理（空清单 = 本轮无在途委托，不阻塞）
function parseBudgetOrders(block: string): { pendingOrders: PendingOrder[]; ordersToday: OrderFact[] } {
  const lines = block.split("\n");
  const idx = lines.findIndex((l) => l.startsWith("■ 纪律预算机器可读"));
  if (idx < 0) return { pendingOrders: [], ordersToday: [] };
  const raw = (lines[idx + 1] ?? "").trim();
  if (!raw.startsWith("{")) return { pendingOrders: [], ordersToday: [] };
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const toPending = (o: Record<string, unknown>): PendingOrder => ({
      order_no: String(o.order_no ?? ""),
      side: o.side === "buy" ? ("buy" as const) : ("sell" as const),
      code: String(o.code ?? ""),
      name: String(o.name ?? ""),
      volume: Math.trunc(Number(o.volume ?? 0)),
      price: Number(o.price ?? 0),
      status: Number(o.status ?? -1),
    });
    const pendingOrders = (Array.isArray(obj.pending_orders) ? obj.pending_orders : [])
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
      .map(toPending)
      .filter((o) => o.order_no !== "" && o.code !== "" && o.volume > 0);
    const ordersToday = (Array.isArray(obj.orders_today) ? obj.orders_today : [])
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
      .map((o) => ({
        ...toPending(o),
        deal_volume: Math.trunc(Number(o.deal_volume ?? 0)),
        time: String(o.time ?? ""),
      }))
      .filter((o) => o.code !== "");
    return { pendingOrders, ordersToday };
  } catch {
    return { pendingOrders: [], ordersToday: [] };
  }
}

// 组装事实流水（会话 6 的唯一事实来源：只给结论与事实，不给原始大 JSON）
function buildFacts(opts: {
  ctxTime: string;
  verdict: Record<string, unknown>;
  marketSrc: Awaited<ReturnType<typeof fetchMarketSource>>;
  positions: Array<Record<string, unknown>>;
  sellable: Array<Record<string, unknown>>;
  t1Blocked: Array<Record<string, unknown>>;
  pendingOrders?: PendingOrder[];
  stageLines: string[];
  sellDecisions?: SellDecision[];
  sellOrders?: SellOrderRecord[];
  buyOrders?: BuyOrderRecord[];
  buyBudget?: { orders: number; weights: number[] } | null;
  buyProcess?: string[];
}): string {
  const { verdict, marketSrc, positions, sellable, t1Blocked, stageLines, sellDecisions = [], sellOrders = [], buyOrders = [], buyBudget = null, buyProcess = [], pendingOrders = [] } = opts;
  const gate = (verdict.market_gate ?? {}) as Record<string, unknown>;
  const channels = (verdict.node_channels ?? {}) as Record<string, unknown>;
  const openChannels = Object.entries(channels)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  const lines: string[] = [
    "## 盘面核心（盘面分析快照）",
    `- 大盘温度标签：${marketSrc?.temperatureLabel || "缺位"}｜短线情绪：${marketSrc?.sentimentLabel ?? "该字段为空"}｜情绪资金对齐：${marketSrc?.alignment ?? "该字段为空"}｜当日仓位上限：${marketSrc ? `${marketSrc.positionLimit}%` : "缺位"}｜分析帧时点：${marketSrc?.analyzeTime || "缺位"}`,
    `- 盘面综述：${trunc(marketSrc?.overview ?? "缺位", 300)}`,
    `- 活跃方向：${marketSrc?.activeDirection ?? "无"}｜撤退方向：${(marketSrc?.retreatDirections ?? []).join("、") || "无"}`,
    `- 操作建议：${trunc(marketSrc?.actionAdvice ?? "缺位", 300)}`,
    ...(marketSrc && marketSrc.riskWarnings.length > 0 ? [`- 风险提示：${trunc(marketSrc.riskWarnings.join("；"), 300)}`] : []),
    "## 市场节点（云端唯一权威，market.read_market_node 输出）",
    `- 当前节点：${String(verdict.market_node ?? "缺位")}｜当日开放的通道资格字段：${openChannels.join("、") || "无"}`,
    "## 本轮节点判定（会话 1 富结论）",
    `- 允许新开仓：${String(gate.open_allowed)}｜理由：${trunc(String(gate.open_reason ?? "未注明"), 400)}`,
    `- 单笔降档封顶：${Number(verdict.size_cap_pct ?? 0) > 0 ? `${Number(verdict.size_cap_pct)}%（降档生效，砍量不否决）` : "无降档"}`,
    `- 可买方向：${((verdict.buy_directions ?? []) as unknown[]).map(String).join("、") || "无"}｜撤退方向：${((verdict.retreat_directions ?? []) as unknown[]).map(String).join("、") || "无"}`,
    `- 当日禁项：${((verdict.forbidden ?? []) as unknown[]).map(String).join("；") || "无"}`,
    `- 持仓政策（供卖链核对的条件，非判决）：${JSON.stringify(verdict.holding_policies ?? [])}`,
    `- 判定降级记录：${((verdict.degradation ?? []) as unknown[]).map(String).join("；") || "无"}`,
    "## 持仓",
    `- 共 ${positions.length} 只；可卖 ${sellable.length} 只${sellable.length > 0 ? `（${sellable.map((p) => String(p.stock_name ?? p.stock_code)).join("、")}）` : ""}；今日买入 T+1 不可卖 ${t1Blocked.length} 只${t1Blocked.length > 0 ? `（${t1Blocked.map((p) => String(p.stock_name ?? p.stock_code)).join("、")}）` : ""}`,
    `- 在途委托（未完成）：${pendingOrders.length > 0 ? pendingOrders.map((o) => `${o.side === "buy" ? "买" : "卖"} ${o.name || o.code} ${o.volume}股@${o.price}`).join("；") : "无"}`,
    "## 卖链判定（会话 2 决策与执行结果）",
    ...(sellDecisions.length > 0
      ? sellDecisions.map((d) => `- ${d.code} ${d.action}（${d.trigger}）：${trunc(d.reason, 160)}`)
      : ["- 本轮无卖出决策（无可卖持仓或卖链未执行）"]),
    ...(sellOrders.length > 0 ? sellOrders.map((o) => `- 委托 ${o.code} ${o.volume}股@${o.price} → ${o.status}${o.note ? `（${o.note}）` : ""}`) : []),
    ...(buyBudget ? [`- 当日购买预算：${buyBudget.orders} 笔（权重 ${buyBudget.weights.join("%/") || "-"}%）`] : []),
    ...(buyOrders.length > 0 ? buyOrders.map((o) => `- 买入委托 ${o.code} ${o.volume}股@${o.price}（权重 ${o.weight_pct}%）→ ${o.status}${o.note ? `（${o.note}）` : ""}`) : ["- 本轮无买入委托（禁开仓 / 无 pass 候选 / 未实施）"]),
    "## 选股过程（池漏斗 / 终选与核验名单 / 各段耗时——候选分析必须覆盖）",
    ...(buyProcess.length > 0 ? buyProcess : ["- 未运行"]),
    "## 本轮阶段流水（各阶段结论 / 跳过与降级原因）",
    ...stageLines.map((l) => `- ${l}`),
  ];
  return lines.join("\n");
}

// 选股过程事实（供总结还原"这轮选了什么、为什么不买"）：压缩为 候选漏斗一行 + 终选核验一行 + 下单一行 + 总耗时一行
function buildBuyProcessLines(buy: Awaited<ReturnType<typeof runBuyChain>>): string[] {
  const sec = (ms: number): string => `${Math.round(ms / 1000)}s`;
  if (buy.poolStage.status === "skipped") return [`- 候选池未拉取：${buy.poolStage.reason ?? "未知"}`];
  const funnel = (buy.poolStage.funnel ?? {}) as { merged?: number; after_elim?: number; batches?: number; eliminated?: { zt?: number; band?: number; retreat?: number } };
  const nameByCode = new Map(buy.chains.map((c) => [c.code, c.name]));
  const batchStages = buy.stages.filter((s) => s.id.startsWith("s3a_batch_"));
  const ranBatches = batchStages.filter((s) => s.status !== "skipped").length;
  const cutBatches = batchStages.length - ranBatches;
  const batchWallMs = batchStages.reduce((acc, s) => acc + Number(s.wall_ms ?? 0), 0);
  const emergedCount = buy.chains.filter((c) => c.chain.includes("emerged")).length;
  const s3b = buy.stages.find((s) => s.id === "s3b_final");
  const s4 = buy.stages.find((s) => s.id === "s4_verify");
  const s5 = buy.stages.find((s) => s.id === "s5_execute");
  const shortlist = (s3b?.shortlist ?? []) as string[];
  const budget = (s3b?.budget ?? null) as { orders: number; weights: number[] } | null;
  const lines = [
    `- 候选：六池合并 ${funnel.merged ?? "?"} 只，分批初选出线 ${emergedCount} 只${cutBatches > 0 ? `（完成 ${ranBatches}/${batchStages.length} 批，${cutBatches} 批因时间预算截断）` : ""}`,
  ];
  if (shortlist.length > 0) {
    let verifyTxt = "未核验";
    if (s4 && s4.status !== "skipped") {
      const verdicts = ((s4.verdicts ?? []) as string[]).map((v) => {
        const parts = v.split(":");
        const label = parts[1] === "pass" ? "通过" : parts[1] === "veto" ? "否决" : "异常";
        return `${nameByCode.get(parts[0] ?? "") ?? parts[0]} ${label}（${parts.slice(2).join(":") || "理由未注明"}）`;
      });
      verifyTxt = verdicts.join("；") || "无结论";
    }
    lines.push(`- 终选：${shortlist.map((code) => nameByCode.get(code) ?? code).join("、")}（预算 ${budget?.orders ?? shortlist.length} 笔 ${(budget?.weights ?? []).join("/") || "-"}%）→ 核验：${verifyTxt}`);
  } else {
    lines.push("- 终选：空名单（宁缺勿滥）");
  }
  const submitted = buy.orders.filter((o) => o.status === "submitted");
  if (submitted.length > 0) {
    lines.push(`- 下单：${submitted.map((o) => `买入 ${o.name || o.code} ${o.volume}股@${o.price}`).join("；")}`);
  } else {
    const noOrderReason = s5
      ? (s5.status === "skipped"
        ? ({ no_pass_candidates: "无通过核验标的", budget_zero: "终选预算为 0", no_shortlist: "终选空名单" } as Record<string, string>)[String(s5.reason)] ?? String(s5.reason)
        : (s5.reason ?? "未下单"))
      : shortlist.length === 0 ? "终选空名单" : "无通过核验标的";
    lines.push(`- 下单：未下单——${noOrderReason}`);
  }
  const totalMs = batchWallMs + Number(s3b?.wall_ms ?? 0) + Number(s4?.wall_ms ?? 0) + Number(s5?.wall_ms ?? 0);
  lines.push(`- 选股总耗时：约 ${sec(totalMs)}（批次 ${sec(batchWallMs)}｜终选 ${sec(Number(s3b?.wall_ms ?? 0))}｜核验 ${sec(Number(s4?.wall_ms ?? 0))}）`);
  return lines;
}

// 零 LLM 整轮跳过的统一收尾（休市闸 / 盘前空转闸共用）：trace 阶段 + transcript + stdout 契约，调度器按主动跳过处理（不归档总结）
function skipRound(trace: RoundTrace, stageId: string, skipped: string, reason: string, startedAt: number, projectRoot: string, ctx: { mode: string; trade_date: string }): void {
  const wallMs = Date.now() - startedAt;
  trace.addStage({ id: stageId, status: "skipped", reason });
  trace.setExtra("usage", { sessions: 0, tokens_uncached: 0, tokens_cached: 0 });
  trace.finish(projectRoot, wallMs);
  appendTranscript("round_end", { wall_ms: wallMs, skipped, reason });
  process.stdout.write(
    `${JSON.stringify({
      summary: "",
      mode: ctx.mode,
      trade_date: ctx.trade_date,
      skipped,
      reason,
      usage: { main: { turns: 0, tokens: 0 }, sub_tokens_total: 0 },
      turns: 0,
      subagent_calls: 0,
      wall_ms: wallMs,
      engine: "pipeline",
    })}\n`,
  );
}

// 主流程
async function main(): Promise<void> {
  const args = parseArgs();
  const projectRoot = process.cwd();
  const startedAt = Date.now();
  loadEnv(projectRoot);

  if (args.check) {
    await runCheck(projectRoot);
    return;
  }
  if (!args.mode || !args.context || (args.mode !== "watch" && args.mode !== "review")) {
    throw new Error("用法: node src/runtime/pipeline/main.ts --mode watch|review --context data/tmp/ctx-{ts}.json [--check|--dry]");
  }
  const ctx = await loadCtx(args.context);
  const dry = args.dry;
  // 演练模式（npm run watch:dryrun / review:dryrun）：LLM 全链真实运行，零交易、零上报、不归档、不落账；买链强制开放（不被"不开仓"卡住，便于验证选股效果）
  const rehearse = args.rehearse;
  // 复盘轮：独立流水线（事实装配 + 复盘会话 + 骨架兜底），自带 trace/transcript/stdout 收尾
  if (ctx.mode === "review") {
    await runReviewRound(projectRoot, ctx, { dry, rehearse });
    return;
  }
  const roundWallMs = Number(process.env.PIPELINE_ROUND_WALL_MS ?? 0) > 0 ? Number(process.env.PIPELINE_ROUND_WALL_MS) : DEFAULT_ROUND_WALL_MS;
  const trace = new RoundTrace(ctx.current_time, "watch");
  // 全量执行留痕：sessions-{日期-时间}.jsonl 与 run log 同目录（随日志保留期清理）——LLM 完整收发 / 机械步骤 / 交易信封
  const compact = `${ctx.trade_date.replace(/-/g, "")}-${ctx.current_time.replace(/:/g, "")}`;
  initTranscript(join(projectRoot, "data", "watch_scheduler_logs", `sessions-${compact}.jsonl`));
  appendTranscript("round_start", { mode: args.mode, dry, trade_date: ctx.trade_date, current_time: ctx.current_time, ctx_block: ctx.block });
  log("pipeline", `轮次开始 ${ctx.trade_date} ${ctx.current_time}${dry ? "（dry 干跑，零 LLM）" : ""}`);

  // ── 休市闸（防御性）：非交易日 / 非交易时段整轮跳过——不烧 LLM、不下单、不归档总结
  //    （调度器守护路径本按时段触发，此闸覆盖 --once 手动/诊断触发与未来新增触发口；
  //    复盘轮已在上方独立分支返回，此闸天然只对盯盘轮生效）
  if (process.env.PIPELINE_FORCE_ROUND !== "1") {
    try {
      const env = (await market.getSummary()) as Record<string, unknown>;
      const d = (env.data ?? env) as Record<string, unknown>;
      if (d.is_trading_day !== true || d.is_trading_time !== true) {
        const reason = `休市（${String(d.stage ?? "非交易时段")}，服务端时间 ${String(d.datetime ?? "")}）`;
        log("pipeline", `跳过本轮盯盘：${reason}——零 LLM、零下单；强制执行用 PIPELINE_FORCE_ROUND=1`);
        skipRound(trace, "s0_market_hours", "market_closed", reason, startedAt, projectRoot, ctx);
        return;
      }
    } catch (e) {
      log("pipeline", `交易时段探测失败（按继续执行处理）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── 持仓快照（跳过分支判定 + 卖链备料 + 摘要事实）
  let positions: Array<Record<string, unknown>> = [];
  let positionsOk = true;
  try {
    const env = (await trading.getPositions()) as Record<string, unknown>;
    positions = env.code === 200 ? ((env.data ?? []) as Array<Record<string, unknown>>) : ((positionsOk = false), []);
  } catch (e) {
    positionsOk = false;
    log("pipeline", `持仓快照拉取失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  const sellable = positions.filter((p) => Number(p.available_volume ?? 0) > 0);
  const t1Blocked = positions.filter((p) => Number(p.available_volume ?? 0) <= 0);
  // 在途委托与当日委托事实（机械层注入的机器可读清单）：卖链据此扣减在途占用、重复卖出先撤单再下，
  //   并自见"今日已卖/已买"保持自己的节奏
  const { pendingOrders, ordersToday } = parseBudgetOrders(ctx.block);

  // ── 盘前空转闸（总纲 §5.3：首条盘面分析约 09:36 生成）：分析缺位窗口 + 空仓 → 整轮零 LLM 跳过
  //    有持仓不跳（止损止盈只依赖持仓分时，机械层照拉，不依赖盘面 LLM）；持仓拉取失败不跳（fail-safe 照常执行）；
  //    current_time 允许 HH:MM 形式（ctx 校验正则秒位可选），归一化为 HH:MM:SS 再比较
  const currentHMS = ctx.current_time.length === 5 ? `${ctx.current_time}:00` : ctx.current_time;
  if (process.env.PIPELINE_FORCE_ROUND !== "1" && positionsOk && positions.length === 0 && currentHMS < PREMARKET_ANALYSIS_TIME) {
    const reason = `盘前空转（${currentHMS} 早于首条盘面分析生成时点 ${PREMARKET_ANALYSIS_TIME}，且空仓——止损无对象、开仓判定无数据）`;
    log("pipeline", `跳过本轮盯盘：${reason}——零 LLM、零下单`);
    skipRound(trace, "s0_premarket_empty", "premarket_empty", reason, startedAt, projectRoot, ctx);
    return;
  }

  // ── 会话 1 · 节点判定（含传递字段对账；先于卖链——卖链消费其持仓政策与撤退方向）
  const warnKitMisses = (stage: { id: string; [key: string]: unknown }): void => {
    const misses = (stage.kit_misses as string[] | undefined) ?? [];
    if (misses.length > 0) appendAttention(projectRoot, "WARN", `kit 手册读取失败（已占位注入，相关判定按缺位处理）: ${misses.join("; ")}`);
  };
  const s1 = await runVerdictStage(projectRoot, ctx, { dry });
  trace.addStage(s1.stage);
  warnKitMisses(s1.stage);
  const verdict = s1.verdict;

  // ── 会话 2 · 卖出纪律（§2：可卖量全 0 → 跳过；固定模板备料 + 政策核对 + 代码钳制执行）
  let sellResult: Awaited<ReturnType<typeof runSellStage>> | null = null;
  if (!positionsOk) {
    trace.addStage({ id: "s2_sell", status: "degraded", reason: "持仓快照拉取失败，卖链无法判定" });
  } else if (sellable.length === 0) {
    trace.addStage({ id: "s2_sell", status: "skipped", reason: positions.length === 0 ? "no_holdings" : "no_sellable_holdings" });
  } else {
    sellResult = await runSellStage(projectRoot, ctx, verdict, positions, {
      dry,
      noTrade: rehearse || process.env.PIPELINE_NO_TRADE === "1",
      pendingOrders,
      ordersToday,
    });
    trace.addStage(sellResult.stage);
    warnKitMisses(sellResult.stage);
  }

  // ── 买链（§2：禁开仓 → 跳过；开仓闸完全由会话 1 富结论承载——代码不持行为表）
  let buyOrders: BuyOrderRecord[] = [];
  let buyChains: CandidateChain[] = [];
  let buyTokensTotal = 0;
  let buyLlmSessions = 0;
  let buyBudget: { orders: number; weights: number[] } | null = null;
  let buyChainExhausted = false;
  const allOrders: unknown[] = [...(sellResult?.orders ?? [])];
  const gate = (verdict.market_gate ?? {}) as Record<string, unknown>;
  // 演练覆写：保留真实判定原文，仅强制开放买链入口（交易 / 上报 / 台账 / 归档仍全部关闭）
  if (rehearse && gate.open_allowed !== true) {
    gate.open_allowed = true;
    gate.open_reason = `演练模式：真实判定为不开仓（${String(gate.open_reason ?? "未注明")}），为验证选股链路强制开放；本轮零交易零上报`;
  }
  let buyProcessLines: string[] = [];
  // 买链入口：开仓与否完全由会话 1 按用户手册逐帧裁决（代码不持行为表、不硬控额度）
  if (gate.open_allowed !== true) {
    trace.addStage({ id: "s3_pool", status: "skipped", reason: `open_not_allowed: ${String(gate.open_reason ?? "未注明")}` });
    buyProcessLines = [`- 买链未启动：开仓闸未开放（${String(gate.open_reason ?? "未注明")}）`];
  } else if (Date.now() - startedAt > roundWallMs - TAIL_RESERVE_MS) {
    // 判定+卖链已吃掉尾部预留（剩余时间不够 至少一批 + 尾部必走段）——买链整段跳过，总结保底
    trace.addStage({ id: "s3_pool", status: "skipped", reason: "round_budget（判定+卖链已用尽轮级预算，买链跳级）" });
    appendAttention(projectRoot, "WARN", "[买链] 进入买链前轮级预算已耗尽，整段跳级——连续出现请检查 s1/s2 会话墙钟配置");
    buyProcessLines = ["- 买链未启动：判定与卖链已用尽轮级预算"];
  } else {
    const soldVolumeByCode = new Map<string, number>();
    for (const o of sellResult?.orders ?? []) {
      if (o.status === "submitted") soldVolumeByCode.set(o.code, (soldVolumeByCode.get(o.code) ?? 0) + o.volume);
    }
    const buy = await runBuyChain(projectRoot, ctx, verdict, positions, soldVolumeByCode, {
      dry,
      noTrade: rehearse || process.env.PIPELINE_NO_TRADE === "1",
      rehearse,
      deadline: startedAt + roundWallMs - TAIL_RESERVE_MS, // 批次选股必须为尾部必走段让位（撞线即止批次，尾部照走）
    });
    trace.addStage(buy.poolStage);
    for (const st of buy.stages) trace.addStage(st);
    if (buy.poolStage.retreat_zero_hit === true) {
      appendAttention(projectRoot, "WARN", "[买链] 撤退方向非空但剔除零命中——方向名与 hot_categories 标签疑似失配，请核对命名");
    }
    buyOrders = buy.orders;
    buyChains = buy.chains;
    buyProcessLines = buildBuyProcessLines(buy);
    if (buy.chains.length > 0) trace.setCandidates(buy.chains as unknown[]);
    allOrders.push(...buy.orders);
    if (allOrders.length > 0) trace.setOrders(allOrders);
    buyTokensTotal = buy.tokens;
    buyLlmSessions = buy.llmSessions;
    buyBudget = buy.budget;
    if (buy.budgetExhausted === true) buyChainExhausted = true;
  }

  // ── 轮级墙钟语义：墙钟只截断批次选股（buy 链内 deadline，事实经 buyChainExhausted 上抛）；
  // 终选→核验→下单→总结必走，超墙顺延由调度器串行触发兜底——不再存在"直接进入总结阶段"的跳级路径
  const budgetTruncated = buyChainExhausted;

  // ── 会话 6 · 盯盘总结（LLM 失败时代码兜底，归档必产出）
  const ops: string[] = [];
  for (const o of sellResult?.orders ?? []) {
    if (o.status === "submitted") ops.push(`卖出${o.name || o.code} ${o.volume}股`);
    else if (o.status === "failed") ops.push(`卖出${o.name || o.code}失败`);
  }
  for (const o of buyOrders) {
    if (o.status === "submitted") ops.push(`买入${o.name || o.code} ${o.volume}股`);
    else if (o.status === "failed") ops.push(`买入${o.name || o.code}失败`);
  }
  const digest: SummaryDigest = {
    timeHM: ctx.current_time.slice(0, 5),
    timeHMS: ctx.current_time,
    regimeLabel: s1.nodeLabel,
    sentimentLabel: s1.marketSrc?.sentimentLabel ?? "该字段为空",
    activeDirection: s1.marketSrc?.activeDirection ?? "无",
    // 仓位上限 = 当日执行上限（会话 1 按用户手册裁决的声明值，买链钳制用的就是它），缺位才退回盘面建议值
    positionLimitPct: Number(gate.position_limit ?? 0) > 0 ? `${Number(gate.position_limit)}%` : s1.marketSrc ? `${s1.marketSrc.positionLimit}%` : "缺位",
    operations: ops.length > 0 ? ops : ["无操作"],
    holdingCount: positions.length,
  };
  const factStageLines = trace.stagesSnapshot().map((s) => `${s.id}=${s.status}${s.reason ? `（${s.reason}）` : ""}`);
  const factsText = `${rehearse ? "【本轮为演练模式：LLM 全链真实运行，零交易、零上报、不归档——综合决策需注明演练】\n" : ""}${buildFacts({
    ctxTime: ctx.current_time,
    verdict,
    marketSrc: s1.marketSrc,
    positions,
    sellable,
    t1Blocked,
    pendingOrders,
    stageLines: factStageLines,
    sellDecisions: sellResult?.decisions ?? [],
    sellOrders: sellResult?.orders ?? [],
    buyOrders,
    buyBudget,
    buyProcess: buyProcessLines,
  })}`;
  const s6 = await runSummaryStage(projectRoot, ctx, factsText, digest, { dry });
  trace.addStage(s6.stage);
  warnKitMisses(s6.stage);

  // ── 控制台回显总结全文（stderr 随调度器镜像到终端与 run log；正文自带「盯盘总结」标记，直接原样输出）
  process.stderr.write(`${s6.summary}\n\n`);

  // ── 上报（尽力而为，失败忽略不重试——§九；演练模式不上报）
  if (!rehearse) {
    try {
      await report.submitSummary("watch", s6.summary);
    } catch (e) {
      log("pipeline", `总结上报失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── trace 收尾 + 结果 JSON（stdout 契约与调度器消费格式一致）
  const llmSessions = (dry ? 0 : 1) + (sellResult?.llmRan === true ? 1 : 0) + (dry ? 0 : 1) + buyLlmSessions;
  const tokensTotal = Number(s1.stage.tokens ?? 0) + Number(sellResult?.stage.tokens ?? 0) + Number(s6.stage.tokens ?? 0) + buyTokensTotal;
  // 双口径：阶段 tokens 为总量（含缓存命中部分）；cached 由各阶段 cached_tokens 汇总——供应商未上报缓存时恒 0、uncached 即总量
  const cachedTotal = trace.stagesSnapshot().reduce((acc, s) => acc + Number(s.cached_tokens ?? 0), 0);
  trace.setExtra("usage", { sessions: llmSessions, tokens_uncached: tokensTotal - cachedTotal, tokens_cached: cachedTotal });
  trace.finish(projectRoot, Date.now() - startedAt);
  const summary = s6.summary;
  appendTranscript("round_end", {
    wall_ms: Date.now() - startedAt,
    stages: trace.stagesSnapshot().map((s) => ({ id: s.id, status: s.status, ...(s.reason ? { reason: s.reason } : {}) })),
    orders: allOrders,
    summary,
  });

  const fatal = !summary.includes("盯盘总结") ? "总结缺少盯盘总结标记（兜底总结也未含标记，异常）" : null;
  if (fatal) process.stderr.write(`[pipeline fatal] ${fatal}\n`);
  process.stdout.write(
    `${JSON.stringify({
      summary,
      mode: ctx.mode,
      trade_date: ctx.trade_date,
      usage: { main: { turns: llmSessions, tokens: tokensTotal }, sub_tokens_total: 0 },
      turns: llmSessions,
      subagent_calls: 0,
      wall_ms: Date.now() - startedAt,
      budget_truncated: budgetTruncated,
      engine: "pipeline",
      ...(rehearse ? { rehearse: true } : {}),
      ...(fatal ? { error: fatal } : {}),
    })}\n`,
  );
  if (fatal) process.exitCode = 1;
}

// 入口：致命错误走 exitWith（stderr 留痕 + stdout 单行错误 JSON，调度器按 cli_error 处理）
main().catch(exitWith);
