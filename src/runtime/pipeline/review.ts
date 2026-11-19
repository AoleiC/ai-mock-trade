// 复盘轮（--mode review，v4.3）：机械事实装配 + 单复盘会话（有界自主）+ 代码兜底骨架
// 事实来源：ctx.block（buildReviewContext：服务端权威事实——委托成交 / 持仓 / 账户 / 盘面摘要 / 状态机 + 台账语义标注层）
//          + data/watch-summary-{date}.md 全文机械预喂（决策档案——复盘"当时怎么想"的唯一权威源，代码预喂消灭 read_file 依赖）
// 兜底：LLM 失败 → 机械骨架总结（账户盈亏 + 当日委托清单 + 留痕说明）——复盘归档必产出（与盯盘会话 6 同纪律）
// stdout 契约与盯盘轮一致（mode=review），调度器零改动消费
import { readFileSync } from "node:fs";
import { attentionPath } from "./trace.ts";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { assembleKit, reviewKitSpec } from "./kit.ts";
import { runToolTextSession } from "./llm.ts";
import { RoundTrace, appendAttention, type StageRec } from "./trace.ts";
import { initTranscript, appendTranscript } from "./transcript.ts";
import { makeReadFileTool } from "../tools/fs.ts";
import { makeSdkTool } from "../tools/sdk.ts";
import { log } from "../log.ts";
import type { WatchCtx } from "../ctx.ts";
import * as trading from "../../../skills/mock/trading.ts";
import * as report from "../../../skills/mock/report.ts";

// 复盘会话墙钟（单会话；复盘 21:00 触发无后续轮竞争，给足分析时间）
const REVIEW_WALL_MS = 300_000;

// 复盘会话系统指令（kit 预喂手册知识；事实在 user 消息）
function reviewInstruction(tradeDate: string): string {
  return `# 阶段任务（复盘会话）

你是柚子 AI 的复盘器官。基于用户消息注入的服务端权威事实（当日委托成交 / 持仓 / 账户 / 盘面摘要 / 市场节点 / 台账语义标注）与当日盯盘总结时间线全文，按 kit 中的复盘输出规范产出复盘总结。

## 复盘纪律
- 旁观者视角，只覆盖"今日"：不做推演、不做选股、节点判定只读引用云端返回值，无次日计划板块
- 核心四问：买卖点是否正确正常？行情好时为何一直不开仓？行情不好时为何开仓？仓位是否合理？
- 合规检查口径：总仓位对照**各笔出手时点帧**的仓位上限（日内上限跨帧摆动，同时报出手时点与收盘两值，禁止拿收盘帧给盘中出手定性）；单只 / 同方向 / 已撤退方向红线
- 执行计量按 kit 复盘手册的输出规范与执行计量细则逐项核对（资格日履约 / channel 转化 / 踏空计量 / 试错信息价值 / 否决-买入对照）
- 系统执行异常：用户消息【系统执行留痕】非空时，在【操作反思】后追加【系统执行异常】小节——大白话归纳哪里超时/降级/告警、是否疑似代码或配置缺陷、建议人工核查什么；留痕为空则省略本小节
- 非 pipeline 轮次：用户消息【非 pipeline 轮次标注】列出的轮次不在调度器 trace 中，属 pipeline 之外的轮次（如第三方自驱路径追加，总纲 §3.1.3）——复盘时只作补充事实参考，不纳入系统执行纪律与合规归因；但这些轮次时段若有实际委托成交，合规检查照常覆盖
- 配置漂移对照（常规检查项）：对照用户手册（read_file 按需读心法 / 战法 / 核心层中关于选股来源与剔除行为的要求）与用户消息【当日引擎配置快照】——两者不一致（如手册允许的形态被配置剔除、手册要求的选股来源不在池清单）时，在【系统执行异常】小节明确指出"配置疑似未随策略更新"并给出应改哪一项；一致则不提
- 大白话红线：写给人看——禁止代码字段名、条款编号、数学比较式与符号链

## 自主补数（可选，预喂为主）

当日事实与决策档案已全量预喂。仅当复盘必需的证据缺位时（如情绪轨迹需历史指标、板块需当日热点榜），可用工具补数：\`read_file\` 读 memory/ 手册与当日 watch-summary；\`sdk_call\` 调只读行情 / 委托 / 市场节点接口。轮次与墙钟有限——先看预喂内容再补数，禁止漫游式取数。

## 输出格式

以「========== 复盘总结 ${tradeDate} ==========」标记起头（日期逐字用注入的交易日），后接 3 个板块（【当日盈亏】【情绪演变】【操作反思】）与一行摘要行（\`[柚子 AI] 复盘 | 盈亏:... | 反思:...\`），完整细则见 kit。`;
}

