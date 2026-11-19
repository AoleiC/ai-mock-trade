// read_file 工具：白名单读取（memory/** + AGENTS.md；复盘模式加当日 watch-summary），结构性替代总纲 §十一 执行边界（设计文档 §4）
// 默认整份全文返回，不设静默截断上限——白名单是收敛的受控文件集（memory 手册 + AGENTS.md + 单日 watch-summary），
//   尺寸天然有界；历史教训：12000 小分页默认值导致模型"忘了续读"在残缺策略上做判定（2026-11-04 实测），已拆除。
//   offset/limit 显式传参仍可用（模型主动分页，上限 40000/次）
// 路径失败分流（2026-11-09 实测模型猜错路径浪费轮次）：文件不存在 ≠ 越界——不存在时按文件名在 memory 清单里
//   给纠错建议，真越界才报"拒绝"；工具描述同时枚举全部白名单文件，模型不靠猜
import { readdirSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { log } from "../log.ts";

// 单文件读取的单次返回上限（仅显式传 limit 时生效；默认全文返回不经过此上限）
const EXPLICIT_LIMIT_CAP = 40000;

// 列出 memory/ 下全部 .md 文件相对路径（工具描述展示 + 猜错路径时纠错建议；文件集小且固定）
function listMemoryFiles(projectRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith(".md")) out.push(relative(projectRoot, join(dir, e.name)));
    }
  };
  try {
    walk(join(projectRoot, "memory"));
  } catch {
    // memory/ 缺失时清单为空，工具按白名单逻辑兜底
  }
  return out.sort();
}

// read_file 参数 schema
const READ_FILE_SCHEMA = Type.Object({
  path: Type.String({ description: "相对项目根的路径，如 memory/dynamic-strategy.md" }),
  offset: Type.Optional(Type.Number({ description: "起始字符偏移（分页续读用，默认 0）" })),
  limit: Type.Optional(Type.Number({ description: "本次最多返回字符数（默认全文返回；仅在明确想分页时传入，单次上限 40000）" })),
});

// 组装 read_file 工具定义；mode=review 时额外允许 data/watch-summary-{trade_date}.md
export function makeReadFileTool(projectRoot: string, mode: "watch" | "review", tradeDate: string): ToolDefinition<typeof READ_FILE_SCHEMA> {
  const memoryRoot = join(projectRoot, "memory");
  const agentsFile = join(projectRoot, "AGENTS.md");
  const reviewFile = join(projectRoot, "data", `watch-summary-${tradeDate}.md`);
  const memoryFiles = listMemoryFiles(projectRoot);
  const fileListText = memoryFiles.length > 0 ? `现有文件：${memoryFiles.join("、")}` : "目录当前为空";
  const desc =
    mode === "review"
      ? `读取文件原文，默认整份全文返回（无截断）。白名单：memory/ 目录（${fileListText}）、AGENTS.md、data/watch-summary-${tradeDate}.md（复盘当日）。白名单外一律不可读；memory 路径必须与清单逐字一致。`
      : `读取文件原文，默认整份全文返回（无截断）。白名单：memory/ 目录（${fileListText}）与 AGENTS.md（盘中轮禁读任何 watch-summary）。白名单外一律不可读；memory 路径必须与清单逐字一致。`;
  return {
    name: "read_file",
    label: "白名单读文件",
      description: desc,
      parameters: READ_FILE_SCHEMA,
      execute: async (_id, params) => {
      const target = resolve(projectRoot, params.path);
      const realTarget = await realpath(target).catch(() => null);
      if (!realTarget) {
        // 文件（或路径中某级目录）不存在：按文件名在 memory 清单里找精确匹配给纠错建议，与真越界分流
        const suggestion = memoryFiles.find((f) => basename(f) === basename(params.path));
        const text = `文件不存在: ${params.path}${suggestion ? `；是否要找 ${suggestion}` : ""}`;
        log("read_file", `文件不存在: ${params.path}${suggestion ? ` → 建议 ${suggestion}` : ""}`);
        return { content: [{ type: "text" as const, text }], details: {}, isError: true };
      }
      const realMemory = await realpath(memoryRoot).catch(() => null);
      const realAgents = await realpath(agentsFile).catch(() => null);
      const realReview = mode === "review" ? await realpath(reviewFile).catch(() => null) : null;
      const allowed =
        (!!realMemory && (realTarget === realMemory || realTarget.startsWith(realMemory + "/"))) ||
        realTarget === realAgents ||
        realTarget === realReview;
      if (!allowed) {
        log("read_file", `拒绝越界读取: ${params.path}`);
        return { content: [{ type: "text" as const, text: `路径不在白名单内: ${params.path}` }], details: {}, isError: true };
      }
      try {
        const text = await readFile(target, "utf-8");
        const offset = Math.max(0, Math.floor(params.offset ?? 0));
        // 默认整份全文（offset 起到文件末尾）；仅显式传 limit 才分页（钳 1~EXPLICIT_LIMIT_CAP）
        const limit = params.limit === undefined ? text.length : Math.min(EXPLICIT_LIMIT_CAP, Math.max(1, Math.floor(params.limit)));
        const slice = text.slice(offset, offset + limit);
        const next = offset + slice.length;
        const truncated = next < text.length;
        const head = truncated
          ? `【已分页】${params.path} 第 ${offset + 1}-${next} 字符（共 ${text.length} 字符）。续读请传 offset=${next}。\n\n`
          : "";
        log("read_file", `ok ${params.path} [${offset},${next})/${text.length}${truncated ? " 分页" : ""}`);
        return { content: [{ type: "text" as const, text: head + slice }], details: { total_chars: text.length, offset, returned: slice.length } };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `读取失败: ${e instanceof Error ? e.message : String(e)}` }], details: {}, isError: true };
      }
    },
  };
}
