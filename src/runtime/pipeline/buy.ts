// 买链（设计文档 §2 / §2.1）：三重剔除 → 蛇形分批 → 会话 3a 批初选 ×K（默认串行）→ 会话 3b 终选（预算声明）
//   → 三件套预拉 → 会话 4 核验（心法 / 买入手册整册在场 + 止损计划声明）→ 会话 5 终裁（caps 由会话从心法整册
//   逐字读出并声明，代码只做算术，缺声明 → fail-closed）
//   → 代码钳制执行（数值来源：会话声明值 / 盘面 position_limit——代码不持任何手册数字，§9）
// 组合状态 = 持仓快照 + 本轮已成交卖单的合成（不用开轮旧快照）
// 买入落账 journal（buy，含止损计划 stop_loss_pct——卖链兜底执行该记录值）+ 核验否决落账（veto）
import { assembleKit, batchKitSpec, finalSelectKitSpec, verifyKitSpec, finalKitSpec } from "./kit.ts";
import { runJsonSession, runToolJsonSession } from "./llm.ts";
import { appendAttention, type StageRec } from "./trace.ts";
import { buildFactsBlockSafe } from "./facts.ts";
import { fetchAndEliminate, snakeBatch, renderPoolRows } from "./pool.ts";
import { appendTranscript } from "./transcript.ts";
import type { Candidate } from "../tools/pools.ts";
import { loadEngineConfig } from "../tools/pools.ts";
import { makeReadFileTool } from "../tools/fs.ts";
import { makeSdkTool, SUBAGENT_METHODS } from "../tools/sdk.ts";
import { log, brief } from "../log.ts";
import * as trading from "../../../skills/mock/trading.ts";
import * as market from "../../../skills/mock/market.ts";
import * as journal from "../../../skills/journal/journal.ts";

// 各会话墙钟（单会话上限；轮级预算优先）
const BATCH_WALL_MS = 60_000;
const FINAL_SEL_WALL_MS = 60_000;
// 核验 / 终裁整册注入手册（s4）与 read_file 按需读册（s5 dynamic-strategy ~85k 字符）的 prefill 预算加大
const VERIFY_WALL_MS = 240_000;
const FINAL_RULE_WALL_MS = 120_000;
// 每批出线上限 / 核验上限（§12 未决 4 定值，Phase 3 实测可调）；批大小已外置 engine-config.batch_size
const PICK_PER_BATCH = 3;
const VERIFY_CAP = 4;

// 买入委托记录（trace orders / 摘要行消费）
export interface BuyOrderRecord {
  code: string;
  name: string;
  action: "buy";
  volume: number;
  price: number;
  weight_pct: number;
  stop_loss_pct: number | null; // 会话声明的止损计划（台账落账，卖链兜底执行）
  status: string; // submitted / failed / skipped
  order_no?: string;
  note?: string;
}

// 候选逐级判决链（§8：为什么没买 X 一次可查）
export interface CandidateChain {
  code: string;
  name?: string;
  chain: string[];
  note?: string;
}

// 买链返回（main 消费：poolStage 单独记账，其余 stages 顺序追加）
export interface BuyChainResult {
  poolStage: StageRec;
  stages: StageRec[];
  orders: BuyOrderRecord[];
  chains: CandidateChain[];
  budget: { orders: number; weights: number[] } | null;
  llmSessions: number;
  tokens: number;
  budgetExhausted?: boolean; // 轮级预算中途耗尽（main 聚合进 budget_truncated）
}

// 从注入块提取「纪律预算」节（会话 3b 的事实输入；与 watch-context 组装格式对齐）
function extractBudgetSection(block: string): string {
  const lines = block.split("\n");
  const start = lines.findIndex((l) => l.startsWith("■ 纪律预算"));
  if (start < 0) return "纪律预算节缺位（按缺位处理：今日已出手按 0 计）";
  const end = lines.findIndex((l, i) => i > start && l.startsWith("■"));
  return lines.slice(start, end > start ? end : lines.length).join("\n");
}

// ── 会话指令（阶段模板；kit 内已含手册知识） ──

function batchInstruction(): string {
  return `# 阶段任务（会话 3a · 批初选）

你是选股流水线的批初选器官。本批候选来自六池合并，已过机械剔除（已涨停 / 涨幅带 / 撤退方向——以用户消息「引擎配置事实」行为准；监管名单仅⚠标记不剔除，禁买由下游核验终审），结合注入的当日方向与节点背景，从**本批**中选出最多 ${PICK_PER_BATCH} 只最值得今日出手的候选。

- 判定依据与打分规则见上方固定知识（方向契合 / 量价基础 / 资金方向 / 池来源交集，批内相对比较）
- 表内「持仓」列非"-"的候选为已持仓标的（含今日已买入金额）——能否再次出手属补足判定，归下游会话按手册裁决；批内排序与新股同标准，不因已持仓加分或降权
- 绝对资格裁决不在本批职责内——四类股 / 追高位置 / 资金面硬条件 / 买点形态由下游核验会话对照用户手册整册终审
- 本批无合格者 → 输出空数组（宁缺勿滥）

只输出一个 JSON：{"picked":[{"code":"...","score":0,"reason":"一句话（含关键数字：涨幅 / 换手 / 主力净额 / 池来源）"}]}`;
}

function finalSelectInstruction(): string {
  return `# 阶段任务（会话 3b · 终选）

你是选股流水线的终选器官。全部批初选出线者在下方**同台**重排（跨批可比性在这里解决），结合当日节点背景与纪律预算事实，声明今日购买预算与终选名单。

- **当日购买预算**：\`{orders, weights[], direction_alloc{}}\`——orders=今日还可出手笔数，weights=每笔权重（占账户总资产 %，如 [8,7]），direction_alloc=方向分配；按上方固定知识的预算推导程序，从「纪律预算事实」（今日已出手 / 组合现状）机械算术推导，代码只对红线钳制
- **已持仓候选 = 补足笔**：表中「持仓」列非"-"者仅在手册分笔建仓的强确认要件成立时才可入选（reason 写明确认了什么），照常占用预算名额；无强确认按落选处理，不得当作新票重复出手
- **终选名单**：≤ min(预算笔数, ${VERIFY_CAP}) 只，按出手优先级排序 + 理由；无合适者输出空名单（宁缺勿滥）

只输出一个 JSON：{"budget":{"orders":0,"weights":[],"direction_alloc":{}},"shortlist":[{"code":"...","rank":1,"reason":"..."}]}`;
}

