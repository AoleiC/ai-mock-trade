// 当日裁决事实块（各层共用的完整事实——层间信息逐层传递，但每层拿到的必须是完整的同一份事实）
//
// 背景（2026-11-12 教训）：s1 判「允许开仓」，s5 只拿到「阶段=退潮期」一行字就反向否决；
//   s4 说「板块量化要件缺位，留终裁裁决」，s5 拿不到该要件又以「缺位=无法判定」否决——两层互相甩锅。
//   修法不是砍掉分层，而是把「事实」在代码层装配成唯一一份，各层注入同一份：
//   云端节点字段（节点词 / 通道 / 基调）+ 盘面当帧（温度 / 情绪 / 对齐）+ 板块量化要件（当日与前一交易日）
//   + 上一环节（会话 1）的裁决声明。事实缺位一律写「缺位」，不许下游用「缺位」当否决理由。
//
// 纪律：本模块只搬运客观事实与会话 1 的声明值，不做交易判断（判断权在各会话）。
import * as market from "../../../skills/mock/market.ts";

// 事实块里各板块取前 N（够用且不撑爆上下文）
//   HOT_LIMIT：当日热度榜拉取条数（比展示条数多——可买方向未必在榜单前 10，缺当日实况就没法判方向强度）
const HOT_LIMIT = 30;
const HOT_SHOW = 10;
const PREV_HOT_LIMIT = 10;
// 风向标兜底取几只（盘面未给 key_stocks 时按板块成分股当日涨幅补）
const KEY_STOCK_FALLBACK = 5;

// 板块热度行（当日）
interface HotRow {
  name: string;
  zt: number;
  height: number;
  avgZdf: number;
  mainInflow: string;
  belowMa5: number;
}

// 前一交易日热度行（涨停数 + 排名）
interface PrevHotRow {
  name: string;
  zt: number;
  lb: number;
}

// 读云端市场节点（唯一权威；读取失败按缺位处理，不臆造）
async function readNodeFacts(): Promise<Record<string, unknown>> {
  try {
    const out = (await market.readMarketNode()) as Record<string, unknown>;
    if (out.code !== 200) return { __error: `市场节点读取失败（code=${String(out.code)}）：${String(out.error ?? "")}` };
    return out;
  } catch (e) {
    return { __error: `市场节点读取异常：${e instanceof Error ? e.message : String(e)}` };
  }
}

// 盘面当帧（服务端 LLM 分析的客观字段；取不到写缺位）
interface MarketFacts {
  temperature: string;
  sentiment: string;
  alignment: string;
  positionLimit: string;
  overview: string;
  advice: string;
  attackSectors: Array<{ sector: string; todayZt: number; inflow: string; keyStocks: Array<{ name: string; code: string; zdf: number }> }>;
  attackStocks: Array<{ direction: string; name: string; code: string; zdf: number }>;
  retreatSectors: string[];
  error?: string;
}

async function fetchMarketFacts(): Promise<MarketFacts> {
  const empty: MarketFacts = {
    temperature: "缺位",
    sentiment: "缺位",
    alignment: "缺位",
    positionLimit: "缺位",
    overview: "",
    advice: "",
    attackSectors: [],
    attackStocks: [],
    retreatSectors: [],
  };
  try {
    const env = (await market.getIntradayAnalysis()) as Record<string, unknown>;
    if (env.code !== 200) return { ...empty, error: `盘面分析拉取失败（code=${String(env.code)}）` };
    const data = (env.data ?? null) as Record<string, unknown> | null;
    if (!data) return { ...empty, error: "盘面分析缺位（data=null）" };
    const final = (data.final_analysis ?? {}) as Record<string, unknown>;
    const hot = (data.hot_rotation_analysis ?? {}) as Record<string, unknown>;
    const sectors = (hot.attack_sectors ?? []) as Array<Record<string, unknown>>;
    const dirs = (final.attack_directions ?? []) as Array<Record<string, unknown>>;
    return {
      temperature: `${String(data.temperature_score ?? "?")} 分（${String(data.temperature_label ?? "?")}）`,
      sentiment: `${String((data.sentiment_analysis as Record<string, unknown> | undefined)?.sentiment_label ?? "?")}（${String((data.sentiment_analysis as Record<string, unknown> | undefined)?.sentiment_score ?? "?")} 分）`,
      alignment: String(final.sentiment_capital_alignment ?? "?"),
      positionLimit: String(final.position_limit ?? "?"),
      overview: String(final.market_overview ?? "").slice(0, 300),
      advice: String(final.action_advice ?? "").slice(0, 200),
      attackSectors: sectors.map((s) => ({
        sector: String(s.sector ?? ""),
        todayZt: Number(s.today_zt ?? 0),
        inflow: String(s.today_inflow ?? "-"),
        keyStocks: ((s.key_stocks ?? []) as Array<Record<string, unknown>>).map((k) => ({
          name: String(k.name ?? ""),
          code: String(k.code ?? ""),
          zdf: Number(k.zdf ?? 0),
        })),
      })),
      attackStocks: dirs.flatMap((d) =>
        ((d.stocks ?? []) as Array<Record<string, unknown>>).map((st) => ({
          direction: String(d.direction ?? ""),
          name: String(st.name ?? ""),
          code: String(st.code ?? ""),
          zdf: Number(st.zdf ?? 0),
        })),
      ),
      retreatSectors: ((hot.retreat_sectors ?? []) as Array<Record<string, unknown>>).map((s) => String(s.sector ?? s.name ?? "")).filter(Boolean),
    };
  } catch (e) {
    return { ...empty, error: `盘面分析拉取异常：${e instanceof Error ? e.message : String(e)}` };
  }
}

