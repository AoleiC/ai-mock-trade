// 模拟交易 SDK：账号、持仓、委托、买卖、撤单、历史成交（行为对齐原 Python trading.py）
// 所有接口通过 cookie 中的 secret_key 认证；信封 {code, message, data} 由调用方读 code 判断
import { apiGet, apiPost } from "./http.ts";

// 买入委托价上浮比例（相对传入价上浮，便于穿越当前价快速撮合）
export const BUY_PRICE_PREMIUM = 0.006;
// 卖出委托价下浮比例
export const SELL_PRICE_DISCOUNT = 0.006;
// A 股最小报价单位（元）
export const PRICE_TICK = 0.01;

// 将价格按 A 股最小报价单位（0.01 元）四舍五入取整
export function roundToTick(price: number): number {
  return Math.round(Math.round(price / PRICE_TICK) * PRICE_TICK * 100) / 100;
}

// ===== 一、账号查询 =====

// 获取当前认证账号详情（total_amount/available_amount/daily_profit 等）
export async function getAccount(secretKey?: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/mock/account", undefined, secretKey)) as Record<string, unknown>;
}

// ===== 二、持仓查询 =====

// 获取持仓列表（volume 总持仓 / available_volume 可卖量——A 股 T+1 当日买入不可卖）
export async function getPositions(secretKey?: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/mock/positions", undefined, secretKey)) as Record<string, unknown>;
}

// ===== 三、委托查询 =====

// 获取委托列表（默认当天；order_status：0待报/1已报/2部成/3已成/4已撤/5废单）
export async function getOrders(secretKey?: string, startTime?: number, endTime?: number): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {};
  if (startTime !== undefined && startTime !== null) params.start_time = startTime;
  if (endTime !== undefined && endTime !== null) params.end_time = endTime;
  return (await apiGet("/api/web/mock/orders", params, secretKey)) as Record<string, unknown>;
}

// ===== 四、交易操作 =====

// 买入下单（限价单异步撮合；内部上浮 0.6% 提升撮合优先级；volume 需 100 股整数倍）
export async function buy(stockCode = "", price = 0, volume = 0, secretKey?: string): Promise<Record<string, unknown>> {
  const adjustedPrice = roundToTick(price * (1 + BUY_PRICE_PREMIUM));
  return (await apiPost("/api/web/mock/buy", { stock_code: stockCode, price: adjustedPrice, volume }, secretKey)) as Record<string, unknown>;
}

// 卖出下单（限价单异步撮合；内部下浮 0.6%；T+1 当日买入不可卖，卖出以 available_volume 为准）
export async function sell(stockCode = "", price = 0, volume = 0, secretKey?: string): Promise<Record<string, unknown>> {
  const adjustedPrice = roundToTick(price * (1 - SELL_PRICE_DISCOUNT));
  return (await apiPost("/api/web/mock/sell", { stock_code: stockCode, price: adjustedPrice, volume }, secretKey)) as Record<string, unknown>;
}

// 撤单（仅待报 0 / 已报 1 状态可撤）
export async function cancel(orderNo = "", secretKey?: string): Promise<Record<string, unknown>> {
  return (await apiPost("/api/web/mock/cancel", { order_no: orderNo }, secretKey)) as Record<string, unknown>;
}

// ===== 五、历史查询 =====

// 获取历史成交记录（默认 100 条，最大 500）
export async function getTradeHistory(limit = 100, secretKey?: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/mock/history", { limit }, secretKey)) as Record<string, unknown>;
}

// 获取委托撮合日志（match_result：0=未成交 / 1=成交）
export async function getMatchLogs(stockCode = "", orderNo = "", logDate = 0, secretKey?: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/mock/match_logs", { stock_code: stockCode, order_no: orderNo, log_date: logDate }, secretKey)) as Record<string, unknown>;
}

// 获取账号收益率曲线（最近约 1 年每日收盘快照 + 今日实时点）
export async function getProfitCurve(secretKey?: string): Promise<Record<string, unknown>> {
  return (await apiGet("/api/web/mock/profit_curve", undefined, secretKey)) as Record<string, unknown>;
}

// ===== 六、辅助接口 =====

// 获取股票实时价格（下单前确认价格用；data.price 为实时价）
export async function getStockPrice(stockCode: string): Promise<Record<string, unknown>> {
  return (await apiGet(`/api/web/mock/stock_price/${stockCode}`)) as Record<string, unknown>;
}
