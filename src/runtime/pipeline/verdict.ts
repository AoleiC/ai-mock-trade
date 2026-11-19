// 会话 1 · 节点判定（设计文档 §2 / §3.1）：注入块（裁持仓复核节）+ 判定 kit（字段纪律固定件 + 手册整册）→ 富结论 JSON
// + 传递字段代码对账（market_node / 通道 / 情绪对齐 与云端节点源和盘面源值核对，不一致用源值覆写 + 记 degradation——数据一致性校验；
//   position_limit 例外：盘面值仅建议输入，执行上限以 s1 按用户手册裁决的声明值为准，仅做 0~100 合法性校验与缺位回退）
// 注意：open_allowed 的「节点 × 允许行为表」编译兜底是 Phase 3 内容（表须从文档编译，代码不得硬编码节点断言）
import { assembleKit, verdictKitSpec } from "./kit.ts";
import { runToolJsonSession } from "./llm.ts";
import type { StageRec } from "./trace.ts";
import { log } from "../log.ts";
import { makeReadFileTool } from "../tools/fs.ts";
import { makeSdkTool } from "../tools/sdk.ts";
import * as market from "../../../skills/mock/market.ts";

// 会话 1 墙钟（单会话上限；轮级预算优先）
const VERDICT_WALL_MS = 120_000;

// 注入块节标记（与 watch-context.ts 组装格式对齐）
const POS_REVIEW_MARKER = "■ 持仓复核数据";
const BUDGET_MARKER = "■ 纪律预算";