// 复盘工具面：当日 watch-summary 白名单 read_file + 只读行情/委托/状态机 sdk
function reviewTools(projectRoot: string, ctx: WatchCtx): ToolDefinition[] {
  return [
    makeReadFileTool(projectRoot, "review", ctx.trade_date),
    makeSdkTool(projectRoot, [
      "market.get_intraday_analysis",
      "market.get_key_watch_stocks",
      "market.get_hot_spot_list",
      "market.get_top_hot_spots",
      "market.get_stock_info",
      "market.get_daily_k_data",
      "market.get_stock_trendline",
      "market.get_stock_minute_trendline",
      "market.get_hot_spot_rotation",
      "market.get_daily_indicators_history",
      "market.get_summary",
      "market.get_daily_summary",
      "market.get_indicator_trendline",
      "market.get_consecutive_board_ladder",
      "market.read_market_node",
      "market.get_market_node_series",
      "trading.get_orders",
      "trading.get_positions",
      "trading.get_account",
      "trading.get_stock_price",
    ]),
  ];
}

// 收集当日系统执行留痕（attention 告警清单 + trace 降级/预算截断轮次）——复盘【系统执行异常】小节的事实输入
function collectSystemAnomalies(projectRoot: string, tradeDate: string): { text: string; count: number } {
  const parts: string[] = [];
  try {
    const att = readFileSync(attentionPath(projectRoot, tradeDate), "utf-8").trim();
    if (att) parts.push(`当日 attention 告警清单：\n${att}`);
  } catch {
    /* attention 文件不存在 = 当日无告警，正常 */
  }
  try {
    const traceLines = readFileSync(join(projectRoot, "data", `pipeline-trace-${tradeDate}.jsonl`), "utf-8").split("\n").filter(Boolean);
    const degraded: string[] = [];
    for (const line of traceLines) {
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        const stages = (rec.stages ?? []) as Array<Record<string, unknown>>;
        for (const st of stages) {
          if (st.status === "degraded") degraded.push(`${String(rec.time ?? "?")} ${String(st.id)}: ${String(st.reason ?? "未注明")}`);
        }
        if (rec.budget_truncated === true) degraded.push(`${String(rec.time ?? "?")} 轮级预算截断（budget_truncated）`);
      } catch {
        /* 单行损坏跳过 */
      }
    }
    if (degraded.length > 0) parts.push(`当日降级/截断记录（trace）：\n${degraded.map((d) => `- ${d}`).join("\n")}`);
  } catch {
    /* trace 文件不存在（当日无盯盘轮） */
  }
  const count = parts.length > 0 ? parts.join("\n").split("\n").filter((l) => l.startsWith("- ") || l.includes("：") || l.includes("attention")).length : 0;
  return { text: parts.join("\n\n"), count: parts.length };
}

// 提取当日实际生效的引擎配置快照（trace 里最后一次 s3_pool 的 engine_config——复盘对照策略手册识别"改了手册忘改配置"漂移）
function collectEngineConfigSnapshot(projectRoot: string, tradeDate: string): string {
  try {
    const traceLines = readFileSync(join(projectRoot, "data", `pipeline-trace-${tradeDate}.jsonl`), "utf-8").split("\n").filter(Boolean);
    let snapshot = "";
    for (const line of traceLines) {
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        for (const st of (rec.stages ?? []) as Array<Record<string, unknown>>) {
          if (st.id === "s3_pool" && typeof st.engine_config === "string") snapshot = st.engine_config;
        }
      } catch {
        /* 单行损坏跳过 */
      }
    }
    return snapshot;
  } catch {
    return "";
  }
}

