// 单轮用量四分类拆解（tokens_uncached / tokens_cached 双口径计量的数据源）
export interface UsageTokens {
  input: number; // 全价输入 token（未命中缓存部分）
  output: number; // 输出 token
  cacheRead: number; // 前缀缓存命中读（供应商支持时上报，未支持恒为 0）
  cacheWrite: number; // 前缀缓存写入（供应商支持时上报，未支持恒为 0）
}

// 拆解供应商单轮 usage 为四分类：兼容 pi 的 usage 结构（input/output/cacheRead/cacheWrite）
// 与 Anthropic 原生结构（input_tokens/output_tokens/cache_read_input_tokens…）。
// 供应商不上报 usage 时返回全 0，由调用方走上下文估算兜底。
export function usageBreakdown(usage: unknown): UsageTokens {
  if (!usage || typeof usage !== "object") return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const u = usage as Record<string, number>;
  const pick = (...keys: string[]): number => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    }
    return 0;
  };
  return {
    input: pick("input", "input_tokens"),
    output: pick("output", "output_tokens"),
    cacheRead: pick("cacheRead", "cache_read_input_tokens", "cache_read_tokens"),
    cacheWrite: pick("cacheWrite", "cache_creation_input_tokens", "cache_write_tokens"),
  };
}

// 上下文 token 粗估（供应商不上报 usage 时的兜底）：按字符数折算，
// 中英混排取 2 字符 ≈ 1 token 的经验值，只用于预算闸与记账，不做计费依据。
export function estimateContextTokens(texts: string[]): number {
  let chars = 0;
  for (const t of texts) chars += t.length;
  return Math.ceil(chars / 2);
}

// 预算硬闸：主/子会话轮次、总 token、墙钟（设计文档 §7）——代码而非纪律
import process from "node:process";

// 预算超限原因（模块内使用；超限回调由调用方注入收尾逻辑）
type BudgetReason = "max_turns" | "token_limit" | null;

// 单会话预算闸：订阅事件喂入，超限即回调 abort（由调用方注入收尾逻辑）
export class BudgetGate {
  private turns = 0;
  private tokens = 0; // 输入+缓存读+输出合计
  private aborted = false;
  private readonly opts: { maxTurns: number; tokenLimit: number };
  private readonly onExceed: (reason: Exclude<BudgetReason, null>) => void;

  constructor(
    opts: { maxTurns: number; tokenLimit: number },
    onExceed: (reason: Exclude<BudgetReason, null>) => void,
  ) {
    this.opts = opts;
    this.onExceed = onExceed;
  }

  // 喂入一轮的 token 用量（已由调用方归一化：供应商上报优先，上报缺失时用上下文估算兜底）
  feedTurn(tokens: number): void {
    this.turns += 1;
    this.tokens += Math.max(0, tokens);
    if (this.aborted) return;
    if (this.turns > this.opts.maxTurns) {
      this.aborted = true;
      this.onExceed("max_turns");
    } else if (this.opts.tokenLimit > 0 && this.tokens > this.opts.tokenLimit) {
      this.aborted = true;
      this.onExceed("token_limit");
    }
  }

  // 当前计数快照（结果 JSON 记账用）
  stats(): { turns: number; tokens: number } {
    return { turns: this.turns, tokens: this.tokens };
  }

  // 是否已触发过闸
  isAborted(): boolean {
    return this.aborted;
  }
}

// 进程退出码统一出口（stdout 协议之外的信息一律不打）
export function exitWith(error: unknown): never {
  const msg = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[runtime fatal] ${msg}\n`);
  process.stdout.write(`${JSON.stringify({ summary: "", error: msg })}\n`);
  process.exit(1);
}
