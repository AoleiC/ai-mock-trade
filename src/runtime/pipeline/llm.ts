// 单次调用 LLM 会话（设计文档 §3.3）：无工具、单轮、单次调用——无 turns 概念天然有界
// JSON 会话：解析失败带强格式提示重试一次，仍失败返回错误（绝不静默采用部分结果）
// 基础设施重试：过载（429/529）退避 5s、瞬时异常（创建失败/执行异常/空输出）退避 2s 后重建会话重试一次；墙钟超限不重试
// 复用 session.ts 的会话工厂约定：systemPromptOverride + agentsFilesOverride=[] + inMemory + PI_MODEL 解析
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveEnvModel, createMainSession } from "../session.ts";
import { BudgetGate, usageBreakdown, estimateContextTokens } from "../budget.ts";
import { appendTranscript } from "./transcript.ts";
import { log } from "../log.ts";

// 单会话执行结果（JSON 或纯文本共用）
export interface SessionResult {
  ok: boolean; // 是否成功拿到并（如要求）解析了输出
  text: string; // 最终 assistant 文本（原始）
  json: Record<string, unknown> | null; // JSON 会话专用：解析后的对象
  tokens: number; // 供应商上报优先，缺失用输入字符粗估（2 字符 ≈ 1 token）
  cachedTokens?: number; // 前缀缓存命中读 cacheRead（供应商上报；未上报 / 无命中时为 0。cacheWrite 是写入成本而非命中，不计入）
  ms: number;
  retried: boolean; // 是否发生过一次格式重试
  repaired?: boolean; // 是否经确定性结构修复采用（缺闭合大括号模式，见 repairJson）
  error?: string; // 失败原因
}

