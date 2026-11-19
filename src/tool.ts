#!/usr/bin/env node
// 柚子 AI 自更新工具（TypeScript / Node）：连接服务端接口，按模块增量更新本地 skills / 系统指令 / memory
// 复用 /api/web/skills/download_v2 的整包 zip（v2 专用升级接口），配合版本门禁（list 的
// project_last_updated）与 zip 缓存。覆盖前自动备份；自包含设计（fetch + adm-zip，不依赖
// skills 模块——本工具职责是更新它们）。
//
// 用法：
//   node src/tool.ts update [skills|memory|agents|all]   # 缺省 = skills
//   node src/tool.ts check                               # 仅检查服务端是否有更新，不下载
//   node src/tool.ts status                              # 显示本地版本、服务端版本、缓存状态
//   node src/tool.ts update --force                      # 跳过版本门禁强制下载（list 失败时兜底）
//
// ⚠ 版本通道说明：旧版 v1（Python 技术栈，GitHub tag/1.0）的更新接口 /api/web/skills/download
// 已由服务端废弃（恒返 410），v1 客户端不会再拉到新包；本工具只消费 v2 接口。
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { loadEnv, findProjectRoot } from "../skills/env.ts";

loadEnv();

// 项目根（源码直跑，向上找 AGENTS.md 定位根）
const SCRIPT_DIR = findProjectRoot();
const BACKUPS_DIR = join(SCRIPT_DIR, "backups");
const CACHE_DIR = join(BACKUPS_DIR, "cache");
const STATE_PATH = join(BACKUPS_DIR, "state.json");

// zip 包内项目目录前缀（服务端打包 arcname = "ai-mock-trade/<rel>"）
const ZIP_ROOT = "ai-mock-trade";

// 模块 → 覆盖目标（dir 递归整目录，file 单文件；skills = 独立 skill 层，src = 后台运行层）
const MODULE_TARGETS: Record<string, Array<[("dir" | "file"), string]>> = {
  skills: [["dir", "skills"]],
  memory: [["dir", "memory"]],
  agents: [["file", "AGENTS.md"]],
  all: [
    ["dir", "skills"],
    ["dir", "src"],
    ["dir", "memory"],
    ["file", "AGENTS.md"],
    ["file", "README.md"],
    ["file", "LICENSE"],
    ["file", "package.json"],
    ["file", "tsconfig.json"],
    ["file", ".env.example"],
    ["file", ".gitignore"],
    ["dir", "assets"],
  ],
};

// 永久黑名单（按路径任意段匹配，任何模块都不覆盖）：.env 含本地密钥；data 是运行时数据；
// backups 是工具自身产物；node_modules / dist 构建产物不入包
const BLACKLIST_SEGMENTS = new Set([".env", "data", "backups", "node_modules", "dist", ".DS_Store"]);

// 服务端接口路径（download 为 v2 专用升级接口；旧 /skills/download 已废弃恒返 410）
const LIST_PATH = "/api/web/skills/list";
const DOWNLOAD_PATH = "/api/web/skills/download_v2";

// 简易日志（stderr，与原 tool.py 一致）
function log(level: "INFO" | "ERROR" | "DEBUG", msg: string): void {
  process.stderr.write(`${level === "INFO" ? "" : `${level} `}${msg}\n`);
}

// 取服务端基地址
function getBaseUrl(): string {
  return (process.env.STOCK_API_BASE_URL ?? "https://stock.objie.com").replace(/\/+$/, "");
}

// 取认证密钥（cookie 中的 secret_key）
function getSecretKey(): string {
  return (process.env.STOCK_SECRET_KEY ?? "").trim();
}

// 自更新总开关（.env TOOL_UPDATE_ENABLED，缺省开启；关闭保守短路）
function isUpdateEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes((process.env.TOOL_UPDATE_ENABLED ?? "true").trim().toLowerCase());
}

