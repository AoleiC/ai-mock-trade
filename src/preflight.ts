// 盘前预检（设计文档 §8.1 时点 1）：纯代码零 LLM，机械聚合问题清单 → data/attention-{date}.md + 调度日志
// 检查项：云端市场节点可达性 / 近期 attention 遗留 / 盯盘归档断档 / 残留未成交委托
// 边界：预检只"发现问题并呈现"，不修复不判定——节点拉取失败由轮内机械层自动重试；人不在线不影响系统自主运行
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attentionPath, appendAttention, type AttentionLevel } from "./runtime/pipeline/trace.ts";
import { localDateString } from "../skills/journal/journal.ts";
import * as market from "../skills/mock/market.ts";
import * as trading from "../skills/mock/trading.ts";

// 调度器日志接口（info/warning/error 三级，由调用方注入）
export interface PreflightLogger {
  info: (msg: string) => void;
  warning: (msg: string) => void;
  error: (msg: string) => void;
}

// 从文件名提取 YYYY-MM-DD（无法识别返回 null）
function dateFromName(name: string): string | null {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// data 目录下指定前缀的最新日期文件（按文件名日期取最近，含 maxInclusive 当日）
function latestDatedFile(dataDir: string, prefix: string, maxInclusive: string): { name: string; date: string } | null {
  let best: { name: string; date: string } | null = null;
  try {
    for (const name of readdirSync(dataDir)) {
      if (!name.startsWith(prefix)) continue;
      const date = dateFromName(name);
      if (!date || date > maxInclusive) continue;
      if (best === null || date > best.date) best = { name, date };
    }
  } catch {
    return null;
  }
  return best;
}

// 日期加天数（YYYY-MM-DD）
function addDays(dateStr: string, days: number): string {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// 自然日差（b - a）
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// 当日 attention 是否已记录过同一条盘前预检项（调度器重启会重复跑预检——同源问题当日只记一次）
function alreadyRecorded(dataDir: string, today: string, needle: string): boolean {
  try {
    return readFileSync(join(dataDir, `attention-${today}.md`), "utf-8").includes(needle);
  } catch {
    return false;
  }
}

// 盘前预检主入口（每交易日一次，由调度器在启动与当日首轮触发前调用）
export async function runPreflight(projectRoot: string, log: PreflightLogger): Promise<void> {
  const today = localDateString();
  const dataDir = join(projectRoot, "data");
  const counts: Record<AttentionLevel, number> = { ERROR: 0, WARN: 0, INFO: 0 };
  const record = (level: AttentionLevel, text: string): void => {
    counts[level] += 1;
    appendAttention(projectRoot, level, `[盘前预检] ${text}`);
  };

  // 1) 云端市场节点可达性（读一次确认鉴权与服务正常；失败仅 WARN——轮内机械层每轮会重试）
  try {
    const node = (await market.readMarketNode()) as Record<string, unknown>;
    if (node.code !== 200) {
      if (!alreadyRecorded(dataDir, today, "市场节点读取失败")) {
        record("WARN", `市场节点读取失败（code=${String(node.code)}）：${String(node.error ?? "")}——轮内机械层会自动重试，持续失败则当日按防守`);
      }
    } else {
      log.info(`市场节点可达: 节点=${String(node.effective_node ?? "?")}｜昨日=${String(node.yesterday_node ?? "?")}`);
    }
  } catch (e) {
    if (!alreadyRecorded(dataDir, today, "市场节点读取失败")) {
      record("WARN", `市场节点读取异常: ${e instanceof Error ? e.message : String(e)}——轮内机械层会自动重试，持续失败则当日按防守`);
    }
  }

  // 2) 近期 attention 遗留（未消化的问题隔日必须还在眼前；只看当日之前的清单）
  //    引用式：只给条数与文件指向，不复制历史正文——历史条目正文本身可能已嵌套上上一天的遗留，复制会层层嵌套放大
  const lastAttention = latestDatedFile(dataDir, "attention-", addDays(today, -1));
  if (lastAttention && daysBetween(lastAttention.date, today) <= 3) {
    try {
      const lines = readFileSync(join(dataDir, lastAttention.name), "utf-8").split("\n").filter((l) => /- \[\d{2}:\d{2}:\d{2}\] (ERROR|WARN)/.test(l));
      if (lines.length > 0 && !alreadyRecorded(dataDir, today, `attention 遗留 ${lastAttention.date}`)) {
        record("WARN", `${lastAttention.date} attention 遗留 ${lines.length} 条未消化问题（详见 data/${lastAttention.name}；本条只引用不复制正文，避免历史文本层层嵌套）`);
      }
    } catch {
      // 读取失败不阻塞预检
    }
  }

  // 3) 盯盘归档断档（含当日；近 10 个自然日无任何 watch-summary → 调度器整日未跑或归档异常）
  const lastSummary = latestDatedFile(dataDir, "watch-summary-", today);
  if ((lastSummary === null || daysBetween(lastSummary.date, today) > 10) && !alreadyRecorded(dataDir, today, "盯盘归档断档")) {
    record("WARN", `盯盘归档断档：最近归档为 ${lastSummary?.date ?? "无"}（近 10 日无 watch-summary——调度器未运行或归档异常，复盘将无输入）`);
  }

  // 4) 残留未成交委托（待报 / 已报 / 部成未全成——重启后人工确认是否撤单）
  try {
    const env = (await trading.getOrders()) as Record<string, unknown>;
    if (env.code === 200) {
      const statusText: Record<number, string> = { 0: "待报", 1: "已报", 2: "部成" };
      const active = ((env.data ?? []) as Array<Record<string, unknown>>).filter(
        (o) => !o.is_invalid && (o.order_status === 0 || o.order_status === 1 || (o.order_status === 2 && Number(o.deal_volume ?? 0) < Number(o.order_volume ?? 0))),
      );
      if (active.length > 0) {
        const brief = active
          .slice(0, 5)
          .map((o) => `${o.order_type === 1 ? "买" : "卖"} ${o.stock_name}(${o.stock_code}) ${statusText[Number(o.order_status)] ?? String(o.order_status)} ${Number(o.order_volume ?? 0) - Number(o.deal_volume ?? 0)}股`)
          .join("；");
        record("WARN", `残留未成交委托 ${active.length} 笔：${brief}`);
      }
    }
  } catch (e) {
    record("WARN", `预检委托查询失败（不阻塞）: ${e instanceof Error ? e.message : String(e)}`);
  }

  const total = counts.ERROR + counts.WARN + counts.INFO;
  const line = `盘前预检完成: ERROR=${counts.ERROR} WARN=${counts.WARN} INFO=${counts.INFO}${total > 0 ? `（详见 ${attentionPath(projectRoot, today).split("/").pop() ?? "attention"}）` : "（无问题）"}`;
  if (counts.ERROR > 0) log.error(line);
  else if (counts.WARN > 0) log.warning(line);
  else log.info(line);
}
