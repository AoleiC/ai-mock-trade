// 总结上报 SDK：把盯盘 / 复盘总结上报到后台（写入 mock_log 表），供事后回溯
// 上报为「尽力而为」：异常吞掉返回错误信封，不影响已产出的总结与后续盯盘
import { apiPost } from "./http.ts";

// 上报盯盘 / 复盘总结（log_type：watch-盯盘 / review-复盘；date 缺省当天）
export async function submitSummary(logType: string, content: string, date?: string, secretKey?: string): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = { log_type: logType, content };
  if (date !== undefined && date !== null) payload.trade_date = date;
  try {
    return (await apiPost("/api/web/mock/log", payload, secretKey)) as Record<string, unknown>;
  } catch (exc) {
    return { code: 500, message: `AI总结上报失败: ${exc instanceof Error ? exc.message : String(exc)}`, data: null };
  }
}
