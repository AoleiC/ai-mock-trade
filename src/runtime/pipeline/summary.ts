// 会话 6 · 盯盘总结：事实流水 + 输出规范固定件（零手册——格式契约是代码知识）→ §八格式 prose 总结
// 唯一非 JSON 输出的会话；LLM 失败时代码生成兜底总结——watch-summary 归档必产出（§7 轮级墙钟条款）
import { assembleKit, summaryKitSpec } from "./kit.ts";
import { runTextSession } from "./llm.ts";
import type { StageRec } from "./trace.ts";
import { log } from "../log.ts";

// 会话 6 墙钟（单会话上限；轮级预算下另有 60s 保底）
const SUMMARY_WALL_MS = 90_000;

// 摘要行与兜底总结所需的轮次事实摘要（orchestrator 组装）
export interface SummaryDigest {
  timeHM: string; // HH:MM（摘要行时间 = 调度指令注入的当前时间）
  timeHMS: string; // HH:MM:SS（总结标记时间，同源）
  regimeLabel: string; // 阶段字段 = 云端市场节点词（十词；读取失败写"该字段为空"）
  sentimentLabel: string; // 情绪标签（盘面源值；缺位写"该字段为空"）
  activeDirection: string; // 活跃方向（盘面 attack_directions[0]）
  positionLimitPct: string; // 仓位上限（如 "20%"；缺位写"缺位"）
  operations: string[]; // 实际动作（"无操作" / "买入XX N股"…）
  holdingCount: number; // 持仓只数
}

// 总结会话的阶段指令（kit 内已含总纲 §八 与核心层 §七 全文，指令只做角色与红线收口）
function summaryInstruction(): string {
  return `# 阶段任务（会话 6 · 盯盘总结）

你是柚子 AI 盯盘流水线的「总结器官」。基于用户消息注入的**事实流水**与上述输出规范，写本轮盯盘总结。

## 硬性要求

1. **时间权威**：总结标记与摘要行的时间**逐字采用**用户消息注入的「当前时间」，禁止从任何接口返回值推算
2. **格式**：以 \`========== 盯盘总结 HH:MM:SS ==========\`（等号 10 个）起头，后接观点总结 + 一行摘要行，格式遵循上方输出规范
3. **写给人看（大白话红线）**：正文只说三件事——当前环境怎么样 / 满足或不满足什么条件（只点与出手相关的关键判定，译成自然语言）/ 操作是什么加一句原因。**禁止**出现：条款编号、代码字段名与枚举值、数学比较式与符号链；不逐项罗列全部检查项，不成立的一句"其余通道今天没资格/不适用"带过
4. **如实降级**：事实流水中标注的降级 / 未实施 / 兜底事件必须如实写进总结（温度对账差异已由调度器按服务端定格覆盖并日志留痕，总结不写对账告警段）
5. **选股过程压缩写**：把事实流水「选股过程」节写进【候选分析】时控制在两三句——共筛出多少候选（有截断提一句）、终选名单、逐只核验结论（每只一句话理由，大白话、数字可保留）、是否下单、选股总耗时（约 N 秒）。**禁止**逐段报各阶段耗时、罗列"合并/剔除/分批"漏斗细节、"下单执行耗时 0 秒"这类零信息句。**买链未启动 / 未运行时**：【候选分析】一两句说明未启动原因即可——不写终选名单、核验结论、耗时等不存在的过程
6. 只输出总结全文本身，不要任何额外说明
7. **你没有工具、不能执行命令**：总结上报由系统代码自动完成，禁止输出任何工具调用 / 命令行 / cli 语法——那些语法不属于总结文本`
}

