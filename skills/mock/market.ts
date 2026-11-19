// 行情查询 SDK：大盘、板块、个股、热点、事件驱动等行情数据查询入口（行为对齐原 Python market.py）
// 认证与请求基础设施见 http.ts；接口契约（字段表 / 枚举 / 默认值）的权威定义见各函数注释与 SKILL.md
import { apiGet, apiPost } from "./http.ts";

// ===== 一、大盘维度 =====

// 获取首页大盘指标汇总（指标数组 / 交易时段 / 当前阶段 stage；无信封包装）
export async function getSummary(): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/summary")) as Record<string, unknown>;
}

// 获取今日涨停时间轴（code/name/zdt_time/zdt_type/theme 等）
export async function getZtTimeline(): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/zt_timeline")) as Record<string, unknown>;
}

// 获取指标分时趋势线（code：pjgj/zjln/zlje/ztjs/dmjs/zbl/szjs/temperature）
export async function getIndicatorTrendline(code: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/indicator_trendline", { code })) as Record<string, unknown>;
}

// 获取历史指标矩阵数据（复盘用：dates/rows/hot_spots）
export async function getDailyIndicatorsHistory(): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/daily_indicators_history")) as Record<string, unknown>;
}

// 获取全天异动时间轴（复盘用；date 基准日、since 增量游标 HH:MM）
export async function getDailySummary(date?: string, since?: string): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {};
  if (date) params.date = date;
  if (since) params.since = since;
  return (await apiGet("/api/web/yidong_timeline", params)) as Record<string, unknown>;
}

// ===== 二、板块维度 =====

// 获取热点分类列表（sort_by：avg_zdf/zt_count/lb_count/dr_count；默认 dr_count 降序 20 条）
export async function getHotSpotList(sortBy = "dr_count", sortOrder = "desc", limit = 20): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/hot_spot_list", { sort_by: sortBy, sort_order: sortOrder, limit })) as Record<string, unknown>;
}

// 获取热点分类的成分股列表（sort_by：zdf/price/main_amount/turn_z/market_value）
export async function getHotSpotComponents(name: string, sortBy = "zdf", sortOrder = "desc"): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/hot_spot_components", { name, sort_by: sortBy, sort_order: sortOrder })) as Record<string, unknown>;
}

// 获取热点分类中被淘汰的股票列表
export async function getHotSpotEliminated(name: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/hot_spot_eliminated", { name })) as Record<string, unknown>;
}

// 获取热点分类的主力资金分时趋势线
export async function getHotSpotTrendline(name: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/hot_spot_trendline", { name })) as Record<string, unknown>;
}

// 获取某日热点分类统计数据（复盘用；date 缺省最近交易日）
export async function getHotSpotDailyStats(date?: string): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {};
  if (date) params.date = date;
  return (await apiGet("/api/web/hot_spot_daily_stats", params)) as Record<string, unknown>;
}

// 批量获取多日热点分类统计数据（趋势分析用；默认 10 日）
export async function getHotSpotDailyStatsBatch(name: string, days = 10): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/hot_spot_daily_stats_batch", { name, days })) as Record<string, unknown>;
}

// 获取某日排名前 N 的热点分类（默认 10；范围 1-100）
export async function getTopHotSpots(date?: string, limit = 10): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = { limit };
  if (date) params.date = date;
  return (await apiGet("/api/web/top_hot_spots", params)) as Record<string, unknown>;
}

// 获取热点分类在指定日期的成分股历史快照
export async function getHotSpotComponentsByDate(name: string, date: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/hot_spot_components_by_date", { name, date })) as Record<string, unknown>;
}

// ===== 三、个股维度 =====

// 裁掉分时序列尾部的 null 占位（服务端用 null 占位未到时间点），返回同步裁剪后的双序列
function trimTailPlaceholders(labels: unknown[], series: unknown[]): [unknown[], unknown[]] {
  let last = -1;
  for (let i = 0; i < series.length; i++) {
    if (series[i] !== null && series[i] !== undefined) last = i;
  }
  return [labels.slice(0, last + 1), series.slice(0, last + 1)];
}

// 获取个股详情（name/price/zdf/turn_z/amount_main/hot_categories/up_reason 等；无信封包装）
// 注：服务端附带的 reason_items 长文本已剥离（与原实现一致，防上下文膨胀）
export async function getStockInfo(stockCode: string): Promise<Record<string, unknown>> {
  const info = (await apiGet("/api/web/stock_info", { code: stockCode })) as Record<string, unknown>;
  delete info.reason_items;
  return info;
}

