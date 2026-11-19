// 盯盘机械层：把无判断的取数 / 比对步骤从 agent（LLM）剥离到调度器侧（零 token）
// 职责边界（与 AGENTS.md §3.1 / §3.1.2 契约对应）——本模块只做机械步骤（无判断、纯取数与算术）：
//   1. 市场节点读取（云端唯一权威：盘中帧实时节点 + 日级链组合，本地零判定零重放）
//   2. 五项必读数据拉取（盘面分析 / 监管名单 / 账户 / 持仓 / 温度历史）
//   3. 纪律预算计算（出手台账对账补录 + 不可卖暴露 + 板块热度前 3 + 当日委托清单）
//   4. 持仓复核数据代拉（可卖持仓的分时 + 板块归属 + 买入溯源）
//   5. 组装注入块（pi runtime ctx 消费；CLI 命令教学不入块——pipeline 会话无 shell，用法由工具 schema 承载）
// 全链路容错：任何一步失败只降级为「该项不注入 + 提示 agent 自行调用」，绝不阻塞盯盘
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as market from "../skills/mock/market.ts";
import * as trading from "../skills/mock/trading.ts";
import * as journal from "../skills/journal/journal.ts";

// 调度器日志接口（info/warning 两级，由调用方注入）
export interface CtxLogger {
  info: (msg: string) => void;
  warning: (msg: string) => void;
}

// 本地日期 YYYY-MM-DD
function today(): string {
  return journal.localDateString();
}

