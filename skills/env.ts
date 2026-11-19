// 共享环境与路径工具：项目根发现（bundle 内向上找 AGENTS.md）+ .env 加载
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 从 bundle 位置向上找项目根（含 AGENTS.md 的目录）；找不到退回 cwd
// 源码直跑与任意嵌套深度下向上扫描都是唯一通用解
export function findProjectRoot(startDir?: string): string {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "AGENTS.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

// 读取项目根 .env 并加载到 process.env（已存在的环境变量优先，不覆盖）
export function loadEnv(root?: string): void {
  const envPath = join(root ?? findProjectRoot(), ".env");
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
