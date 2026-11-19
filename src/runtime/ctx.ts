// ctx 契约解析校验：调度器写入 data/tmp/ctx-{ts}.json，runtime 启动时读取（设计文档 §8.2）
import { readFile } from "node:fs/promises";

// ctx 文件结构（watch 模式 block=机械层注入块，review 模式 block 为空串）
export interface WatchCtx {
  mode: "watch" | "review";
  trade_date: string; // YYYY-MM-DD
  current_time: string; // HH:MM:SS —— 总结标记与摘要行时间的唯一权威来源（AGENTS.md §八 时间硬红线）
  block: string; // 机械层注入块（纯事实数据，无 CLI 命令教学）
}

// 读取并校验 ctx 文件；任何字段缺失/非法直接抛错（调度器按 cli_error 处理）
export async function loadCtx(path: string): Promise<WatchCtx> {
  const raw = await readFile(path, "utf-8");
  const obj = JSON.parse(raw) as Partial<WatchCtx>;
  if (obj.mode !== "watch" && obj.mode !== "review") {
    throw new Error(`ctx.mode 非法: ${String(obj.mode)}`);
  }
  const tradeDate = String(obj.trade_date ?? "");
  const currentTime = String(obj.current_time ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    throw new Error(`ctx.trade_date 非法: ${tradeDate}`);
  }
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(currentTime)) {
    throw new Error(`ctx.current_time 非法: ${currentTime}`);
  }
  return { mode: obj.mode, trade_date: tradeDate, current_time: currentTime, block: String(obj.block ?? "") };
}

// 组装首条 user 消息：当前时间权威 + 任务指令 + 注入块（承接原 run_cli 的 prompt 后缀时间注入）
export function buildFirstMessage(ctx: WatchCtx): string {
  const task = ctx.mode === "watch" ? "执行一次盯盘" : "复盘今天的行情数据";
  const head =
    `【调度指令】当前时间 ${ctx.trade_date} ${ctx.current_time}（输出中的总结标记与摘要行时间必须逐字采用此值）。\n` +
    `任务：${task}。`;
  if (!ctx.block) return head;
  return `${head}\n\n${ctx.block}`;
}
