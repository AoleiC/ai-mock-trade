// 会话 2 · 卖出纪律（设计文档 §2 / §3.2 卖出模板 / §3.3）：
//   固定模板备料（快照 + 分时 + 日 K + 板块归属 + 热度 + 溯源 + 持仓政策）→ LLM 判定 → 代码钳制执行
//   会话失败 → 默认 hold + 台账止损计划机械兜底（执行买入时声明的 stop_loss_pct 记录值——代码执行记录数据，不持手册数字；
//   无台账记录（旧持仓/漏记）→ 只 hold 并如实记录，与 classic 同水平）
//   卖出只落 trace（journal 台账仅记买入 buy / 否决 veto——skill 契约，卖出成交由当日委托清单与持仓快照对账）
import { assembleKit, sellKitSpec } from "./kit.ts";
import { runToolJsonSession } from "./llm.ts";
import { isMarketOpenAt } from "./buy.ts";
import { appendAttention, type StageRec } from "./trace.ts";
import { log, brief } from "../log.ts";
import { lookupPositionOrigin, lookupBuyRecord } from "../../watch-context.ts";
import { appendTranscript } from "./transcript.ts";
import { makeReadFileTool } from "../tools/fs.ts";
import { buildFactsBlockSafe } from "./facts.ts";
import * as market from "../../../skills/mock/market.ts";
import * as trading from "../../../skills/mock/trading.ts";

// 会话 2 墙钟（单会话上限；含 read_file 按需读取 dynamic-strategy ~85k 字符的 prefill 预算；轮级预算优先）
const SELL_WALL_MS = 120_000;
// 限价偏离现价 >1% 时按现价重挂（执行机械修正：卖出向现价收敛只会更贴近可成交）
const PRICE_REHANG_DEV = 0.01;

// 卖出最小单位（A 股撮合格式规则，代码持规则不持手册数字——手册只管买卖理由，不管委托格式）
const SELL_LOT = 100;

// 卖出数量规整（撮合格式的机械修正：会话给的股数按交易所最小单位折算，不因格式退单丢掉整笔决策）
//   ① 可卖量不足一手（零股余额）→ 一次性全卖（零股一次性申报卖出）
//   ② 清仓意图（请求量 ≥ 可卖量）→ 卖光全部（含零股余额，一次性申报）
//   ③ 部分卖出 → 向下取整到一手整数倍；请求不足一手时按最小单位卖（不静默吞掉减仓意图）
function normalizeSellVolume(requested: number, available: number): { volume: number; note?: string } {
  const req = Math.floor(Number.isFinite(requested) ? requested : 0);
  const avail = Math.floor(Number.isFinite(available) ? available : 0);
  if (avail <= 0) return { volume: 0, note: "可卖量为零" };
  if (req <= 0) return { volume: 0 };
  // 零股余额：一次性全卖
  if (avail < SELL_LOT) return { volume: avail, note: `零股余额一次性卖出（可卖 ${avail} 股不足 ${SELL_LOT} 股）` };
  // 清仓意图：卖光全部（零股余额一并申报，符合交易所零股一次性卖出规则）
  if (req >= avail) {
    return {
      volume: avail,
      note: avail % SELL_LOT === 0 ? `清仓卖出 ${avail} 股` : `清仓卖出 ${avail} 股（含零股余额 ${avail % SELL_LOT} 股，一次性申报）`,
    };
  }
  // 会话给的股数不足一手：按最小单位卖
  if (req < SELL_LOT) return { volume: SELL_LOT, note: `委托量 ${req} 股不足 ${SELL_LOT} 股最小单位，按 ${SELL_LOT} 股卖出` };
  const vol = Math.floor(req / SELL_LOT) * SELL_LOT;
  if (vol <= 0) return { volume: 0, note: `可卖 ${avail} 股不足 ${SELL_LOT} 股最小单位` };
  return { volume: vol, note: vol !== req ? `委托量 ${req} 股规整为 ${vol} 股（${SELL_LOT} 股整数倍）` : undefined };
}

// 数量类退单识别（服务端按最小单位 / 整手 / 股数校验失败——属格式问题，可改量重提）
function isVolumeRejection(message: string): boolean {
  return /数量|最小|股数|整数倍|整手|一手|手数|100/.test(message);
}