function verifyInstruction(): string {
  return `# 阶段任务（会话 4 · 个股核验）

对用户消息注入的**每只终选候选**，按上方随附的用户手册整册（心法 / 买入手册）逐项核验硬条件：心法红线（四类股 / 监管回避）/ 资金面硬条件 / 量价持续性与趋势位置 / 分时四信号买入侧 / 多日上涨后追高判定 / 买点形态匹配。

- 手册是唯一权威：逐字按手册条文判定，禁止凭常识发明阈值
- **已持仓候选（数据块含"已持仓"行）按补足笔核验**：补足要件（强确认形态 + 全部硬条件）以随附买入手册分笔建仓节为准——强确认不成立 → veto 并注明"补足条件不成立"；pass 的 reason 必须写明强确认证据是什么
- **题材阶段要件已在事实区给全**（板块当日涨停数与名次、风向标当日涨幅、前一交易日连榜、板块平均涨幅与主力）——请自行判定，不要以"要件缺位"为由把题材层判断推给下游；确有个股级证据缺口才用工具补
- 数据缺位（块内有 ⚠ 标注）→ 该条件跳过并在 reason 注明；接口整体失败 → verdict "error"
- 宁 veto 不硬凑 pass；pass 仅代表个股资格，仓位与出手由终裁裁决
- **metrics.price 必须填该股数据块中的最新价**（终裁限价的唯一基准）
- **verdict=pass 时必填 stop_loss_pct**：按买入手册止损规则声明的止损计划（占买入价百分比，正数）——下游终裁与台账直接消费该值

## 自主补数（可选，预喂为主）

每只候选的分时 / 个股详情 / 日 K 三件套已预拉注入，心法 / 买入手册 / 核心层 / 当日战法册整册已随 kit 预载。仅当核验必需的证据缺位时，可用工具补数：\`sdk_call\` 调个股三件套与板块热度接口；\`read_file\` 仅限确需 kit 之外的其它手册时。轮次与墙钟有限，禁止漫游式取数。

只输出一个 JSON：{"verdicts":[{"code":"...","verdict":"pass 或 veto 或 error","reason":"一句话关键依据（含关键数字与手册条文出处）","metrics":{"price":0},"stop_loss_pct":0}]}`;
}

function finalRuleInstruction(): string {
  return `# 阶段任务（会话 5 · 买入终裁）

基于核验结论、账户与持仓合成状态，给出今日买入指令。

## 红线数值声明（fail-closed）

从上方随附的**心法整册**红线条文中**逐字读出**单只与同方向仓位红线数值，填入 \`caps\`——代码只拿你声明的值做钳制算术，不注入任何数值；caps 缺失或非法 → 本轮全部不下单。

## 你的裁量范围（不许越界，也不许甩锅）

- **市场节点与开仓许可已由会话 1 裁决**（事实区「会话 1 裁决声明」+ 云端节点字段，含 effective_node / 通道资格 / 卖侧基调）——**你不得以市场节点为由推翻它**；若你认为事实区内部自相矛盾，必须在 decline_note 里指出具体字段与数值的冲突，不许只说"节点不对"
- **题材阶段要件已在事实区给全**（板块当日涨停数与名次、风向标当日涨幅、前一交易日连榜、板块平均涨幅与主力）——**不许以"要件缺位"为由否决**；事实区标了缺位就按缺位处理该条件并说明，不等于不能买
- 你的裁量范围 = 个股层与纪律层：核验结论不成立、买点失效、仓位/组合纪律不允许、已持仓补足笔要件不成立

## 自主补数（组合纪律必读）

出手节奏与组合纪律（复买核对 / 已买标的补足笔 / 高位载体否决 / 仓位阶梯等细则）在 memory/dynamic-strategy.md（用户手册，整册未预注入）——声明预算与每笔 weight 前先 \`read_file\` 该手册，读取其出手节奏与组合纪律相关内容并按条文执行；轮次有限，只读必需的册。

## 补足笔（已持仓标的的订单）

核验候选为已持仓标的时（持仓事实见「账户与持仓事实」明细）：该笔订单 = 补足笔——须核验结论的 reason 含强确认证据，并在你输出的 reason 中对照「纪律预算事实」里该股当日买入记录（或首笔台账理由）注明"补足：确认了什么"；无强确认证据的补足笔放弃该笔，其余订单不受影响。

## 输出契约

- \`caps\`：\`{"single_pct":0,"direction_pct":0}\`（从心法整册红线条文读出的数值）
- \`orders[].weight_pct\` = 该笔买入金额占账户总资产百分比；不得超过 caps 与账户仓位上限（盘面 position_limit）与**会话 1 声明的单笔降档封顶**（事实区给出，0 = 无降档）——代码会再逐笔钳制，超限部分会被砍量而非放大
- \`orders[].limit_price\` 以核验 metrics.price 为基准小幅偏离即可（买入内部会小幅上浮提升撮合优先级）
- \`orders[].stop_loss_pct\` = 该笔买入的止损计划——**直接采用核验结论中该股的声明值**（核验已按买入手册规则声明），不要自行改写；**填正数**（如核验声明 5 则填 5，表示 -5%；核验结论展示的"-N%"只是展示格式，输出字段不得带负号）；核验未声明时按心法与已读手册纪律给保守值
- \`reason\` 末尾必须注明依据的手册与条文出处（如 心法红线节 / 核心层出手节奏）——事后审计的抓手
- 无 pass 候选或按纪律不该出手 → 输出空 orders，且**必须**填 \`decline_note\`（一句话：核验通过了为何仍不出手——审计抓手，禁止静默放弃）
- 有 orders 时 decline_note 可省略

只输出一个 JSON：{"caps":{"single_pct":0,"direction_pct":0},"decline_note":"空 orders 时必填","orders":[{"code":"...","name":"...","direction":"板块方向","weight_pct":0,"limit_price":0,"stop_loss_pct":0,"reason":"...（依据：手册与条文出处）"}]}`;
}

// ── 执行钳制（数值来源：会话声明 caps / 盘面 position_limit；缺任一 → 该轮不开仓） ──

// 从会话 5 声明中取仓位红线（schema sanity：0 < x ≤ 100；数值真伪由会话对着心法整册条文读出）
function capsFromSession(json: Record<string, unknown>): { single: number; direction: number } | null {
  const c = (json.caps ?? {}) as Record<string, unknown>;
  const single = Number(c.single_pct);
  const direction = Number(c.direction_pct);
  if (!Number.isFinite(single) || single <= 0 || single > 100) return null;
  if (!Number.isFinite(direction) || direction <= 0 || direction > 100) return null;
  return { single, direction };
}

// 交易时段闸（交易所连续竞价制度，机械事实非判断）：休市时段提交必不成交（2026-11-04 12:31 休市单教训）；买卖共用
export function isMarketOpenAt(timeHM: string): boolean {
  const m = /^(\d{1,2}):(\d{2})/.exec(timeHM);
  if (!m) return false;
  const hm = Number(m[1]) * 60 + Number(m[2]);
  return (hm >= 570 && hm < 690) || (hm >= 780 && hm < 900); // 9:30~11:30 / 13:00~15:00
}