// 当日板块热度（按涨停数降序）
async function fetchHotRows(): Promise<{ rows: HotRow[]; error?: string }> {
  try {
    const env = (await market.getHotSpotList("zt_count", "desc", HOT_LIMIT)) as Record<string, unknown>;
    if (env.code !== 200) return { rows: [], error: `板块热度拉取失败（code=${String(env.code)}）` };
    const rows = ((env.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      name: String(r.name ?? ""),
      zt: Number(r.zt_count ?? 0),
      height: Number(r.height ?? 0),
      avgZdf: Number(r.avg_zdf ?? 0),
      mainInflow: String(r.main_inflow ?? "-"),
      belowMa5: Number(r.below_ma5_core_count ?? 0),
    }));
    return { rows };
  } catch (e) {
    return { rows: [], error: `板块热度拉取异常：${e instanceof Error ? e.message : String(e)}` };
  }
}

// 前一交易日板块热度（连榜判定用；当日盘中该接口返回空，必须带日期）
async function fetchPrevHotRows(prevDate: string): Promise<{ rows: PrevHotRow[]; error?: string }> {
  if (!prevDate) return { rows: [], error: "前一交易日日期缺位" };
  try {
    const env = (await market.getTopHotSpots(prevDate, PREV_HOT_LIMIT)) as Record<string, unknown>;
    if (env.code !== 200) return { rows: [], error: `前一日板块热度拉取失败（code=${String(env.code)}）` };
    const rows = ((env.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      name: String(r.hot_spot_name ?? r.name ?? ""),
      zt: Number(r.zt_count ?? 0),
      lb: Number(r.lb_count ?? 0),
    }));
    return { rows };
  } catch (e) {
    return { rows: [], error: `前一日板块热度拉取异常：${e instanceof Error ? e.message : String(e)}` };
  }
}

// 板块名匹配（精确优先，其次包含关系——服务端命名与盘面命名常有前后缀差异）
function matchHot<T extends { name: string }>(name: string, rows: T[]): { row: T | undefined; rank: number } {
  const exact = rows.findIndex((r) => r.name === name);
  if (exact >= 0) return { row: rows[exact], rank: exact + 1 };
  const partial = rows.findIndex((r) => r.name.includes(name) || name.includes(r.name));
  if (partial >= 0) return { row: rows[partial], rank: partial + 1 };
  return { row: undefined, rank: -1 };
}

// 风向标兜底：盘面分析未给该方向 key_stocks 时，按板块成分股当日涨幅取前几只（只取涨幅与代码，不带分时序列）
async function fetchKeyStocksFallback(dir: string): Promise<Array<{ name: string; code: string; zdf: number }>> {
  try {
    const env = (await market.getHotSpotComponents(dir, "zdf", "desc")) as Record<string, unknown>;
    if (env.code !== 200) return [];
    return ((env.data ?? []) as Array<Record<string, unknown>>)
      .slice(0, KEY_STOCK_FALLBACK)
      .map((s) => ({ name: String(s.stock_name ?? ""), code: String(s.stock_code ?? ""), zdf: Number(s.zdf ?? 0) }));
  } catch {
    return [];
  }
}

