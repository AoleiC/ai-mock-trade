// 会话知识装配（pipeline 独立引擎 · 固定件模型）：
//   会话知识 = 代码持有的固定提示词（prompts.ts，随代码发版、结构稳定）+ 用户手册**整册注入**（格式无关）
//   纪律（架构宪法）：
//   - pipeline 不消费 AGENTS.md（它只服务第三方 agent 路径）——程序性知识在 prompts.ts 固定件里
//   - memory/ 心法与策略是用户调教面、格式不保证，只允许**整册注入**或会话 read_file 按需读取两种消费方式，
//     不做任何标题锚点切片（用户改手册结构不破坏装配）
//   - 数字 / 开关类策略配置在 memory/engine-config.json（结构化用户可变层），代码只做机械
//   文件 hash 变化 → 留痕"手册已变更"（attention / 日志消费）；读取失败 → 占位注入 + misses 告警（fail-visible）
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../log.ts";
import {
  P_MARKET_FIELD_DISCIPLINE,
  P_BATCH_SELECT,
  P_FINAL_SELECT,
  P_VERIFY,
  P_FINAL_RULE,
  P_SELL,
  P_SUMMARY_SPEC,
  P_REVIEW_SPEC,
} from "./prompts.ts";

// 单会话知识配给：fixed = 固定提示词（prompts.ts 常量）；manuals = 整册注入的用户手册（相对项目根路径）
export interface KitSpec {
  fixed: string[];
  manuals?: string[];
}

// 装配结果：拼接后的知识文本 + 统计（misses = 读取失败的手册文件，供 attention / --check 消费）
export interface KitAssembly {
  text: string;
  chars: number;
  misses: string[]; // 手册文件读取失败项（已占位注入——fail-visible，不静默缺知识）
  changedFiles: string[]; // 本次发现 hash 变化的手册文件（相对上一次装配的缓存）
}

// kit 缓存文件（data/kit-cache.json）：手册文件 → hash，用于检测"手册已变更"并留痕
function kitCachePath(projectRoot: string): string {
  return join(projectRoot, "data", "kit-cache.json");
}

// 读取缓存的文件 hash 表（损坏 / 缺失按空表处理）
function loadHashCache(projectRoot: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(kitCachePath(projectRoot), "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

// 回写缓存（best-effort，失败只告警不阻塞装配）
function saveHashCache(projectRoot: string, cache: Record<string, string>): void {
  try {
    const p = kitCachePath(projectRoot);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cache, null, 2), "utf-8");
  } catch (e) {
    log("kit", `hash 缓存回写失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 文本内容 hash（sha1 前 16 位足够变更检测）
function contentHash(text: string): string {
  return createHash("sha1").update(text, "utf-8").digest("hex").slice(0, 16);
}

// 装配一个会话的完整知识块：固定提示词拼接 + 手册整册注入（读取失败占位注入 + misses）
export function assembleKit(projectRoot: string, stageId: string, spec: KitSpec): KitAssembly {
  const cache = loadHashCache(projectRoot);
  const sections: string[] = spec.fixed.filter(Boolean).map((t) => t.trim());
  const misses: string[] = [];
  const changedFiles: string[] = [];

  for (const file of spec.manuals ?? []) {
    let raw: string;
    try {
      raw = readFileSync(join(projectRoot, file), "utf-8");
    } catch (e) {
      // 文件缺失：占位注入 + 告警（fail-visible——知识缺位必须可见，不能静默降智）
      misses.push(`${file}（文件读取失败）`);
      sections.push(`# 手册缺失（${file}）\n\n【装配失败】读取失败: ${e instanceof Error ? e.message : String(e)}——依赖该手册的判定按缺位纪律处理并注明`);
      continue;
    }
    // hash 变更检测（手册已变更，重新装配留痕）
    const h = contentHash(raw);
    if (cache[file] !== undefined && cache[file] !== h) {
      changedFiles.push(file);
      log("kit", `手册已变更，重新装配: ${file}（hash ${cache[file]} → ${h}）`);
    }
    cache[file] = h;
    sections.push(`# 用户手册（${file} 全文）\n\n${raw.trim()}`);
  }

  saveHashCache(projectRoot, cache);
  const text = sections.join("\n\n---\n\n");
  const chars = text.length;
  log("kit", `装配 ${stageId}: ${(spec.manuals ?? []).length} 手册整册 / ${chars} 字符 / 失败 ${misses.length} 项${changedFiles.length > 0 ? ` / 变更 ${changedFiles.length} 文件` : ""}`);
  return { text, chars, misses, changedFiles };
}