// 带 cookie 的 GET（自包含 fetch 封装）
async function apiGet(path: string, timeoutMs = 30_000): Promise<Response> {
  const key = getSecretKey();
  return fetch(`${getBaseUrl()}${path}`, {
    headers: key ? { Cookie: `secret_key=${key}` } : {},
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// 调 list 接口拿服务端 project_last_updated
async function fetchRemoteVersion(): Promise<{ ts: number; text: string } | null> {
  let resp: Response;
  try {
    resp = await apiGet(LIST_PATH, 10_000);
  } catch (e) {
    log("ERROR", `list 接口请求失败: 错误=${e instanceof Error ? e.message : String(e)}, url=${LIST_PATH}`);
    return null;
  }
  if (resp.status !== 200) {
    log("ERROR", `list 接口异常: status=${resp.status}, url=${LIST_PATH}`);
    return null;
  }
  let plu: Record<string, unknown>;
  try {
    const body = (await resp.json()) as { data?: { project_last_updated?: Record<string, unknown> } };
    plu = body.data?.project_last_updated ?? {};
  } catch (e) {
    log("ERROR", `list 响应解析失败: 错误=${e instanceof Error ? e.message : String(e)}, url=${LIST_PATH}`);
    return null;
  }
  const ts = Number(plu.ts);
  if (!ts) {
    log("ERROR", `list 返回无 project_last_updated.ts: 响应=${JSON.stringify(plu)}`);
    return null;
  }
  return { ts, text: String(plu.text ?? "") };
}

// zip 下载缓存（命中复用省配额；miss 下载落盘）
async function ensureZip(remoteTs: number | null, force: boolean): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  let cache: string;
  if (!force && remoteTs !== null) {
    cache = join(CACHE_DIR, `ai-mock-trade-${remoteTs}.zip`);
    if (existsSync(cache)) {
      log("INFO", `命中缓存复用 zip: 版本=${remoteTs}, 路径=${basename(cache)}`);
      return cache;
    }
  }
  cache = force
    ? join(CACHE_DIR, `ai-mock-trade-force-${Date.now()}.zip`)
    : join(CACHE_DIR, `ai-mock-trade-${remoteTs}.zip`);

  let resp: Response;
  try {
    resp = await apiGet(DOWNLOAD_PATH, 60_000);
  } catch (e) {
    log("ERROR", `下载失败: 网络异常 错误=${e instanceof Error ? e.message : String(e)}, url=${DOWNLOAD_PATH}`);
    throw new Error("网络异常");
  }
  if (resp.status === 401) {
    log("ERROR", `下载失败: 认证失败 status=401, url=${DOWNLOAD_PATH}, 原因=请检查 .env 的 STOCK_SECRET_KEY`);
    throw new Error("认证失败");
  }
  if (resp.status === 429) {
    let quota: Record<string, unknown> = {};
    try {
      quota = ((await resp.json()) as { data?: Record<string, unknown> }).data ?? {};
    } catch {
      quota = {};
    }
    log("ERROR", `下载失败: 配额超限 status=429, url=${DOWNLOAD_PATH}, used=${quota.used}, limit=${quota.limit}, 原因=今日下载次数已达上限`);
    throw new Error("配额超限");
  }
  if (resp.status === 410) {
    // 接口废弃：服务端关闭了当前大版本的更新通道，提示用户重新下载整包
    let message = "";
    try {
      message = String(((await resp.json()) as { message?: string }).message ?? "");
    } catch {
      message = "";
    }
    log("ERROR", `下载失败: 接口已废弃 status=410, url=${DOWNLOAD_PATH}, 原因=${message || "当前大版本更新通道已关闭，请到官网重新下载最新安装包"}`);
    throw new Error("接口已废弃");
  }
  if (resp.status >= 300) {
    log("ERROR", `下载失败: status=${resp.status}, url=${DOWNLOAD_PATH}, 原因=${resp.statusText}`);
    throw new Error(`下载失败 status=${resp.status}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(cache, buf);
  log("INFO", `下载完成: 版本=${remoteTs}, 路径=${basename(cache)}, 大小=${buf.length} 字节`);
  return cache;
}

// 状态读写（backups/state.json；损坏视为首次运行）
function loadState(): Record<string, unknown> {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Record<string, unknown>;
  } catch (e) {
    log("INFO", `state.json 解析失败，当作首次运行: 错误=${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

function saveState(state: Record<string, unknown>): void {
  mkdirSync(BACKUPS_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// 相对路径是否命中黑名单（按路径任意段匹配）
function isBlacklisted(rel: string): boolean {
  return rel.split("/").some((seg) => BLACKLIST_SEGMENTS.has(seg));
}

// 相对路径是否属于模块覆盖范围
function matchTarget(rel: string, targets: Array<[("dir" | "file"), string]>): boolean {
  for (const [kind, tgt] of targets) {
    if (kind === "file" && rel === tgt) return true;
    if (kind === "dir" && (rel === tgt || rel.startsWith(`${tgt}/`))) return true;
  }
  return false;
}

// 收集 zip 内属于该模块的文件相对路径集合
function collectZipFiles(extractRoot: string, module: string): Set<string> {
  const zipProj = join(extractRoot, ZIP_ROOT);
  if (!existsSync(zipProj)) return new Set();
  const rels = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const rel = relative(zipProj, p).split("\\").join("/");
        if (!isBlacklisted(rel) && matchTarget(rel, MODULE_TARGETS[module]!)) rels.add(rel);
      }
    }
  };
  walk(zipProj);
  return rels;
}

// 收集本地属于该模块的文件相对路径集合
function collectLocalFiles(module: string): Set<string> {
  const rels = new Set<string>();
  for (const [kind, tgt] of MODULE_TARGETS[module]!) {
    const p = join(SCRIPT_DIR, tgt);
    if (kind === "dir") {
      if (existsSync(p)) {
        const walk = (dir: string) => {
          for (const name of readdirSync(dir)) {
            const q = join(dir, name);
            if (statSync(q).isDirectory()) walk(q);
            else {
              const rel = relative(SCRIPT_DIR, q).split("\\").join("/");
              if (!isBlacklisted(rel)) rels.add(rel);
            }
          }
        };
        walk(p);
      }
    } else if (existsSync(p) && !isBlacklisted(tgt)) {
      rels.add(tgt);
    }
  }
  return rels;
}

// 计算文件 sha256
function sha256(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

// 备份单个本地文件（保留相对路径结构）
function backupFile(src: string, backupDir: string, rel: string): void {
  const bp = join(backupDir, rel);
  mkdirSync(dirname(bp), { recursive: true });
  cpSync(src, bp);
}

// 应用单个模块的覆盖（sha256 比对 + 备份 + 写入 + 目录清理）
function applyModule(extractRoot: string, module: string, backupDir: string): Record<string, number> {
  const stats: Record<string, number> = { 新增: 0, 更新: 0, 未变: 0, 删除: 0, 保留: 0 };
  const zipProj = join(extractRoot, ZIP_ROOT);
  const zipFiles = collectZipFiles(extractRoot, module);
  const localFiles = collectLocalFiles(module);

  for (const rel of [...new Set([...zipFiles, ...localFiles])].sort()) {
    if (isBlacklisted(rel)) continue;
    const src = join(zipProj, rel);
    const dst = join(SCRIPT_DIR, rel);
    const inZip = zipFiles.has(rel);
    const inLocal = localFiles.has(rel);

    if (inZip && !inLocal) {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst);
      stats["新增"]!++;
    } else if (inZip && inLocal) {
      if (sha256(src) === sha256(dst)) {
        stats["未变"]!++;
      } else {
        backupFile(dst, backupDir, rel);
        cpSync(src, dst);
        stats["更新"]!++;
      }
    } else {
      // 服务端已删除：skills/memory 目录下源码残留 → 备份后删除；其余保守保留
      const top = rel.split("/")[0] ?? "";
      const suffix = rel.split(".").pop() ?? "";
      if (["skills", "memory"].includes(top) && ["py", "md", "ts"].includes(suffix)) {
        backupFile(dst, backupDir, rel);
        rmSync(dst);
        stats["删除"]!++;
      } else {
        stats["保留"]!++;
      }
    }
  }
  return stats;
}

// update 子命令：版本门禁 + zip 缓存 + 按模块覆盖 + 备份
async function cmdUpdate(args: { module: string; force: boolean }): Promise<number> {
  if (!getSecretKey()) {
    log("ERROR", "认证失败: .env 未配置 STOCK_SECRET_KEY，请在 .env 填入密钥后重试");
    return 1;
  }

  let remoteTs: number | null = null;
  let remoteText = "";
  const remote = await fetchRemoteVersion();
  if (remote === null) {
    if (!args.force) {
      log("ERROR", "无法获取服务端版本(list 接口失败)，中止 update；可用 --force 强制下载");
      return 1;
    }
    log("INFO", "list 接口失败，--force 强制下载（无版本号，不更新本地版本标记）");
  } else {
    remoteTs = remote.ts;
    remoteText = remote.text;
  }

  let zipPath: string;
  try {
    zipPath = await ensureZip(remoteTs, args.force);
  } catch (e) {
    log("ERROR", `更新中止: 原因=${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "tool-update-"));
  try {
    let zip: AdmZip;
    try {
      zip = new AdmZip(zipPath);
      zip.extractAllTo(tmpDir, true);
    } catch (e) {
      rmSync(zipPath, { force: true });
      log("ERROR", `解压失败: 错误=${e instanceof Error ? e.message : String(e)}, zip=${basename(zipPath)}, 原因=缓存 zip 损坏已删除，请重试`);
      return 1;
    }
    const extractRoot = tmpDir;

    const module = args.module;
    const backupStamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
    const backupDir = join(BACKUPS_DIR, backupStamp);
    try {
      const stats = applyModule(extractRoot, module, backupDir);
      const hasBackup = existsSync(backupDir) && readdirSync(backupDir).length > 0;
      log(
        "INFO",
        `更新完成: 模块=${module}, 新增=${stats["新增"]}/更新=${stats["更新"]}/未变=${stats["未变"]}/删除=${stats["删除"]}/保留=${stats["保留"]}` +
          (hasBackup ? `, 备份=backups/${backupStamp}` : ", 无文件需备份"),
      );
    } catch (e) {
      log("ERROR", `覆盖失败: 错误=${e instanceof Error ? e.message : String(e)}, 备份目录=backups/${backupStamp}, 原文可手动恢复`);
      return 1;
    }

    if (remoteTs !== null) {
      const state = loadState();
      state.last_updated_ts = remoteTs;
      state.last_updated_text = remoteText;
      state.cached_zip = relative(SCRIPT_DIR, zipPath).split("\\").join("/");
      state.last_check_at = new Date().toISOString().slice(0, 19);
      saveState(state);
    }
    return 0;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// check 子命令：仅比对版本，不下载
async function cmdCheck(): Promise<number> {
  const remote = await fetchRemoteVersion();
  if (remote === null) {
    log("ERROR", "无法获取服务端版本(list 接口失败)，请检查网络或稍后重试");
    return 1;
  }
  const state = loadState();
  const localTs = state.last_updated_ts;
  const localText = String(state.last_updated_text ?? "");
  if (localTs === remote.ts) {
    log("INFO", `已是最新: 本地=${localTs} (${localText}), 服务端=${remote.ts} (${remote.text})`);
  } else {
    log("INFO", `有更新: 本地=${localTs} (${localText}), 服务端=${remote.ts} (${remote.text})`);
  }
  return 0;
}

// status 子命令：本地状态与缓存
function cmdStatus(): number {
  const state = loadState();
  log("INFO", `本地状态: 版本=${state.last_updated_ts ?? "无"} (${String(state.last_updated_text ?? "无")}), 缓存=${String(state.cached_zip ?? "无")}, 上次检查=${String(state.last_check_at ?? "无")}`);
  if (existsSync(CACHE_DIR)) {
    const zips = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".zip")).sort();
    log("INFO", `本地缓存 zip: 数量=${zips.length}`);
    for (const z of zips) log("INFO", `  ${z} (${statSync(join(CACHE_DIR, z)).size} 字节)`);
  } else {
    log("INFO", "本地缓存 zip: 无（backups/cache 目录不存在）");
  }
  return 0;
}

// 主入口：子命令分发（自更新开关关闭时 update/check 短路返回 0，保证调度器日志干净）
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "";
  const module = argv[1] && !argv[1].startsWith("--") ? argv[1] : "skills";
  const force = argv.includes("--force");
  if (!["update", "check", "status"].includes(cmd)) {
    process.stderr.write("用法: node src/tool.ts update [skills|memory|agents|all] | check | status [--force]\n");
    return 1;
  }
  loadEnv();
  if (["update", "check"].includes(cmd) && !isUpdateEnabled()) {
    log("INFO", `自更新已关闭(.env TOOL_UPDATE_ENABLED=false)，跳过 ${cmd}；恢复自动更新请把该配置改回 true`);
    return 0;
  }
  if (cmd === "update") return cmdUpdate({ module, force });
  if (cmd === "check") return cmdCheck();
  return cmdStatus();
}

main().then((code) => process.exit(code));