// 获取日 K 线数据（date/open/close/high/low/volume/amount/zdf；无信封包装，直接返回数组）
export async function getDailyKData(code: string, days = 30): Promise<unknown[]> {
  return (await apiGet("/api/web/daily_k_data", { scene: "stock", code, days })) as unknown[];
}

// 获取个股当日分时趋势线（涨跌幅序列；已裁掉未到时间点的尾部占位）
export async function getStockTrendline(code: string): Promise<Record<string, unknown>> {
  const resp = (await apiGet("/api/web/stock_trendline", { code })) as Record<string, unknown>;
  const data = (resp.data ?? {}) as Record<string, unknown>;
  const [labels, zdfData] = trimTailPlaceholders(
    (data.labels ?? []) as unknown[],
    (data.zdf_data ?? []) as unknown[],
  );
  data.labels = labels;
  data.zdf_data = zdfData;
  return resp;
}

// 获取个股分时趋势线（多轴：涨跌幅全序列 + 主力净额快照单值）
// y2.data 仅 1 个元素（当日主力净额快照，亿）；fund_trend / fund_divergence 恒 null（分时主力序列已下线）
export async function getStockMinuteTrendline(code: string): Promise<Record<string, unknown>> {
  const trendResp = (await apiGet("/api/web/stock_trendline", { code })) as Record<string, unknown>;
  const trend = (trendResp.data ?? {}) as Record<string, unknown>;
  const [labels, zdfData] = trimTailPlaceholders(
    (trend.labels ?? []) as unknown[],
    (trend.zdf_data ?? []) as unknown[],
  );

  // 主力净额快照：/stock_info 的 amount_main（元）转亿
  const info = (await apiGet("/api/web/stock_info", { code })) as Record<string, unknown>;
  let mainAmountYi: number | null = null;
  if (info.amount_main !== null && info.amount_main !== undefined) {
    mainAmountYi = Math.round((Number(info.amount_main) / 1e8) * 10000) / 10000;
  }
  const y2Data = mainAmountYi !== null ? [mainAmountYi] : [];
  const y1Valid = (zdfData as unknown[]).filter((v) => v !== null && v !== undefined) as number[];
  return {
    labels,
    y1: {
      title: "涨跌度",
      unit: "%",
      data: zdfData,
      min: y1Valid.length ? Math.min(...y1Valid) : 0,
      max: y1Valid.length ? Math.max(...y1Valid) : 0,
    },
    y2: {
      title: "主力",
      unit: "亿",
      data: y2Data,
      min: mainAmountYi ?? 0,
      max: mainAmountYi ?? 0,
    },
    fund_trend: null,
    fund_divergence: null,
  };
}

// 获取个股历史分时趋势线（复盘用）
export async function getStockTrendlineHistory(code: string, date: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/stock_trendline_history", { code, date })) as Record<string, unknown>;
}

// 获取某日连板股列表（默认 200，最大 500）
export async function getLianbanStocks(date?: string, limit = 200): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = { limit };
  if (date) params.date = date;
  return (await apiGet("/api/web/lianban_stocks", params)) as Record<string, unknown>;
}

// 获取个股近 N 个交易日完整日级行情（复盘用；MA/主力/涨跌停封单全字段；默认 5 日）
export async function getStockDailyHistory(code: string, days = 5): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/stock_daily_history", { code, days })) as Record<string, unknown>;
}

// 获取当天成交额前 30 的个股（mode=amount_top，纯列表不带分时序列）
export async function getAmountTop(): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/strategy_trend_stocks", {
    mode: "amount_top",
    limit: 30,
    with_intraday: "false",
  })) as Record<string, unknown>;
}

// 获取大市值高涨幅个股（涨跌各返回；data 为 {up:[], down:[]}）
export async function getLargeCapStocks(): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/large_cap_stocks")) as Record<string, unknown>;
}

// 获取主力净流出前 20 的个股
export async function getMainOutflowTop(): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/main_outflow_top")) as Record<string, unknown>;
}

// 获取策略趋势股列表（strategy_id 见 SKILL.md；with_intraday=false 可大幅减小响应；sort_by="pool" = 策略池自身顺序）
// with_analysis=true 附加分析辅助字段：ma5/ma10/ma20/ma30 均价（盘中实时）、zdf_high/zdf_low 日内区间、
// amount_main_ratio 主力净流入占比(%)——趋势初筛（多头排列 / 现价日内位置 / 主力相对强度）可直接用，不必逐只拉日 K；
// 服务端默认 false（盯盘页等纯展示省流），SDK 默认 true（agent 选股场景）
export async function getStrategyTrendStocks(strategyId: number, mode = "", limit = 50, withIntraday = true, sortBy = "", withAnalysis = true): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/strategy_trend_stocks", {
    strategy_id: strategyId,
    mode,
    limit,
    with_intraday: withIntraday,
    sort_by: sortBy,
    with_analysis: withAnalysis,
  })) as Record<string, unknown>;
}

