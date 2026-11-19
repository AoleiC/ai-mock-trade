#!/usr/bin/env node
// 柚子 AI 定时盯盘调度器（TypeScript / Node 直跑）：常驻进程，按 A 股交易时段触发 pi agent runtime
// 交易日 09:30-11:30 / 13:00-15:00 每 5 分钟一轮盯盘，21:00 一次复盘；非交易时段只 sleep。
// 引擎唯一（pipeline 流水线，无回退；classic 已退役）：机械层（watch-context.ts，0 token）→ ctx 落盘 →
// node src/runtime/pipeline/main.ts → stdout 结果 JSON → summary 直写归档（零 grep）。
// 启动时自动升级 skills（node src/tool.ts update skills，失败只告警）+ 分层清理旧文件 + pi 就绪检测。
//
// 用法：node src/scheduler.ts [--interval 5] [--once watch|review] ...
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { basename, dirname, join } from "node:path";
import { loadEnv, findProjectRoot } from "../skills/env.ts";
import { buildReviewContext, buildWatchContext, type CtxLogger } from "./watch-context.ts";
import { runPreflight } from "./preflight.ts";

loadEnv();

// 项目根（bundle 在 dist/ 下，向上找 AGENTS.md 定位根）
const SCRIPT_DIR = findProjectRoot();

// A 股盘中两段（闭区间表示闭市后不再触发）
const MORNING_START = [9, 30] as const;
const MORNING_END = [11, 30] as const;
const AFTERNOON_START = [13, 0] as const;
const AFTERNOON_END = [15, 0] as const;

// 日志类保留窗口（自然日）：run/scheduler 日志早清理
const LOG_RETENTION_DAYS = 2;
// 落地数据保留窗口：总结归档长留（复盘回溯资产）
const DATA_RETENTION_DAYS = 10;

// 引擎执行链：调度器 spawn runtime（独立进程故障隔离）
const NODE_MIN_VERSION: [number, number] = [22, 18];
// 引擎唯一（v4.3）：classic runtime 已整体退役，盯盘与复盘统一走 pipeline 流水线
const RUNTIME_ENTRY = "src/runtime/pipeline/main.ts";
// 单轮外层硬杀（runtime 内部墙钟 10 分钟 + 收尾宽限 90s；外层 15 分钟兜底）
const RUNTIME_HARD_KILL_MS = 15 * 60_000;
// 命令行参数（同名环境变量可覆盖，CLI 参数优先）
function parseArgs(): {
  interval: number;
  reviewHour: number;
  reviewMinute: number;
  pidFile: string;
  logDir: string;
  once: "watch" | "review" | null;
  rehearse: boolean;
  forceRound: boolean;
} {
  const argv = process.argv.slice(2);
  const get = (name: string, envName: string, def: string): string => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
    return process.env[envName] ?? def;
  };
  const onceIdx = argv.indexOf("--once");
  const onceVal = onceIdx >= 0 ? argv[onceIdx + 1] : null;
  return {
    interval: Math.max(1, parseInt(get("interval", "WATCH_INTERVAL_MINUTES", "5"), 10) || 5),
    reviewHour: parseInt(get("review-hour", "WATCH_REVIEW_HOUR", "21"), 10) || 21,
    reviewMinute: parseInt(get("review-minute", "WATCH_REVIEW_MINUTE", "0"), 10) || 0,
    pidFile: get("pid-file", "WATCH_PID_FILE", join(SCRIPT_DIR, "data", "watch_scheduler.pid")),
    logDir: get("log-dir", "WATCH_LOG_DIR", join(SCRIPT_DIR, "data", "watch_scheduler_logs")),
    once: onceVal === "watch" || onceVal === "review" ? onceVal : null,
    rehearse: argv.includes("--rehearse"),
    // 强制执行本轮（跳过休市闸 / 盘前空转闸）——用命令行开关而非环境变量前缀，跨平台（Windows cmd 不支持 VAR=value cmd）
    forceRound: argv.includes("--force-round"),
  };
}