// 事实块装配的安全壳：装配本身异常时退化为最小事实块（阶段 + 裁决声明），不阻断买链
export async function buildFactsBlockSafe(ctx: { trade_date: string; current_time: string }, verdict: Record<string, unknown>): Promise<string> {
  try {
    return await buildFactsBlock(ctx, verdict);
  } catch (e) {
    const gate = (verdict.market_gate ?? {}) as Record<string, unknown>;
    return [
      "【当日裁决事实】",
      "- ⚠ 事实块装配异常，以下仅保留最低限度声明（其余按缺位处理）",
      `- 生效节点：${String(verdict.market_node ?? "缺位")}`,
      `- 本帧是否允许新开仓：${gate.open_allowed === true ? "允许" : "不允许"}`,
      `- 裁决理由：${String(gate.open_reason ?? "缺位").slice(0, 400)}`,
      `- 可买方向：${((verdict.buy_directions ?? []) as unknown[]).map(String).join("、") || "无"}｜撤退方向：${((verdict.retreat_directions ?? []) as unknown[]).map(String).join("、") || "无"}`,
      `- 装配异常：${e instanceof Error ? e.message : String(e)}`,
    ].join("\n");
  }
}

// 装配当日裁决事实块（各层注入同一份）
export async function buildFactsBlock(ctx: { trade_date: string; current_time: string }, verdict: Record<string, unknown>): Promise<string> {
  const node = await readNodeFacts();
  const prevDate = String(node.yesterday_date ?? "");
  const [marketFacts, hot, prevHot] = await Promise.all([
    fetchMarketFacts(),
    fetchHotRows(),
    fetchPrevHotRows(prevDate),
  ]);

  const gate = (verdict.market_gate ?? {}) as Record<string, unknown>;
  const channels = (verdict.node_channels ?? {}) as Record<string, unknown>;
  const buyDirections = ((verdict.buy_directions ?? []) as unknown[]).map(String).filter(Boolean);
  const retreatDirections = ((verdict.retreat_directions ?? []) as unknown[]).map(String).filter(Boolean);

  // 云端节点字段（逐字事实）
  const nodeLines = [
    `- 当帧节点：${String(node.market_node ?? "缺位")}｜生效节点：${String(node.effective_node ?? "缺位")}${node.node_degraded === true ? "（当帧缺位，已退回昨日链末节点）" : ""}`,
    `- 昨日定格节点：${String(node.yesterday_node ?? "缺位")}（${String(node.yesterday_date ?? "缺位")}，${String(node.yesterday_score ?? "缺位")} 分）`,
    `- 通道资格：${Object.entries(channels).map(([k, v]) => `${k}=${v === true}`).join("，") || "缺位"}｜禁新开仓：${node.forbidden_new_position === true}｜只兑现：${node.realize_only === true}`,
    `- 当帧大盘五档：${String(node.temperature_level ?? "缺位")}`,
  ];

  // 可买方向的板块量化要件（当日 + 前一交易日 + 风向标）
  const directionLines = await Promise.all(
    buyDirections.map(async (dir) => {
      const today = matchHot(dir, hot.rows);
      const prev = matchHot(dir, prevHot.rows);
      const sector = marketFacts.attackSectors.find((s) => s.sector === dir) ?? marketFacts.attackSectors.find((s) => s.sector.includes(dir) || dir.includes(s.sector));
      let keyStocks = sector?.keyStocks ?? marketFacts.attackStocks.filter((s) => s.direction === dir).slice(0, 6);
      let keySource = sector ? "盘面题材维度" : "盘面进攻方向关联个股";
      if (keyStocks.length === 0) {
        keyStocks = await fetchKeyStocksFallback(dir);
        keySource = "板块成分股当日涨幅（兜底）";
      }
      return [
        `  ▸ ${dir}`,
        `当日：涨停 ${today.row ? today.row.zt : "缺位"} 只（热度榜第 ${today.rank > 0 ? today.rank : "缺位"} 名${hot.error ? `｜${hot.error}` : ""}）｜最高连板 ${today.row ? today.row.height : "缺位"}｜板块平均涨幅 ${today.row ? `${today.row.avgZdf}%` : "缺位"}｜板块主力 ${today.row ? today.row.mainInflow : "缺位"}｜跌破 5 日线核心股 ${today.row ? today.row.belowMa5 : "缺位"} 只`,
        `前一交易日（${String(node.yesterday_date ?? "缺位")}）：涨停 ${prev.row ? prev.row.zt : "缺位"} 只（榜内第 ${prev.rank > 0 ? prev.rank : "缺位"} 名${prevHot.error ? `｜${prevHot.error}` : ""}）｜连板 ${prev.row ? prev.row.lb : "缺位"}`,
        `风向标（当日涨幅，来源：${keySource}）：${keyStocks.length > 0 ? keyStocks.map((k) => `${k.name}(${k.code}) ${k.zdf}%`).join("、") : "缺位"}`,
      ].join("\n");
    }),
  );

  const lines = [
    "【当日裁决事实（代码直查的客观事实 + 会话 1 的裁决声明；各层拿到的都是这一份，缺位已标注，不要用「缺位」当否决理由）】",
    "",
    "■ 市场节点（云端唯一权威，market.read_market_node 输出）",
    ...nodeLines,
    "",
    "■ 盘面当帧（服务端分析的事实字段）",
    `- 大盘温度：${marketFacts.temperature}${marketFacts.error ? `｜${marketFacts.error}` : ""}`,
    `- 短线情绪：${marketFacts.sentiment}｜短线×大盘对齐：${marketFacts.alignment}｜盘面仓位建议：${marketFacts.positionLimit}%`,
    marketFacts.overview ? `- 盘面综述：${marketFacts.overview}` : "- 盘面综述：缺位",
    marketFacts.advice ? `- 操作建议：${marketFacts.advice}` : "- 操作建议：缺位",
    "",
    "■ 会话 1（开仓判定）裁决声明——已生效，下游不得以同一理由推翻",
    `- 本帧是否允许新开仓：${gate.open_allowed === true ? "允许" : "不允许"}`,
    `- 裁决理由：${String(gate.open_reason ?? "缺位").slice(0, 800)}`,
    `- 当日买入时间窗口：${((verdict.buy_windows ?? []) as unknown[]).map((w) => (Array.isArray(w) ? w.map(String).join("-") : String(w))).join(" / ") || "全天禁买"}`,
    `- 仓位上限（会话 1 声明）：${String(gate.position_limit ?? "缺位")}%｜单笔降档封顶：${String(verdict.size_cap_pct ?? 0)}%（0 = 无降档）`,
    `- 可买方向：${buyDirections.join("、") || "无"}｜撤退方向（禁买）：${retreatDirections.join("、") || "无"}`,
    `- 当日禁项：${((verdict.forbidden ?? []) as unknown[]).map(String).join("；") || "无"}`,
    "",
    "■ 可买方向板块量化要件（当日实况 + 前一交易日连榜 + 风向标当日涨幅）",
    ...(directionLines.length > 0 ? directionLines : ["  （无当日可买方向）"]),
    "",
    `■ 板块热度榜前 ${HOT_SHOW}（按涨停数；rank 为当日名次）`,
    ...(hot.rows.length > 0
      ? hot.rows.slice(0, HOT_SHOW).map((r, i) => `  ${i + 1}. ${r.name}：涨停 ${r.zt} 只｜最高连板 ${r.height}｜平均涨幅 ${r.avgZdf}%｜主力 ${r.mainInflow}｜跌破 5 日线核心 ${r.belowMa5} 只`)
      : [`  （缺位${hot.error ? `：${hot.error}` : ""}）`]),
    "",
    "■ 前一交易日板块热度前 10（按涨停数；rank 为当日名次）",
    ...(prevHot.rows.length > 0
      ? prevHot.rows.map((r, i) => `  ${i + 1}. ${r.name}：涨停 ${r.zt} 只｜连板 ${r.lb} 只`)
      : [`  （缺位${prevHot.error ? `：${prevHot.error}` : ""}）`]),
    "",
    "■ 盘面进攻方向关联个股（仅作参考：盘面举例，非选股门槛、非买入依据）",
    ...(marketFacts.attackStocks.length > 0
      ? marketFacts.attackStocks.slice(0, 24).map((s) => `  ${s.direction}：${s.name}(${s.code}) ${s.zdf}%`)
      : ["  （缺位）"]),
  ];
  return lines.join("\n");
}