// 代码兜底总结（LLM 失败 / dry 模式）：保留标记 + 摘要行与事实行，保证归档与次日复盘输入不断档
export function buildFallbackSummary(digest: SummaryDigest, factsText: string): string {
  const lines = [
    `========== 盯盘总结 ${digest.timeHMS} ==========`,
    "（本轮为代码兜底总结——总结会话未产出，以下为事实流水摘要）",
    "",
    ...factsText.split("\n").filter(Boolean),
    "",
    buildSummaryLine(digest),
  ];
  return lines.join("\n");
}

// 摘要行（代码生成，唯一权威格式与取值）：LLM 逐字采用，杜绝"阶段吐枚举 / 操作写 16 种花样 / 仓位上限漂移"
export function buildSummaryLine(digest: SummaryDigest): string {
  return `[柚子 AI] ${digest.timeHM} | 盯盘 | 节点:${digest.regimeLabel} | 情绪:${digest.sentimentLabel} | 活跃:${digest.activeDirection} | 仓位上限:${digest.positionLimitPct} | 操作:${digest.operations.join("；") || "无操作"} | 持仓:${digest.holdingCount}只`;
}

// 会话 6 主流程：事实流水 → LLM 总结 →（失败）代码兜底
// 输出净化：模型偶发把「总结上报」当成自己的动作、输出工具调用语法原文（会话无工具）——
// 从首个工具调用标记起截断（标记前的正文即干净总结），防止污染归档与上报
function sanitizeSummaryText(text: string): string {
  const markers = ["<tool_call>", "]<]", "<invoke", "cli.py report.submit_summary"];
  let out = text;
  for (const m of markers) {
    const i = out.indexOf(m);
    if (i > 0) out = out.slice(0, i);
  }
  return out.trimEnd();
}
export async function runSummaryStage(
  projectRoot: string,
  ctx: { trade_date: string; current_time: string },
  factsText: string,
  digest: SummaryDigest,
  opts: { dry?: boolean } = {},
): Promise<{ stage: StageRec; summary: string }> {
  const startedAt = Date.now();
  const kit = assembleKit(projectRoot, "s6_summary", summaryKitSpec());

  if (opts.dry) {
    // 干跑：跳过 LLM，直接代码兜底总结（plumbing 验证用）
    return {
      stage: { id: "s6_summary", status: "degraded", reason: "dry 模式：LLM 未调用，代码兜底总结", wall_ms: Date.now() - startedAt, tokens: 0 },
      summary: buildFallbackSummary(digest, factsText),
    };
  }

  const userMessage = [
    `【当前时间】${ctx.trade_date} ${ctx.current_time}（总结标记与摘要行时间逐字采用此值）`,
    "",
    "【摘要行（代码生成，逐字采用——格式与取值都不得改写、不得自创标签）】",
    buildSummaryLine(digest),
    "",
    "【事实流水（本轮各阶段结论与数据事实，总结的唯一事实来源）】",
    factsText,
  ].join("\n");

  const result = await runTextSession({
    projectRoot,
    systemPrompt: `${kit.text}\n\n---\n\n${summaryInstruction()}`,
    userMessage,
    wallMs: SUMMARY_WALL_MS,
    stageId: "s6_summary",
  });

  const stage: StageRec = {
    id: "s6_summary",
    status: "ok",
    wall_ms: result.ms,
    tokens: result.tokens,
    cached_tokens: result.cachedTokens ?? 0,
    ...(kit.misses.length > 0 ? { kit_misses: kit.misses } : {}),
  };
  if (result.ok) {
    const clean = sanitizeSummaryText(result.text);
    log("summary", `s6 总结已产出（${clean.length} 字符${clean.length !== result.text.length ? "，已截断工具调用污染段" : ""}）`);
    return { stage, summary: clean };
  }
  // LLM 失败 → 代码兜底总结（§7：归档必产出）
  stage.status = "degraded";
  stage.reason = `总结会话失败（${result.error ?? "未知"}），代码兜底总结已生成`;
  log("summary", `总结会话失败，启用代码兜底: ${result.error ?? ""}`);
  return { stage, summary: buildFallbackSummary(digest, factsText) };
}