// 简易分级日志：控制台 + 按日归档文件（对齐原 scheduler-*.log 格式）
class SchedLogger {
  private fh: number;
  constructor(logDir: string) {
    mkdirSync(logDir, { recursive: true });
    this.fh = openSync(join(logDir, `scheduler-${localDate()}.log`), "a");
  }
  private write(level: string, msg: string): void {
    const line = `${nowStamp()} [${level}] ${msg}`;
    process.stdout.write(`${line}\n`);
    appendFileSync(this.fh, `${line}\n`, "utf-8");
  }
  info(msg: string): void {
    this.write("INFO", msg);
  }
  warning(msg: string): void {
    this.write("WARNING", msg);
  }
  error(msg: string): void {
    this.write("ERROR", msg);
  }
}

// 本地日期/时间工具
function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function nowStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${localDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function nowHMS(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 短等待（事件循环内 sleep，可被停止标志打断；返回 false = 被打断）
async function nap(ms: number, stopFlag: { stop: boolean } | null): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (stopFlag?.stop) return false;
    await new Promise((r) => setTimeout(r, Math.min(500, deadline - Date.now())));
  }
  return !stopFlag?.stop;
}

// 从文件名提取日期（兼容 ISO 与紧凑两种格式；无法识别返回 null）
function dateFromFilename(name: string): string | null {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(name) ?? /(\d{4})(\d{2})(\d{2})/.exec(name);
  if (!m) return null;
  const [, y, mo, da] = m as unknown as [string, string, string, string];
  if (Number(mo) < 1 || Number(mo) > 12 || Number(da) < 1 || Number(da) > 31) return null;
  return `${y}-${mo}-${da}`;
}

// 两个 YYYY-MM-DD 的自然日差（b − a）
function daysBetweenDates(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// 总结归档：runtime summary 直写按日 md（格式契约：保留总结标记与摘要行，对账正则锚定）
function archiveSummaryText(summary: string, mode: string, dataDir: string, log: SchedLogger): void {
  const text = (summary ?? "").trim();
  if (!text) {
    log.warning("总结归档跳过: runtime summary 为空");
    return;
  }
  const kind = mode === "watch" ? "watch-summary" : "review-summary";
  const archive = join(dataDir, `${kind}-${localDate()}.md`);
  try {
    appendFileSync(archive, `${text}\n\n`, "utf-8");
    log.info(`总结归档完成: ${basename(archive)} (${text.length} 字符)`);
  } catch (exc) {
    log.warning(`总结归档写入失败: ${archive}, err=${exc instanceof Error ? exc.message : String(exc)}`);
  }
}

// 启动前分层清理：日志类早清（data 下非归档文件 + log 目录），总结归档长留
function cleanupOldLogs(dataDir: string, logDir: string, log: SchedLogger): void {
  const todayStr = localDate();
  // 截止日 = 最旧保留日（含当日保留）：保留窗口 N 个自然日 = 今天 + 往前 N-1 天
  const logCutoff = addDays(todayStr, -(LOG_RETENTION_DAYS - 1));
  const dataCutoff = addDays(todayStr, -(DATA_RETENTION_DAYS - 1));
  let deleted = 0;
  for (const directory of [dataDir, logDir]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of entries) {
      const file = join(directory, name);
      let isFile = false;
      try {
        isFile = statSync(file).isFile();
      } catch {
        continue;
      }
      if (!isFile) continue;
      const fileDate = dateFromFilename(name);
      if (!fileDate) continue;
      const isArchived =
        name.startsWith("watch-summary-") ||
        name.startsWith("review-summary-") ||
        name.startsWith("attention-") || // 问题清单：落地数据档保留（复盘 / 人工回溯消费）
        name.startsWith("pipeline-trace-"); // 流水线留痕：落地数据档保留（纪律机检 / 问责消费）
      const cutoff = directory === dataDir && isArchived ? dataCutoff : logCutoff;
      if (daysBetweenDates(cutoff, fileDate) >= 0) continue; // 文件日期不早于截止日（含当日），保留
      try {
        unlinkSync(file);
        deleted += 1;
      } catch (exc) {
        log.warning(`删除旧文件失败: ${file}, err=${exc instanceof Error ? exc.message : String(exc)}`);
      }
    }
  }
  log.info(`旧文件分层清理完成: 日志截止<=${logCutoff}(${LOG_RETENTION_DAYS}天), 落地数据截止<=${dataCutoff}(${DATA_RETENTION_DAYS}天), 删除文件数=${deleted}`);
}