// 持仓个股详情紧凑键（与 watch-context 注入块同清单——盯盘消费字段）
const STOCK_INFO_COMPACT_KEYS = ["name", "price", "zdf", "turn_z", "amount", "amount_main_str", "hot_categories", "hot_category_identities", "yd_tags", "up_reason"];

// 卖出决策（会话 2 输出契约）
export interface SellDecision {
  code: string;
  action: "sell" | "hold";
  volume: number;
  limit_price: number;
  reason: string;
  trigger: string;
}

// 在途委托（机械层注入的机器可读清单）：未完成的卖单占用可卖量，重复卖出必须先撤单再下
export interface PendingOrder {
  order_no: string;
  side: "buy" | "sell";
  code: string;
  name: string;
  volume: number;
  price: number;
  status: number;
}

// 当日全部委托事实（机械层注入）：卖链会话据此自见"今天已经卖过什么 / 买过什么"，自己保持减仓节奏
export interface OrderFact {
  order_no: string;
  side: "buy" | "sell";
  code: string;
  name: string;
  volume: number;
  deal_volume: number;
  price: number;
  status: number;
  time: string;
}

// 撤销在途卖单（重复卖出前的机械动作）：全部撤成功才继续下新单；有失败则放弃重挂（防超卖）
async function cancelPendingSells(pending: PendingOrder[]): Promise<{ ok: boolean; cancelled: string[]; failed: string[] }> {
  const cancelled: string[] = [];
  const failed: string[] = [];
  for (const p of pending) {
    try {
      const env = (await trading.cancel(p.order_no)) as Record<string, unknown>;
      if (env.code === 200) {
        cancelled.push(`${p.order_no}(${p.volume}股@${p.price})`);
      } else {
        failed.push(`${p.order_no}:${String(env.message ?? env.error ?? "撤单失败")}`);
      }
    } catch (e) {
      failed.push(`${p.order_no}:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: failed.length === 0, cancelled, failed };
}

// 委托记录（trace orders / 摘要行操作消费）
export interface SellOrderRecord {
  code: string;
  name: string;
  action: "sell";
  requested_volume: number;
  volume: number;
  price: number;
  status: string; // submitted / failed / skipped
  order_no?: string;
  note?: string;
}

// 单只持仓的卖出模板数据（任一数据源失败记入 fetchErrors，判定按缺位纪律跳过该条件）
interface HoldingBlock {
  pos: Record<string, unknown>;
  trendline: unknown;
  info: Record<string, unknown> | null;
  dailyK: Array<Record<string, unknown>> | null;
  origin: string;
  pendingSells: PendingOrder[];
  fetchErrors: string[];
}

// 拉取单只可卖持仓的三件套数据（分时 / 个股详情 / 日 K；并行，失败不阻塞）
async function fetchHoldingData(projectRoot: string, pos: Record<string, unknown>, pendingSells: PendingOrder[]): Promise<HoldingBlock> {
  const code = String(pos.stock_code ?? "");
  const fetchErrors: string[] = [];
  const [trend, info, dailyK] = await Promise.allSettled([
    market.getStockMinuteTrendline(code),
    market.getStockInfo(code),
    market.getDailyKData(code, 10),
  ]);
  if (trend.status === "rejected") fetchErrors.push(`分时拉取失败: ${String(trend.reason).slice(0, 80)}`);
  if (info.status === "rejected") fetchErrors.push(`个股详情拉取失败: ${String(info.reason).slice(0, 80)}`);
  if (dailyK.status === "rejected") fetchErrors.push(`日 K 拉取失败: ${String(dailyK.reason).slice(0, 80)}`);
  const infoRaw = info.status === "fulfilled" ? (info.value as Record<string, unknown>) : null;
  return {
    pos,
    trendline: trend.status === "fulfilled" ? trend.value : null,
    info: infoRaw !== null ? Object.fromEntries(STOCK_INFO_COMPACT_KEYS.map((k) => [k, infoRaw[k] ?? null])) : null,
    dailyK: dailyK.status === "fulfilled" ? ((dailyK.value ?? []) as Array<Record<string, unknown>>).slice(-10) : null,
    origin: lookupPositionOrigin(projectRoot, code, pos.position_date),
    pendingSells,
    fetchErrors,
  };
}

// 渲染单只持仓的固定模板数据块（§3.2 卖出模板——判断质量 = 输入固定性）
function renderHoldingBlock(h: HoldingBlock, idx: number): string {
  const p = h.pos;
  const num = (v: unknown, suffix = ""): string => (Number.isFinite(Number(v)) ? `${Number(v)}${suffix}` : String(v ?? "?"));
  const lines = [
    `【持仓 ${idx}：${String(p.stock_code ?? "")} ${String(p.stock_name ?? "")}】`,
    `- 快照：总持仓 ${num(p.volume, " 股")} / 可卖 ${num(p.available_volume, " 股")} / 成本均价 ${num(p.avg_price)} / 现价 ${num(p.current_price)} / 浮盈 ${num(p.profit, " 元")}（${num(p.profit_ratio, "%")}）/ 当日盈亏 ${num(p.today_profit_ratio, "%")}`,
    `- 买入溯源：${h.origin}`,
  ];
  if (h.pendingSells.length > 0) {
    const pendingText = h.pendingSells.map((o) => `${o.volume}股@${o.price}（订单号 ${o.order_no}，未完成）`).join("；");
    lines.push(
      `- 在途卖单：${pendingText}——该委托仍占用可卖量；本轮若判卖出，代码会先撤销在途单再重新挂单（你的 volume = 撤销后要挂出的委托量，不得超过上面的可卖股数）`,
    );
  }
  if (h.info !== null) {
    lines.push(`- 板块归属与资金：${JSON.stringify(h.info)}`);
  }
  if (h.trendline !== null && h.trendline !== undefined) {
    lines.push(`- 分时（当日涨跌幅序列 + 主力净额快照）：${JSON.stringify(h.trendline)}`);
  }
  if (h.dailyK !== null) {
    const rows = h.dailyK
      .map((r) => `${String(r.date ?? "").slice(5)} 收${r.close} ${r.zdf}% 换手${r.turnover ?? "-"} MA5 ${r.ma5 ?? "-"}`)
      .join("；");
    lines.push(`- 日 K 近 10 日（日期 收盘 涨跌 换手 MA5）：${rows}`);
  }
  if (h.fetchErrors.length > 0) {
    lines.push(`- ⚠ 数据缺项（对应条件按缺位纪律跳过并注明）：${h.fetchErrors.join("；")}`);
  }
  return lines.join("\n");
}

// 会话 2 的阶段指令（字段契约与判定顺序；程序知识与读册指引在 kit 固定件 P_SELL）
function sellInstruction(): string {
  return `# 阶段任务（会话 2 · 卖出纪律）

你是柚子 AI 盯盘流水线的「卖出纪律器官」。对用户消息注入的**每一只可卖持仓**，按上述知识判定卖出或持有，输出一个 JSON。

## 判定顺序（每股）

1. **读册（一次性，最先做）**：按上方固定知识指引 read_file memory/dynamic-strategy.md，读取止盈止损三层与加速止盈四信号的数值与细则——这是判定的唯一数值权威
2. **政策核对**：若「持仓政策」中有该股的政策（如环境分层减仓豁免），先用分时 / 日 K 数据核对政策条件（如加速止盈四信号是否成立、止损是否触发）——豁免条件成立 → 按政策处理（如豁免首笔逢高减仓）；不成立 → 按正常纪律走
3. **三层纪律**：环境层（盘面恶化 / 方向走弱 → 环境分层减仓）→ 方向层（持仓板块归属命中当日撤退方向 → 减仓 / 清仓，撤退是红线）→ 个股层（止损止盈阈值 + 加速止盈四信号）
4. 数据缺项的持仓：跳过依赖缺失数据的条件，在 reason 注明缺了什么，其余条件照常判定

## 输出契约

只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块：
{"decisions":[{"code":"601888","action":"sell 或 hold","volume":0,"limit_price":0.0,"reason":"一句话关键依据（必须含关键数字：浮盈%/四信号/撤退方向等）","trigger":"止损|止盈|加速止盈|撤退减仓|环境分层|政策豁免|无"}]}

- **每只持仓必须有一条决策（含 hold）**
- action=hold 时 volume=0、limit_price=0
- action=sell 时 volume ≤ 该股可卖量；限价以数据块中的现价为基准小幅偏离即可（卖出内部会下浮提升撮合优先级）
- action=sell 时 volume 请给 **100 股整数倍**（A 股卖出最小单位；代码还会按可卖量再规整一次，格式不合规会被服务端退单）`;
}

// 会话失败时的台账止损计划机械兜底（§7：不让"模型没输出"等于"持仓裸奔"；执行的是买入时声明的记录值）
async function fallbackStopLoss(
  projectRoot: string,
  holdings: HoldingBlock[],
  noTrade: boolean,
  ctxTimeHM: string,
): Promise<{ decisions: SellDecision[]; orders: SellOrderRecord[]; note: string }> {
  const decisions: SellDecision[] = [];
  const orders: SellOrderRecord[] = [];
  let noPlan = 0;
  for (const h of holdings) {
    const ratio = Number(h.pos.profit_ratio);
    const code = String(h.pos.stock_code ?? "");
    const name = String(h.pos.stock_name ?? "");
    const buy = lookupBuyRecord(projectRoot, code, h.pos.position_date);
    const planPct = Number(buy?.stop_loss_pct);
    if (!Number.isFinite(planPct) || planPct <= 0) {
      noPlan += 1;
      continue;
    }
    if (!Number.isFinite(ratio) || ratio > -planPct) continue;
    const vol = Math.floor(Number(h.pos.available_volume ?? 0));
    decisions.push({ code, action: "sell", volume: vol, limit_price: Number(h.pos.current_price ?? 0), reason: `浮盈 ${ratio}% 触破买入时止损计划 -${planPct}%（台账记录值）——会话失败由代码机械兜底`, trigger: "止损" });
    if (!noTrade && vol > 0) {
      // 在途卖单：先撤销再重挂（重复卖出防护，与会话判定路径同一机械规则）
      if (h.pendingSells.length > 0) {
        const cancelRes = await cancelPendingSells(h.pendingSells);
        if (!cancelRes.ok) {
          orders.push({ code, name, action: "sell", requested_volume: vol, volume: 0, price: Number(h.pos.current_price ?? 0), status: "skipped", note: `在途卖单撤销失败（${cancelRes.failed.join("，")}）——不重复下单，避免超卖` });
          continue;
        }
        log("sell", `${code} 撤销在途卖单 ${cancelRes.cancelled.join("，")}（止损兜底重挂）`);
      }
      orders.push(await executeSellDecision(projectRoot, code, name, vol, Number(h.pos.current_price ?? 0), vol, ctxTimeHM));
    } else if (vol > 0) {
      orders.push({ code, name, action: "sell", requested_volume: vol, volume: vol, price: Number(h.pos.current_price ?? 0), status: "skipped", note: "no_trade 模式未执行" });
    }
  }
  const note = decisions.length > 0 ? `按台账止损计划机械兜底，触发 ${decisions.length} 笔${noPlan > 0 ? `（${noPlan} 只无台账计划仅 hold）` : ""}` : `台账无可用止损计划（${noPlan} 只无记录——旧持仓或漏记），本轮全部 hold`;
  return { decisions, orders, note };
}

// 执行一笔卖出决策：钳制（可卖量 / 最小单位 / 价格带）→ 现价偏离机械修正 → trading.sell（数量类退单自动改量重提一次）
async function executeSellDecision(
  projectRoot: string,
  code: string,
  name: string,
  volume: number,
  limitPrice: number,
  available: number,
  timeHM: string,
): Promise<SellOrderRecord> {
  const rawVol = Math.floor(Math.min(Number.isFinite(volume) ? volume : 0, available));
  const norm = normalizeSellVolume(volume, available);
  const vol = norm.volume;
  const base: SellOrderRecord = { code, name, action: "sell", requested_volume: rawVol, volume: vol, price: Math.round((limitPrice || 0) * 100) / 100, status: "skipped" };
  if (vol <= 0) return { ...base, note: norm.note ?? `委托量非法或为零（传入 ${volume}，可卖 ${available}）` };
  if (!(base.price > 0)) return { ...base, note: `委托价非法（${limitPrice}）` };
  // 交易所时段闸（物理约束，非策略窗口——策略不禁卖，止损全天有效；防边界轮次休市废单）
  if (!isMarketOpenAt(timeHM)) return { ...base, note: `休市时段（${timeHM}）不提交——决策保留，下一交易时段重新评估` };
  // 现价核对：拉不到现价放弃下单（与 classic order 工具同纪律）；偏离 >1% 按现价重挂（卖出向现价收敛）
  let live: number;
  try {
    const env = (await trading.getStockPrice(code)) as Record<string, unknown>;
    live = Number(((env.data ?? {}) as Record<string, unknown>).price);
    if (!Number.isFinite(live) || live <= 0) throw new Error(`现价数据非法: ${String(((env.data ?? {}) as Record<string, unknown>).price)}`);
  } catch (e) {
    return { ...base, status: "failed", note: `现价查询失败，放弃下单: ${e instanceof Error ? e.message : String(e)}` };
  }
  let price = base.price;
  let note: string | undefined = norm.note;
  if (Math.abs(price - live) / live > PRICE_REHANG_DEV) {
    price = Math.round(live * 100) / 100;
    note = note ? `${note}；限价 ${base.price} 偏离现价 ${live} 超 1%，已按现价重挂` : `限价 ${base.price} 偏离现价 ${live} 超 1%，已按现价重挂`;
  }
  try {
    let env = (await trading.sell(code, price, vol)) as Record<string, unknown>;
    let attemptVol = vol;
    // 数量类退单自动重试一次：按最小单位改量重提（格式问题不该让整笔卖出决策白跑）
    if (env.code !== 200) {
      const msg = String(env.message ?? env.error ?? "");
      const fixedVol = Math.floor(attemptVol / SELL_LOT) * SELL_LOT;
      if (isVolumeRejection(msg) && fixedVol > 0 && fixedVol !== attemptVol) {
        log("sell", `${code} 数量类退单（${msg}）——按 ${SELL_LOT} 股整数倍改量 ${attemptVol} → ${fixedVol} 自动重提一次`);
        attemptVol = fixedVol;
        env = (await trading.sell(code, price, attemptVol)) as Record<string, unknown>;
      }
    }
    const ok = env.code === 200;
    const data = (env.data ?? {}) as Record<string, unknown>;
    log("sell", `${code} ${attemptVol}股@${price} → code=${String(env.code)} order_no=${String(data.order_no ?? "")}`);
    appendTranscript("trade", { side: "sell", code, name, volume: attemptVol, price, status: ok ? "submitted" : "failed", env });
    const failNote = ok ? undefined : String(env.message ?? env.error ?? "下单失败");
    if (!ok) appendAttention(projectRoot, "WARN", `[卖链] ${code} ${name} 卖单被服务端拒绝（${failNote}）——决策保留，下轮重判`);
    return { ...base, price, volume: attemptVol, status: ok ? "submitted" : "failed", order_no: data.order_no !== undefined ? String(data.order_no) : undefined, note: note ?? failNote };
  } catch (e) {
    return { ...base, price, status: "failed", note: `下单执行异常: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// 当日委托事实行（卖链自见节奏）：今天已经卖过什么 / 买过什么——让会话自己保持分批减仓的一致节奏，
//   而不是每轮从零重判（事实给足，判定权仍在会话）
function renderTodayOrders(orders: OrderFact[]): string[] {
  if (orders.length === 0) return ["【当日已提交委托】无"];
  const statusText: Record<number, string> = { 0: "待报", 1: "已报", 2: "部成", 3: "已成", 4: "已撤", 5: "废单" };
  const sold = orders.filter((o) => o.side === "sell");
  const bought = orders.filter((o) => o.side === "buy");
  const line = (list: OrderFact[]): string =>
    list.length > 0
      ? list.map((o) => `${o.side === "buy" ? "买" : "卖"} ${o.name || o.code} ${o.volume}股@${o.price}（${o.time} ${statusText[o.status] ?? String(o.status)}${o.deal_volume > 0 ? ` 成交${o.deal_volume}股` : ""}）`).join("；")
      : "无";
  return [
    `【当日已提交委托——今日出手节奏事实（此前已卖/已买在此，避免重复判断同一件事）】`,
    `- 卖出：${line(sold)}`,
    `- 买入：${line(bought)}`,
  ];
}

// 会话 2 主流程：备料（固定模板）→ LLM 判定 → 解析校验 → 代码钳制执行
export async function runSellStage(
  projectRoot: string,
  ctx: { trade_date: string; current_time: string },
  verdict: Record<string, unknown>,
  positions: Array<Record<string, unknown>>,
  opts: { dry?: boolean; noTrade?: boolean; pendingOrders?: PendingOrder[]; ordersToday?: OrderFact[] } = {},
): Promise<{ stage: StageRec; decisions: SellDecision[]; orders: SellOrderRecord[]; llmRan: boolean }> {
  const startedAt = Date.now();
  const ctxTimeHM = ctx.current_time.slice(0, 5); // 交易所时段闸用（物理约束，策略不禁卖）
  const sellable = positions.filter((p) => Number(p.available_volume ?? 0) > 0);
  const nodeWord = String(verdict.market_node ?? "降温");
  const noTrade = opts.noTrade === true;
  // 在途卖单（机械层注入的机器可读清单）：按 code 归集——重复卖出先撤单再下，可卖量以持仓快照为准
  const pendingSellByCode = new Map<string, PendingOrder[]>();
  for (const o of (opts.pendingOrders ?? []).filter((p) => p.side === "sell")) {
    const arr = pendingSellByCode.get(o.code) ?? [];
    arr.push(o);
    pendingSellByCode.set(o.code, arr);
  }

  // 备料：三件套并行 + 热度榜（方向热度锚点，1 call 全持仓共享）
  const holdings = await Promise.all(
    sellable.map((p) => fetchHoldingData(projectRoot, p, pendingSellByCode.get(String(p.stock_code ?? "")) ?? [])),
  );
  // 板块热度事实由当日裁决事实块统一提供（下方注入），此处不再单独拉取

  // 当日裁决事实（与买链同一份：状态机 / 盘面当帧 / 板块量化要件 / 会话 1 裁决声明）——卖链的环境层判断同样需要完整事实
  const factsBlock = await buildFactsBlockSafe(ctx, verdict);
  const userMessage = [
    `【当前时间】${ctx.trade_date} ${ctx.current_time}`,
    factsBlock,
    `【持仓政策（会话 1 前置的政策 + 生效条件——你拿数据核对条件，成立与否由你判决）】`,
    JSON.stringify(verdict.holding_policies ?? []),
    ...renderTodayOrders(opts.ordersToday ?? []),
    "",
    "【可卖持仓数据块（固定模板，逐只判定）】",
    ...holdings.map((h, i) => renderHoldingBlock(h, i + 1)),
  ].join("\n");

  const kit = assembleKit(projectRoot, "s2_sell", sellKitSpec(nodeWord));

  if (opts.dry) {
    // 干跑：跳过 LLM 与执行（plumbing 验证用）
    return {
      stage: { id: "s2_sell", status: "degraded", reason: "dry 模式：LLM 未调用，卖链未执行", wall_ms: Date.now() - startedAt, tokens: 0 },
      decisions: [],
      orders: [],
      llmRan: false,
    };
  }

  // s2 · 有界工具会话：止盈止损细则在 dynamic-strategy.md（用户手册按需读取——整册过大不预注入）
  const result = await runToolJsonSession({
    projectRoot,
    systemPrompt: `${kit.text}\n\n---\n\n${sellInstruction()}`,
    userMessage,
    wallMs: SELL_WALL_MS,
    stageId: "s2_sell",
    requiredKeys: ["decisions"],
    tools: [makeReadFileTool(projectRoot, "watch", ctx.trade_date)],
    maxTurns: 4,
  });
  const tokens = result.tokens;
  const baseStage: StageRec = { id: "s2_sell", status: "ok", wall_ms: Date.now() - startedAt, tokens, cached_tokens: result.cachedTokens ?? 0 };
  if (kit.misses.length > 0) baseStage.kit_misses = kit.misses;

  // 解析失败 → 默认 hold + 编译止损线机械兜底（§7）
  if (!result.ok || !result.json) {
    const fb = await fallbackStopLoss(projectRoot, holdings, noTrade, ctxTimeHM);
    log("sell", `会话失败，兜底: ${fb.note}`);
    return {
      stage: {
        ...baseStage,
        status: "degraded",
        reason: `卖链会话失败（${result.error ?? "未知"}）；${fb.note}`,
        fallback_orders: fb.orders.length,
      },
      decisions: fb.decisions,
      orders: fb.orders,
      llmRan: true,
    };
  }

  // 解析校验：code 必须在可卖清单内、action 枚举合法；非法条目剔除计数（绝不静默采用）
  const sellableCodes = new Set(sellable.map((p) => String(p.stock_code ?? "")));
  const availableByCode = new Map(sellable.map((p) => [String(p.stock_code ?? ""), Math.floor(Number(p.available_volume ?? 0))]));
  const nameByCode = new Map(sellable.map((p) => [String(p.stock_code ?? ""), String(p.stock_name ?? "")]));
  const raw = (result.json.decisions ?? []) as Array<Record<string, unknown>>;
  const decisions: SellDecision[] = [];
  let invalid = 0;
  for (const d of raw) {
    const code = String(d.code ?? "");
    const action = String(d.action ?? "");
    if (!sellableCodes.has(code) || (action !== "sell" && action !== "hold")) {
      invalid += 1;
      continue;
    }
    decisions.push({
      code,
      action: action as "sell" | "hold",
      volume: Math.floor(Number(d.volume ?? 0)) || 0,
      limit_price: Number(d.limit_price ?? 0) || 0,
      reason: String(d.reason ?? ""),
      trigger: String(d.trigger ?? "无"),
    });
  }
  // 同股多决策去重（保留首条 sell）
  const seen = new Set<string>();
  const deduped = decisions.filter((d) => (seen.has(d.code) ? (invalid += 1, false) : (seen.add(d.code), true)));

  // 代码执行：sell 决策逐笔钳制下单（hold 不动；同股在途卖单先撤单再重挂，防重复卖出超卖）
  const orders: SellOrderRecord[] = [];
  for (const d of deduped) {
    if (d.action !== "sell") continue;
    if (noTrade) {
      orders.push({ code: d.code, name: nameByCode.get(d.code) ?? "", action: "sell", requested_volume: d.volume, volume: Math.min(d.volume, availableByCode.get(d.code) ?? 0), price: d.limit_price, status: "skipped", note: "no_trade 模式未执行" });
      continue;
    }
    const pend = pendingSellByCode.get(d.code) ?? [];
    if (pend.length > 0) {
      const cancelRes = await cancelPendingSells(pend);
      if (!cancelRes.ok) {
        log("sell", `${d.code} 在途卖单撤销失败（${cancelRes.failed.join("，")}）——放弃重挂，避免超卖`);
        orders.push({
          code: d.code,
          name: nameByCode.get(d.code) ?? "",
          action: "sell",
          requested_volume: d.volume,
          volume: 0,
          price: d.limit_price,
          status: "skipped",
          note: `在途卖单撤销失败（${cancelRes.failed.join("，")}）——不重复下单，避免超卖`,
        });
        continue;
      }
      log("sell", `${d.code} 撤销在途卖单 ${cancelRes.cancelled.join("，")} 后重新挂单`);
    }
    orders.push(await executeSellDecision(projectRoot, d.code, nameByCode.get(d.code) ?? "", d.volume, d.limit_price, availableByCode.get(d.code) ?? 0, ctxTimeHM));
  }

  const sellCount = deduped.filter((d) => d.action === "sell").length;
  baseStage.decisions_brief = deduped.map((d) => `${d.code}:${d.action}(${d.trigger})`);
  baseStage.orders = orders.map((o) => `${o.code}:${o.status}`);
  if (invalid > 0) baseStage.invalid_entries = invalid;
  log(
    "sell",
    `s2 卖出判定（可卖 ${sellable.length} 只${invalid > 0 ? `，剔除非法条目 ${invalid}` : ""}）: ${deduped.map((d) => `${d.code} ${nameByCode.get(d.code) ?? ""} ${d.action === "sell" ? `卖 ${d.volume}股` : "hold"}（${brief(d.reason, 60)}）`).join("｜") || "全部 hold"}`,
  );
  return { stage: baseStage, decisions: deduped, orders, llmRan: true };
}