// 获取小时热度榜前 30 的个股（sort_by：rank/zdf/main_amount）
export async function getHourlyHotTop(sortBy = "rank", sortDir = "desc"): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/hourly_hot_top", { sort_by: sortBy, sort_dir: sortDir })) as Record<string, unknown>;
}

// 获取近 11 个交易日交易所重点监管股票名单（**禁买名单**）
export async function getKeyWatchStocks(): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/key_watch_stocks")) as Record<string, unknown>;
}

// 获取主力净流入前 20 的个股
export async function getMainInflowTop(): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/main_inflow_top")) as Record<string, unknown>;
}

// 获取近四日连板天梯数据（end_date 缺省取最近 4 个交易日）
export async function getConsecutiveBoardLadder(endDate?: string): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {};
  if (endDate) params.end_date = endDate;
  return (await apiGet("/api/web/consecutive_board_ladder", params)) as Record<string, unknown>;
}

// 获取近 N 日热点轮动数据（组合接口组装：日期取 daily_indicators_history 剔除今日，逐日取 hot_spot_daily_stats）
export async function getHotSpotRotation(days = 5, topN = 9): Promise<Record<string, unknown>> {
  const hist = (await apiGet("/api/web/daily_indicators_history")) as Record<string, unknown>;
  const histData = (hist.data ?? {}) as Record<string, unknown>;
  const todayStr = new Date().toISOString().slice(0, 10);
  const allDates = ((histData.dates ?? []) as string[]).filter((d) => d < todayStr);
  const dates = allDates.slice(-days);

  const perDay: Array<Array<Record<string, unknown>>> = [];
  for (const d of dates) {
    const dayResp = (await apiGet("/api/web/hot_spot_daily_stats", { date: d })) as Record<string, unknown>;
    const rows = ((dayResp.data ?? []) as Array<Record<string, unknown>>).slice();
    rows.sort((a, b) => ((Number(b.zt_count) || 0) + (Number(b.dr_count) || 0)) - ((Number(a.zt_count) || 0) + (Number(a.dr_count) || 0)));
    perDay.push(rows.slice(0, topN));
  }

  // 转置为「每行一个排名、每列一个日期」矩阵（与原契约一致）
  const cells: Array<Array<Record<string, unknown> | null>> = [];
  for (let ri = 0; ri < topN; ri++) {
    const row: Array<Record<string, unknown> | null> = [];
    for (let di = 0; di < dates.length; di++) {
      const r = perDay[di]?.[ri];
      if (r) {
        row.push({
          name: r.hot_spot_name,
          score: (Number(r.zt_count) || 0) + (Number(r.dr_count) || 0),
          zt_count: Number(r.zt_count) || 0,
          dr_count: Number(r.dr_count) || 0,
          all_avg_zdf: Number(r.all_avg_zdf) || 0,
        });
      } else {
        row.push(null);
      }
    }
    cells.push(row);
  }
  return {
    code: 200,
    message: "success",
    data: {
      dates: dates.map((d) => d.slice(5)),
      rank_labels: Array.from({ length: topN }, (_, i) => i + 1),
      cells,
    },
  };
}

// 获取最新一条盘中 LLM 盘面分析结果（agent 盘面分析的唯一权威源；data=None/status=failed 时按总纲退化流程）
// 附带云端增强字段：market_node（短线主引擎实时节点，十词）、temperature_level（大盘五档）、
// temperature_delta（当帧 − 前一交易日大盘收盘分值，机读参考、不进判定）
export async function getIntradayAnalysis(): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/intraday_analysis")) as Record<string, unknown>;
}

// ===== 市场节点（云端唯一权威；本地零判定、零缓存、零重放） =====

// 本地日期 YYYY-MM-DD（与 journal.localDateString 同口径）
function localDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 本地时间 HH:MM:SS
function localHMS(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 冰点链 / 升温链节点词集合（云端十词子集，仅用于通道资格词映射，不做任何节点判定）
const ICE_CHAIN = ["冰点", "连续冰点"];
const UP_CHAIN = ["升温", "连续升温"];
// 禁新开仓节点组（云端节点 × 操作映射：防守 / 只兑现语义）
const NO_NEW_POSITION_NODES = ["降温", "连续降温", "高潮降温", "高潮", "连续高潮"];
// 只兑现不加仓节点组（高潮链含高潮降温事件日）
const REALIZE_ONLY_NODES = ["高潮", "连续高潮", "高潮降温"];

// 获取双链情绪节点结构化序列（云端 /market_node_series，登录态）
// sentiment_chain: [{date, score, node}]（倒序）、market_chain: [{date, score, level, node, has_alert}]（倒序）、
// today_included: 盘中 false（链到昨日）、盘后 true；复盘叙述与通道资格昨日锚的序列源
export async function getMarketNodeSeries(days = 90): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/market_node_series", { days })) as Record<string, unknown>;
}

