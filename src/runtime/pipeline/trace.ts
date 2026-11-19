// 每轮留痕 + attention 问题清单聚合（设计文档 §8 / §8.1）
// trace：每轮在 data/pipeline-trace-{date}.jsonl 追加一行（机器可析，best-effort 写失败不中断轮次）
// attention：degraded/error 阶段机械聚合进 data/attention-{date}.md（单一出口；发现与收集是代码的活，不依赖模型）
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import { localDateString } from "../../../skills/journal/journal.ts";

// 阶段状态枚举（skipped 必带 reason / degraded 必带降级说明）
export type StageStatus = "ok" | "skipped" | "degraded" | "error";

// 单阶段记录（额外字段按阶段自由扩展：funnel / verdicts / output 等）
export interface StageRec {
  id: string;
  status: StageStatus;
  reason?: string;
  wall_ms?: number;
  tokens?: number;
  [key: string]: unknown;
}

// attention 级别（分级纪律见 §8.1：正常 skipped 不算问题，防狼来了）
export type AttentionLevel = "ERROR" | "WARN" | "INFO";

// 本地时间 HH:MM:SS
function nowHMS(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// attention 文件路径（data/attention-{date}.md，当日累积，代码维护的唯一问题出口）
export function attentionPath(projectRoot: string, dateStr = localDateString()): string {
  return join(projectRoot, "data", `attention-${dateStr}.md`);
}

// 追加一条 attention 记录（所有告警源只准写这里，不准各自直接通知——将来通知只是本文件的 consumer）
export function appendAttention(projectRoot: string, level: AttentionLevel, text: string): void {
  try {
    const path = attentionPath(projectRoot);
    mkdirSync(join(projectRoot, "data"), { recursive: true });
    appendFileSync(path, `- [${nowHMS()}] ${level} ${text}\n`, "utf-8");
  } catch (e) {
    // 写失败不中断轮次（告警即可）
    log("attention", `写入失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 单轮留痕：阶段记录 + 候选判决链 + 委托 + 用量（双口径 token 记账）
export class RoundTrace {
  readonly round: string;
  readonly mode: string;
  private stages: StageRec[] = [];
  private candidates: unknown[] = [];
  private orders: unknown[] = [];
  private extra: Record<string, unknown> = {};

  constructor(round: string, mode: string) {
    this.round = round;
    this.mode = mode;
  }

  // 记录一个阶段（同 id 重复调用以后者覆盖——以最终状态为准）
  addStage(rec: StageRec): void {
    const idx = this.stages.findIndex((s) => s.id === rec.id);
    if (idx >= 0) this.stages[idx] = rec;
    else this.stages.push(rec);
  }

  // 已记录阶段的只读快照（事实流水组装用）
  stagesSnapshot(): StageRec[] {
    return this.stages.map((s) => ({ ...s }));
  }

  // 记录候选逐级判决链（"为什么没买 X"一次 grep 可答）
  setCandidates(candidates: unknown[]): void {
    this.candidates = candidates;
  }

  // 记录本轮委托 / 成交
  setOrders(orders: unknown[]): void {
    this.orders = orders;
  }

  // 记录轮级附加信息（rules 编译态 / usage 双口径汇总等）
  setExtra(key: string, value: unknown): void {
    this.extra[key] = value;
  }

  // 轮次收尾：落盘 jsonl 一行 + attention 聚合（best-effort，绝不向上抛）
  finish(projectRoot: string, wallMs: number): void {
    const record = {
      round: this.round,
      mode: this.mode,
      wall_ms: wallMs,
      stages: this.stages,
      candidates: this.candidates,
      orders: this.orders,
      ...this.extra,
    };
    try {
      const path = join(projectRoot, "data", `pipeline-trace-${localDateString()}.jsonl`);
      mkdirSync(join(projectRoot, "data"), { recursive: true });
      appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
    } catch (e) {
      log("trace", `落盘失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
      appendAttention(projectRoot, "WARN", `pipeline-trace 落盘失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    // attention 聚合：degraded → WARN / error → ERROR（正常 skipped 不算问题）
    for (const s of this.stages) {
      if (s.status === "degraded") {
        appendAttention(projectRoot, "WARN", `[${this.mode}] ${s.id} 降级: ${String(s.reason ?? "未注明")}`);
      } else if (s.status === "error") {
        appendAttention(projectRoot, "ERROR", `[${this.mode}] ${s.id} 失败: ${String(s.reason ?? "未注明")}`);
      }
    }
  }
}