// 裁掉注入块的「持仓复核数据」节（会话 1 无需分时明细；政策条件核对由会话 2 拿数据做）
export function trimBlockForVerdict(block: string): string {
  const lines = block.split("\n");
  const start = lines.findIndex((l) => l.startsWith(POS_REVIEW_MARKER));
  if (start < 0) return block;
  const end = lines.findIndex((l) => l.startsWith(BUDGET_MARKER));
  const stop = end > start ? end : lines.length;
  return lines.slice(0, start).concat(lines.slice(stop)).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

// 阶段判定会话的系统指令（阶段模板 + kit 拼接；字段三分类契约见 §3.1）
function verdictInstruction(): string {
  return `# 阶段任务（会话 1 · 节点判定）

你是柚子 AI 盯盘流水线的「节点判定器官」。基于用户消息注入的机械层数据与上述手册知识，对今日盘面做节点判定，输出**一个**富结论 JSON。

## 字段要求（三类，纪律不同）

**传递字段（只许抄写，禁止推演改写）**：
- \`market_node\`：逐字抄写注入块「市场节点」JSON 的 \`effective_node\` 节点词（云端十词：冰点 / 连续冰点 / 冰点回暖 / 升温 / 连续升温 / 高潮 / 连续高潮 / 高潮降温 / 降温 / 连续降温）
- \`node_channels\`：逐字抄写节点 JSON 的 \`channels\` 全部字段（a_open / a2_open / b_open / c_open / d_open / ef_open，布尔）与 \`forbidden_new_position\` / \`realize_only\`（禁止自行推演通道资格——云端节点与代码派生是唯一权威）
- \`market_gate.sentiment_label\`：抄盘面分析 JSON 的 \`sentiment_analysis.sentiment_label\`
- \`market_gate.alignment\`：抄盘面分析 JSON 的 \`final_analysis.sentiment_capital_alignment\`（五词：双强 / 普涨 / 胶着 / 逆势 / 双弱）
- \`market_gate.position_limit\`：**当日执行仓位上限由你（用户侧判定会话）裁决声明**（0~100）——盘面分析 JSON 的 \`final_analysis.position_limit\` 只是**建议输入**，不是权威值。裁决依据 = 用户手册（心法仓位哲学 / 红线 / 战法档位）与当日节点：手册有明确口径时按手册声明（如用户要求永远满仓则声明 100）；无手册依据时采用盘面建议值，**禁止无依据即兴调档**。偏离盘面建议时必须在 \`open_reason\` 注明手册条文依据（代码只校验 0~100 合法性，不再覆写回盘面值）

**语义字段（你的判断）：
- \`market_gate.open_allowed\`：按当日通道资格（含豁免）× 当帧开仓触发（情绪标签 + 对齐）× 纪律预算 × **账户开仓空间**，判定**当前时点（本帧）是否允许新开仓**——逐轮重判，不是当日终身判决；账户开仓空间 = 注入块账户资金与持仓的机械事实判定：当前持仓市值已达盘面 \`position_limit\` 上限、或可用资金不足以手册最小试错档一笔（数值从手册读出）、或纪律预算硬闸命中（暴露 / 笔数 / 同方向额度尽）→ \`open_allowed=false\`（买链整段不启动，不烧选股 token）；\`open_reason\` 说明①当前卡在哪条②当日后续还有哪些待定开仓窗口及其放行条件（如通道 D 14:30~14:55、通道 C 尾盘段认证），确无待定窗口才写"当日再无开仓路径"；**理由写给人看**——禁内部术语（"尾盘段认证""佐证""节点许可"等一律译成人话），但必须带具体数字（分数 / 温度值 / 时间点）
- \`buy_windows\`：按 kit 策略（战法 / 核心层的时段规则）给出**当日允许新开仓买入的时间窗口**，格式 \`[["09:30","11:30"],["13:00","15:00"]]\`——策略只允许尾盘买（如通道 D/E）就只给尾盘窗口；策略要求 10 点后可买就从 10 点起给；全天禁买给空数组 \`[]\`；策略无任何时段约束时给交易所连续竞价全时段。这是声明不是判断——逐字按策略时段规则填，下游代码用它拦截窗口外的拉池与下单
- \`buy_directions\` / \`retreat_directions\`：当日可买方向与撤退方向（板块名沿用盘面分析命名，撤退方向是一票否决项）
- \`size_cap_pct\`：**单笔**仓位上限（占总资产 %）——通道降档后的封顶；无降档填 0（代码不额外封顶）。触发条件按战法册。降档**只封顶单笔仓位、不否决出手**
- \`forbidden\`：当日禁项清单（大白话短句，如"连续降温禁新开仓"）

**政策字段（前置规则 + 生效条件，不是判决！）**：
- \`holding_policies\`：对每只**可卖持仓**（持仓快照 available_volume > 0）给出适用政策。你没有分时数据，加速止盈四信号等条件由下游卖链会话拿数据核对——你只声明政策与条件：
  \`{"code":"601888","basis":"试错仓（溯源摘要）","policy":"环境分层减仓豁免","conditions":"四信号全不成立且止损未触发 → 豁免首笔逢高减仓；任一成立 → 按策略正常执行"}\`
  政策依据当日战法册的持仓管理节；当日无适用政策时输出空数组

**降级规则**：盘面分析缺位（data 为 None / status 非 success）→ \`open_allowed\` 按保守输出（false）并在 \`open_reason\` 注明"盘面缺位"；节点读取失败（code != 200）→ \`market_node\` 按缺位处理、\`open_allowed=false\` 并注明"节点读取失败按防守"。节点 JSON 的 \`node_degraded=true\`（当帧节点缺位退回昨日链末节点）时须在 \`open_reason\` 注明。\`degradation\` 字段留空数组（代码回填）。

## 自主补数（可选，预喂为主）

上方 kit 已预载心法 / 节点契约 / 当日战法册整册，注入块已含五项必读数据。仅当判定必需的证据缺位时，可用工具补数：\`read_file\` 读 memory/ 其它手册（如买入手册的仓位阶梯细则）；\`sdk_call\` 调只读行情接口与市场节点读取。轮次与墙钟有限——先看预喂内容再补数，禁止漫游式取数。

## 输出格式

只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块：
{"trade_date":"YYYY-MM-DD","time":"HH:MM:SS","market_node":"...","node_channels":{...上述字段...},"market_gate":{"sentiment_label":"...","alignment":"...","position_limit":0,"open_allowed":false,"open_reason":"..."},"size_cap_pct":0,"buy_windows":[["09:30","11:30"],["13:00","15:00"]],"buy_directions":[],"retreat_directions":[],"holding_policies":[],"forbidden":[],"degradation":[]}`;
}

// 传递字段对账源：云端市场节点（market.readMarketNode 输出，唯一权威）
interface NodeSource {
  node: string; // effective_node（当帧缺位时 = 昨日链末节点）
  degraded: boolean; // 当帧节点缺位（effective 已退回昨日）
  readFailed: boolean; // 整体读取失败（防守信封）
  channels: Record<string, boolean>;
  forbiddenNewPosition: boolean;
  realizeOnly: boolean;
}

// 读取云端节点对账源（读取失败按防守——与总纲「节点读取失败 → 当日防守」纪律一致）
async function readNodeSource(): Promise<NodeSource> {
  try {
    const out = (await market.readMarketNode()) as Record<string, unknown>;
    if (out.code !== 200) {
      return { node: "", degraded: false, readFailed: true, channels: {}, forbiddenNewPosition: true, realizeOnly: false };
    }
    const channels: Record<string, boolean> = {};
    for (const [k, v] of Object.entries((out.channels ?? {}) as Record<string, unknown>)) {
      channels[k] = v === true;
    }
    return {
      node: String(out.effective_node ?? ""),
      degraded: out.node_degraded === true,
      readFailed: false,
      channels,
      forbiddenNewPosition: out.forbidden_new_position === true,
      realizeOnly: out.realize_only === true,
    };
  } catch (e) {
    log("verdict", `云端节点源拉取失败（按防守）: ${e instanceof Error ? e.message : String(e)}`);
    return { node: "", degraded: false, readFailed: true, channels: {}, forbiddenNewPosition: true, realizeOnly: false };
  }
}

// 传递字段对账：LLM 抄写值 vs 源值；不一致 / 缺失 → 用源值覆写并记 degradation（返回覆写次数）
function reconcile(verdict: Record<string, unknown>, src: NodeSource, marketSrc: MarketSource | null): number {
  const degradation = (verdict.degradation as unknown[]) ?? (verdict.degradation = []);
  let fixed = 0;
  const note = (msg: string): void => {
    degradation.push(msg);
    fixed += 1;
    log("verdict", `对账覆写: ${msg}`);
  };
  // 节点词
  if (String(verdict.market_node ?? "") !== src.node) {
    note(`market_node 与云端节点源值不一致（${String(verdict.market_node ?? "缺失")} → ${src.node || "缺位"}），已按源值覆写`);
    verdict.market_node = src.node;
  }
  // 通道字段
  const channels = (verdict.node_channels ?? (verdict.node_channels = {})) as Record<string, unknown>;
  for (const [k, v] of Object.entries(src.channels)) {
    if (channels[k] !== v) {
      if (channels[k] === undefined) continue; // 缺失静默回填（无错误可对）
      note(`node_channels.${k} 与节点源值不一致（${String(channels[k])} → ${String(v)}），已覆写`);
    }
    channels[k] = v;
  }
  // 盘面三字段（源缺位时跳过对账——盘面缺位由会话自身按降级规则处理）
  if (marketSrc !== null) {
    const gate = (verdict.market_gate ?? (verdict.market_gate = {})) as Record<string, unknown>;
    if (gate.sentiment_label !== undefined && String(gate.sentiment_label) !== marketSrc.sentimentLabel) {
      note(`sentiment_label 与盘面源值不一致，已覆写为 ${marketSrc.sentimentLabel}`);
    }
    gate.sentiment_label = marketSrc.sentimentLabel;
    if (gate.alignment !== undefined && String(gate.alignment) !== marketSrc.alignment) {
      note(`alignment 与盘面源值不一致，已覆写为 ${marketSrc.alignment}`);
    }
    gate.alignment = marketSrc.alignment;
    // position_limit：盘面值仅是建议输入，执行上限以 s1 按用户手册裁决的声明值为准（用户手册如"永远满仓"等明确口径优先）。
    // 合法声明（0~100）一律保留——与盘面建议不同属合法偏离（须手册依据，由 s1 指令约束），仅日志留痕不覆写不记 degradation；
    // 声明缺位 / 非法时才回退盘面建议值并记 degradation。
    const pl = Number(gate.position_limit);
    if (gate.position_limit !== undefined && Number.isFinite(pl) && pl > 0 && pl <= 100) {
      if (pl !== marketSrc.positionLimit) log("verdict", `position_limit 采用 s1 裁决值 ${pl}%（盘面建议 ${marketSrc.positionLimit}%，手册依据见 open_reason）`);
      gate.position_limit = pl;
    } else {
      if (gate.position_limit !== undefined) note(`position_limit 声明非法（${String(gate.position_limit)}），已回退盘面建议值 ${marketSrc.positionLimit}`);
      gate.position_limit = marketSrc.positionLimit;
    }
  }
  // 单笔降档封顶（语义字段，会话声明）：非法值 → 归零并记 degradation（下游 buy 链按 0 = 无降档处理）
  const rawSizeCap = Number(verdict.size_cap_pct ?? 0);
  if (!Number.isFinite(rawSizeCap) || rawSizeCap < 0 || rawSizeCap > 100) {
    note(`size_cap_pct 声明非法（${String(verdict.size_cap_pct)}），已归零（无降档）`);
    verdict.size_cap_pct = 0;
  } else {
    verdict.size_cap_pct = rawSizeCap;
  }
  // 买入时间窗口（策略声明值）：格式非法/缺位 → 回退交易所全时段并记 degradation（缺位不拦开仓——时段是策略收紧非安全底线）
  const FULL_SESSION_WINDOWS = [["09:30", "11:30"], ["13:00", "15:00"]];
  const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const rawWindows = verdict.buy_windows;
  const validWindows =
    Array.isArray(rawWindows) &&
    rawWindows.every((w) => Array.isArray(w) && w.length === 2 && HM_RE.test(String(w[0])) && HM_RE.test(String(w[1])) && String(w[0]) < String(w[1]));
  if (!validWindows) {
    verdict.buy_windows = FULL_SESSION_WINDOWS;
    if (rawWindows !== undefined) note(`buy_windows 声明非法（${JSON.stringify(rawWindows).slice(0, 60)}），已回退交易所全时段`);
  }
  if (fixed > 0) verdict.degradation = degradation;
  return fixed;
}

// 盘面分析对账源（position_limit / 情绪 / 对齐；拉取失败返回 null）
export interface MarketSource {
  sentimentLabel: string;
  alignment: string;
  analyzeTime: string; // 判定消费帧的生成时点（data.analyze_time；帧龄审计：轮次时间 − 帧时间，防"消费上一帧"无留痕）
  positionLimit: number;
  temperatureLabel: string;
  overview: string;
  activeDirection: string;
  retreatDirections: string[];
  actionAdvice: string;
  riskWarnings: string[];
}

// 拉取盘面分析核心字段（一次 HTTP，对账与总结事实共用；失败返回 null）
export async function fetchMarketSource(): Promise<MarketSource | null> {
  try {
    const env = (await market.getIntradayAnalysis()) as Record<string, unknown>;
    if (env.code !== 200) return null;
    const data = (env.data ?? null) as Record<string, unknown> | null;
    if (!data) return null;
    const final = (data.final_analysis ?? {}) as Record<string, unknown>;
    const sentiment = (data.sentiment_analysis ?? {}) as Record<string, unknown>;
    const attacks = (final.attack_directions ?? []) as Array<Record<string, unknown>>;
    const retreats = (final.retreat_directions ?? []) as Array<Record<string, unknown>>;
    const pl = Number(final.position_limit);
    return {
      sentimentLabel: String(sentiment.sentiment_label ?? "该字段为空"),
      alignment: String(final.sentiment_capital_alignment ?? "该字段为空"),
      analyzeTime: String(data.analyze_time ?? ""),
      positionLimit: Number.isFinite(pl) ? pl : 0,
      temperatureLabel: String(data.temperature_label ?? ""),
      overview: String(final.market_overview ?? ""),
      activeDirection: attacks.length > 0 ? String(attacks[0]!.direction ?? "无") : "无",
      retreatDirections: retreats.map((r) => String(r.direction ?? "")).filter(Boolean),
      actionAdvice: String(final.action_advice ?? ""),
      riskWarnings: ((final.risk_warnings ?? []) as unknown[]).map((w) => String(w)),
    };
  } catch (e) {
    log("verdict", `盘面源拉取失败（跳过对账）: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// 判定失败的防守兜底富结论（§7：解析失败按防守处理，禁开仓）
function defensiveVerdict(tradeDate: string, time: string, src: NodeSource, reason: string): Record<string, unknown> {
  return {
    trade_date: tradeDate,
    time,
    market_node: src.node,
    node_channels: { ...src.channels },
    market_gate: { sentiment_label: "该字段为空", alignment: "该字段为空", position_limit: 0, open_allowed: false, open_reason: reason },
    size_cap_pct: 0,
    buy_directions: [],
    retreat_directions: [],
    holding_policies: [],
    forbidden: ["判定会话失败，按防守处理：禁开仓"],
    degradation: [`会话 1 解析失败（重试后仍败）：${reason}`],
  };
}

// 会话 1 主流程：备料 → LLM 判定 → 传递字段对账 → 阶段记录
export async function runVerdictStage(
  projectRoot: string,
  ctx: { trade_date: string; current_time: string; block: string },
  opts: { dry?: boolean } = {},
): Promise<{ stage: StageRec; verdict: Record<string, unknown>; marketSrc: MarketSource | null; nodeReadFailed: boolean; nodeLabel: string }> {
  const startedAt = Date.now();
  const src = await readNodeSource();
  const marketSrc = await fetchMarketSource();
  const kit = assembleKit(projectRoot, "s1_verdict", verdictKitSpec(src.node || "降温"));

  if (opts.dry) {
    // 干跑：跳过 LLM，直接产出防守兜底富结论（全链 plumbing 验证用）
    const verdict = defensiveVerdict(ctx.trade_date, ctx.current_time, src, "dry 模式未调用 LLM");
    return {
      stage: { id: "s1_verdict", status: "degraded", reason: "dry 模式：LLM 未调用", wall_ms: Date.now() - startedAt, tokens: 0 },
      verdict,
      marketSrc,
      nodeReadFailed: src.readFailed,
      nodeLabel: src.node || "该字段为空",
    };
  }

  const userMessage = [
    `【当前时间】${ctx.trade_date} ${ctx.current_time}（输出 JSON 的 time 字段逐字采用此值）`,
    "",
    "【机械层注入块】",
    trimBlockForVerdict(ctx.block) || "（注入块缺位——按盘面/节点缺位的降级规则处理）",
  ].join("\n");

  const result = await runToolJsonSession({
    projectRoot,
    systemPrompt: `${kit.text}\n\n---\n\n${verdictInstruction()}`,
    userMessage,
    wallMs: VERDICT_WALL_MS,
    stageId: "s1_verdict",
    requiredKeys: ["node_channels", "market_gate", "size_cap_pct", "buy_windows", "buy_directions", "retreat_directions"],
    tools: [
      makeReadFileTool(projectRoot, "watch", ctx.trade_date),
      makeSdkTool(projectRoot, [
        "market.get_intraday_analysis",
        "market.read_market_node",
        "market.get_market_node_series",
        "market.get_key_watch_stocks",
        "market.get_hot_spot_list",
        "market.get_top_hot_spots",
        "market.get_stock_info",
        "market.get_daily_k_data",
        "market.get_stock_trendline",
        "market.get_stock_minute_trendline",
        "market.get_hot_spot_rotation",
        "market.get_daily_indicators_history",
        "market.get_daily_summary",
        "market.get_indicator_trendline",
        "market.get_consecutive_board_ladder",
      ]),
    ],
    maxTurns: 8,
  });

  const stage: StageRec = {
    id: "s1_verdict",
    status: "ok",
    wall_ms: result.ms,
    tokens: result.tokens,
    cached_tokens: result.cachedTokens ?? 0,
    ...(kit.misses.length > 0 ? { kit_misses: kit.misses } : {}),
    ...(kit.changedFiles.length > 0 ? { kit_changed: kit.changedFiles } : {}),
  };

  if (!result.ok || !result.json) {
    stage.status = "degraded";
    stage.reason = result.error ?? "判定失败";
    const verdict = defensiveVerdict(ctx.trade_date, ctx.current_time, src, result.error ?? "判定失败");
    return { stage, verdict, marketSrc, nodeReadFailed: src.readFailed, nodeLabel: src.node || "该字段为空" };
  }

  const verdict = result.json;
  verdict.trade_date = ctx.trade_date;
  verdict.time = ctx.current_time;
  const fixed = reconcile(verdict, src, marketSrc);
  if (fixed > 0) stage.reconcile_overrides = fixed;
  stage.output_brief = {
    market_node: verdict.market_node,
    open_allowed: ((verdict.market_gate ?? {}) as Record<string, unknown>).open_allowed,
    buy: verdict.buy_directions,
    retreat: verdict.retreat_directions,
    policies: ((verdict.holding_policies ?? []) as unknown[]).length,
    degradation: verdict.degradation,
  };
  const gate = (verdict.market_gate ?? {}) as Record<string, unknown>;
  const reason = String(gate.open_reason ?? "未注明");
  const windows = ((verdict.buy_windows ?? []) as unknown[])
    .map((w) => (Array.isArray(w) ? w.map(String).join("-") : String(w)))
    .join("/");
  log(
    "verdict",
    `s1 判定: 节点=${String(verdict.market_node ?? "?")}｜开仓=${gate.open_allowed === true ? "允许" : "不允许"}｜情绪=${String(gate.sentiment_label ?? "?")}｜仓位上限=${String(gate.position_limit ?? "?")}%｜可买方向=${(((verdict.buy_directions ?? []) as unknown[]).map(String).join("、")) || "无"}｜撤退方向=${(((verdict.retreat_directions ?? []) as unknown[]).map(String).join("、")) || "无"}｜买入窗口=${windows || "无"}`,
  );
  // 理由全文单独一行输出（不截断）：控制台是人工排查入口，截断会把"卡在哪、还剩什么窗口"藏起来
  log("verdict", `s1 开仓判定理由（全文）: ${reason}`);
  return { stage, verdict, marketSrc, nodeReadFailed: src.readFailed, nodeLabel: String(verdict.market_node ?? "") || "该字段为空" };
}
