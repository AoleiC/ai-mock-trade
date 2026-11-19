// 全量执行留痕（人工审计）：每轮一个 JSONL，落在调度器日志目录（随 LOG_RETENTION_DAYS 清理）。
// 记录：round_start（含完整注入块）/ llm（每会话完整 system+user+原始输出）/ pool（漏斗）/
//       trade（下单原始信封）/ journal（台账写入载荷）/ round_end——审计唯一全文来源，写入失败不阻断主流程。
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// 当前轮留痕文件路径（null = 未初始化，静默跳过）
let sink: string | null = null;

// 初始化本轮留痕文件（main 入口调用；目录已存在时递归创建为无害操作）
export function initTranscript(path: string): void {
  sink = path;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* 目录已存在 */
  }
}

// 追加一条留痕记录（type + 任意字段；带时间戳）
export function appendTranscript(type: string, data: Record<string, unknown>): void {
  if (!sink) return;
  try {
    appendFileSync(sink, `${JSON.stringify({ ts: new Date().toISOString(), type, ...data })}\n`);
  } catch {
    /* 留痕失败不影响交易主流程 */
  }
}
