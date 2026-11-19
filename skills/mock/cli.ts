#!/usr/bin/env node
// mock skill 通用方法调用器（CLI runner）：一行命令调用 market / trading / report 任意方法
// 用法：node skills/mock/cli.ts <module>.<method> [位置参数...] [--key value ...]（--list / --help）
import { runCli, applyConstraints, type MethodSpec } from "../cli-runner.ts";
import * as market from "./market.ts";
import * as trading from "./trading.ts";
import * as report from "./report.ts";

// 按需取数约束表（对齐原 Python _PARAM_CONSTRAINTS：重数据接口在 CLI 层收敛默认值与范围）
const CONSTRAINTS: Record<string, Record<string, [number | boolean, number | null, number | null]>> = {
  "market.get_daily_k_data": { days: [10, 5, 15] },
  "market.get_stock_daily_history": { days: [5, 1, 15] },
  "market.get_hot_spot_list": { limit: [10, 1, 20] },
  "market.get_strategy_trend_stocks": { limit: [50, 1, 100], with_intraday: [false, null, null] },
  "market.get_market_node_series": { days: [90, 30, 120] },
  "trading.get_trade_history": { limit: [20, 1, 50] },
};

// 方法注册表（模块白名单：market / trading / report；参数声明顺序 = 位置参数绑定顺序，与原签名一致）
const METHODS: Record<string, MethodSpec> = {
  // ===== market =====
  "market.get_summary": { invoke: () => market.getSummary(), params: {} },
  "market.get_zt_timeline": { invoke: () => market.getZtTimeline(), params: {} },
  "market.get_indicator_trendline": {
    invoke: (a) => market.getIndicatorTrendline(String(a.code)),
    params: { code: { type: "str", required: true } },
  },
  "market.get_daily_indicators_history": { invoke: () => market.getDailyIndicatorsHistory(), params: {} },
  "market.get_daily_summary": {
    invoke: (a) => market.getDailySummary(a.date as string | undefined, a.since as string | undefined),
    params: { date: { type: "str" }, since: { type: "str" } },
  },
  "market.get_hot_spot_list": {
    invoke: (a) => {
      applyConstraints(a, CONSTRAINTS["market.get_hot_spot_list"]!);
      return market.getHotSpotList(a.sort_by as string, a.sort_order as string, a.limit as number);
    },
    params: { sort_by: { type: "str" }, sort_order: { type: "str" }, limit: { type: "int" } },
  },
  "market.get_hot_spot_components": {
    invoke: (a) => market.getHotSpotComponents(String(a.name), a.sort_by as string, a.sort_order as string),
    params: { name: { type: "str", required: true }, sort_by: { type: "str" }, sort_order: { type: "str" } },
  },
  "market.get_hot_spot_eliminated": {
    invoke: (a) => market.getHotSpotEliminated(String(a.name)),
    params: { name: { type: "str", required: true } },
  },
  "market.get_hot_spot_trendline": {
    invoke: (a) => market.getHotSpotTrendline(String(a.name)),
    params: { name: { type: "str", required: true } },
  },
  "market.get_hot_spot_daily_stats": {
    invoke: (a) => market.getHotSpotDailyStats(a.date as string | undefined),
    params: { date: { type: "str" } },
  },
  "market.get_hot_spot_daily_stats_batch": {
    invoke: (a) => market.getHotSpotDailyStatsBatch(String(a.name), a.days as number | undefined),
    params: { name: { type: "str", required: true }, days: { type: "int" } },
  },
  "market.get_top_hot_spots": {
    invoke: (a) => market.getTopHotSpots(a.date as string | undefined, a.limit as number | undefined),
    params: { date: { type: "str" }, limit: { type: "int" } },
  },
  "market.get_hot_spot_components_by_date": {
    invoke: (a) => market.getHotSpotComponentsByDate(String(a.name), String(a.date)),
    params: { name: { type: "str", required: true }, date: { type: "str", required: true } },
  },
  "market.get_stock_info": {
    invoke: (a) => market.getStockInfo(String(a.stock_code)),
    params: { stock_code: { type: "str", required: true } },
  },
  "market.get_daily_k_data": {
    invoke: (a) => {
      applyConstraints(a, CONSTRAINTS["market.get_daily_k_data"]!);
      return market.getDailyKData(String(a.code), a.days as number);
    },
    params: { code: { type: "str", required: true }, days: { type: "int" } },
  },
  "market.get_stock_trendline": {
    invoke: (a) => market.getStockTrendline(String(a.code)),
    params: { code: { type: "str", required: true } },
  },
  "market.get_stock_minute_trendline": {
    invoke: (a) => market.getStockMinuteTrendline(String(a.code)),
    params: { code: { type: "str", required: true } },
  },
  "market.get_stock_trendline_history": {
    invoke: (a) => market.getStockTrendlineHistory(String(a.code), String(a.date)),
    params: { code: { type: "str", required: true }, date: { type: "str", required: true } },
  },
  "market.get_lianban_stocks": {
    invoke: (a) => market.getLianbanStocks(a.date as string | undefined, a.limit as number | undefined),
    params: { date: { type: "str" }, limit: { type: "int" } },
  },
  "market.get_stock_daily_history": {
    invoke: (a) => {
      applyConstraints(a, CONSTRAINTS["market.get_stock_daily_history"]!);
      return market.getStockDailyHistory(String(a.code), a.days as number);
    },
    params: { code: { type: "str", required: true }, days: { type: "int" } },
  },
  "market.get_amount_top": { invoke: () => market.getAmountTop(), params: {} },
  "market.get_large_cap_stocks": { invoke: () => market.getLargeCapStocks(), params: {} },
  "market.get_main_outflow_top": { invoke: () => market.getMainOutflowTop(), params: {} },
  "market.get_strategy_trend_stocks": {
    invoke: (a) => {
      applyConstraints(a, CONSTRAINTS["market.get_strategy_trend_stocks"]!);
      return market.getStrategyTrendStocks(
        a.strategy_id as number,
        (a.mode as string) ?? "",
        a.limit as number,
        a.with_intraday as boolean,
        (a.sort_by as string) ?? "",
        (a.with_analysis as boolean) ?? true,
      );
    },
    params: {
      strategy_id: { type: "int", required: true },
      mode: { type: "str" },
      limit: { type: "int" },
      with_intraday: { type: "bool" },
      sort_by: { type: "str" },
      with_analysis: { type: "bool" },
    },
  },
  "market.get_hourly_hot_top": {
    invoke: (a) => market.getHourlyHotTop(a.sort_by as string, a.sort_dir as string),
    params: { sort_by: { type: "str" }, sort_dir: { type: "str" } },
  },
  "market.get_key_watch_stocks": { invoke: () => market.getKeyWatchStocks(), params: {} },
  "market.get_main_inflow_top": { invoke: () => market.getMainInflowTop(), params: {} },
  "market.get_consecutive_board_ladder": {
    invoke: (a) => market.getConsecutiveBoardLadder(a.end_date as string | undefined),
    params: { end_date: { type: "str" } },
  },
  "market.get_hot_spot_rotation": {
    invoke: (a) => market.getHotSpotRotation(a.days as number | undefined, a.top_n as number | undefined),
    params: { days: { type: "int" }, top_n: { type: "int" } },
  },
  "market.get_intraday_analysis": { invoke: () => market.getIntradayAnalysis(), params: {} },
  "market.get_market_node_series": {
    invoke: (a) => {
      applyConstraints(a, CONSTRAINTS["market.get_market_node_series"]!);
      return market.getMarketNodeSeries(a.days as number);
    },
    params: { days: { type: "int" } },
  },
  "market.read_market_node": { invoke: () => market.readMarketNode(), params: {} },
  "market.get_batch_stock_zdf": {
    invoke: (a) => market.getBatchStockZdf(String(a.codes)),
    params: { codes: { type: "str", required: true } },
  },
  "market.get_jtcsm_events": {
    invoke: (a) => market.getJtcsmEvents(a.days as number | undefined, a.limit as number | undefined, a.include_detail as boolean | undefined),
    params: { days: { type: "int" }, limit: { type: "int" }, include_detail: { type: "bool" } },
  },
  "market.get_jtcsm_event_stocks": {
    invoke: (a) => market.getJtcsmEventStocks(String(a.event_id), String(a.date)),
    params: { event_id: { type: "str", required: true }, date: { type: "str", required: true } },
  },
  "market.get_stock_jtcsm_directions": {
    invoke: (a) => market.getStockJtcsmDirections(String(a.code), a.days as number | undefined),
    params: { code: { type: "str", required: true }, days: { type: "int" } },
  },
  "market.get_jtcsm_direction_stocks": {
    invoke: (a) => market.getJtcsmDirectionStocks(String(a.event_id), (a.exclude_code as string) ?? ""),
    params: { event_id: { type: "str", required: true }, exclude_code: { type: "str" } },
  },
  "market.get_stock_theme_tags": {
    invoke: (a) => market.getStockThemeTags(String(a.code)),
    params: { code: { type: "str", required: true } },
  },
  "market.get_theme_stocks": {
    invoke: (a) => market.getThemeStocks(String(a.theme_code), (a.level2_code as string) ?? "", a.limit as number | undefined),
    params: { theme_code: { type: "str", required: true }, level2_code: { type: "str" }, limit: { type: "int" } },
  },
  "market.get_hot_theme_list": {
    invoke: (a) =>
      market.getHotThemeList(
        a.limit as number | undefined,
        a.level_only as boolean | undefined,
        a.sort_field as string | undefined,
        (a.keyword as string) ?? "",
        (a.sort_order as string) ?? "",
      ),
    params: { limit: { type: "int" }, level_only: { type: "bool" }, sort_field: { type: "str" }, keyword: { type: "str" }, sort_order: { type: "str" } },
  },
  "market.get_theme_stock_list": {
    invoke: (a) =>
      market.getThemeStockList(String(a.code), a.field as string, a.sort as string, a.limit as number | undefined, (a.keyword as string) ?? ""),
    params: { code: { type: "str", required: true }, field: { type: "str" }, sort: { type: "str" }, limit: { type: "int" }, keyword: { type: "str" } },
  },
  "market.get_theme_detail": {
    invoke: (a) => market.getThemeDetail(String(a.code)),
    params: { code: { type: "str", required: true } },
  },
  "market.nl_pick": {
    invoke: (a) => market.nlPick(String(a.query), a.secret_key as string | undefined),
    params: { query: { type: "str", required: true }, secret_key: { type: "str" } },
  },

  // ===== trading =====
  "trading.get_account": { invoke: (a) => trading.getAccount(a.secret_key as string | undefined), params: { secret_key: { type: "str" } } },
  "trading.get_positions": { invoke: (a) => trading.getPositions(a.secret_key as string | undefined), params: { secret_key: { type: "str" } } },
  "trading.get_orders": {
    invoke: (a) => trading.getOrders(a.secret_key as string | undefined, a.start_time as number | undefined, a.end_time as number | undefined),
    params: { secret_key: { type: "str" }, start_time: { type: "int" }, end_time: { type: "int" } },
  },
  "trading.buy": {
    invoke: (a) => trading.buy(String(a.stock_code), a.price as number, a.volume as number, a.secret_key as string | undefined),
    params: { stock_code: { type: "str", required: true }, price: { type: "float", required: true }, volume: { type: "int", required: true }, secret_key: { type: "str" } },
  },
  "trading.sell": {
    invoke: (a) => trading.sell(String(a.stock_code), a.price as number, a.volume as number, a.secret_key as string | undefined),
    params: { stock_code: { type: "str", required: true }, price: { type: "float", required: true }, volume: { type: "int", required: true }, secret_key: { type: "str" } },
  },
  "trading.cancel": {
    invoke: (a) => trading.cancel(String(a.order_no), a.secret_key as string | undefined),
    params: { order_no: { type: "str", required: true }, secret_key: { type: "str" } },
  },
  "trading.get_trade_history": {
    invoke: (a) => {
      applyConstraints(a, CONSTRAINTS["trading.get_trade_history"]!);
      return trading.getTradeHistory(a.limit as number, a.secret_key as string | undefined);
    },
    params: { limit: { type: "int" }, secret_key: { type: "str" } },
  },
  "trading.get_match_logs": {
    invoke: (a) => trading.getMatchLogs((a.stock_code as string) ?? "", (a.order_no as string) ?? "", (a.log_date as number) ?? 0, a.secret_key as string | undefined),
    params: { stock_code: { type: "str" }, order_no: { type: "str" }, log_date: { type: "int" }, secret_key: { type: "str" } },
  },
  "trading.get_profit_curve": { invoke: (a) => trading.getProfitCurve(a.secret_key as string | undefined), params: { secret_key: { type: "str" } } },
  "trading.get_stock_price": {
    invoke: (a) => trading.getStockPrice(String(a.stock_code)),
    params: { stock_code: { type: "str", required: true } },
  },

  // ===== report =====
  "report.submit_summary": {
    invoke: (a) => report.submitSummary(String(a.log_type), String(a.content), a.date as string | undefined, a.secret_key as string | undefined),
    params: { log_type: { type: "str", required: true }, content: { type: "str", required: true }, date: { type: "str" }, secret_key: { type: "str" } },
  },
};