// 节点词 → 当日战法册的稳定映射（映射关系与 00-market-node.md 路由表一致，代码只持映射不持规则）
// 节点词为云端十词：冰点 / 连续冰点 / 冰点回暖 / 升温 / 连续升温 / 高潮 / 连续高潮 / 高潮降温 / 降温 / 连续降温
export const NODE_BOOK: Record<string, string> = {
  冰点: "memory/strategies/10-ice-point.md",
  连续冰点: "memory/strategies/10-ice-point.md",
  冰点回暖: "memory/strategies/40-retreat-defense.md", // 修复试探窗口（通道 E/F）细则在 40 §二E/§二F
  升温: "memory/strategies/40-retreat-defense.md",
  连续升温: "memory/strategies/40-retreat-defense.md",
  高潮: "memory/strategies/20-main-uptrend.md",
  连续高潮: "memory/strategies/20-main-uptrend.md",
  高潮降温: "memory/strategies/30-high-oscillation.md",
  降温: "memory/strategies/40-retreat-defense.md",
  连续降温: "memory/strategies/40-retreat-defense.md",
};

// 节点缺位 / 未知词的兜底册（防守语义，40 分册）
export const DEFAULT_BOOK = "memory/strategies/40-retreat-defense.md";

// 会话 1 · 节点判定 kit：字段纪律固定件 + 心法 / 节点契约 / 当日战法册整册（细分手册可 read_file 按需）
export function verdictKitSpec(node: string): KitSpec {
  return {
    fixed: [P_MARKET_FIELD_DISCIPLINE],
    manuals: ["memory/trading-mindset.md", "memory/strategies/00-market-node.md", NODE_BOOK[node] ?? DEFAULT_BOOK],
  };
}

// 会话 2 · 卖出纪律 kit：卖出程序固定件 + 心法 / 当日战法册整册（dynamic-strategy 止盈止损细则 read_file 按需）
export function sellKitSpec(node: string): KitSpec {
  return {
    fixed: [P_SELL],
    manuals: ["memory/trading-mindset.md", NODE_BOOK[node] ?? DEFAULT_BOOK],
  };
}

// 会话 3a · 批初选 kit：零手册——批内相对比较程序 + 出线契约（绝对资格裁决后移核验会话；数字门槛在 engine-config 机械层）
export function batchKitSpec(): KitSpec {
  return { fixed: [P_BATCH_SELECT] };
}

// 会话 3b · 终选 kit：零手册——同台重排 + 预算推导程序（纪律预算事实由用户消息机械注入）
export function finalSelectKitSpec(): KitSpec {
  return { fixed: [P_FINAL_SELECT] };
}

// 会话 4 · 个股核验 kit：核验程序固定件 + 心法 / 买入手册 / 核心层 / 当日战法册整册（绝对否决关口，知识必须在场而非可寻；仓位阶梯 / 止损数值 / 通道试错上限 / 买点触发为每轮必用，预喂省读册往返）
export function verifyKitSpec(node: string): KitSpec {
  return {
    fixed: [P_VERIFY],
    manuals: ["memory/trading-mindset.md", "memory/buy-playbook.md", "memory/dynamic-strategy.md", NODE_BOOK[node] ?? DEFAULT_BOOK],
  };
}

// 会话 5 · 买入终裁 kit：caps 声明程序固定件 + 心法整册（红线数值唯一来源）+ 核心层整册（组合纪律随册在场，
//   不再靠 read_file 往返——终裁每轮都在墙钟顶格运行，读册往返是超时主因）
export function finalKitSpec(): KitSpec {
  return {
    fixed: [P_FINAL_RULE],
    manuals: ["memory/trading-mindset.md", "memory/dynamic-strategy.md"],
  };
}

// 会话 6 · 盯盘总结 kit：输出规范固定件（零手册——格式契约是代码知识，事实由流水注入）
export function summaryKitSpec(): KitSpec {
  return { fixed: [P_SUMMARY_SPEC] };
}

// 复盘会话 kit：复盘输出规范固定件 + 复盘手册 / 心法整册
export function reviewKitSpec(): KitSpec {
  return {
    fixed: [P_REVIEW_SPEC],
    manuals: ["memory/review-guide.md", "memory/trading-mindset.md"],
  };
}