// 本地时间 HH:MM:SS
function nowHMS(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Unix 秒 → 本地 HH:MM
function tsToHM(ts: unknown): string {
  if (!ts) return "";
  const d = new Date(Number(ts) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 注入块 JSON 紧凑序列化（等价 Python json.dumps(ensure_ascii=False, separators=(",",":"))）
function j(obj: unknown): string {
  return JSON.stringify(obj);
}

// 每轮的市场节点读取（云端唯一权威：盘中帧实时节点 + 日级链组合；失败按缺位注入，下轮自动重试）
async function runNodeStep(log: CtxLogger): Promise<Record<string, unknown> | null> {
  try {
    const node = (await market.readMarketNode()) as Record<string, unknown>;
    if (node.code !== 200) {
      log.warning(`市场节点读取失败: ${String(node.error ?? "未知")}`);
      return node; // 防守信封照常注入（code != 200 时 agent 按读取失败纪律处理）
    }
    return node;
  } catch (e) {
    log.warning(`市场节点读取异常: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// 注入瘦身：盘面分析 / 温度历史（省 token，不改判定事实）
//   纪律：只裁「重复」与「按总纲不得作论据/门槛」的内容——服务端原始数据仍以接口为准（第三方路径不受影响）

// 温度历史：只保留最近 N 个交易日的「大盘温度 / 短线温度」两行
//   理由：其余指标行（涨停数 / 炸板率 / 连板高度 / 各板个股名单）按总纲 §5.1 第 2 条不得作情绪论据，
//   个股名单行属"举例非门槛"；这两行仅供复盘叙述与温度语境参考（节点判定已云端化，不消费该矩阵）
const HISTORY_KEEP_ROWS = ["大盘温度", "短线温度"];
const HISTORY_KEEP_DATES = 5;

// 裁剪温度历史为「最近 N 日 × 温度两行」（拉取失败原样占位）
function slimIndicatorHistory(env: Record<string, unknown> | null): unknown {
  if (env === null) return { __fetch_error: "拉取失败，可自行调用补拉" };
  const data = (env.data ?? null) as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return env;
  const dates = (data.dates ?? []) as unknown[];
  const rows = (data.rows ?? []) as Array<Record<string, unknown>>;
  const keepRows = rows
    .filter((r) => HISTORY_KEEP_ROWS.includes(String(r.label ?? "")))
    .map((r) => ({ label: r.label, values: ((r.values ?? []) as unknown[]).slice(-HISTORY_KEEP_DATES) }));
  return {
    code: env.code,
    data: {
      dates: dates.slice(-HISTORY_KEEP_DATES),
      rows: keepRows,
      note: `已裁剪：仅保留最近 ${HISTORY_KEEP_DATES} 个交易日的 ${HISTORY_KEEP_ROWS.join(" / ")}（其余指标行不进上下文）`,
    },
  };
}

// 去掉方向条目里的个股名单（举例非门槛——总纲 §5.1 第 3 条）
function stripDirectionStocks(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const o = { ...(item as Record<string, unknown>) };
  delete o.stocks;
  return o;
}

// 裁剪盘面分析：顶层 attack/retreat 与 final_analysis 内同名字段重复（去重）、方向内个股名单（去名单）、
//   sentiment_analysis.reasoning（仅供日志/解释）——保留全部判定必需字段（温度 / 情绪 / 对齐 / 方向名 /
//   key_stocks 风向标 / 仓位建议 / 操作建议 / 风险提示 / 综述 / 观察方向）
function slimIntradayAnalysis(env: Record<string, unknown>): Record<string, unknown> {
  if (env.code !== 200) return env;
  const data = env.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return env;
  const out: Record<string, unknown> = { ...data };
  delete out.attack_directions;
  delete out.retreat_directions;
  const final = data.final_analysis as Record<string, unknown> | undefined;
  if (final && typeof final === "object") {
    const f: Record<string, unknown> = { ...final };
    for (const k of ["attack_directions", "retreat_directions", "observe_directions"]) {
      const list = f[k];
      if (Array.isArray(list)) f[k] = list.map(stripDirectionStocks);
    }
    out.final_analysis = f;
  }
  const sent = data.sentiment_analysis as Record<string, unknown> | undefined;
  if (sent && typeof sent === "object") {
    const s = { ...sent };
    delete s.reasoning;
    out.sentiment_analysis = s;
  }
  return { ...env, data: out };
}

// 五项必读之四项接口数据拉取（失败项以 __fetch_error 占位，agent 按退化流程处理）
async function fetchWatchData(): Promise<Record<string, Record<string, unknown>>> {
  const items: Array<[string, () => Promise<Record<string, unknown>>]> = [
    ["盘面分析 market.get_intraday_analysis", () => market.getIntradayAnalysis()],
    ["交易所重点监管股票 market.get_key_watch_stocks", () => market.getKeyWatchStocks()],
    ["账户资金 trading.get_account", () => trading.getAccount()],
    ["当前持仓 trading.get_positions", () => trading.getPositions()],
  ];
  const out: Record<string, Record<string, unknown>> = {};
  for (const [title, call] of items) {
    try {
      const env = await call();
      out[title] = title.startsWith("盘面分析") ? slimIntradayAnalysis(env) : env;
    } catch (exc) {
      out[title] = { __fetch_error: exc instanceof Error ? exc.message : String(exc) };
    }
  }
  return out;
}

// 纪律预算：当日出手台账（含委托对账补录）+ 不可卖暴露 + 板块热度前 3 + 当日委托紧凑清单
async function buildDisciplineBudget(
  root: string,
  todayStr: string,
  accountEnv: Record<string, unknown> | undefined,
  positionsEnv: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | null> {
  // 1) 读当日出手台账
  let journalOut = journal.readDecisions(todayStr) as Record<string, unknown>;
  if (journalOut.code !== 200) journalOut = { code: 404, records: [], buy_count: 0, veto_list: [], buy_by_direction: {} };

  // 2) 拉当日委托，对账补录缺失的 buy 记录（委托同时以紧凑清单注入）
  let ordersEnv: Record<string, unknown> | null = null;
  try {
    const r = await trading.getOrders();
    if (r.code === 200) ordersEnv = r;
  } catch {
    ordersEnv = null;
  }
  const ordersBuys: Array<Record<string, unknown>> = [];
  const ordersUnfilled: Array<Record<string, unknown>> = [];
  if (ordersEnv) {
    for (const o of ((ordersEnv.data ?? []) as Array<Record<string, unknown>>)) {
      if (o.order_type !== 1) continue; // 只处理买入委托
      if (Number(o.deal_volume ?? 0) > 0 && !o.is_invalid) ordersBuys.push(o);
      else if (Number(o.deal_volume ?? 0) <= 0) ordersUnfilled.push(o);
    }
  }
  const journalRecordsRaw = ((journalOut.records ?? []) as Array<Record<string, unknown>>).filter((r) => r.action === "buy");
  const jStatus = (r: Record<string, unknown>): string => String(r.status ?? "filled");
  // 同键判定：同代码 + 同成交量 + 价差 ≤3%（限价单更优成交滑点，如委托 8.49 成交 8.43——
  // 2026-11-04 三重落账教训：pipeline 委托价行 / orders 成交价行 / agent 补录行实为同一笔）
  const sameKey = (r: Record<string, unknown>, code: string, vol: number, price: number): boolean =>
    String(r.stock_code ?? "") === code &&
    Math.trunc(Number(r.volume ?? 0)) === vol &&
    Math.abs(Number(r.price ?? 0) - price) / Math.max(Math.abs(price), 0.01) <= 0.03;
  // 注入口径去重：filled 组内同键多条只留一条（方向信息最全优先，其次最新）；台账文件不动（审计留痕）
  const journalRecords: Array<Record<string, unknown>> = [];
  for (const r of journalRecordsRaw) {
    if (jStatus(r) !== "filled") {
      journalRecords.push(r);
      continue;
    }
    const dupIdx = journalRecords.findIndex(
      (k) => jStatus(k) === "filled" && sameKey(k, String(r.stock_code ?? ""), Math.trunc(Number(r.volume ?? 0)), Number(r.price ?? 0)),
    );
    if (dupIdx < 0) {
      journalRecords.push(r);
      continue;
    }
    const dup = journalRecords[dupIdx]!;
    const rHasDir = r.direction != null && String(r.direction) !== "";
    const dupHasDir = dup.direction != null && String(dup.direction) !== "";
    if ((rHasDir && !dupHasDir) || (rHasDir === dupHasDir && String(r.time ?? "") >= String(dup.time ?? ""))) journalRecords[dupIdx] = r;
  }
  if (journalRecords.length !== journalRecordsRaw.length) {
    const filledDedup = journalRecords.filter((r) => jStatus(r) === "filled");
    const byDir: Record<string, number> = {};
    for (const r of filledDedup) {
      const key = (r.direction as string) || "方向待确认";
      byDir[key] = (byDir[key] ?? 0) + 1;
    }
    journalOut = {
      ...journalOut,
      records: [...journalRecords, ...((journalOut.records ?? []) as Array<Record<string, unknown>>).filter((r) => r.action !== "buy")],
      buy_count: filledDedup.length,
      buy_by_direction: byDir,
    };
  }
  let recovered = 0; // 服务端成交 → 台账补录事实行（agent 未落账）
  let upgraded = 0; // 委托行 → 升级为成交事实（成交价量以服务端为准）
  let cancelled = 0; // 委托未成交 → pending 行标记 cancelled（不计笔数）
  if (ordersBuys.length > 0 || ordersUnfilled.length > 0) {
    for (const o of ordersBuys) {
      const code = String(o.stock_code ?? "");
      const vol = Math.trunc(Number(o.deal_volume ?? 0));
      const price = Number(o.deal_price ?? 0);
      const tHM = tsToHM(o.deal_time) || tsToHM(o.order_time) || undefined;
      // 已有同键成交事实（价差 ≤3% 容差）→ 跳过（幂等）
      const hasFact = journalRecords.some((r) => jStatus(r) === "filled" && sameKey(r, code, vol, price));
      if (hasFact) continue;
      // 有 pending 委托行（先同量、再同代码）→ 原地升级为成交事实（不新增行）
      const pendingSameVol = [...journalRecords]
        .reverse()
        .find((r) => String(r.stock_code ?? "") === code && jStatus(r) === "pending" && Math.trunc(Number(r.volume ?? 0)) === vol);
      const pendingAny = pendingSameVol ?? [...journalRecords].reverse().find((r) => String(r.stock_code ?? "") === code && jStatus(r) === "pending");
      if (pendingAny) {
        const up = journal.updateDecision(todayStr, "buy", code, { status: "filled", price, volume: vol, time: tHM }, { onlyStatus: "pending" });
        if (up.code === 200) {
          upgraded += 1;
          continue;
        }
      }
      // 无匹配 → 按服务端成交补录事实行（成交价量 + 成交时间；方向待 agent 补正）
      const rec = journal.recordDecision(
        todayStr,
        "buy",
        code,
        String(o.stock_name ?? ""),
        null,
        price,
        vol,
        "服务端成交对账补录（agent 未落账）",
        tHM,
        "orders",
        null,
        "filled",
      );
      if (rec.code === 200) recovered += 1;
    }
    // 未成交委托 → 关联 pending 行标记 cancelled（不计笔数；事实以服务端为准）
    for (const o of ordersUnfilled) {
      const code = String(o.stock_code ?? "");
      const up = journal.updateDecision(todayStr, "buy", code, { status: "cancelled", time: tsToHM(o.order_time) || undefined }, { onlyStatus: "pending" });
      if (up.code === 200) cancelled += 1;
    }
    if (recovered > 0 || upgraded > 0 || cancelled > 0) {
      // 对账后重读，保证注入的计数与分组反映成交事实
      const reread = journal.readDecisions(todayStr) as Record<string, unknown>;
      if (reread.code === 200) journalOut = reread;
    }
  }

  // 3) 今日买入不可卖暴露：持仓快照 today_buy_amount 合计 / 账户总资产
  let todayBuyAmount: number | null = null;
  if (positionsEnv && positionsEnv.code === 200) {
    todayBuyAmount =
      Math.round(
        ((positionsEnv.data ?? []) as Array<Record<string, unknown>>)
          .reduce((acc, p) => acc + Number(p.today_buy_amount ?? 0), 0) * 100,
      ) / 100;
  }
  let totalAmount: number | null = null;
  if (accountEnv && accountEnv.code === 200) {
    totalAmount = Number(((accountEnv.data ?? {}) as Record<string, unknown>).total_amount ?? NaN);
    if (!Number.isFinite(totalAmount)) totalAmount = null;
  }
  const unsellableRatio =
    todayBuyAmount !== null && totalAmount ? Math.round((todayBuyAmount / totalAmount) * 1000) / 10 : null;

  // 4) 板块热度前 3（按涨停数）：方向位置锚点（连板高度 height）与共振认证的事实输入
  const hotTop3: Array<Record<string, unknown>> = [];
  try {
    const hotEnv = (await market.getHotSpotList("zt_count", "desc", 3)) as Record<string, unknown>;
    if (hotEnv.code === 200) {
      for (const h of ((hotEnv.data ?? []) as Array<Record<string, unknown>>)) {
        hotTop3.push({ name: h.name, zt_count: Number(h.zt_count ?? 0), height: Number(h.height ?? 0), lb_count: Number(h.lb_count ?? 0) });
      }
    }
  } catch {
    // 拉取失败按缺位注入（下方判空兜底）
  }

  // 5) 当日委托紧凑清单（买卖全量、含最新成交状态）
  const ordersCompact: string[] = [];
  if (ordersEnv) {
    const statusText: Record<number, string> = { 0: "待报", 1: "已报", 2: "部成", 3: "已成", 4: "已撤", 5: "废单" };
    for (const o of ((ordersEnv.data ?? []) as Array<Record<string, unknown>>)) {
      ordersCompact.push(
        `${o.order_type === 1 ? "买" : "卖"} ${o.stock_name}(${o.stock_code})` +
          ` 委${o.order_volume}股@${o.order_price} → ${statusText[Number(o.order_status)] ?? String(o.order_status)}` +
          ` 成交${Number(o.deal_volume ?? 0)}@${o.deal_price ?? 0} ${tsToHM(o.order_time)}` +
          (o.is_invalid ? " [无效]" : ""),
      );
    }
  }

  // 6) 当日委托机器可读清单
  //    pending_orders：未完成委托（待报 / 已报 / 部成未全成）——pipeline 卖链据此扣减有效可卖量、
  //      重复卖出先撤单再下（防超卖）；带 order_no 才能撤单
  //    orders_today：当日全部委托（含已成）——卖链会话据此看到"今天已经卖过什么"，自己保持减仓节奏
  const pendingOrders: Array<Record<string, unknown>> = [];
  const ordersToday: Array<Record<string, unknown>> = [];
  if (ordersEnv) {
    for (const o of ((ordersEnv.data ?? []) as Array<Record<string, unknown>>)) {
      if (o.is_invalid) continue;
      const st = Number(o.order_status ?? -1);
      const orderVol = Math.trunc(Number(o.order_volume ?? 0));
      const dealVol = Math.trunc(Number(o.deal_volume ?? 0));
      const remain = orderVol - dealVol;
      ordersToday.push({
        order_no: String(o.order_no ?? ""),
        side: o.order_type === 1 ? "buy" : "sell",
        code: String(o.stock_code ?? ""),
        name: String(o.stock_name ?? ""),
        volume: orderVol,
        deal_volume: dealVol,
        price: Number(o.order_price ?? 0),
        status: st,
        time: tsToHM(o.order_time),
      });
      if (!(st === 0 || st === 1 || (st === 2 && remain > 0))) continue;
      pendingOrders.push({
        order_no: String(o.order_no ?? ""),
        side: o.order_type === 1 ? "buy" : "sell",
        code: String(o.stock_code ?? ""),
        name: String(o.stock_name ?? ""),
        volume: remain > 0 ? remain : orderVol,
        price: Number(o.order_price ?? 0),
        status: st,
      });
    }
  }

  // 台账与委托都拉不到时无有效内容可注入，返回 null 让调用方标注失败
  if (journalOut.code !== 200 && ordersBuys.length === 0 && todayBuyAmount === null && hotTop3.length === 0 && ordersCompact.length === 0) {
    return null;
  }
  // 笔数以服务端成交为准（委托清单里 deal_volume > 0 的买入笔数）；台账计数仅作交叉核对
  const serverBuyCount = ordersBuys.length;
  const journalBuyCount = Number(journalOut.buy_count ?? 0);
  const rec = {
    orders_buy_count: serverBuyCount,
    journal_buy_count: journalBuyCount,
    recovered,
    upgraded,
    cancelled,
    count_mismatch: serverBuyCount !== journalBuyCount,
  };
  return {
    buy_count: serverBuyCount > 0 || ordersEnv !== null ? serverBuyCount : journalBuyCount,
    pending_count: journalOut.pending_count ?? 0,
    cancelled_count: journalOut.cancelled_count ?? 0,
    buy_by_direction: journalOut.buy_by_direction ?? {},
    veto_list: journalOut.veto_list ?? [],
    journal_ok: journalOut.code === 200,
    orders_fetched: ordersEnv !== null,
    orders_today: ordersCompact,
    pending_orders: pendingOrders,
    orders_today_machine: ordersToday,
    today_buy_amount: todayBuyAmount,
    total_amount: totalAmount,
    unsellable_ratio_pct: unsellableRatio,
    hot_top3: hotTop3,
    reconcile: rec,
  };
}

// 持仓个股详情紧凑键（盯盘消费字段：板块归属 / 换手 / 主力净额）
const STOCK_INFO_COMPACT_KEYS = ["name", "price", "zdf", "turn_z", "amount", "amount_main_str", "hot_categories", "hot_category_identities", "yd_tags", "up_reason"];

// 按买入日回查当日台账的该股最后一条 buy 记录（结构化，供卖链兜底读止损计划；本地文件直读零接口成本）
export function lookupBuyRecord(root: string, stockCode: string, positionDateTs: unknown): Record<string, unknown> | null {
  if (!positionDateTs) return null;
  const dateStr = journal.localDateString(new Date(Number(positionDateTs) * 1000));
  const journalPath = join(root, "data", `trade-journal-${dateStr}.json`);
  let records: Array<Record<string, unknown>> = [];
  try {
    records = ((JSON.parse(readFileSync(journalPath, "utf-8")) as Record<string, unknown>).records ?? []) as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
  let lastBuy: Record<string, unknown> | null = null;
  for (const r of records) {
    if (r.action === "buy" && String(r.stock_code ?? "") === stockCode) lastBuy = r;
  }
  return lastBuy;
}

// 持仓买入溯源：按 position_date 回查当日出手台账 buy 记录（本地文件直读，零接口成本）
// （pipeline 卖链复用——固定输入模板的溯源行与此同源同格式）
export function lookupPositionOrigin(root: string, stockCode: string, positionDateTs: unknown): string {
  if (!positionDateTs) return "溯源：买入日期未知（持仓快照缺 position_date）";
  const lastBuy = lookupBuyRecord(root, stockCode, positionDateTs);
  if (lastBuy === null) {
    const dateStr = journal.localDateString(new Date(Number(positionDateTs) * 1000));
    return `溯源：${dateStr} 台账无该股买入记录 / 文件缺失（早于保留窗口或当日漏记）`;
  }
  const dateStr = journal.localDateString(new Date(Number(positionDateTs) * 1000));
  const base = `溯源：${dateStr} ${String(lastBuy.time ?? "")} 买入 ${String(lastBuy.volume ?? "?")}股@${String(lastBuy.price ?? "?")}`;
  const reason = String(lastBuy.reason ?? "");
  if (lastBuy.source === "orders" || !reason) {
    return `${base}（机械层补录，无 channel / 方向记录——试错仓属性按买入日所处阶段通道判定）`;
  }
  const reasonBrief = reason.length > 90 ? `${reason.slice(0, 90)}…` : reason;
  return `${base}｜方向:${(lastBuy.direction as string) || "未记录"}｜${reasonBrief}`;
}

// 持仓复核数据代拉（可卖持仓的分时 + 板块归属；T+1 当日买入不取数）
async function fetchPositionReviewData(
  root: string,
  positionsEnv: Record<string, unknown> | undefined,
): Promise<{ sellable: Array<Record<string, unknown>>; t1_blocked: Array<Record<string, unknown>> } | null> {
  if (!positionsEnv || positionsEnv.code !== 200) return null;
  const sellable: Array<Record<string, unknown>> = [];
  const t1Blocked: Array<Record<string, unknown>> = [];
  for (const p of ((positionsEnv.data ?? []) as Array<Record<string, unknown>>)) {
    const code = String(p.stock_code ?? "");
    if (!code) continue;
    const origin = lookupPositionOrigin(root, code, p.position_date);
    // T+1 当日买入：只列代码与溯源，不取数（agent 按 §3.3 跳过盘中卖出分析）
    if (Number(p.available_volume ?? 0) <= 0) {
      t1Blocked.push({ code, name: p.stock_name, origin });
      continue;
    }
    const entry: Record<string, unknown> = { code, name: p.stock_name, available_volume: p.available_volume, origin };
    try {
      entry.trendline = await market.getStockMinuteTrendline(code);
    } catch (exc) {
      entry.trendline = { __fetch_error: exc instanceof Error ? exc.message : String(exc) };
    }
    try {
      const info = await market.getStockInfo(code);
      entry.info = Object.fromEntries(STOCK_INFO_COMPACT_KEYS.map((k) => [k, info[k] ?? null]));
    } catch (exc) {
      entry.info = { __fetch_error: exc instanceof Error ? exc.message : String(exc) };
    }
    sellable.push(entry);
  }
  return { sellable, t1_blocked: t1Blocked };
}

// 复盘轮机械层注入块：事实一律取服务端（成交 / 持仓 / 账户 / 盘面 / 状态机）；
// 本地台账只作为「语义标注层」注入（否决理由 / channel / 止损计划——服务端没有这些字段）；
// 决策档案（当日盯盘总结正文）由复盘会话自行读 data/watch-summary-{date}.md（read_file 白名单内）
export async function buildReviewContext(root: string, logger?: CtxLogger): Promise<string> {
  const noop: CtxLogger = { info: () => {}, warning: () => {} };
  const log = logger ?? noop;
  const lines: string[] = [];
  try {
    const todayStr = today();
    const fetchedAt = nowHMS();
    lines.push(
      `【调度器机械层前置（复盘 · ${fetchedAt} 完成）——以下数据由调度器代取，直接消费，不要重复调用对应接口】`,
      "",
      "■ 数据口径（复盘第一原则）：",
      "- **成交 / 持仓 / 账户 / 盘面 / 状态机 = 服务端权威事实**，一律以本块为准；本地台账只提供服务端没有的语义标注（方向归属 / channel / 否决理由 / 止损计划）",
      "- **决策档案**（当日每轮「当时怎么想」）= data/watch-summary-{当日}.md，已由复盘流水线在会话用户消息中**全文预喂**（无需再 read_file 重复读取）",
      "",
    );
    // 当日委托与成交（服务端）
    let ordersEnv: Record<string, unknown> | null = null;
    try {
      ordersEnv = (await trading.getOrders()) as Record<string, unknown>;
    } catch (e) {
      log.warning(`复盘注入：当日委托拉取失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    lines.push("■ 当日委托与成交（服务端 trading.get_orders 全量；成交 = deal_volume > 0）：");
    if (ordersEnv && ordersEnv.code === 200) {
      const rows = (ordersEnv.data ?? []) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        lines.push("（当日无委托记录）");
      } else {
        for (const o of rows) {
          lines.push(
            `- ${o.order_type === 1 ? "买" : "卖"} ${o.stock_name}(${o.stock_code}) 委${o.order_volume}股@${o.order_price} → 状态${String(o.order_status ?? "?")}` +
              ` 成交${Number(o.deal_volume ?? 0)}股@${Number(o.deal_price ?? 0)} 时间${tsToHM(o.deal_time) || tsToHM(o.order_time) || "?"}` +
              (o.is_invalid ? " [无效单]" : ""),
          );
        }
      }
    } else {
      lines.push("（拉取失败——按缺位处理，成交事实以本块缺位说明为准）");
    }
    // 当前持仓 + 账户（服务端）
    for (const [title, call] of [
      ["当前持仓（服务端 trading.get_positions）", () => trading.getPositions()],
      ["账户资金（服务端 trading.get_account）", () => trading.getAccount()],
    ] as Array<[string, () => Promise<Record<string, unknown>>]>) {
      try {
        const env = await call();
        lines.push("", `■ ${title}：`, j(env));
      } catch (e) {
        lines.push("", `■ ${title}：拉取失败（${e instanceof Error ? e.message : String(e)}）`);
      }
    }
    // 当日盘面摘要（服务端）
    try {
      const env = (await market.getIntradayAnalysis()) as Record<string, unknown>;
      const data = (env.data ?? null) as Record<string, unknown> | null;
      if (data) {
        const final = (data.final_analysis ?? {}) as Record<string, unknown>;
        const sentiment = (data.sentiment_analysis ?? {}) as Record<string, unknown>;
        const attacks = (final.attack_directions ?? []) as Array<Record<string, unknown>>;
        const retreats = (final.retreat_directions ?? []) as Array<Record<string, unknown>>;
        lines.push(
          "",
          "■ 当日盘面摘要（服务端 market.get_intraday_analysis 核心字段）：",
          `- 市场节点：${String(data.market_node ?? "缺位")}｜大盘五档：${String(data.temperature_level ?? "缺位")}｜短线情绪：${String(sentiment.sentiment_label ?? "缺位")}（${String(sentiment.sentiment_score ?? "缺位")} 分）｜情绪资金对齐：${String(final.sentiment_capital_alignment ?? "缺位")}｜仓位上限：${String(final.position_limit ?? "缺位")}%｜分析帧：${String(data.analyze_time ?? "缺位")}`,
          `- 盘面综述：${String(final.market_overview ?? "缺位").slice(0, 400)}`,
          `- 活跃方向：${attacks.map((a) => String(a.direction ?? "")).join("、") || "无"}｜撤退方向：${retreats.map((r) => String(r.direction ?? "")).join("、") || "无"}`,
          `- 操作建议：${String(final.action_advice ?? "缺位").slice(0, 300)}`,
        );
      } else {
        lines.push("", "■ 当日盘面摘要：缺位（服务端无当日分析）");
      }
    } catch (e) {
      lines.push("", `■ 当日盘面摘要：拉取失败（${e instanceof Error ? e.message : String(e)}）`);
    }
    // 语义标注层（本地台账：否决清单 + 成交行的 channel / 止损计划 / 方向）
    const dec = journal.readDecisions(todayStr) as Record<string, unknown>;
    const records = (dec.records ?? []) as Array<Record<string, unknown>>;
    const filled = records.filter((r) => r.action === "buy" && String(r.status ?? "filled") === "filled");
    const vetoes = records.filter((r) => r.action === "veto");
    lines.push(
      "",
      "■ 语义标注层（本地台账——只有服务端没有的信息；成交笔数以服务端为准，勿据此改写事实）：",
      `- 当日成交标注（${filled.length} 笔）：` +
        (filled.length > 0
          ? filled
              .map((r) => `${r.stock_name ?? r.stock_code}(${r.stock_code}) ${r.volume}股@${r.price} 方向=${r.direction ?? "未记录"}${r.stop_loss_pct ? ` 止损${r.stop_loss_pct}%` : ""}｜${String(r.reason ?? "").slice(0, 120)}`)
              .join("；")
          : "无"),
      `- 当日否决记录（${vetoes.length} 条）：` +
        (vetoes.length > 0
          ? vetoes.map((r) => `${r.stock_name ?? r.stock_code}(${r.stock_code}) ${r.time}｜${String(r.reason ?? "").slice(0, 100)}`).join("；")
          : "无"),
    );
    return lines.join("\n");
  } catch (exc) {
    log.warning(`复盘注入块整体异常(降级为无注入): ${exc instanceof Error ? exc.message : String(exc)}`);
    return "";
  }
}

// 机械层总入口：执行全部机械步骤并组装注入块（整体异常返回空串，调度器退化为无注入模式）
export async function buildWatchContext(root: string, logger?: CtxLogger): Promise<string> {
  const noop: CtxLogger = { info: () => {}, warning: () => {} };
  const log = logger ?? noop;
  try {
    const todayStr = today();
    const fetchedAt = nowHMS();

    // 市场节点（云端唯一权威：盘中帧实时节点 + 日级链组合；失败按缺位注入，下轮自动重试）
    const node = await runNodeStep(log);
    const marketData = await fetchWatchData();

    // 纪律预算：复用同轮账户 / 持仓拉取
    const budget = await buildDisciplineBudget(
      root,
      todayStr,
      marketData["账户资金 trading.get_account"],
      marketData["当前持仓 trading.get_positions"],
    );

    const lines: string[] = [
      `【调度器机械层前置（${fetchedAt} 完成）——以下数据与结果由调度器代取得，`
        + `除标注 __fetch_error / 拉取失败 / 需更新鲜数据外，不要重复调用对应接口，直接消费】`,
      "",
      `■ 市场节点（云端唯一权威，市场.read_market_node 输出）：`,
      node !== null
        ? j(node)
        : "读取失败（agent 按总纲「节点读取失败 → 当日防守处理并记录」纪律执行，可自行调用 market.read_market_node 补拉）",
    ];

    const fourItemsStart = lines.length;
    lines.push(
      "",
      `■ 五项必读之四项接口数据（第 1 项市场节点见上节；${fetchedAt} 拉取快照；`
        + "标注 __fetch_error 的项按总纲退化流程处理或自行调用补拉）：",
    );
    Object.entries(marketData).forEach(([title, payload], i) => {
      lines.push(`[${i + 1}] ${title}：`, j(payload));
    });
    // 附带温度历史：仅供温度语境叙述参考（节点判定已云端化、不消费该矩阵）
    let historyEnv: Record<string, unknown> | null = null;
    try {
      historyEnv = await market.getDailyIndicatorsHistory();
    } catch (exc) {
      log.warning(`机械层温度历史拉取失败: ${exc instanceof Error ? exc.message : String(exc)}`);
      historyEnv = null;
    }
    lines.push(
      "附 温度历史 market.get_daily_indicators_history（已裁剪：最近 5 个交易日的大盘温度 / 短线温度）：",
      j(slimIndicatorHistory(historyEnv)),
    );

    // 持仓复核数据注入（§3.3）：可卖持仓的分时 + 板块归属 + 买入溯源代拉
    const posReview = await fetchPositionReviewData(root, marketData["当前持仓 trading.get_positions"]);
    const posReviewStart = lines.length;
    lines.push(
      "",
      `■ 持仓复核数据（可卖持仓分时 + 板块归属 + 买入溯源，${fetchedAt} 拉取快照；`
        + "按策略加速止盈四信号直接判定，标 __fetch_error 的项自行补拉；"
        + "溯源已含买入日 / channel / 方向——盘中轮无需再翻台账 read_decisions）：",
    );
    if (posReview === null) {
      lines.push(
        "持仓快照缺位，本轮未代拉（agent 按退化流程自行调 market.get_stock_minute_trendline / market.get_stock_info）",
      );
    } else if (posReview.sellable.length === 0 && posReview.t1_blocked.length === 0) {
      lines.push("当前无持仓");
    } else {
      posReview.sellable.forEach((e, i) => {
        lines.push(
          `[${i + 1}] ${e.code} ${e.name}（可卖 ${e.available_volume} 股）`,
          String(e.origin),
          `分时：${j(e.trendline)}`,
          `板块归属与资金：${j(e.info)}`,
        );
      });
      if (posReview.t1_blocked.length > 0) {
        lines.push("今日买入 T+1 不可卖（未代拉数据，跳过盘中卖出分析）：");
        for (const e of posReview.t1_blocked) {
          lines.push(`- ${e.code} ${e.name}`, `  ${e.origin}`);
        }
      }
    }

    // 纪律预算注入（§3.1.2）：纯事实数字，消费纪律（复买核对 / 发酵晚段买点约束）见核心层策略；暴露数字仅复盘参考
    const budgetStart = lines.length;
    if (budget === null) {
      lines.push(
        "",
        "■ 纪律预算：本轮计算失败（按退化流程自行取数判定：journal.read_decisions + "
          + "trading.get_orders + market.get_hot_spot_list，下轮自动重试）",
      );
    } else {
      // 出手笔数 + 方向分组（台账读取失败时不显示误导性计数，标注降级）
      let buyLine: string;
      if (budget.journal_ok !== true) {
        buyLine = `台账读取失败（当日买入成交委托 ${(budget.reconcile as Record<string, unknown>).orders_buy_count ?? 0} 笔可参考，自行补拉 journal.read_decisions）`;
      } else {
const dirParts = Object.entries(budget.buy_by_direction as Record<string, number>)
        .map(([k, v]) => `${k} ${v} 笔`)
        .join("、");
        const pendingCount = Number(budget.pending_count ?? 0);
        const cancelledCount = Number(budget.cancelled_count ?? 0);
        const extraCounts =
          pendingCount > 0 || cancelledCount > 0 ? `（另有未成交 ${pendingCount} 笔 / 已撤废 ${cancelledCount} 笔，不计笔数）` : "";
        buyLine = dirParts ? `${budget.buy_count} 笔（${dirParts}）${extraCounts}` : `0 笔${extraCounts}`;
      }
      const vetoParts = ((budget.veto_list as Array<Record<string, unknown>>) ?? [])
        .map((v) => `${v.stock_name || v.stock_code}（${v.time}，${String(v.reason ?? "").slice(0, 40)}）`)
        .join("；");
      let exposurePart: string;
      if (budget.today_buy_amount !== null && budget.total_amount !== null && budget.total_amount !== 0) {
        exposurePart = `${budget.today_buy_amount} 元 / 总资产 ${budget.total_amount} 元 = ${budget.unsellable_ratio_pct}%`;
      } else {
        exposurePart = "计算缺位（账户或持仓拉取失败）";
      }
      const hotParts = ((budget.hot_top3 as Array<Record<string, unknown>>) ?? [])
        .map((h) => `${h.name}（涨停 ${h.zt_count} 只 / 最高 ${h.height} 板）`)
        .join("、");
const rec = budget.reconcile as Record<string, unknown>;
      let reconcileNote: string;
      if (budget.orders_fetched !== true) {
        reconcileNote = `委托拉取失败，本轮未对账（台账成交 ${rec.journal_buy_count ?? "?"} 笔，下轮自动重试）`;
      } else if (rec.count_mismatch === true) {
        reconcileNote = `成交笔数不一致（服务端 ${rec.orders_buy_count ?? "?"} 笔 / 台账 ${rec.journal_buy_count ?? "?"} 笔）——笔数以服务端为准，台账差异待复核`;
      } else if (Number(rec.recovered ?? 0) > 0 || Number(rec.upgraded ?? 0) > 0 || Number(rec.cancelled ?? 0) > 0) {
        reconcileNote = `已对账（成交升级 ${Number(rec.upgraded ?? 0)} 笔 / 补录 ${Number(rec.recovered ?? 0)} 笔 / 未成交销账 ${Number(rec.cancelled ?? 0)} 笔）`;
      } else {
        reconcileNote = "一致（笔数以服务端成交为准）";
      }
      const ordersParts = ((budget.orders_today as string[]) ?? []).join("；");
      const pendingOrders = (budget.pending_orders as Array<Record<string, unknown>>) ?? [];
      const ordersToday = (budget.orders_today_machine as Array<Record<string, unknown>>) ?? [];
      lines.push(
        "",
        "■ 纪律预算（机械层算术事实，消费纪律见核心层策略「出手节奏与组合纪律」）：",
        "- 数据口径：成交与持仓事实以服务端为准；本地台账只提供服务端没有的语义标注（方向归属 / channel / 否决理由 / 止损计划）",
        `- 当日已出手 buy（服务端成交笔数）：${buyLine}`,
        `- 今日买入不可卖暴露（T+1，复盘参考事实，不作开仓闸）：${exposurePart}`,
        `- 当日否决记录：${vetoParts || "无"}（当日复买须先推翻原否决理由）`,
        `- 板块热度前 3（按涨停数）：${hotParts || "无"}（height = 板块内最高连板高度，方向发酵深度锚点）`,
        `- 当日委托（买卖全量含最新状态；下单后成交确认看这里或下一轮注入，不必自调 get_orders）：${ordersParts || "无"}`,
        `- 台账对账：${reconcileNote}`,
      );
      // 机器可读纪律预算（pipeline 消费：在途委托 → 有效可卖量扣减 / 重复卖出先撤单再下；
      //   当日全部委托 → 卖链会话自见"今天已卖过什么"，自己保持减仓节奏）
      lines.push(
        "",
        "■ 纪律预算机器可读（pipeline 消费；在途委托＝待报 / 已报 / 部成未全成）：",
        j({ pending_orders: pendingOrders, orders_today: ordersToday }),
      );
    }

    // 注入块组成体积日志（字符，按节边界差分）：供 token 消耗排查与后续裁剪定位大头
    const bounds: Array<[string, number]> = [
      ["头部+市场节点", 0],
      ["四项数据+温度历史", fourItemsStart],
      ["持仓复核", posReviewStart],
      ["纪律预算", budgetStart],
      ["", lines.length],
    ];
    log.info(
      `注入块组成(字符): ${bounds
        .slice(0, -1)
        .map(([name, start], i) => `${name}=${lines.slice(start, bounds[i + 1]![1]).join("\n").length}`)
        .join(" ")} 总计=${lines.join("\n").length}`,
    );
    return lines.join("\n");
  } catch (exc) {
    log.warning(`机械层前置整体异常(降级为无注入): ${exc instanceof Error ? exc.message : String(exc)}`);
    return "";
  }
}