// 用法说明（--help 打印）
const USAGE = `柚子 AI mock skill 通用方法调用器（TypeScript / Node）

用法:
    node skills/mock/cli.ts <module>.<method> [位置参数...] [--key value ...]
    node skills/mock/cli.ts --list          列出全部可用方法
    node skills/mock/cli.ts --help          打印本说明

模块白名单: market / trading / report

示例:
    node skills/mock/cli.ts market.read_market_node
    node skills/mock/cli.ts market.get_intraday_analysis
    node skills/mock/cli.ts market.get_stock_info --stock_code 603019
    node skills/mock/cli.ts market.get_daily_k_data 603019 --days 10
    node skills/mock/cli.ts trading.get_positions
    node skills/mock/cli.ts trading.buy --stock_code 603019 --price 45.0 --volume 100
    node skills/mock/cli.ts report.submit_summary watch "盯盘总结文本"

类型转换: 按参数声明类型转换（str/int/float/bool/JSON）；支持 @路径 文件引用传长文本。
按需取数: 重数据接口已收敛默认值与范围（get_daily_k_data days 默认 10 钳 5~15、
          get_strategy_trend_stocks with_intraday 默认 false、get_trade_history limit
          默认 20 钳 1~50、get_market_node_series days 默认 90 钳 30~120 等）——直接按默认调用即可。
输出: 方法返回值 JSON（保留信封契约）；异常输出结构化错误 JSON 且退出码非零。`;

const argv = process.argv.slice(2);
runCli(METHODS, argv, USAGE, "market.* / trading.* / report.* 方法清单：").then((code) => process.exit(code));