// 创建无工具单轮会话（noTools:"all" 且不注册任何自定义工具 = 模型零工具面，纯文本进 / 文本出）
async function createBareSession(projectRoot: string, systemPrompt: string): Promise<AgentSession> {
  const loader = new DefaultResourceLoader({
    cwd: projectRoot,
    agentDir: getAgentDir(),
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await loader.reload();
  const envModel = await resolveEnvModel();
  const { session } = await createAgentSession({
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    noTools: "all",
    cwd: projectRoot,
    ...(envModel ? { model: envModel as never } : {}),
  });
  return session;
}

// 从模型输出解析 JSON 对象（防御式：剥代码围栏 / 取首个 { 到末个 }）
export function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// 字符串感知的大括号深度扫描：返回未闭合的 { 数量与扫描结束时是否停在字符串内
function braceDepth(text: string): { depth: number; inStr: boolean } {
  let inStr = false;
  let esc = false;
  let depth = 0;
  for (const c of text) {
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === "\"") {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return { depth, inStr };
}

// 确定性结构修复：只处理「缺闭合大括号」这一实测高频失败模式（长 open_reason 后漏关 market_gate）。
//   两个变体的结果都必须解析成功且含全部顶层必需键才接受——防止"末尾补括号"把被吞进内层对象的
//   顶层键留在错误作用域（如 size_cap_pct/buy_windows 落进 market_gate 里导致下游取值为 undefined）
function repairJson(text: string, requiredKeys: string[]): { json: Record<string, unknown>; note: string } | null {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const core = cleaned.slice(start, end + 1); // 末个 } 之后的尾随杂质丢弃
  const { depth, inStr } = braceDepth(core);
  if (depth <= 0 || inStr) return null; // 括号平衡（失败另属引号等问题）或字符串未闭合——不可机械修复
  const accept = (obj: unknown): Record<string, unknown> | null =>
    obj && typeof obj === "object" && !Array.isArray(obj) && requiredKeys.every((k) => k in (obj as Record<string, unknown>)) ? (obj as Record<string, unknown>) : null;
  // 变体 A：末尾追加 depth 个 }（截断在顶层字段之间 / 漏关最外层时作用域正确）
  try {
    const a = accept(JSON.parse(core + "}".repeat(depth)));
    if (a) return { json: a, note: `末尾补 ${depth} 个 }` };
  } catch {
    /* 试下一变体 */
  }
  // 变体 B：在顶层必需键出现处前插 depth 个 }（内层对象漏闭合把后续顶层键吞进去的作用域修复）
  //   插入点回退越过键名前的逗号（} 要落在逗号之前——保留逗号作外层成员分隔，否则产生尾随逗号 / 缺分隔符）
  for (const k of requiredKeys) {
    const needle = `"${k}"`;
    for (let idx = core.indexOf(needle); idx > 0; idx = core.indexOf(needle, idx + 1)) {
      let ins = idx;
      while (ins > 0 && /\s/.test(core[ins - 1] ?? "")) ins--;
      if (core[ins - 1] === ",") ins--;
      try {
        const b = accept(JSON.parse(core.slice(0, ins) + "}".repeat(depth) + core.slice(ins)));
        if (b) return { json: b, note: `"${k}" 前插入 ${depth} 个 }（作用域修复）` };
      } catch {
        /* 试下一候选位置 */
      }
    }
  }
  return null;
}

// 取 JSON.parse 的具体错误信息（重试提示注入用，帮助模型定位自己的结构错误；无法提取时返回 null）
function jsonParseError(text: string): string | null {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    JSON.parse(cleaned.slice(start, end + 1));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// 解析 + 结构修复：先严格解析；失败后做确定性修复（纯代码、墙钟触发后也允许）；返回结果与修复标记
function parseWithRepair(text: string, requiredKeys: string[], stageId: string): { json: Record<string, unknown> | null; repaired: boolean; parseError: string | null } {
  const json = extractJson(text);
  if (json !== null) return { json, repaired: false, parseError: null };
  const parseError = jsonParseError(text);
  const rep = repairJson(text, requiredKeys);
  if (rep) {
    log("pipeline", `${stageId} JSON 结构修复生效（${rep.note}）——模型输出缺闭合大括号`);
    return { json: rep.json, repaired: true, parseError };
  }
  return { json: null, repaired: false, parseError };
}

// 服务端过载特征（429 / 529 / 负载较高）——多会话使过载发生率放大，须显式退避（§3.3）
function isOverload(error: string): boolean {
  return error.includes("429") || error.includes("529") || error.includes("负载较高") || error.toLowerCase().includes("overload");
}

// 瞬时基础设施异常特征（会话创建失败 / 网络抖动等执行异常 / 空输出）——退避后重建会话重试一次大概率自愈；
//   墙钟超限不在其列（重试大概率再超且拖长轮次）
function isTransient(error: string): boolean {
  return error.startsWith("会话创建失败") || error.startsWith("会话执行异常") || error.includes("会话无文本输出");
}

// 是否值得退避重建重试一次（过载或瞬时异常；墙钟超限 / 解析失败不在此列——后者已有强格式提示重试）
function isRetryable(error: string): boolean {
  return isOverload(error) || isTransient(error);
}

// 带超时的等待（退避用，unref 防阻塞进程退出）
function backoff(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

// 运行一个单轮会话（内部共用）：墙钟超限 abort；wantJson 时解析失败重试一次（强格式提示）；
//   过载 / 瞬时异常时整个会话重建后指数退避重试一次（§3.3），仍败按失败返回
async function runSession(opts: {
  projectRoot: string;
  systemPrompt: string;
  userMessage: string;
  wallMs: number;
  wantJson: boolean;
  stageId: string;
  requiredKeys?: string[]; // JSON 会话的顶层必需键（结构修复的作用域校验清单；缺省只做末尾补括号变体）
}): Promise<SessionResult> {
  log("llm", `${opts.stageId} LLM 调用开始（输入 ${opts.userMessage.length} 字符，墙钟 ${Math.round(opts.wallMs / 1000)}s）…`);
  const first = await attemptSession(opts);
  let result = first;
  if (!first.ok && isRetryable(first.error ?? "")) {
    const overload = isOverload(first.error ?? "");
    log("pipeline", `${opts.stageId} ${overload ? "服务端过载" : "瞬时异常"}（${first.error?.slice(0, 80)}），退避 ${overload ? 5 : 2}s 后重建会话重试一次`);
    await backoff(overload ? 5_000 : 2_000);
    const second = await attemptSession(opts);
    if (!second.ok) second.error = `${overload ? "过载" : "瞬时异常"}重试后仍失败: ${second.error ?? "未知"}`;
    result = second;
  }
  // 完成留痕一行（tokens 双口径：cached = 供应商上报的缓存命中（cacheRead），恒 0 说明供应商未上报或未启用缓存）
  log("llm", `${opts.stageId} LLM 完成: ok=${result.ok}, tokens=${result.tokens}, cached=${result.cachedTokens ?? 0}, ${result.ms}ms`);
  // 全量留痕：完整收发原文（含过载重试标记）——人工审计
  appendTranscript("llm", {
    stage: opts.stageId,
    ok: result.ok,
    ms: result.ms,
    tokens: result.tokens,
    cached_tokens: result.cachedTokens ?? 0,
    retried: result.retried,
    error: result.error ?? null,
    repaired: result.repaired ?? false,
    system: opts.systemPrompt,
    user: opts.userMessage,
    output: result.text,
  });
  return result;
}

// 单次尝试：创建会话 → prompt →（JSON 会话）解析失败强格式重试一次
// followUp 一律带 30s 护栏（墙钟可能已触发，无护栏的收尾注入会挂死到外层 15min 硬杀）
async function attemptSession(opts: {
  projectRoot: string;
  systemPrompt: string;
  userMessage: string;
  wallMs: number;
  wantJson: boolean;
  stageId: string;
  requiredKeys?: string[];
}): Promise<SessionResult> {
  const startedAt = Date.now();
  let session: AgentSession;
  try {
    session = await createBareSession(opts.projectRoot, opts.systemPrompt);
  } catch (e) {
    return { ok: false, text: "", json: null, tokens: 0, ms: Date.now() - startedAt, retried: false, error: `会话创建失败: ${e instanceof Error ? e.message : String(e)}` };
  }

  let tokens = 0;
  let cachedTokens = 0;
  let wallFired = false;
  const unsub = session.subscribe((event) => {
    if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
      const b = usageBreakdown((event.message as { usage?: unknown }).usage);
      const reported = b.input + b.output + b.cacheRead + b.cacheWrite;
      if (reported > 0) {
        tokens += reported;
        cachedTokens += b.cacheRead;
      }
    }
  });
  const wall = setTimeout(() => {
    wallFired = true;
    log("pipeline", `${opts.stageId} 墙钟超限（${opts.wallMs}ms），abort`);
    void session.abort();
  }, opts.wallMs);
  wall.unref?.();
  const followUpGuarded = async (text: string): Promise<void> => {
    const wrap = setTimeout(() => {
      log("pipeline", `${opts.stageId} 收尾护栏（30s）触发，abort`);
      void session.abort();
    }, 30_000);
    wrap.unref?.();
    try {
      await session.followUp(text);
    } catch {
      // 收尾失败按已有产出结算
    } finally {
      clearTimeout(wrap);
    }
  };

  // 供应商不上报 usage 时用会话上下文粗估兜底（2 字符 ≈ 1 token）
  const estimate = (): number =>
    tokens > 0 ? tokens : estimateContextTokens([opts.systemPrompt, opts.userMessage, session.getLastAssistantText() ?? ""]);

  let retried = false;
  let lastError = "";
  try {
    await session.prompt(opts.userMessage);
    if (opts.wantJson) {
      let parsed = parseWithRepair(session.getLastAssistantText() ?? "", opts.requiredKeys ?? [], opts.stageId);
      let json = parsed.json;
      if (json === null && !wallFired) {
        // 重试一次：更强格式提示（含具体解析错误，帮助模型定位结构问题）
        retried = true;
        log("pipeline", `${opts.stageId} 输出无法解析为 JSON，强格式提示重试一次`);
        await followUpGuarded(
          `上一次输出无法解析为 JSON 对象${parsed.parseError ? `（解析错误：${parsed.parseError}）` : ""}。重新输出：只输出一个完整的 JSON 对象，不要任何解释文字、不要 markdown 代码块围栏；逐个检查所有 { 和 } 都成对闭合、字符串值内不要出现未转义的双引号。`,
        );
        parsed = parseWithRepair(session.getLastAssistantText() ?? "", opts.requiredKeys ?? [], opts.stageId);
        json = parsed.json;
      }
      if (json === null) {
        lastError = wallFired ? "会话墙钟超限，未获得可解析输出" : "重试后输出仍无法解析为 JSON";
        return { ok: false, text: session.getLastAssistantText() ?? "", json: null, tokens: estimate(), cachedTokens, ms: Date.now() - startedAt, retried, error: lastError };
      }
      return { ok: true, text: session.getLastAssistantText() ?? "", json, tokens: estimate(), cachedTokens, ms: Date.now() - startedAt, retried, ...(parsed.repaired ? { repaired: true } : {}) };
    }
    const text = session.getLastAssistantText()?.trim() ?? "";
    if (!text) {
      return { ok: false, text: "", json: null, tokens: estimate(), cachedTokens, ms: Date.now() - startedAt, retried, error: wallFired ? "会话墙钟超限，无输出" : "会话无文本输出" };
    }
    return { ok: true, text, json: null, tokens: estimate(), cachedTokens, ms: Date.now() - startedAt, retried };
  } catch (e) {
    return { ok: false, text: session.getLastAssistantText() ?? "", json: null, tokens: estimate(), cachedTokens, ms: Date.now() - startedAt, retried, error: wallFired ? "会话墙钟超限" : `会话执行异常: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(wall);
    unsub();
    session.dispose();
  }
}

// JSON 会话（判定 / 卖出决策 / 选股 / 核验 / 终裁等结构化输出阶段）
export function runJsonSession(opts: {
  projectRoot: string;
  systemPrompt: string;
  userMessage: string;
  wallMs: number;
  stageId: string;
  requiredKeys?: string[];
}): Promise<SessionResult> {
  return runSession({ ...opts, wantJson: true });
}

// 纯文本会话（会话 6 盯盘总结——唯一非 JSON 输出的会话）
export function runTextSession(opts: {
  projectRoot: string;
  systemPrompt: string;
  userMessage: string;
  wallMs: number;
  stageId: string;
}): Promise<SessionResult> {
  return runSession({ ...opts, wantJson: false });
}

// ── 有界自主工具会话（预喂 kit 之外保留补数自主性）──
// 原则：知识预喂（kit 全量注入）为主，工具面只收窄为白名单只读取数；
//   有界 = 轮次闸 + token 闸 + 墙钟闸，超限注入收尾指令强制产出契约输出
export interface ToolSessionResult extends SessionResult {
  toolCalls: number; // 实际执行的工具调用数（留痕用）
  truncated: boolean; // 是否触发过轮次 / token / 墙钟闸（结果 JSON budget_truncated 如实上报）
}

// 工具会话执行（内部共用）：与无工具会话同格式契约（JSON 解析失败强提示重试一次；过载 / 瞬时异常退避重建一次）
async function runToolSession(opts: {
  projectRoot: string;
  systemPrompt: string;
  userMessage: string;
  wallMs: number;
  wantJson: boolean;
  stageId: string;
  requiredKeys?: string[]; // JSON 会话的顶层必需键（结构修复的作用域校验清单）
  tools: ToolDefinition[];
  maxTurns: number;
  tokenLimit: number;
}): Promise<ToolSessionResult> {
  log("llm", `${opts.stageId} LLM 调用开始（输入 ${opts.userMessage.length} 字符，工具 ${opts.tools.length} 项 / 上限 ${opts.maxTurns} 轮，墙钟 ${Math.round(opts.wallMs / 1000)}s）…`);
  const first = await attemptToolSession(opts);
  let result = first;
  if (!first.ok && isRetryable(first.error ?? "")) {
    const overload = isOverload(first.error ?? "");
    log("pipeline", `${opts.stageId} ${overload ? "服务端过载" : "瞬时异常"}（${first.error?.slice(0, 80)}），退避 ${overload ? 5 : 2}s 后重建会话重试一次`);
    await backoff(overload ? 5_000 : 2_000);
    const second = await attemptToolSession(opts);
    if (!second.ok) second.error = `${overload ? "过载" : "瞬时异常"}重试后仍失败: ${second.error ?? "未知"}`;
    result = second;
  }
  // 完成留痕一行（tokens 双口径：cached = 供应商上报的缓存命中（cacheRead），恒 0 说明供应商未上报或未启用缓存）
  log("llm", `${opts.stageId} LLM 完成: ok=${result.ok}, tokens=${result.tokens}, cached=${result.cachedTokens ?? 0}, ${result.ms}ms, tool_calls=${result.toolCalls}`);
  appendTranscript("llm", {
    stage: opts.stageId,
    ok: result.ok,
    ms: result.ms,
    tokens: result.tokens,
    cached_tokens: result.cachedTokens ?? 0,
    retried: result.retried,
    tool_calls: result.toolCalls,
    error: result.error ?? null,
    repaired: result.repaired ?? false,
    system: opts.systemPrompt,
    user: opts.userMessage,
    output: result.text,
  });
  return result;
}

// 工具会话单次尝试：createMainSession（白名单工具面）→ prompt（agentic 循环内执行工具）→ 预算/墙钟超限收尾注入
async function attemptToolSession(opts: {
  projectRoot: string;
  systemPrompt: string;
  userMessage: string;
  wallMs: number;
  wantJson: boolean;
  stageId: string;
  requiredKeys?: string[];
  tools: ToolDefinition[];
  maxTurns: number;
  tokenLimit: number;
}): Promise<ToolSessionResult> {
  const startedAt = Date.now();
  let session: AgentSession;
  try {
    session = await createMainSession(opts.projectRoot, opts.systemPrompt, opts.tools);
  } catch (e) {
    return { ok: false, text: "", json: null, tokens: 0, ms: Date.now() - startedAt, retried: false, toolCalls: 0, truncated: false, error: `会话创建失败: ${e instanceof Error ? e.message : String(e)}` };
  }

  let tokens = 0;
  let cachedTokens = 0;
  let toolCalls = 0;
  let budgetReason: "max_turns" | "token_limit" | null = null;
  let wallFired = false;
  const wasTruncated = (): boolean => budgetReason !== null || wallFired;
  const finalizeHint = opts.wantJson
    ? "预算已达上限。立即停止一切工具调用，基于已有信息只输出一个完整的 JSON 对象（契约格式），不要任何解释文字。"
    : "预算已达上限。立即停止一切工具调用，基于已有信息直接输出最终文本（按任务要求的格式），不要再做任何补充取数。";
  const gate = new BudgetGate({ maxTurns: opts.maxTurns, tokenLimit: opts.tokenLimit }, (reason) => {
    budgetReason = reason;
    log("pipeline", `${opts.stageId} 触发 ${reason} 闸，abort 工具循环`);
    void session.abort();
  });
  const unsub = session.subscribe((event) => {
    if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
      const b = usageBreakdown((event.message as { usage?: unknown }).usage);
      const reported = b.input + b.output + b.cacheRead + b.cacheWrite;
      const cached = b.cacheRead;
      const est = reported > 0 ? reported : estimateContextTokens([opts.systemPrompt, opts.userMessage, session.getLastAssistantText() ?? ""]);
      gate.feedTurn(est);
      tokens += est;
      cachedTokens += cached;
      log("turn", `#${gate.stats().turns} tokens=${est}${reported > 0 ? ` cache=${cached}` : "(估)"}`);
    } else if (event.type === "tool_execution_start") {
      toolCalls += 1;
      log("tool", event.toolName);
    }
  });
  const wall = setTimeout(() => {
    wallFired = true;
    log("pipeline", `${opts.stageId} 墙钟超限（${opts.wallMs}ms），abort`);
    void session.abort();
  }, opts.wallMs);
  wall.unref?.();
  // followUp 一律带 30s 护栏（墙钟可能已触发，无护栏的收尾注入会挂死到外层 15min 硬杀）
  const followUpGuarded = async (text: string): Promise<void> => {
    const wrap = setTimeout(() => {
      log("pipeline", `${opts.stageId} 收尾护栏（30s）触发，abort`);
      void session.abort();
    }, 30_000);
    wrap.unref?.();
    try {
      await session.followUp(text);
    } catch {
      // 收尾失败按已有产出结算
    } finally {
      clearTimeout(wrap);
    }
  };

  const estimate = (): number => (tokens > 0 ? tokens : estimateContextTokens([opts.systemPrompt, opts.userMessage, session.getLastAssistantText() ?? ""]));

  let retried = false;
  try {
    await session.prompt(opts.userMessage);
    // 预算截断但尚无可用输出 → 一次收尾注入（强制产出契约输出）
    if (wasTruncated() && !session.getLastAssistantText()?.trim()) {
      await followUpGuarded(finalizeHint);
    }
    if (opts.wantJson) {
      let parsed = parseWithRepair(session.getLastAssistantText() ?? "", opts.requiredKeys ?? [], opts.stageId);
      let json = parsed.json;
      if (json === null && !wallFired) {
        retried = true;
        log("pipeline", `${opts.stageId} 输出无法解析为 JSON，强格式提示重试一次`);
        await followUpGuarded(
          `上一次输出无法解析为 JSON 对象${parsed.parseError ? `（解析错误：${parsed.parseError}）` : ""}。重新输出：只输出一个完整的 JSON 对象，不要任何解释文字、不要 markdown 代码块围栏；逐个检查所有 { 和 } 都成对闭合、字符串值内不要出现未转义的双引号。`,
        );
        parsed = parseWithRepair(session.getLastAssistantText() ?? "", opts.requiredKeys ?? [], opts.stageId);
        json = parsed.json;
      }
      if (json === null) {
        return { ok: false, text: session.getLastAssistantText() ?? "", json: null, tokens: estimate(), cachedTokens, ms: Date.now() - startedAt, retried, toolCalls, truncated: wasTruncated(), error: wallFired ? "会话墙钟超限，未获得可解析输出" : "重试后输出仍无法解析为 JSON" };
      }
      return { ok: true, text: session.getLastAssistantText() ?? "", json, tokens: estimate(), cachedTokens, ms: Date.now() - startedAt, retried, toolCalls, truncated: wasTruncated(), ...(parsed.repaired ? { repaired: true } : {}) };
    }
    const text = session.getLastAssistantText()?.trim() ?? "";
    if (!text) {
      return { ok: false, text: "", json: null, tokens: estimate(), cachedTokens, ms: Date.now() - startedAt, retried, toolCalls, truncated: wasTruncated(), error: wallFired ? "会话墙钟超限，无输出" : "会话无文本输出" };
    }
    return { ok: true, text, json: null, tokens: estimate(), cachedTokens, ms: Date.now() - startedAt, retried, toolCalls, truncated: wasTruncated() };
  } catch (e) {
    return { ok: false, text: session.getLastAssistantText() ?? "", json: null, tokens: estimate(), cachedTokens, ms: Date.now() - startedAt, retried, toolCalls, truncated: wasTruncated(), error: wallFired ? "会话墙钟超限" : `会话执行异常: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(wall);
    unsub();
    session.dispose();
  }
}

// 有界自主 · JSON 会话（节点判定 / 个股核验等：预喂 kit + 白名单只读工具补数）
export function runToolJsonSession(opts: {
  projectRoot: string;
  systemPrompt: string;
  userMessage: string;
  wallMs: number;
  stageId: string;
  requiredKeys?: string[];
  tools: ToolDefinition[];
  maxTurns?: number;
  tokenLimit?: number;
}): Promise<ToolSessionResult> {
  return runToolSession({ ...opts, wantJson: true, maxTurns: opts.maxTurns ?? 8, tokenLimit: opts.tokenLimit ?? 400_000 });
}

// 有界自主 · 纯文本会话（复盘总结：预喂事实 + 白名单只读工具补数）
export function runToolTextSession(opts: {
  projectRoot: string;
  systemPrompt: string;
  userMessage: string;
  wallMs: number;
  stageId: string;
  tools: ToolDefinition[];
  maxTurns?: number;
  tokenLimit?: number;
}): Promise<ToolSessionResult> {
  return runToolSession({ ...opts, wantJson: false, maxTurns: opts.maxTurns ?? 10, tokenLimit: opts.tokenLimit ?? 500_000 });
}