// 日期加天数（YYYY-MM-DD）
function addDays(dateStr: string, days: number): string {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// 启动前自动升级 skills（spawn node src/tool.ts update skills；失败只告警不阻塞）
function autoUpgradeSkills(log: SchedLogger): void {
  const toolPath = join(SCRIPT_DIR, "src", "tool.ts");
  if (!existsSync(toolPath)) {
    log.warning(`自动升级 skills 跳过: 未找到 ${toolPath}`);
    return;
  }
  log.info(`启动前自动升级 skills: 命令=node src/tool.ts update skills`);
  try {
    const r = spawnSync(process.execPath, [toolPath, "update", "skills"], { cwd: SCRIPT_DIR, timeout: 180_000 });
    for (const line of String(r.stderr ?? "").split("\n")) {
      if (line.trim()) log.info(`[tool.js] ${line.trim()}`);
    }
    if (r.status === 0) log.info("自动升级 skills 完成: returncode=0");
    else log.warning(`自动升级 skills 失败(不阻塞启动): returncode=${r.status}, 详情见上方 [tool.js] 输出`);
  } catch (exc) {
    log.warning(`自动升级 skills 失败(不阻塞启动): 原因=${exc instanceof Error ? exc.message : String(exc)}`);
  }
}

// 交易窗口 / 周末判定
function inTradingWindow(d = new Date()): boolean {
  const hm = d.getHours() * 60 + d.getMinutes();
  const morning = MORNING_START[0] * 60 + MORNING_START[1];
  const morningEnd = MORNING_END[0] * 60 + MORNING_END[1];
  const afternoon = AFTERNOON_START[0] * 60 + AFTERNOON_START[1];
  const afternoonEnd = AFTERNOON_END[0] * 60 + AFTERNOON_END[1];
  return (hm >= morning && hm < morningEnd) || (hm >= afternoon && hm < afternoonEnd);
}
function isWeekend(d = new Date()): boolean {
  return d.getDay() === 0 || d.getDay() === 6;
}

// pi 就绪检测（诊断性，非回退）：node 版本 + runtime 入口 + --check 自检
function checkPiReady(log: SchedLogger): boolean {
  const entries = [RUNTIME_ENTRY];
  for (const entry of entries) {
    if (!existsSync(join(SCRIPT_DIR, entry))) {
      log.error(`pi 就绪检测未过: 缺少 ${entry}（在项目根执行 npm install 安装依赖）`);
      return false;
    }
  }
  const v = spawnSync("node", ["--version"], { timeout: 15_000 });
  const m = /v(\d+)\.(\d+)/.exec(String(v.stdout ?? ""));
  if (!m || Number(m[1]) < NODE_MIN_VERSION[0] || (Number(m[1]) === NODE_MIN_VERSION[0] && Number(m[2]) < NODE_MIN_VERSION[1])) {
    log.error(`pi 就绪检测未过: node 版本过低（${String(v.stdout ?? "").trim() || "未知"}，需 >= ${NODE_MIN_VERSION.join(".")}）`);
    return false;
  }
  for (const entry of entries) {
    const chk = spawnSync("node", [join(SCRIPT_DIR, entry), "--check"], { cwd: SCRIPT_DIR, timeout: 60_000 });
    if (chk.status !== 0) {
      log.error(`pi 就绪检测未过: ${basename(entry)} --check 失败 returncode=${chk.status}, 输出=${String(chk.stdout ?? chk.stderr ?? "").trim().slice(0, 300)}`);
      return false;
    }
  }
  log.info(`pi 就绪检测通过: node=${String(v.stdout ?? "").trim()}, engine=pipeline, runtime=${entries.join(",")}`);
  return true;
}

// 盘前预检（设计文档 §8.1 时点 1）：每交易日一次（进程内幂等），问题清单写 data/attention-{date}.md
async function maybeRunPreflight(log: SchedLogger): Promise<void> {
  const today = localDate();
  if (preflightDoneDate === today) return;
  preflightDoneDate = today;
  log.info("执行盘前预检（状态机 / attention 遗留 / 归档断档 / 残留委托）...");
  try {
    await runPreflight(SCRIPT_DIR, log);
  } catch (exc) {
    log.warning(`盘前预检异常（不阻塞调度）: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
}
// 当日预检完成标记（进程内，重启后会再跑一次——幂等，只追加清单）
let preflightDoneDate: string | null = null;

// ctx 落盘（watch：注入块；review：复盘注入块——事实取服务端，决策档案由 review 流水线预喂）
async function writePiContext(mode: "watch" | "review", log: SchedLogger, ctxLogger: CtxLogger): Promise<string> {
  const now = new Date();
  let block = "";
  if (mode === "watch") {
    block = await buildWatchContext(SCRIPT_DIR, ctxLogger);
    if (!block) log.warning("机械层注入块为空，本轮退回无注入模式");
    else log.info(`机械层注入完成: 注入块 ${block.length} 字符`);
  } else {
    block = await buildReviewContext(SCRIPT_DIR, ctxLogger);
    if (!block) log.warning("复盘注入块为空，复盘退回自行取数模式");
    else log.info(`复盘机械层注入完成: 注入块 ${block.length} 字符（事实取服务端 + 语义标注层）`);
  }
  const ctxDir = join(SCRIPT_DIR, "data", "tmp");
  mkdirSync(ctxDir, { recursive: true });
  const p = (n: number) => String(n).padStart(2, "0");
  const ctxPath = join(ctxDir, `ctx-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.json`);
  writeFileSync(ctxPath, JSON.stringify({ mode, trade_date: localDate(now), current_time: nowHMS(now), block }), "utf-8");
  return ctxPath;
}

// 当前子进程引用（signal handler 强杀用）
const currentProcess: { proc: ReturnType<typeof spawn> | null } = { proc: null };

// 终止子进程：SIGTERM → 宽限 → SIGKILL（整个进程组）
async function terminateProcess(child: ReturnType<typeof spawn>, graceSeconds = 2.0): Promise<void> {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // 进程可能已退出
    }
  }
  const deadline = Date.now() + graceSeconds * 1000;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已退出
      }
    }
  }
}

// 执行一轮 pi runtime：ctx → node 子进程 → 解析 stdout 结果 JSON → 归档
async function runPi(
  mode: "watch" | "review",
  log: SchedLogger,
  ctxLogger: CtxLogger,
  logDir: string,
  stopFlag: { stop: boolean },
  rehearse = false,
): Promise<string | null> {
  const ctxPath = await writePiContext(mode, log, ctxLogger);
  const entry = RUNTIME_ENTRY;
  const cmd = [process.execPath, join(SCRIPT_DIR, entry), "--mode", mode, "--context", ctxPath, ...(rehearse ? ["--rehearse"] : [])];
  const stamp = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const logFile = join(logDir, `run-${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}${p(stamp.getSeconds())}.log`);
  log.info(`触发${mode === "watch" ? "盯盘" : "复盘"}: ctx=${basename(ctxPath)}, 命令=${cmd.join(" ")}`);
  process.stdout.write(`\n========== 盯盘开始 ${nowHMS()} ==========\n`);

  const child = spawn(cmd[0]!, cmd.slice(1), { cwd: SCRIPT_DIR, stdio: ["ignore", "pipe", "pipe"] });
  currentProcess.proc = child;
  const logFh = openSync(logFile, "w");
  let logBuf = "";
  const stderrTail: string[] = [];
  const writeLog = (text: string) => {
    logBuf += text;
    while (logBuf.includes("\n")) {
      const idx = logBuf.indexOf("\n");
      const line = logBuf.slice(0, idx);
      logBuf = logBuf.slice(idx + 1);
      appendFileSync(logFh, `[${nowHMS()}] ${line}\n`, "utf-8");
    }
  };

  let stdoutText = "";
  child.stdout?.on("data", (c: Buffer) => (stdoutText += c.toString("utf-8")));
  child.stderr?.on("data", (c: Buffer) => {
    const text = c.toString("utf-8");
    process.stdout.write(text);
    writeLog(text);
    stderrTail.push(text);
    if (stderrTail.length > 60) stderrTail.shift();
  });

  // 等待退出：close 事件 + stop 响应 + 外层墙钟硬杀
  const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
  const deadline = Date.now() + RUNTIME_HARD_KILL_MS;
  let hardKilled = false;
  while (child.exitCode === null) {
    if (stopFlag.stop) {
      process.stdout.write("\n[调度器] 检测到停止请求，向子进程发送 SIGTERM ...\n");
      await terminateProcess(child);
      break;
    }
    if (Date.now() > deadline) {
      log.error(`runtime 超过外层硬杀时限(${RUNTIME_HARD_KILL_MS / 1000}s)，SIGKILL 强杀`);
      hardKilled = true;
      await terminateProcess(child, 0.5);
      break;
    }
    await nap(200, null);
  }
  await Promise.race([exited, nap(3000, null)]);
  const result = child.exitCode ?? 1;

  // 冲出日志残余并关闭句柄
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (logBuf) appendFileSync(logFh, `[${nowHMS()}] ${logBuf}\n`, "utf-8");
  try {
    closeSync(logFh);
  } catch {
    // 关闭失败不影响主流程
  }
  if (currentProcess.proc === child) currentProcess.proc = null;
  try {
    unlinkSync(ctxPath);
  } catch {
    // ctx 残留由按日清理兜底
  }
  process.stdout.write(`========== 盯盘结束 ${nowHMS()} ==========\n\n`);

  if (result !== 0) {
    const tail = stderrTail.join("").slice(-2000);
    log.error(`runtime 退出非零: returncode=${result}${hardKilled ? "(硬杀)" : ""}, stderr日志=${basename(logFile)}, 尾部=${tail.slice(-200).replace(/\n/g, " ⏎ ")}`);
    if (tail.includes("负载较高") || tail.includes("(529)")) {
      log.warning("runtime 失败原因为服务端过载（负载较高 / 529），跳过本轮立即重试，等下一轮触发");
      return "service_overload";
    }
    return "cli_error";
  }

  // 解析 stdout 最后一非空行结果 JSON
  const lastLine = stdoutText.split("\n").reverse().find((l) => l.trim().length > 0)?.trim() ?? "";
  let obj: Record<string, unknown> | null = null;
  if (lastLine) {
    try {
      const parsed = JSON.parse(lastLine) as unknown;
      obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      obj = null;
    }
  }
  if (!obj) {
    log.error(`runtime 结果 JSON 解析失败: returncode=0, 最后一行=${lastLine.slice(0, 200)}, stderr日志=${basename(logFile)}`);
    return "cli_error";
  }
  const summary = String(obj.summary ?? "");
  if (obj.error) {
    log.error(`runtime 报告错误: error=${String(obj.error).slice(0, 300)}`);
    return "cli_error";
  }
  // 主动跳过（如休市闸）：非失败——不归档总结，按成功计
  if (obj.skipped) {
    log.info(`runtime 主动跳过本轮（${String(obj.skipped)}: ${String(obj.reason ?? "").slice(0, 120)}），不归档总结`);
    return null;
  }
  if (!summary.trim()) {
    // 空转（休市 / 未产出总结）：不是失败——记 WARN 并按成功计，不归档、不重试
    if (Number(obj.turns ?? 0) === 0) {
      log.warning(`runtime 未产出总结（turns=0，空转）——按跳过处理，不归档不重试, stderr日志=${basename(logFile)}`);
      return null;
    }
    log.error(`runtime 结果缺 summary（turns=${String(obj.turns)}）, stderr日志=${basename(logFile)}`);
    return "cli_error";
  }

  // 演练模式（dryrun）：总结只回显终端，不归档（runtime 侧已零交易零上报零台账）
  if (obj.rehearse === true) {
    log.info("演练模式：总结不归档、不上报（LLM 全链真实运行，零交易）");
  } else {
    archiveSummaryText(summary, mode, join(SCRIPT_DIR, "data"), log);
  }
  const usage = (obj.usage ?? {}) as Record<string, unknown>;
  const mainUsage = (usage.main ?? {}) as Record<string, unknown>;
  log.info(
    `pi 盯盘统计: turns=${String(obj.turns)} subagents=${String(obj.subagent_calls)} wall=${String(obj.wall_ms)}ms ` +
      `tokens_main=${String(mainUsage.tokens)} tokens_sub=${String(usage.sub_tokens_total)} budget_truncated=${String(obj.budget_truncated)}`,
  );
  return null;
}

// 信号处理：两段式退出（先优雅等当前轮，再强杀）
function installSignalHandlers(log: SchedLogger, stopFlag: { stop: boolean }): void {
  let escalated = false;
  const handle = (signum: string) => {
    if (escalated) {
      if (currentProcess.proc && currentProcess.proc.exitCode === null) {
        log.warning(`再次收到信号 ${signum}，强杀当前子进程组后退出`);
        void terminateProcess(currentProcess.proc, 0.5);
      } else {
        log.warning(`再次收到信号 ${signum}，强制退出`);
      }
      process.exit(130);
    }
    escalated = true;
    log.info(`收到信号 ${signum}，将等当前 runtime 轮跑完再退出（再按一次 Ctrl+C 强制终止）`);
    stopFlag.stop = true;
  };
  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));
}

// 到下一个窗口起点的秒数（复盘点 > 下午开盘 > 上午开盘 > 次交易日）
function secondsUntilWindow(now = new Date()): number {
  const candidates: number[] = [];
  const morningOpen = new Date(now);
  morningOpen.setHours(MORNING_START[0], MORNING_START[1], 0, 0);
  const afternoonOpen = new Date(now);
  afternoonOpen.setHours(AFTERNOON_START[0], AFTERNOON_START[1], 0, 0);
  const reviewTime = new Date(now);
  reviewTime.setHours(21, 0, 0, 0);
  if (now < morningOpen && !isWeekend(morningOpen)) candidates.push(morningOpen.getTime());
  if (now < afternoonOpen && !isWeekend(afternoonOpen)) candidates.push(afternoonOpen.getTime());
  if (now < reviewTime && !isWeekend(reviewTime)) candidates.push(reviewTime.getTime());
  if (candidates.length > 0) {
    return Math.max(Math.round((Math.min(...candidates) - now.getTime()) / 1000), 60);
  }
  const nextDay = new Date(now);
  do {
    nextDay.setDate(nextDay.getDate() + 1);
  } while (isWeekend(nextDay));
  nextDay.setHours(MORNING_START[0], MORNING_START[1], 0, 0);
  return Math.max(Math.round((nextDay.getTime() - now.getTime()) / 1000), 60);
}

// 可中断 sleep（事件循环内分段等待，每段检查停止标志）
async function interruptibleSleep(seconds: number, stopFlag: { stop: boolean }): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!stopFlag.stop && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, deadline - Date.now()))));
  }
}

// 主入口
async function main(): Promise<number> {
  const args = parseArgs();
  // 强制执行：转成 runtime 子进程可见的环境变量（子进程默认继承本进程 env）
  const log = new SchedLogger(args.logDir);
  if (args.forceRound) {
    process.env.PIPELINE_FORCE_ROUND = "1";
    log.info("强制执行本轮: PIPELINE_FORCE_ROUND=1（跳过休市闸 / 盘前空转闸）");
  }
  const stopFlag = { stop: false };
  installSignalHandlers(log, stopFlag);
  const ctxLogger: CtxLogger = { info: (m) => log.info(m), warning: (m) => log.warning(m) };

  autoUpgradeSkills(log);
  cleanupOldLogs(join(SCRIPT_DIR, "data"), args.logDir, log);
  let lastCleanupDate = localDate(); // 最近执行清理的日期（启动清理后当日首个触发轮不再重复；常驻多日按日滚动）
  checkPiReady(log);
  // 盘前预检：启动时执行一次（周末启动不预检——attention 不落周末空档）
  if (!isWeekend(new Date())) {
    await maybeRunPreflight(log);
  }

  if (args.once) {
    const err = await runPi(args.once, log, ctxLogger, args.logDir, stopFlag, args.rehearse);
    log.info(`单次执行完成: mode=${args.once}, ok=${err === null}`);
    return err === null ? 0 : 1;
  }

  // PID 文件（防重复实例）
  mkdirSync(dirname(args.pidFile), { recursive: true });
  if (existsSync(args.pidFile)) {
    try {
      const existingPid = parseInt(readFileSync(args.pidFile, "utf-8").trim(), 10);
      process.kill(existingPid, 0);
      log.error(`已有调度器在运行: pid=${existingPid}, pid_file=${args.pidFile}`);
      return 1;
    } catch {
      log.warning(`残留 PID 文件: ${args.pidFile}，将被覆盖`);
    }
  }
  writeFileSync(args.pidFile, String(process.pid), "utf-8");
  log.info(`PID 文件: ${args.pidFile} (pid=${process.pid})`);

  const interval = args.interval;
  const reviewHM = args.reviewHour * 60 + args.reviewMinute;
  let todayReviewDone: string | null = null;
  log.info(
    `调度器启动（pi 引擎 · 单引擎无回退）: interval=${interval}min, project=${SCRIPT_DIR}, 复盘=${String(args.reviewHour).padStart(2, "0")}:${String(args.reviewMinute).padStart(2, "0")}, log_dir=${args.logDir}`,
  );
  log.info(
    `盘中窗口: 上午 ${MORNING_START.join(":")}-${MORNING_END.join(":")}, 下午 ${AFTERNOON_START.join(":")}-${AFTERNOON_END.join(":")}, 周末不盯盘`,
  );

  // 触发节奏：启动后立即第 1 次，之后每 interval 分钟（与窗口解耦）
  let nextDue = Date.now();

  while (!stopFlag.stop) {
    const now = new Date();
    if (now.getTime() < nextDue) {
      const hm = now.getHours() * 60 + now.getMinutes();
      const inReviewWindow = hm >= 15 * 60 && hm < reviewHM;
      if (!inTradingWindow(now) && !inReviewWindow) {
        const wait = secondsUntilWindow(now);
        log.info(`非交易时段，睡眠 ${wait} 秒到下个窗口`);
        await interruptibleSleep(wait, stopFlag);
        continue;
      }
      const wait = Math.round((nextDue - now.getTime()) / 1000);
      if (wait > 0) await interruptibleSleep(wait, stopFlag);
      continue;
    }

    const due = new Date();
    const dueHM = due.getHours() * 60 + due.getMinutes();

    // 每日首个触发轮顺带清理旧日志（启动清理的日常补充：常驻多日不重启也按日滚动，防堆积）
    if (lastCleanupDate !== localDate(due)) {
      cleanupOldLogs(join(SCRIPT_DIR, "data"), args.logDir, log);
      lastCleanupDate = localDate(due);
    }

    // 复盘点：每交易日一次（错过 21:00 点位则补跑——合盖休眠 / 关机不能把当日复盘永久跳过）
    if (dueHM >= reviewHM && !isWeekend(due)) {
      const todayStr = localDate(due);
      if (todayReviewDone !== todayStr) {
        if (dueHM > reviewHM) log.warning(`复盘点（${String(args.reviewHour).padStart(2, "0")}:${String(args.reviewMinute).padStart(2, "0")}）已过——补跑当日复盘`);
        let err = await runPi("review", log, ctxLogger, args.logDir, stopFlag, args.rehearse);
        log.info(`复盘结果: ok=${err === null}`);
        if (err && err !== "service_overload" && !stopFlag.stop) {
          log.info("复盘失败，延时 10 秒后重试一次");
          await interruptibleSleep(10, stopFlag);
          if (!stopFlag.stop) {
            err = await runPi("review", log, ctxLogger, args.logDir, stopFlag, args.rehearse);
            log.info(`复盘重试结果: ok=${err === null}`);
          }
        }
        todayReviewDone = todayStr;
      }
      nextDue = due.getTime() + interval * 60_000;
      continue;
    }

    // 盘中盯盘：仅交易窗口内触发（每日首轮前先跑盘前预检——问题清单给执行程序的人看）
    if (inTradingWindow(due) && !isWeekend(due)) {
      await maybeRunPreflight(log);
      let err = await runPi("watch", log, ctxLogger, args.logDir, stopFlag, args.rehearse);
      log.info(`盯盘结果: ok=${err === null}`);
      if (err && !stopFlag.stop) {
        if (err === "service_overload") {
          log.info("盯盘失败（服务端过载），跳过本轮重试，等下一轮触发");
        } else {
          log.info("盯盘失败，延时 10 秒后重试一次");
          await interruptibleSleep(10, stopFlag);
          if (!stopFlag.stop) {
            err = await runPi("watch", log, ctxLogger, args.logDir, stopFlag, args.rehearse);
            log.info(`盯盘重试结果: ok=${err === null}`);
          }
        }
      }
      nextDue = due.getTime() + interval * 60_000;
    } else {
      log.info("当前不在交易时段，跳过本轮盯盘");
      nextDue = due.getTime() + interval * 60_000;
    }
  }

  try {
    if (existsSync(args.pidFile) && readFileSync(args.pidFile, "utf-8").trim() === String(process.pid)) {
      unlinkSync(args.pidFile);
    }
  } catch (exc) {
    log.warning(`清理 PID 文件失败: ${args.pidFile}, err=${exc instanceof Error ? exc.message : String(exc)}`);
  }
  log.info("调度器已退出");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[scheduler fatal] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