// 市场节点读取 + 通道资格派生（盘中第 0 步唯一入口；无状态纯函数组合，节点判定全在云端）
//
// 数据源：盘中帧 market_node（实时）+ 日级链昨日定格节点（分层锚）。
// 通道资格映射（设计文档 §五，云端节点词零分值条件）：
//   a_open  = 昨日=连续冰点 且 当帧 ∈ 冰点链（双冰背景仍冰，冰中低吸）
//   a2_open = 昨日 ∈ 冰点链（首冰次日与双冰后通用的共振试错资格）
//   b_open  = 昨日=冰点 且非连续（首冰次日的尾盘低吸资格；当帧分流留给盘中两件套）
//   c_open  = 当帧 ∈ 升温链（升温=轻仓先手 / 连续升温=主出手窗口，仓位分档见 40 §二A）
//   d_open  = 当帧 ∈ 升温链 ∪ 冰点链 ∪ {冰点回暖}（节点许可窗口内的板块级机会）
//   ef_open = 当帧=冰点回暖（脱冰首日修复试探，E/F 窗口）
// 卖侧基调：forbidden_new_position / realize_only（云端节点 × 操作映射的直接代码化）
// 降级：当帧节点缺位（LLM 失败帧 / 首帧未生成）→ effective_node 取昨日链末节点并置 node_degraded=true
//（降级期间盘面按总纲退化流程处理，新开仓跳过）；两请求均失败 → code 502 防守信封
export async function readMarketNode(): Promise<Record<string, unknown>> {
  const today = localDate();
  const [frameEnv, seriesEnv] = await Promise.all([
    getIntradayAnalysis().catch((e: unknown) => ({ __error: e instanceof Error ? e.message : String(e) })),
    getMarketNodeSeries(90).catch((e: unknown) => ({ __error: e instanceof Error ? e.message : String(e) })),
  ]);

  // 日级链昨日锚：sentiment_chain 中 date < 当日的最新一条（盘中/盘后口径一致）
  let yesterday: Record<string, unknown> | null = null;
  let prevNode: string | null = null;
  let todayIncluded: boolean | null = null;
  if (!(seriesEnv instanceof Object) || !("__error" in seriesEnv)) {
    const env = seriesEnv as Record<string, unknown>;
    if (env.code === 200) {
      const data = (env.data ?? {}) as Record<string, unknown>;
      const chain = (Array.isArray(data.sentiment_chain) ? data.sentiment_chain : []) as Array<Record<string, unknown>>;
      todayIncluded = data.today_included === true;
      const past = chain.filter((r) => String(r.date ?? "") < today);
      yesterday = past[0] ?? null;
      prevNode = past[1] ? (past[1].node as string | null) ?? null : null;
    }
  }

  // 盘中帧节点（缺位 → 降级用昨日节点）
  let frameNode: string | null = null;
  let frameLevel: string | null = null;
  if (!(frameEnv instanceof Object) || !("__error" in frameEnv)) {
    const env = frameEnv as Record<string, unknown>;
    if (env.code === 200 && env.data && typeof env.data === "object") {
      const data = env.data as Record<string, unknown>;
      frameNode = typeof data.market_node === "string" ? data.market_node : null;
      frameLevel = typeof data.temperature_level === "string" ? data.temperature_level : null;
    }
  }
  const yesterdayNode = yesterday ? (yesterday.node as string | null) ?? null : null;
  const degraded = frameNode === null;
  const effective = frameNode ?? yesterdayNode;

  // 链与帧双双缺位 → 防守信封（调用方按"节点读取失败 → 当日防守处理并记录"纪律执行）
  if (effective === null) {
    return {
      code: 502,
      error: "云端节点不可用：盘中帧与日级链均未取到节点（agent 当日按防守处理并记录，下轮自动重试）",
      defensive: true,
      trade_date: today,
      time: localHMS(),
    };
  }

  // 通道资格派生（云端节点词映射，无状态）
  const yesterdayInIce = yesterdayNode !== null && ICE_CHAIN.includes(yesterdayNode);
  const inIce = ICE_CHAIN.includes(effective);
  const inUp = UP_CHAIN.includes(effective);
  const channels = {
    a_open: yesterdayNode === "连续冰点" && inIce,
    a2_open: yesterdayInIce,
    b_open: yesterdayNode === "冰点",
    c_open: inUp,
    d_open: inUp || inIce || effective === "冰点回暖",
    ef_open: effective === "冰点回暖",
  };
  return {
    code: 200,
    trade_date: today,
    time: localHMS(),
    market_node: frameNode, // 当帧实时节点（可 null）
    node_degraded: degraded, // 当帧节点缺位 → effective_node 已退回昨日链末节点
    effective_node: effective, // 通道资格与展示所用节点（= 当帧节点，缺位时 = 昨日节点）
    temperature_level: frameLevel, // 当帧大盘五档（冰点/偏冷/常温/偏热/亢奋）
    yesterday_node: yesterdayNode,
    yesterday_score: yesterday ? yesterday.score ?? null : null,
    yesterday_date: yesterday ? yesterday.date ?? null : null,
    prev_node: prevNode, // 前日节点（叙述参考）
    today_included: todayIncluded,
    forbidden_new_position: NO_NEW_POSITION_NODES.includes(effective), // 降温链 / 高潮链 / 高潮降温 → 禁新开仓
    realize_only: REALIZE_ONLY_NODES.includes(effective), // 高潮链（含高潮降温）→ 只兑现不加仓
    channels,
  };
}