// 机械对比 watch-summary 总结标记与 pipeline trace 轮次：不在 trace 中的盯盘轮 = 第三方自驱路径追加（AGENTS.md §3.1.3），
//   复盘预喂时标注来源，防复盘把第三方轮误当系统判定做纪律归因
export function collectExternalRounds(projectRoot: string, tradeDate: string): string[] {
  let summary = "";
  try {
    summary = readFileSync(join(projectRoot, "data", `watch-summary-${tradeDate}.md`), "utf-8");
  } catch {
    return [];
  }
  // 提取总结标记时间并归一化为 HH:MM:SS（容忍第三方轮 H:M / HH:MM 简写）
  const marked = new Set<string>();
  for (const m of summary.matchAll(/========== 盯盘总结 (\d{1,2}:\d{2}(?::\d{2})?) ==========/g)) {
    const parts = m[1]!.split(":").map((p) => p.padStart(2, "0"));
    marked.add(`${parts[0]}:${parts[1]}:${parts[2] ?? "00"}`);
  }
  if (marked.size === 0) return [];
  try {
    const traceLines = readFileSync(join(projectRoot, "data", `pipeline-trace-${tradeDate}.jsonl`), "utf-8").split("\n").filter(Boolean);
    for (const line of traceLines) {
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        if (rec.mode === "watch") marked.delete(String(rec.round));
      } catch {
        /* 单行损坏跳过 */
      }
    }
  } catch (e) {
    // trace 文件不存在 = 当日无任何 pipeline 盯盘轮，watch-summary 全部轮次均为第三方追加，照常标注；
    //   其他读取异常（损坏 / IO）无法权威核对，宁缺勿误标——返回空，复盘按原时间线处理
    if (!(e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT")) return [];
  }
  return [...marked].sort();
}

// 机械骨架兜底总结：账户盈亏 + 当日委托清单 + 留痕说明（LLM 失败时归档必产出）
async function buildSkeletonSummary(projectRoot: string, ctx: WatchCtx, reason: string): Promise<string> {
  const lines: string[] = [`========== 复盘总结 ${ctx.trade_date} ==========`, "", "【当日盈亏】"];
  try {
    const env = (await trading.getAccount()) as Record<string, unknown>;
    const d = (env.data ?? {}) as Record<string, unknown>;
    lines.push(
      `总资产 ${Number(d.total_amount ?? 0)}｜可用 ${Number(d.available_amount ?? 0)}｜持仓市值 ${Number(d.market_value ?? 0)}｜今日盈亏 ${Number(d.today_profit ?? d.profit_today ?? 0)}（账户事实）`,
    );
  } catch (e) {
    lines.push(`账户拉取失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const env = (await trading.getOrders()) as Record<string, unknown>;
    const rows = (env.data ?? []) as Array<Record<string, unknown>>;
    lines.push(
      rows.length === 0
        ? "今日无交易"
        : `当日委托 ${rows.length} 笔：${rows.map((o) => `${o.order_type === 1 ? "买" : "卖"}${String(o.stock_name ?? o.stock_code)} 成交${Number(o.deal_volume ?? 0)}股@${Number(o.deal_price ?? 0)}`).join("；")}`,
    );
  } catch {
    lines.push("当日委托拉取失败");
  }
  lines.push("", "【情绪演变】（复盘会话失败，骨架留痕——无当日轨迹分析）", "", `【操作反思】复盘会话失败（${reason}），本总结为机械骨架兜底；问题已记 attention，请人工核查当日复盘。`);
  const anomalies = collectSystemAnomalies(projectRoot, ctx.trade_date);
  const engineCfgSnapshot = collectEngineConfigSnapshot(projectRoot, ctx.trade_date);
  if (anomalies.count > 0) lines.push("", "【系统执行异常】", anomalies.text);
  lines.push("", `[柚子 AI] 复盘 | 盈亏:见上 | 反思:骨架兜底（会话失败）`);
  return lines.join("\n");
}

// 复盘轮主流程：事实装配 → 会话 → 兜底 → 上报 → trace → stdout 结果 JSON
export async function runReviewRound(projectRoot: string, ctx: WatchCtx, opts: { dry?: boolean; rehearse?: boolean } = {}): Promise<void> {
  const startedAt = Date.now();
  const dry = opts.dry === true;
  const trace = new RoundTrace(ctx.current_time, "review");
  const compact = `${ctx.trade_date.replace(/-/g, "")}-${ctx.current_time.replace(/:/g, "")}`;
  initTranscript(join(projectRoot, "data", "watch_scheduler_logs", `sessions-${compact}.jsonl`));
  appendTranscript("round_start", { mode: "review", dry, trade_date: ctx.trade_date, current_time: ctx.current_time, ctx_block: ctx.block });
  log("pipeline", `复盘轮开始 ${ctx.trade_date} ${ctx.current_time}${dry ? "（dry 干跑，零 LLM）" : ""}`);

  // ── 事实装配（代码）：决策档案全文机械预喂
  let watchSummary = "";
  let summaryMissing = false;
  try {
    watchSummary = readFileSync(join(projectRoot, "data", `watch-summary-${ctx.trade_date}.md`), "utf-8");
  } catch {
    summaryMissing = true;
    appendAttention(projectRoot, "WARN", `[review] 决策档案缺失: data/watch-summary-${ctx.trade_date}.md（复盘输入不完整，已在总结留痕）`);
  }
  const anomalies = collectSystemAnomalies(projectRoot, ctx.trade_date);
  const engineCfgSnapshot = collectEngineConfigSnapshot(projectRoot, ctx.trade_date);
  const externalRounds = collectExternalRounds(projectRoot, ctx.trade_date);
  if (externalRounds.length > 0) {
    appendAttention(projectRoot, "INFO", `[review] 识别到 ${externalRounds.length} 个非 pipeline 盯盘轮次（pipeline 之外追加，已在复盘预喂标注）: ${externalRounds.join("、")}`);
  }
  if (anomalies.count > 0) {
    appendAttention(projectRoot, "WARN", `[review] 当日存在 ${anomalies.count} 组系统执行异常留痕，已在复盘总结【系统执行异常】小节呈现——持续出现的异常（连日超时/同一阶段反复降级）通常是代码或配置问题，请人工核查`);
  }
  const factsStage: StageRec = {
    id: "r0_facts",
    status: summaryMissing ? "degraded" : "ok",
    ...(summaryMissing ? { reason: "watch-summary 缺失（决策档案缺位）" } : {}),
    ...(!summaryMissing ? { summary_chars: watchSummary.length } : {}),
  };
  trace.addStage(factsStage);

  // ── 复盘会话（有界自主文本会话）
  let summary = "";
  let budgetTruncated = false;  let sessionTokens = 0;  let sessionCached = 0;
  let llmSessions = 0;
  const kit = assembleKit(projectRoot, "r1_review", reviewKitSpec());
  if (kit.misses.length > 0) appendAttention(projectRoot, "WARN", `kit 手册读取失败（已占位注入）: ${kit.misses.join("; ")}`);
  if (dry) {
    trace.addStage({ id: "r1_review", status: "degraded", reason: "dry 模式：LLM 未调用", wall_ms: 0, tokens: 0 });
    summary = await buildSkeletonSummary(projectRoot, ctx, "dry 模式未调用 LLM");
  } else {
    const userMessage = [
      `【当前时间】${ctx.trade_date} ${ctx.current_time}`,
      "",
      "【机械层注入块（服务端权威事实 + 台账语义标注）】",
      ctx.block || "（注入块缺位——按缺位处理，可用工具补数）",
      "",
      "【当日盯盘总结时间线（决策档案全文——复盘「当时怎么想」的唯一权威源）】",
      summaryMissing ? `（data/watch-summary-${ctx.trade_date}.md 缺失——盯盘总结缺位，复盘输入不完整，须在总结中留痕说明）` : watchSummary,
      "",
      "【系统执行留痕（代码维护的事实——attention 告警与降级/超时记录）】",
      anomalies.count > 0 ? anomalies.text : "（当日无 attention 告警、无降级/预算截断记录）",
      "",
      "【非 pipeline 轮次标注（机械对比 trace——来源识别，防误归因）】",
      externalRounds.length > 0
        ? `时间线中以下盯盘总结轮次不在调度器 pipeline trace 中，属 pipeline 之外的轮次（如第三方自驱路径追加，总纲 §3.1.3）：${externalRounds.join("、")}。这些轮次只作补充事实参考，不纳入系统执行纪律与合规归因；其时段若有实际委托成交，合规检查照常覆盖。`
        : "（时间线全部盯盘轮次均有 pipeline trace 对应，无 pipeline 之外的追加轮）",
      "",
      "【当日引擎配置快照（选股来源与剔除行为的实际生效值——机械提取，与手册是否一致由你判断）】",
      engineCfgSnapshot || "（当日未触发候选池阶段，无配置快照）",
    ].join("\n");
    const r = await runToolTextSession({
      projectRoot,
      systemPrompt: `${kit.text}\n\n---\n\n${reviewInstruction(ctx.trade_date)}`,
      userMessage,
      wallMs: REVIEW_WALL_MS,
      stageId: "r1_review",
      tools: reviewTools(projectRoot, ctx),
      maxTurns: 10,
      tokenLimit: 500_000,
    });
    llmSessions = 1;
    sessionTokens = r.tokens;
    sessionCached = r.cachedTokens ?? 0;
    budgetTruncated = r.truncated;
    const okText = r.ok && r.text.includes("复盘总结") ? r.text : "";
    const stage: StageRec = {
      id: "r1_review",
      status: okText ? "ok" : "degraded",
      wall_ms: r.ms,
      tokens: r.tokens,
      cached_tokens: r.cachedTokens ?? 0,
      tool_calls: r.toolCalls,
      ...(!okText ? { reason: `复盘会话失败（${r.error ?? "输出缺少复盘总结标记"}）——机械骨架兜底` } : {}),
    };
    trace.addStage(stage);
    if (okText) {
      summary = okText;
      log("review", `复盘总结已产出（${okText.length} 字符，工具调用 ${r.toolCalls} 次）`);
    } else {
      summary = await buildSkeletonSummary(projectRoot, ctx, r.error ?? "输出缺少复盘总结标记");
      appendAttention(projectRoot, "ERROR", `[review] 复盘会话失败，机械骨架兜底: ${r.error ?? "输出缺少复盘总结标记"}`);
      log("review", `复盘会话失败，骨架兜底（${r.error ?? "输出缺少复盘总结标记"}）`);
    }
  }

  // ── 上报（尽力而为，失败忽略不重试；演练模式不上报）
  if (!opts.rehearse) {
    try {
      await report.submitSummary("review", summary);
    } catch (e) {
      log("review", `总结上报失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── trace 收尾 + stdout 结果 JSON（契约与盯盘轮一致）
  trace.setExtra("usage", { sessions: llmSessions, tokens_uncached: sessionTokens - sessionCached, tokens_cached: sessionCached });
  trace.finish(projectRoot, Date.now() - startedAt);
  appendTranscript("round_end", { wall_ms: Date.now() - startedAt, summary });
  const fatal = !summary.includes("复盘总结") ? "兜底总结也未含复盘总结标记（异常）" : null;
  if (fatal) process.stderr.write(`[pipeline fatal] ${fatal}\n`);
  process.stdout.write(
    `${JSON.stringify({
      summary,
      mode: "review",
      trade_date: ctx.trade_date,
      usage: { main: { turns: llmSessions, tokens: sessionTokens }, sub_tokens_total: 0 },
      turns: llmSessions,
      subagent_calls: 0,
      wall_ms: Date.now() - startedAt,
      budget_truncated: budgetTruncated,
      engine: "pipeline",
      ...(opts.rehearse ? { rehearse: true } : {}),
      ...(fatal ? { error: fatal } : {}),
    })}\n`,
  );
  if (fatal) process.exitCode = 1;
}
