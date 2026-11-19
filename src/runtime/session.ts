// 主会话工厂：systemPromptOverride（派生 prompt）+ agentsFilesOverride=[]（禁 AGENTS.md 自动注入）+ inMemory 会话 + 工具面白名单（设计文档 §4）
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { log } from "./log.ts";

// 解析环境变量指定的模型（PI_MODEL 支持 "provider/model" 或裸模型名 + PI_PROVIDER）：
// 精确命中返回 Model；未配置返回 undefined（走 pi 默认选择）；配置了但找不到返回 null（显式报错不静默回退）
export async function resolveEnvModel(): Promise<unknown | undefined | null> {
  const raw = process.env.PI_MODEL?.trim();
  if (!raw) return undefined;
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  let provider = process.env.PI_PROVIDER?.trim();
  let modelId = raw;
  const slash = raw.indexOf("/");
  if (slash > 0) {
    provider = raw.slice(0, slash);
    modelId = raw.slice(slash + 1);
  }
  if (!provider) return null;
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) return null;
  return model;
}

// 创建主会话：工具面 = 仅本项目的自定义工具（内置工具全关），systemPromptOverride（派生 prompt）+ agentsFilesOverride=[]（禁 AGENTS.md 自动注入）+ inMemory 会话
export async function createMainSession(
  projectRoot: string,
  systemPrompt: string,
  customTools: ToolDefinition[],
): Promise<AgentSession> {
  const loader = new DefaultResourceLoader({
    cwd: projectRoot,
    agentDir: getAgentDir(),
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    // 禁用项目 context files 自动注入（AGENTS.md 已由派生精简版承载，原文不重复进入上下文）
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await loader.reload();
  const envModel = await resolveEnvModel();
  if (envModel === null) {
    log("session", `PI_MODEL 配置无法解析: model=${process.env.PI_MODEL ?? ""} provider=${process.env.PI_PROVIDER ?? ""}（按默认模型继续）`);
  } else if (envModel !== undefined) {
    const m = envModel as { provider?: string; id?: string; modelId?: string };
    log("session", `PI_MODEL 生效: ${m.provider ?? ""}/${m.id ?? m.modelId ?? ""}`);
  }
  // 工具面装配（关键）：
  //   noTools:"all" 关掉内置工具；tools 白名单把自定义工具列入 allowedToolNames + initialActiveToolNames。
  //   ⚠ 只给 noTools 不给 tools 时，pi 的 allowedToolNames=[] 会把自定义工具一并过滤掉——
  //     模型拿不到工具 schema，只会照 prompt 里的工具名"凭空"编造调用，pi 找不到可执行工具便直接结束该轮。
  const toolNames = customTools.map((t) => t.name);
  const { session } = await createAgentSession({
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    noTools: "all",
    tools: toolNames,
    customTools,
    cwd: projectRoot,
    ...(envModel ? { model: envModel as never } : {}),
  });
  log("session", `工具面: ${toolNames.join(", ")}`);
  return session;
}