// 批量获取多只股票的实时涨跌幅（codes 逗号分隔）
export async function getBatchStockZdf(codes: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/batch_stock_zdf", { codes })) as Record<string, unknown>;
}

// ===== "今天炒什么"事件维度 =====

// 获取"今天炒什么"近 N 个交易日事件列表（include_detail=true 附带摘要与关联个股）
export async function getJtcsmEvents(days = 1, limit = 30, includeDetail = false): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/jtcsm_events", { days, limit, include_detail: includeDetail })) as Record<string, unknown>;
}

// 获取事件关联个股在事件当天的行情快照
export async function getJtcsmEventStocks(eventId: string, date: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/jtcsm_event_stocks", { event_id: eventId, date })) as Record<string, unknown>;
}

// 获取个股近 N 个交易日命中的"今天炒什么"投资方向列表（默认 5 日）
export async function getStockJtcsmDirections(code: string, days = 5): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/stock_jtcsm_directions", { code, days })) as Record<string, unknown>;
}

// 获取指定事件包含的个股列表（关联实时行情；exclude_code 排除当前查看个股）
export async function getJtcsmDirectionStocks(eventId: string, excludeCode = ""): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = { event_id: eventId };
  if (excludeCode) params.exclude_code = excludeCode;
  return (await apiGet("/api/web/jtcsm_direction_stocks", params)) as Record<string, unknown>;
}

// ===== 四、主题维度 =====

// 获取个股命中的"主题"标签列表
export async function getStockThemeTags(code: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/stock_theme_tags", { code })) as Record<string, unknown>;
}

// 获取某个主题（一级或二级）下的关联个股列表（默认 15）
export async function getThemeStocks(themeCode: string, level2Code = "", limit = 15): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/theme_stocks", { theme_code: themeCode, level2_code: level2Code, limit })) as Record<string, unknown>;
}

// 获取主题看板的主题列表（sort_field 白名单见 SKILL.md，默认 dr_count）
export async function getHotThemeList(limit = 20, levelOnly = true, sortField = "dr_count", keyword = "", sortOrder = ""): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/hot_theme_list", {
    limit,
    level_only: levelOnly,
    sort_field: sortField,
    keyword,
    sort_order: sortOrder,
  })) as Record<string, unknown>;
}

// 获取指定主题下的个股列表（主题看板卡片数据；支持排序与搜索）
export async function getThemeStockList(code: string, field = "zdf", sort = "desc", limit = 15, keyword = ""): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/theme_stock_list", { code, field, sort, limit, keyword })) as Record<string, unknown>;
}

// 获取主题详情聚合数据（今日分时 + 近 10 日收盘 + 二级子主题）
export async function getThemeDetail(code: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/theme_detail", { code })) as Record<string, unknown>;
}

// ===== 五、选股维度 =====

// 自然语言选股（LLM 解析 → DSL → 四组交集；query 上限 200 字，支持【概念】标记）
export async function nlPick(query: string, secretKey?: string): Promise<Record<string, unknown>> {
  return (await apiPost("/api/web/nl_pick", { query }, secretKey)) as Record<string, unknown>;
}