// 执行一笔买入：权重 → 数量（整手）→ 四重钳制（可用资金 / 账户仓位上限 / 单只红线 / 同方向红线）→ 现价偏离修正 → trading.buy
// 红线数值来源（§9：代码不持任何手册数字）：caps = 会话 5 从心法红线节选逐字声明的值；positionLimitPct = 盘面 LLM 值（会话 1 传递字段）
async function executeBuy(
  order: { code: string; name: string; direction: string; weight_pct: number; limit_price: number; stop_loss_pct: number; reason: string },
  account: { total_amount: number; available_amount: number; market_value: number },
  holdingsInfo: Array<{ code: string; cats: string; remainingValue: number }>,
  spentThisRound: number,
  boughtByDirection: Map<string, number>,
  capSet: { single: number; direction: number; positionLimitPct: number; sizeCapPct: number },
  noTrade: boolean,
  timeHM: string,
  buyWindows: Array<[string, string]>,
): Promise<BuyOrderRecord> {
  const base: BuyOrderRecord = { code: order.code, name: order.name, action: "buy", volume: 0, price: Math.round((order.limit_price || 0) * 100) / 100, weight_pct: order.weight_pct, stop_loss_pct: Number.isFinite(order.stop_loss_pct) && order.stop_loss_pct > 0 ? order.stop_loss_pct : null, status: "skipped" };
  if (!(order.weight_pct > 0) || !(base.price > 0)) return { ...base, note: `参数非法（weight=${order.weight_pct}, price=${order.limit_price}）` };
  if (!isMarketOpenAt(timeHM)) return { ...base, note: `休市时段（${timeHM}）不提交——连续竞价 9:30~11:30 / 13:00~15:00，下一交易时段重新评估` };
  const hm = timeHM.slice(0, 5);
  if (!buyWindows.some(([a, b]) => String(a) <= hm && hm < String(b))) return { ...base, note: `策略买入时间窗口外（${timeHM}，窗口 ${buyWindows.map(([a, b]) => `${a}-${b}`).join("/")}）不提交` };
  // 现价核对：拉不到放弃；偏离 >1% 按现价重挂（买入向现价收敛，只会更贴近可成交）
  let live: number;
  try {
    const env = (await trading.getStockPrice(order.code)) as Record<string, unknown>;
    live = Number(((env.data ?? {}) as Record<string, unknown>).price);
    if (!Number.isFinite(live) || live <= 0) throw new Error(`现价非法: ${String(((env.data ?? {}) as Record<string, unknown>).price)}`);
  } catch (e) {
    return { ...base, status: "failed", note: `现价查询失败，放弃下单: ${e instanceof Error ? e.message : String(e)}` };
  }
  const price = Math.abs(base.price - live) / live > 0.01 ? Math.round(live * 100) / 100 : base.price;
  const notes: string[] = [];
  // 目标金额 → 整手数量
  let volume = Math.floor(((account.total_amount * order.weight_pct) / 100 / price / 100)) * 100;
  const clampByValue = (maxValue: number, label: string): void => {
    const maxVol = Math.floor(maxValue / price / 100) * 100;
    if (volume > maxVol) {
      notes.push(`${label}钳制 ${volume} → ${maxVol} 股`);
      volume = maxVol;
    }
  };
  // 钳制 1/4 · 撮合级硬约束：可用资金（超出即废单）；整手约束见上方取整
  clampByValue(account.available_amount - spentThisRound, "可用资金");
  // 钳制 2/4 · 账户仓位上限（盘面 position_limit）：总资产×上限% − 当前持仓市值 − 本轮已买入
  clampByValue((account.total_amount * capSet.positionLimitPct) / 100 - account.market_value - spentThisRound, `仓位上限${capSet.positionLimitPct}%`);
  // 钳制 3/4 · 单只红线（会话声明 caps.single）：总资产×单只% − 该股现存市值（同代码本轮至多一笔，无需再减本轮）
  clampByValue((account.total_amount * capSet.single) / 100 - (holdingsInfo.find((h) => h.code === order.code)?.remainingValue ?? 0), `单只${capSet.single}%`);
  // 钳制 4/4 · 同方向红线（会话声明 caps.direction）：总资产×方向% − 同方向持仓市值 − 本轮已买同方向
  //   方向归属按持仓 hot_categories 包含本笔 direction 判定；direction 为空无法归属 → 跳过该钳制并留痕
  if (order.direction) {
    const sameDirectionValue =
      holdingsInfo.filter((h) => h.cats.includes(order.direction)).reduce((a, h) => a + h.remainingValue, 0) + (boughtByDirection.get(order.direction) ?? 0);
    clampByValue((account.total_amount * capSet.direction) / 100 - sameDirectionValue, `同方向${capSet.direction}%`);
  } else {
    notes.push("direction 缺失，同方向红线未钳制");
  }
  // 钳制 5/5 · 单笔降档封顶（会话 1 声明的通道降档，如通道 C 尾盘段短线佐证不达标 → 取试错档下限）：
  //   降档只封顶**单笔**仓位、不否决出手——超出的部分砍量而非不出手（单笔口径，不扣减本轮已花额度）
  if (capSet.sizeCapPct > 0) {
    clampByValue((account.total_amount * capSet.sizeCapPct) / 100, `单笔降档${capSet.sizeCapPct}%`);
  }
  if (volume < 100) return { ...base, price, status: "skipped", note: `钳制后不足一手（${notes.join("；") || "权重过小"}）` };
  // no_trade：钳制算术照跑（验证 caps 链路），但不下真实委托、不累计执行态（与卖链同纪律）
  if (noTrade) {
    return { ...base, price, volume, status: "skipped", note: `no_trade 模式未执行（${volume}股@${price}）${notes.length > 0 ? `｜${notes.join("；")}` : ""}` };
  }
  try {
    const env = (await trading.buy(order.code, price, volume)) as Record<string, unknown>;
    const ok = env.code === 200;
    const data = (env.data ?? {}) as Record<string, unknown>;
    log("buy", `${order.code} ${volume}股@${price} → code=${String(env.code)} order_no=${String(data.order_no ?? "")}`);
    appendTranscript("trade", { side: "buy", code: order.code, name: order.name, volume, price, weight_pct: order.weight_pct, stop_loss_pct: base.stop_loss_pct, status: ok ? "submitted" : "failed", env });
    return { ...base, price, volume, status: ok ? "submitted" : "failed", order_no: data.order_no !== undefined ? String(data.order_no) : undefined, note: notes.length > 0 ? notes.join("；") : ok ? undefined : String(env.message ?? env.error ?? "下单失败") };
  } catch (e) {
    return { ...base, price, volume, status: "failed", note: `下单执行异常: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// 买入落账：委托提交事实（status=pending，成交价量由机械层对账以服务端值升级——休市废单对账标 cancelled）
// 止损计划随台账落（stop_loss_pct——卖链会话失败时的机械兜底执行该记录值）
function recordBuyJournal(ctxTradeDate: string, timeHM: string, rec: BuyOrderRecord, direction: string, reason: string): void {
  journal.recordDecision(ctxTradeDate, "buy", rec.code, rec.name, direction || null, rec.price, rec.volume, `${reason}${rec.note ? `｜${rec.note}` : ""}`, timeHM, "pipeline", rec.stop_loss_pct, "pending");
  appendTranscript("journal", { action: "buy", code: rec.code, name: rec.name, direction, price: rec.price, volume: rec.volume, stop_loss_pct: rec.stop_loss_pct, status: "pending", reason: `${reason}${rec.note ? `｜${rec.note}` : ""}` });
}

// ── 买链主流程 ──

export async function runBuyChain(
  projectRoot: string,
  ctx: { trade_date: string; current_time: string; block: string },
  verdict: Record<string, unknown>,
  positions: Array<Record<string, unknown>>,
  soldVolumeByCode: Map<string, number>,
  opts: { dry?: boolean; noTrade?: boolean; rehearse?: boolean; deadline?: number } = {},
): Promise<BuyChainResult> {
  const startedAt = Date.now();
  const dry = opts.dry === true;
  const noTrade = opts.noTrade === true;
  const rehearse = opts.rehearse === true;
  const nodeWord = String(verdict.market_node ?? "降温");
  const chains: CandidateChain[] = [];
  const extraStages: StageRec[] = [];
  let llmSessions = 0;
  let tokens = 0;
  let budgetExhausted = false; // 轮级预算耗尽（批次截断）事实（main 聚合进 budget_truncated）
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY; // 批次选股截止（epoch ms）；撞线即截断剩余批次、带已出线候选进尾部——终选/核验/下单不受轮级墙钟拦截，各靠自身会话墙钟约束
  const overBudget = (stage: string): boolean => {
    if (Date.now() < deadline) return false;
    budgetExhausted = true;
    log("buy", `轮级预算耗尽，${stage} 起剩余批次截断（已用 ${Math.round((Date.now() - startedAt) / 1000)}s）——带已出线候选进终选/核验/下单`);
    appendAttention(projectRoot, "WARN", `[买链] 轮级预算耗尽批次截断（${stage} 起，本会话已用 ${Math.round((Date.now() - startedAt) / 1000)}s）——尾部照常执行；连续出现说明候选池过大，考虑调大 engine-config batch_size / concurrency 或收紧 price_band`);
    return true;
  };

  // 0) 策略买入时间窗口闸（s1 声明值：尾盘策略早盘禁买禁选股；窗口外不拉池不选股——省 token 且符合策略意图；演练模式豁免此闸以验证选股链路）
  const buyWindows = (Array.isArray(verdict.buy_windows) ? verdict.buy_windows : []) as Array<[string, string]>;
  const nowHM = ctx.current_time.slice(0, 5);
  const inBuyWindow = buyWindows.some(([a, b]) => String(a) <= nowHM && nowHM < String(b));
  if (!rehearse && (buyWindows.length === 0 || !inBuyWindow)) {
    const poolSkipped: StageRec = {
      id: "s3_pool",
      status: "skipped",
      reason: buyWindows.length === 0 ? "全天禁买（buy_windows 空）" : `策略买入时间窗口外（窗口 ${buyWindows.map(([a, b]) => `${a}-${b}`).join("/")}，当前 ${nowHM}）`,
      wall_ms: Date.now() - startedAt,
    };
    log("buy", `s3 跳过：${poolSkipped.reason}——不拉池不选股`);
    return { poolStage: poolSkipped, stages: extraStages, orders: [], chains, budget: null, llmSessions, tokens, budgetExhausted };
  }

  // 0.5) 账户空间机械闸（纯算术，命中即买链整段跳过直去总结，不烧池拉取与批选 token；演练豁免）：
  //   ① 可用资金 < account_gate.min_available_yuan（用户显式物理底线）
  //   ② 实际仓位（持仓市值/总资产）> account_gate.max_position_pct（用户显式物理底线）
  //   ③ 持仓市值 ≥ 总资产 × 盘面 position_limit（盘面口径满仓）
  //   可用资金不足最小试错档等含手册数值的判定归 s1 open_allowed 职责——代码只持用户显式配置数字
  let gateTotalAmount = 0; // 账户拉取成功时提升到外层（持仓标记占比分母复用，避免二次拉账户）
  if (!rehearse) {
    try {
      const { cfg: gateCfg } = loadEngineConfig(projectRoot);
      const acctEnv = (await trading.getAccount()) as Record<string, unknown>;
      const acct = (acctEnv.data ?? {}) as Record<string, unknown>;
      const totalAmount = Number(acct.total_amount ?? 0);
      gateTotalAmount = totalAmount;
      const marketValue = Number(acct.market_value ?? 0);
      const available = Number(acct.available_amount ?? 0);
      const posPct = totalAmount > 0 ? (marketValue / totalAmount) * 100 : 0;
      const limitPct = Number(((verdict.market_gate ?? {}) as Record<string, unknown>).position_limit ?? 0);
      let reason = "";
      if (available < gateCfg.account_gate.min_available_yuan) {
        reason = `可用资金 ${Math.round(available)} 元低于 ${gateCfg.account_gate.min_available_yuan} 元下限，无开仓空间`;
      } else if (posPct > gateCfg.account_gate.max_position_pct) {
        reason = `实际仓位 ${posPct.toFixed(1)}% 超过 ${gateCfg.account_gate.max_position_pct}% 物理上限，无开仓空间`;
      } else if (limitPct > 0 && totalAmount > 0 && marketValue >= (totalAmount * limitPct) / 100) {
        reason = `仓位已达盘面上限 ${limitPct}%（持仓市值 ${Math.round(marketValue)} / 总资产 ${Math.round(totalAmount)}），无开仓空间`;
      }
      if (reason) {
        const poolSkipped: StageRec = { id: "s3_pool", status: "skipped", reason: `${reason}——买链跳过`, wall_ms: Date.now() - startedAt };
        log("buy", `s3 跳过：${poolSkipped.reason}`);
        return { poolStage: poolSkipped, stages: extraStages, orders: [], chains, budget: null, llmSessions, tokens, budgetExhausted };
      }
    } catch {
      // 账户拉取失败不阻塞（缺数据不闸），最终由 s5 执行钳制兜底
    }
  }

  // 1) 池拉取 + 配置化剔除 + 蛇形分批（全代码；数值条件由会话按手册判定）
  const retreats = ((verdict.retreat_directions ?? []) as unknown[]).map(String).filter(Boolean);
  const { rows, stats, cfgWarnings, cfgSummary } = await fetchAndEliminate(projectRoot, retreats);
  if (cfgWarnings.length > 0) appendAttention(projectRoot, "WARN", `[engine-config] ${cfgWarnings.join("；")}`);
  appendTranscript("pool", { merged: stats.merged, pool_counts: stats.pool_counts, after_elim: stats.after_elim, watch_forbidden_marked: stats.watch_forbidden_marked, eliminated: stats.dropped, engine_config: cfgSummary });
  const { cfg } = loadEngineConfig(projectRoot);
  // 已持仓标记（补足笔可见性前提）：池行「持仓」列的事实来源——批选 / 终选 / 核验由此看得见"这只已持仓"；
  //   是否可再次出手（补足）归下游会话按手册分笔建仓框架裁决，代码只给事实不做判定
  const holdingMarks = new Map<string, string>();
  for (const p of positions) {
    const code = String(p.stock_code ?? "");
    const sold = soldVolumeByCode.get(code) ?? 0;
    const remaining = Math.max(0, Math.floor(Number(p.volume ?? 0)) - sold);
    if (!code || remaining <= 0) continue;
    const mv = Math.round(remaining * Number(p.current_price ?? 0));
    const todayBuy = Math.round(Number(p.today_buy_amount ?? 0));
    const base = gateTotalAmount > 0 ? `${Math.round((mv / gateTotalAmount) * 1000) / 10}%` : `${mv}元`;
    holdingMarks.set(code, `${base}${todayBuy > 0 ? `（今日已买${todayBuy}元）` : ""}`);
  }
  const batches = snakeBatch(rows, cfg.batch_size);
  log(
    "pool",
    [
      `s3 候选池（趋势池 pool_limit=${cfg.pool_limit} 截断，榜单池服务端定长）`,
      `每池: ${stats.pool_counts.map((p) => `${p.label}=${p.failed ? `拉取失败(${p.failed})` : `${p.fetched}（新${p.added}/重${p.dup}）`}`).join("｜")}`,
      `漏斗: 合并 ${stats.merged} 只 → 剔除后 ${stats.after_elim} 只（监管标记 ${stats.watch_forbidden_marked}（仅标记，禁买归核验终审）/ 已涨停 ${stats.dropped_zt} / 涨幅带 ${stats.dropped_band} / 撤退方向 ${stats.dropped_retreat}）→ 分 ${batches.length} 批`,
    ].join("\n"),
  );
  const poolStage: StageRec = {
    id: "s3_pool",
    status: rows.length > 0 ? "ok" : "skipped",
    ...(rows.length === 0 ? { reason: "empty_after_elimination" } : {}),
    wall_ms: Date.now() - startedAt,
    funnel: { merged: stats.merged, after_elim: stats.after_elim, batches: batches.length, watch_forbidden_marked: stats.watch_forbidden_marked, eliminated: { zt: stats.dropped_zt, band: stats.dropped_band, retreat: stats.dropped_retreat } },
    engine_config: cfgSummary, // 当日实际生效配置快照（复盘对照策略手册识别漂移）
  };
  if (stats.retreat_zero_hit) {
    poolStage.retreat_zero_hit = true;
  }
  // 逐级判决链：剔除落选也要留痕（"为什么没买 X"一次可查）。监管名单命中者保留在链内（⚠标记随行），禁买与否在核验否决理由中留痕
  for (const d of stats.dropped.zt) chains.push({ code: d.code, name: d.name, chain: ["pool", "elim:已涨停"] });
  for (const d of stats.dropped.band) chains.push({ code: d.code, name: d.name, chain: ["pool", "elim:涨幅带"] });
  for (const d of stats.dropped.retreat) chains.push({ code: d.code, name: d.name, chain: ["pool", "elim:撤退方向"] });
  for (const c of rows) {
    chains.push({ code: c.code, name: c.name, chain: ["pool", "elim:pass"] });
  }
  if (rows.length === 0) {
    return { poolStage, stages: extraStages, orders: [], chains, budget: null, llmSessions, tokens };
  }

  // 2) 会话 3a · 批初选 ×K（批间并发读 engine-config.concurrency，钳 1~5 默认 2；超并发只会得到 429——llm.ts 有退避兜底）
  //   批选 kit = 零手册固定件（字节跨批稳定，对前缀缓存友好）；绝对资格裁决后移会话 4
  const concurrency = cfg.concurrency;
  const kitSel = assembleKit(projectRoot, "s3a_select", batchKitSpec());
  if (kitSel.misses.length > 0) poolStage.kit_misses = kitSel.misses;
  const emerged: Array<{ row: Candidate; reason: string }> = [];
  const batchStages: StageRec[] = [];
  // 当日裁决事实（代码装配的唯一一份：状态机 / 盘面当帧 / 板块量化要件 / 会话 1 裁决声明）——各层注入同一份
  const factsBlock = await buildFactsBlockSafe(ctx, verdict);
  const selUserHead = [
    `【当前时间】${ctx.trade_date} ${ctx.current_time}`,
    factsBlock,
    `【引擎配置事实（机械层实际生效的剔除口径——批选 / 终选不携手册，回避政策已由此配置层裁决）】${cfgSummary}`,
  ].join("\n");
  const runBatch = async (batch: Candidate[], idx: number): Promise<void> => {
    const st: StageRec = { id: `s3a_batch_${idx + 1}`, status: overBudget(`s3a 批${idx + 1}`) ? "skipped" : "ok", ...(Date.now() >= deadline ? { reason: "round_budget" } : {}) };
    if (st.status === "skipped") { batchStages.push(st); return; }
    const t0 = Date.now();
    if (dry) {
      // 干跑：机械取批内主力净额前 3（plumbing 验证，不出手）
      const picked = [...batch].sort((a, b) => b.mainAmountNum - a.mainAmountNum).slice(0, PICK_PER_BATCH);
      for (const p of picked) emerged.push({ row: p, reason: "dry 模式机械出线" });
      st.status = "degraded";
      st.reason = "dry 模式：LLM 未调用（机械出线）";
      st.picked = picked.map((p) => p.code);
      st.wall_ms = Date.now() - t0;
      batchStages.push(st);
      return;
    }
    const r = await runJsonSession({
      projectRoot,
      systemPrompt: `${kitSel.text}\n\n---\n\n${batchInstruction()}`,
      userMessage: `${selUserHead}\n\n【本批候选（${batch.length} 只）】\n${renderPoolRows(batch, holdingMarks)}`,
      wallMs: BATCH_WALL_MS,
      stageId: `s3a_batch_${idx + 1}`,
      requiredKeys: ["picked"],
    });
    llmSessions += 1;
    tokens += r.tokens;
    st.wall_ms = r.ms;
    st.tokens = r.tokens;
    st.cached_tokens = r.cachedTokens ?? 0;
    if (!r.ok || !r.json) {
      st.status = "degraded";
      st.reason = `批初选失败（${r.error ?? "未知"}）——本批全部落选`;
    } else {
      const byCode = new Map(batch.map((c) => [c.code, c]));
      const pickedAll = (r.json.picked ?? []) as Array<Record<string, unknown>>;
      const droppedCodes = pickedAll.map((p) => String(p.code)).filter((c) => !byCode.has(c));
      if (droppedCodes.length > 0) {
        st.dropped_codes = droppedCodes.join(",");
        log("buy", `s3a 批${idx + 1} 丢弃 ${droppedCodes.length} 个批外代码（会话输出）: ${droppedCodes.join(",")}`);
      }
      const picked = pickedAll.filter((p) => byCode.has(String(p.code))).slice(0, PICK_PER_BATCH);
      for (const p of picked) emerged.push({ row: byCode.get(String(p.code))!, reason: String(p.reason ?? "") });
      st.picked = picked.map((p) => String(p.code));
      log("buy", `s3a 批${idx + 1}（本批 ${batch.length} 只）出线 ${picked.length} 只: ${picked.map((p) => `${String(p.code)} ${byCode.get(String(p.code))?.name ?? ""}（${brief(String(p.reason ?? ""), 70)}）`).join("｜") || "无（宁缺勿滥）"}`);
    }
    batchStages.push(st);
  };
  // 简单并发闸（默认 1 = 串行）
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (cursor < batches.length) {
      const idx = cursor++;
      await runBatch(batches[idx]!, idx);
    }
  });
  await Promise.all(workers);
  extraStages.push(...batchStages);

  // 出线者去重 + 判决链（已剔除的链到此为止，不追加后续阶段标记）
  const seenCode = new Set<string>();
  const emergedUnique = emerged.filter((e) => (seenCode.has(e.row.code) ? false : (seenCode.add(e.row.code), true)));
  const emergedCodes = new Set(emergedUnique.map((e) => e.row.code));
  const alive = (c: CandidateChain) => c.chain[c.chain.length - 1] === "elim:pass";
  for (const c of chains) {
    if (alive(c) && !emergedCodes.has(c.code)) c.chain.push("batch:落选");
  }
  for (const e of emergedUnique) {
    const c = chains.find((x) => x.code === e.row.code);
    if (c) {
      c.chain.push("emerged");
      c.note = e.reason.slice(0, 80);
    }
  }

  // 3) 会话 3b · 终选（同台重排 + 预算声明）
  let budget: { orders: number; weights: number[] } | null = null;
  let shortlist: Array<{ code: string; reason: string; row: Candidate }> = [];
  if (emergedUnique.length === 0) {
    extraStages.push({ id: "s3b_final", status: "skipped", reason: "no_emerged_candidates" });
  } else {
    const t0 = Date.now();
    if (dry) {
      budget = { orders: 0, weights: [] };
      extraStages.push({ id: "s3b_final", status: "degraded", reason: "dry 模式：LLM 未调用（预算 0）", wall_ms: Date.now() - t0 });
    } else {
      const r = await runJsonSession({
        projectRoot,
        systemPrompt: `${assembleKit(projectRoot, "s3b_final", finalSelectKitSpec()).text}\n\n---\n\n${finalSelectInstruction()}`,
        userMessage: `${selUserHead}\n\n【纪律预算事实（机械层算术）】\n${extractBudgetSection(ctx.block)}\n\n【全部出线者同台（${emergedUnique.length} 只，按主力净额降序）】\n${renderPoolRows(emergedUnique.map((e) => e.row), holdingMarks)}`,
        wallMs: FINAL_SEL_WALL_MS,
        stageId: "s3b_final",
        requiredKeys: ["budget", "shortlist"],
      });
      llmSessions += 1;
      tokens += r.tokens;
      const st: StageRec = { id: "s3b_final", status: "ok", wall_ms: r.ms, tokens: r.tokens, cached_tokens: r.cachedTokens ?? 0 };
      if (!r.ok || !r.json) {
        st.status = "degraded";
        st.reason = `终选失败（${r.error ?? "未知"}）——买链终止（宁可不买）`;
        extraStages.push(st);
        return { poolStage, stages: extraStages, orders: [], chains, budget: null, llmSessions, tokens };
      }
      const b = (r.json.budget ?? {}) as Record<string, unknown>;
      budget = { orders: Math.max(0, Math.floor(Number(b.orders ?? 0)) || 0), weights: ((b.weights ?? []) as unknown[]).map((w) => Number(w) || 0) };
      const byCode = new Map(emergedUnique.map((e) => [e.row.code, e.row]));
      const cap = Math.min(budget.orders, VERIFY_CAP);
      shortlist = ((r.json.shortlist ?? []) as Array<Record<string, unknown>>)
        .filter((s) => byCode.has(String(s.code)))
        .slice(0, cap > 0 ? cap : 0)
        .map((s) => ({ code: String(s.code), reason: String(s.reason ?? ""), row: byCode.get(String(s.code))! }));
      st.budget = budget;
      st.shortlist = shortlist.map((s) => s.code);
      log("buy", `s3b 终选: 出线 ${emergedUnique.length} 只 → 终选 ${shortlist.length} 只（预算 ${budget.orders} 笔×${budget.weights.join("/") || "-"}%）: ${shortlist.map((s) => `${s.code} ${s.row.name}（${brief(s.reason, 70)}）`).join("｜") || "空（宁缺勿滥）"}`);
      extraStages.push(st);
    }
  }
  // 终选标记：只打到经过批初选的存活链（elim 剔除链已终结）
  const reachedBatch = (c: CandidateChain) => c.chain[c.chain.length - 1] === "batch:落选" || c.chain[c.chain.length - 1] === "emerged";
  for (const c of chains) {
    if (reachedBatch(c)) c.chain.push(shortlist.some((s) => s.code === c.code) ? `final:${shortlist.findIndex((s) => s.code === c.code) + 1}` : "final:落选");
  }

  // 4) 三件套预拉 + 会话 4 核验（手册整册在场；pass 必带按手册声明的止损计划——下游台账与卖链兜底消费）
  const verdicts: Array<{ code: string; verdict: string; reason: string; price: number; stopLoss: number | null }> = [];
  if (shortlist.length === 0) {
    extraStages.push({ id: "s4_verify", status: "skipped", reason: budget !== null && budget.orders === 0 ? "budget_zero" : "no_shortlist" });
    extraStages.push({ id: "s5_execute", status: "skipped", reason: "no_pass_candidates" });
    return { poolStage, stages: extraStages, orders: [], chains, budget, llmSessions, tokens };
  }
  const prepull = await Promise.all(
    shortlist.map(async (s) => {
      const [trend, info, dailyK] = await Promise.allSettled([
        market.getStockMinuteTrendline(s.code),
        market.getStockInfo(s.code),
        market.getDailyKData(s.code, 10),
      ]);
      return {
        s,
        trend: trend.status === "fulfilled" ? trend.value : null,
        info: info.status === "fulfilled" ? (info.value as Record<string, unknown>) : null,
        dailyK: dailyK.status === "fulfilled" ? ((dailyK.value ?? []) as Array<Record<string, unknown>>).slice(-10) : null,
        errors: [trend, info, dailyK].filter((x) => x.status === "rejected").length,
      };
    }),
  );
  const verifyBlocks = prepull.map((p) => {
    const lines = [
      `【候选 ${p.s.code} ${String(p.info?.name ?? p.s.row.name)}】`,
      `- 池行：${p.s.row.zdf ?? "-"}% 换手 ${p.s.row.turnZ} 主力 ${p.s.row.mainAmount} 分类 ${p.s.row.hotCategories || "未归类"}${p.s.row.watchForbidden ? " ⚠交易所监管名单内" : ""}｜终选理由：${p.s.reason}`,
    ];
    const holdingMark = holdingMarks.get(p.s.code);
    if (holdingMark) lines.push(`- ⚠ 已持仓（${holdingMark}）——本候选为补足笔：按随附买入手册分笔建仓的补足要件核验，强确认不成立 → veto`);
    if (p.info !== null) lines.push(`- 个股详情：${JSON.stringify(Object.fromEntries(["name", "price", "zdf", "turn_z", "amount", "amount_main_str", "hot_categories", "up_reason"].map((k) => [k, p.info![k] ?? null])))}`);
    if (p.trend !== null && p.trend !== undefined) lines.push(`- 分时（买入侧四信号判据）：${JSON.stringify(p.trend)}`);
    if (p.dailyK !== null) lines.push(`- 日 K 近 10 日：${p.dailyK.map((r) => `${String(r.date ?? "").slice(5)} 收${r.close} ${r.zdf}% 换手${r.turnover ?? "-"} MA5 ${r.ma5 ?? "-"}`).join("；")}`);
    if (p.errors > 0) lines.push(`- ⚠ 有 ${p.errors} 项数据拉取失败（对应条件按缺位跳过并注明）`);
    return lines.join("\n");
  });
  if (dry) {
    extraStages.push({ id: "s4_verify", status: "degraded", reason: "dry 模式：LLM 未调用" });
    extraStages.push({ id: "s5_execute", status: "degraded", reason: "dry 模式：LLM 未调用" });
    return { poolStage, stages: extraStages, orders: [], chains, budget, llmSessions, tokens };
  }
  {
    const t0 = Date.now();
    const r = await runToolJsonSession({
      projectRoot,
      systemPrompt: `${assembleKit(projectRoot, "s4_verify", verifyKitSpec(nodeWord)).text}\n\n---\n\n${verifyInstruction()}`,
      userMessage: `${selUserHead}\n\n【终选候选数据块（逐只核验）】\n${verifyBlocks.join("\n\n")}`,
      wallMs: VERIFY_WALL_MS,
      stageId: "s4_verify",
      requiredKeys: ["verdicts"],
      tools: [
        makeReadFileTool(projectRoot, "watch", ctx.trade_date),
        makeSdkTool(projectRoot, [...SUBAGENT_METHODS, "market.get_hot_spot_list"]),
      ],
      maxTurns: 6,
    });
    llmSessions += 1;
    tokens += r.tokens;
    const st: StageRec = { id: "s4_verify", status: "ok", wall_ms: r.ms, tokens: r.tokens, cached_tokens: r.cachedTokens ?? 0 };
    if (!r.ok || !r.json) {
      st.status = "degraded";
      st.reason = `核验失败（${r.error ?? "未知"}）——全部按 error 处理，不开仓`;
      for (const s of shortlist) verdicts.push({ code: s.code, verdict: "error", reason: "核验会话失败", price: Number(prepull.find((p) => p.s.code === s.code)?.info?.price ?? 0), stopLoss: null });
    } else {
      const shortCodes = new Set(shortlist.map((s) => s.code));
      let dropped = 0;
      for (const v of (r.json.verdicts ?? []) as Array<Record<string, unknown>>) {
        const code = String(v.code ?? "");
        if (!shortCodes.has(code)) {
          dropped += 1;
          continue;
        }
        const slRaw = Number(v.stop_loss_pct);
        verdicts.push({
          code,
          verdict: String(v.verdict ?? "error"),
          reason: String(v.reason ?? ""),
          price: Number((v.metrics as Record<string, unknown> | undefined)?.price ?? 0) || 0,
          // 止损计划：核验按手册声明的正值（占买入价 %）；缺失 / 非法记 null（终裁与台账按缺位处理）
          stopLoss: Number.isFinite(slRaw) && slRaw > 0 ? slRaw : null,
        });
      }
      if (dropped > 0) {
        st.dropped_codes = `${dropped} 个终选外代码`;
        log("verify", `s4 丢弃 ${dropped} 个终选外代码（会话输出）`);
      }
    }
    st.verdicts = verdicts.map((v) => `${v.code}:${v.verdict}:${v.reason.slice(0, 100)}`);
    log("verify", `s4 核验 ${verdicts.length} 只: ${verdicts.map((v) => `${v.code} ${v.verdict}（${brief(v.reason, 90)}）`).join("｜") || "无候选"}`);
    extraStages.push(st);
    // 核验否决落账（veto——台账契约；当日否决复买须先推翻原理由）
    for (const v of verdicts) {
      if (v.verdict !== "veto") continue;
      const row = shortlist.find((s) => s.code === v.code)!.row;
      journal.recordDecision(ctx.trade_date, "veto", v.code, row.name, null, v.price || (row.zdf ?? 0), 0, `核验否决：${v.reason.slice(0, 120)}`, ctx.current_time.slice(0, 5), "pipeline");
      appendTranscript("journal", { action: "veto", code: v.code, name: row.name, price: v.price, reason: `核验否决：${v.reason.slice(0, 120)}` });
    }
  }
  // 核验标记：只打到进过终选的链；veto/error 把核验理由补进 note（trace 完整性——"为什么没买 X"一次可查）
  for (const c of chains) {
    const reachedFinal = c.chain[c.chain.length - 1]?.startsWith("final:");
    if (!reachedFinal) continue;
    const v = verdicts.find((x) => x.code === c.code);
    if (v) {
      c.chain.push(`verify:${v.verdict}`);
      if (v.verdict !== "pass" && v.reason) c.note = `${c.note ?? ""}｜核验${v.verdict === "veto" ? "否决" : "异常"}：${v.reason}`.slice(0, 200);
    } else {
      c.chain.push("verify:未核验");
    }
  }
  const passed = verdicts.filter((v) => v.verdict === "pass");
  if (passed.length === 0) {
    extraStages.push({ id: "s5_execute", status: "skipped", reason: "no_pass_candidates" });
    return { poolStage, stages: extraStages, orders: [], chains, budget, llmSessions, tokens };
  }

  // 5) 会话 5 · 买入终裁（账户 + 合成持仓 + caps 声明；核验 pass 必走——轮级墙钟不拦截，段内靠会话墙钟自约束）
  let orders: BuyOrderRecord[] = [];
  // 终态标记：进过核验的链补 ordered/not_ordered（含提前返回路径）
  const markOrdered = (): void => {
    for (const c of chains) {
      if (!c.chain[c.chain.length - 1]?.startsWith("verify:")) continue;
      c.chain.push(orders.some((o) => o.code === c.code && o.status === "submitted") ? "ordered" : "not_ordered");
    }
  };
  {
    const accountEnv = (await trading.getAccount()) as Record<string, unknown>;
    const acctData = (accountEnv.data ?? {}) as Record<string, unknown>;
    const account = {
      total_amount: Number(acctData.total_amount ?? 0),
      available_amount: Number(acctData.available_amount ?? 0),
      market_value: Number(acctData.market_value ?? 0),
    };
    // 持仓合成状态：快照 - 本轮已卖（§2：不用开轮旧快照）；全持仓拉板块归属供同方向额度核算
    const holdingsInfo = await Promise.all(
      positions.map(async (p) => {
        const code = String(p.stock_code ?? "");
        const sold = soldVolumeByCode.get(code) ?? 0;
        const remaining = Math.max(0, Math.floor(Number(p.volume ?? 0)) - sold);
        let cats = "";
        try {
          const info = (await market.getStockInfo(code)) as Record<string, unknown>;
          cats = String(info.hot_categories ?? "");
        } catch {
          cats = "";
        }
        return { code, cats, remainingValue: remaining * Number(p.current_price ?? 0) };
      }),
    );
    const positionLimitPct = Number(((verdict.market_gate ?? {}) as Record<string, unknown>).position_limit ?? 0);
    // 单笔降档封顶（会话 1 声明）：0 = 无降档；数值非法 → null（fail-closed，见 capSet 传参与注记）
    const rawSizeCap = Number(verdict.size_cap_pct ?? 0);
    const sizeCapPct: number | null = Number.isFinite(rawSizeCap) && rawSizeCap >= 0 && rawSizeCap <= 100 ? rawSizeCap : null;
    // 持仓明细（决策依据全量前置：数量 / 可卖量 / 成本 / 现价 / 市值 / 今日买入金额）
    const positionsDetail = positions.length > 0
      ? positions
          .map((p) => {
            const sold = soldVolumeByCode.get(String(p.stock_code ?? "")) ?? 0;
            const remaining = Math.max(0, Math.floor(Number(p.volume ?? 0)) - sold);
            return `${p.stock_name ?? p.stock_code}(${p.stock_code}) 持有${Math.floor(Number(p.volume ?? 0))}股 可卖${Math.floor(Number(p.available_volume ?? 0))}股 成本${Number(p.avg_price ?? 0)} 现价${Number(p.current_price ?? 0)} 市值${Math.round(remaining * Number(p.current_price ?? 0))}元 今日买入额${Number(p.today_buy_amount ?? 0)}元`;
          })
          .join("\n")
      : "（无持仓）";
    const accountFacts = [
      `账户仓位上限 ${positionLimitPct}%（盘面分析 position_limit）`,
      `单笔降档封顶 ${sizeCapPct === null ? "声明非法（按最保守处理）" : `${sizeCapPct}%`}（会话 1 声明；0 = 无降档）`,
      `总资产 ${account.total_amount} / 可用 ${account.available_amount} / 持仓市值 ${account.market_value}`,
      `持仓明细（扣本轮已卖）：\n${positionsDetail}`,
    ].join("\n");
    const budgetFacts = extractBudgetSection(ctx.block);
    // s5 · 有界工具会话：组合纪律在 dynamic-strategy.md（用户手册按需读取——整册过大不预注入）
    const r = await runToolJsonSession({
      projectRoot,
      systemPrompt: `${assembleKit(projectRoot, "s5_execute", finalKitSpec()).text}\n\n---\n\n${finalRuleInstruction()}`,
      userMessage:
        `${selUserHead}\n\n【核验结论（止损计划为核验按手册声明的值）】\n${verdicts.map((v) => `${v.code} ${v.verdict}: ${v.reason}（参考价 ${v.price}${v.stopLoss !== null ? `，止损计划 -${v.stopLoss}%` : "，止损计划缺位"}）`).join("\n")}` +
        `\n\n【账户与持仓事实】\n${accountFacts}` +
        `\n\n【纪律预算事实（机械层算术；成交笔数以服务端为准）】\n${budgetFacts}`,
      wallMs: FINAL_RULE_WALL_MS,
      stageId: "s5_execute",
      requiredKeys: ["caps"],
      tools: [makeReadFileTool(projectRoot, "watch", ctx.trade_date)],
      maxTurns: 2,
    });
    llmSessions += 1;
    tokens += r.tokens;
    const st: StageRec = { id: "s5_execute", status: "ok", wall_ms: r.ms, tokens: r.tokens, cached_tokens: r.cachedTokens ?? 0 };
    if (!r.ok || !r.json) {
      st.status = "degraded";
      st.reason = `终裁失败（${r.error ?? "未知"}）——不开仓`;
      extraStages.push(st);
      markOrdered();
      return { poolStage, stages: extraStages, orders: [], chains, budget, llmSessions, tokens };
    }
    const passCodes = new Set(passed.map((v) => v.code));
    const nameByCode = new Map(shortlist.map((s) => [s.code, s.row.name])); // 名字以池数据为权威（会话回显不靠谱）
    const ordersAll = (r.json.orders ?? []) as Array<Record<string, unknown>>;
    const droppedCodes = ordersAll.map((o) => String(o.code)).filter((c) => !passCodes.has(c));
    if (droppedCodes.length > 0) {
      st.dropped_codes = droppedCodes.join(",");
      appendAttention(projectRoot, "WARN", `[s5] 终裁输出 ${droppedCodes.length} 个未通过核验的代码已拦截不下单: ${droppedCodes.join(",")}（会话契约违约信号——偶发可忽略，频繁出现需检查 s5 契约与 kit）`);
      log("buy", `s5 拦截榜外订单 ${droppedCodes.length} 个: ${droppedCodes.join(",")}`);
    }
    const raw = ordersAll.filter((o) => passCodes.has(String(o.code)));
    // 空 orders 留痕：decline_note 入 stage 与通过候选链 note（核验通过却不出手必须可审计）
    if (raw.length === 0) {
      const declineNote = String(r.json.decline_note ?? "").slice(0, 120);
      st.reason = `终裁未下单：${declineNote || "未说明理由（decline_note 缺失）"}`;
      if (declineNote) {
        for (const c of chains) {
          if (c.chain[c.chain.length - 1] === "verify:pass") c.note = `${c.note ?? ""}｜终裁未出手：${declineNote}`.slice(0, 200);
        }
      }
    }
    const caps = capsFromSession(r.json);
    if (caps === null || !(positionLimitPct > 0) || sizeCapPct === null) {
      st.status = "degraded";
      st.reason = `caps 声明缺失/非法（${JSON.stringify(r.json.caps ?? null)}）或仓位上限缺位（${positionLimitPct}）或单笔降档声明非法（${String(verdict.size_cap_pct)}）——fail-closed 不开仓`;
      extraStages.push(st);
      log("buy", `终裁 caps 缺失，本轮放弃下单（fail-closed）`);
      markOrdered();
      return { poolStage, stages: extraStages, orders: [], chains, budget, llmSessions, tokens };
    }
    // 逐笔钳制执行（spentThisRound / boughtByDirection 随执行累计）
    let spentThisRound = 0;
    const boughtByDirection = new Map<string, number>();
    const capSet = { single: caps.single, direction: caps.direction, positionLimitPct, sizeCapPct: sizeCapPct ?? 0 };
    for (const o of raw) {
      const code = String(o.code);
      // 止损计划以核验声明值为权威（核验时买入手册整册在场）；终裁值仅在核验缺位时兜底
      const verifySl = verdicts.find((v) => v.code === code)?.stopLoss ?? null;
      const rec = await executeBuy(
        { code, name: nameByCode.get(code) ?? String(o.name ?? ""), direction: String(o.direction ?? ""), weight_pct: Number(o.weight_pct) || 0, limit_price: Number(o.limit_price) || 0, stop_loss_pct: verifySl ?? (Number.isFinite(Number(o.stop_loss_pct)) ? Number(o.stop_loss_pct) : 0), reason: String(o.reason ?? "") },
        account,
        holdingsInfo,
        spentThisRound,
        boughtByDirection,
        capSet,
        noTrade,
        ctx.current_time.slice(0, 5),
        buyWindows,
      );
      if (rec.status === "submitted") {
        spentThisRound += rec.volume * rec.price;
        boughtByDirection.set(String(o.direction ?? ""), (boughtByDirection.get(String(o.direction ?? "")) ?? 0) + rec.volume * rec.price);
      }
      orders.push(rec);
    }
    st.orders = orders.map((o) => `${o.code}:${o.status}`);
    log(
      "buy",
      `s5 终裁: 通过核验 ${passed.length} 只 → 下单 ${orders.filter((o) => o.status === "submitted").length} 笔: ${orders.map((o) => `${o.code} ${o.name} ${o.volume}股@${o.price} ${o.status}${o.note ? `（${brief(o.note, 60)}）` : ""}`).join("｜") || "未下单"}${st.reason ? `｜${st.reason}` : ""}`,
    );
    extraStages.push(st);
    // 买入落账（noTrade 不下单也不落账；成交价量以委托值记，机械层对账兜底）
    if (!noTrade) {
      for (const o of orders.filter((x) => x.status === "submitted")) {
        recordBuyJournal(ctx.trade_date, ctx.current_time.slice(0, 5), o, String((raw.find((x) => String(x.code) === o.code) ?? {}).direction ?? ""), String((raw.find((x) => String(x.code) === o.code) ?? {}).reason ?? ""));
      }
    }
  }
  markOrdered();
  return { poolStage, stages: extraStages, orders, chains, budget, llmSessions, tokens, budgetExhausted };
}
