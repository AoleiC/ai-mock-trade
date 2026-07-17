#!/usr/bin/env python3
"""柚子 AI 定时盯盘调度器：常驻进程，按 A 股交易时段周期触发本地 AI CLI。

默认在每个交易日的 09:30-11:30、13:00-15:00 之间每 5 分钟触发一次「执行一次盯盘」；
每个交易日 21:00 触发一次「复盘今天的行情数据」。非交易时段脚本只 sleep 不消耗资源。

支持的环境变量（也提供同名 CLI 参数，CLI 参数优先）：
  WATCH_CLI              AI CLI 名称，可选 opencode | claude，默认 opencode
  WATCH_INTERVAL_MINUTES 盯盘触发间隔（分钟），默认 5
  WATCH_PROJECT_DIR      项目根目录（含 CLAUDE.md / AGENTS.md），默认脚本所在目录
  WATCH_PROMPT_WATCH     盯盘提示词，默认 "执行一次盯盘"
  WATCH_PROMPT_REVIEW    盘后复盘提示词，默认 "复盘今天的行情数据"
  WATCH_REVIEW_HOUR      复盘触发小时（24h 制），默认 21
  WATCH_REVIEW_MINUTE    复盘触发分钟，默认 0
  WATCH_LOG_DIR          日志输出目录，默认 <项目根>/data/watch_scheduler_logs

用法（在项目根目录下）：
  # 循环执行
  python watch_scheduler.py
  python watch_scheduler.py --cli claude --interval 5
  python watch_scheduler.py --interval 15 --prompt-watch "执行盯盘并打印持仓"
  # 单次执行（不进入循环，跑完即退出）：watch=盯盘、review=复盘
  python watch_scheduler.py --once watch
  python watch_scheduler.py --once review --cli claude
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import os
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import List

# A 股盘中两段：上午 09:30-11:30、下午 13:00-15:00（闭区间表示闭市后不再触发）
MORNING_START = (9, 30)
MORNING_END = (11, 30)
AFTERNOON_START = (13, 0)
AFTERNOON_END = (15, 0)


def parse_args() -> argparse.Namespace:
    """解析命令行参数，CLI 参数优先于同名环境变量。"""
    parser = argparse.ArgumentParser(
        description="柚子 AI 定时盯盘调度器：常驻进程，按 A 股交易时段周期触发本地 AI CLI。",
    )
    parser.add_argument(
        "--cli",
        choices=["opencode", "claude"],
        default=os.environ.get("WATCH_CLI", "opencode"),
        help="要调用的本地 AI CLI，默认 opencode（可通过 WATCH_CLI 环境变量覆盖）",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=int(os.environ.get("WATCH_INTERVAL_MINUTES", "5")),
        help="盯盘触发间隔（分钟），默认 5（可通过 WATCH_INTERVAL_MINUTES 覆盖）",
    )
    parser.add_argument(
        "--project-dir",
        type=Path,
        default=Path(os.environ.get("WATCH_PROJECT_DIR", str(Path(__file__).resolve().parent))),
        help="项目根目录（默认脚本所在目录，可通过 WATCH_PROJECT_DIR 覆盖）",
    )
    parser.add_argument(
        "--prompt-watch",
        default=os.environ.get("WATCH_PROMPT_WATCH", "执行一次盯盘"),
        help="盯盘提示词（可通过 WATCH_PROMPT_WATCH 覆盖）",
    )
    parser.add_argument(
        "--prompt-review",
        default=os.environ.get("WATCH_PROMPT_REVIEW", "复盘今天的行情数据"),
        help="盘后复盘提示词（可通过 WATCH_PROMPT_REVIEW 覆盖）",
    )
    parser.add_argument(
        "--review-hour",
        type=int,
        default=int(os.environ.get("WATCH_REVIEW_HOUR", "21")),
        help="复盘触发小时（24h 制），默认 21",
    )
    parser.add_argument(
        "--review-minute",
        type=int,
        default=int(os.environ.get("WATCH_REVIEW_MINUTE", "0")),
        help="复盘触发分钟，默认 0",
    )
    parser.add_argument(
        "--pid-file",
        type=Path,
        default=Path(
            os.environ.get(
                "WATCH_PID_FILE",
                str(Path(__file__).resolve().parent / "data" / "watch_scheduler.pid"),
            )
        ),
        help="PID 文件路径，脚本启动时写入、退出时清理；可用 kill -TERM $(cat <path>) 优雅停止（可通过 WATCH_PID_FILE 覆盖）",
    )
    parser.add_argument(
        "--log-dir",
        type=Path,
        default=Path(
            os.environ.get(
                "WATCH_LOG_DIR",
                str(Path(__file__).resolve().parent / "data" / "watch_scheduler_logs"),
            )
        ),
        help="日志输出目录（可通过 WATCH_LOG_DIR 覆盖）",
    )
    parser.add_argument(
        "--once",
        choices=["watch", "review"],
        default=None,
        help="单次执行模式：只跑一次后退出，不进入常驻循环。watch=执行盯盘、review=执行复盘。"
        "设置后忽略 interval / 交易时段 / 复盘时间表 / PID 文件",
    )
    return parser.parse_args()


def setup_logger(log_dir: Path) -> logging.Logger:
    """初始化日志：同时输出到控制台与按日归档的日志文件。"""
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"scheduler-{dt.date.today().isoformat()}.log"

    logger = logging.getLogger("watch_scheduler")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()

    formatter = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # 控制台 handler：INFO 一行自包含回答「谁/在做什么/结果」
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(formatter)
    logger.addHandler(console)

    # 文件 handler：保留完整记录用于排障
    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    return logger


def in_trading_window(now: dt.datetime) -> bool:
    """判断当前时间是否落在 A 股盘中两段窗口内。"""
    hm = (now.hour, now.minute)
    if MORNING_START <= hm < MORNING_END:
        return True
    if AFTERNOON_START <= hm < AFTERNOON_END:
        return True
    return False


def is_weekend(now: dt.datetime) -> bool:
    """A 股周末休市，周六周日不盯盘。"""
    return now.weekday() >= 5


def build_command(cli: str, prompt: str, project_dir: Path) -> List[str]:
    """根据 CLI 名称拼出 headless 调用的完整命令。"""
    if cli == "opencode":
        # opencode run <message>：非交互一次性执行，项目根目录作为 cwd 让其读取 AGENTS.md
        return ["opencode", "run", prompt]
    # claude -p <prompt>：Claude Code 的 print 模式
    return ["claude", "-p", prompt]


def seconds_until_window(now: dt.datetime) -> int:
    """计算到下一个盘中窗口起点（或盘后复盘点）的秒数，用于 sleep 时长。

    优先级：盘后复盘点 > 下午开盘 > 上午开盘 > 次日（跳过周末）。
    """
    candidates: List[dt.datetime] = []
    today = now.date()

    # 当天还有可能进入的窗口
    morning_open = now.replace(hour=MORNING_START[0], minute=MORNING_START[1], second=0, microsecond=0)
    afternoon_open = now.replace(hour=AFTERNOON_START[0], minute=AFTERNOON_START[1], second=0, microsecond=0)
    afternoon_close = now.replace(hour=AFTERNOON_END[0], minute=AFTERNOON_END[1], second=0, microsecond=0)
    review_time = now.replace(hour=21, minute=0, second=0, microsecond=0)

    if now < morning_open and not is_weekend(morning_open):
        candidates.append(morning_open)
    if now < afternoon_open and not is_weekend(afternoon_open):
        candidates.append(afternoon_open)
    # 复盘：仅在下午收盘之后到当天 23:59 之前考虑
    if now > afternoon_close and now < review_time + dt.timedelta(hours=3):
        candidates.append(review_time)

    if candidates:
        delta = min(candidates) - now
        return max(int(delta.total_seconds()), 60)

    # 没有今日候选：找下个交易日
    next_day = now + dt.timedelta(days=1)
    while is_weekend(next_day):
        next_day += dt.timedelta(days=1)
    next_open = next_day.replace(hour=MORNING_START[0], minute=MORNING_START[1], second=0, microsecond=0)
    return max(int((next_open - now).total_seconds()), 60)


def run_cli(
    cli: str,
    prompt: str,
    project_dir: Path,
    log_dir: Path,
    logger: logging.Logger,
    stop_flag: dict | None = None,
) -> bool:
    """同步调用本地 AI CLI 执行一次盯盘或复盘，返回是否成功。

    行为约定（按 AGENTS.md 日志规范）：
    - stdout 实时流到调用方终端（用户要"看得到 AI 在干啥"，不能黑盒）
    - stderr 同时落盘到 run-*.log，失败时优先看文件
    - 调度器自己的状态行走 logger（INFO 一行自包含，INFO/ERROR 分级清晰）
    - 收到 stop 请求：先 SIGTERM 礼貌请退，2 秒不退就 SIGKILL 强杀
    """
    cmd = build_command(cli, prompt, project_dir)
    log_file = log_dir / f"run-{dt.datetime.now():%Y%m%d-%H%M%S}.log"

    logger.info("触发盯盘: cli=%s, project=%s, prompt=%s", cli, project_dir, prompt)
    logger.info("执行命令: %s", " ".join(shlex.quote(c) for c in cmd))
    # 把这次调用的「开始/结束」边界打出来，方便在终端扫日志时定位每次触发
    print(f"\n========== 盯盘开始 {dt.datetime.now():%H:%M:%S} ==========", flush=True)

    process: subprocess.Popen | None = None
    try:
        # 关键决策：跑在一个伪 TTY（PTY）里。
        # 原因：opencode / claude 检测到 stdout 不是 TTY 后会切换成「全缓冲」甚至完全静默，
        # 导致 AI 的思考/工具调用/最终输出全部卡在 buffer 里看不到 —— 表现为"黑盒"。
        # PTY 让 opencode 误以为自己在终端跑，会用行缓冲 + ANSI 颜色，输出会立刻刷到用户终端。
        # 同时我们把 PTY 主端读到的内容镜像到日志文件，保留排障能力。
        import pty
        import select as _select
        import threading

        master_fd, slave_fd = pty.openpty()
        # 拿到一个能直接传给 Popen 的「行」stdin/stdout/stderr 三合一
        # 简单做法：把 PTY 主端的数据同时写给用户终端（sys.stdout）和日志文件
        log_fh = open(log_file, "w", encoding="utf-8")
        pty_writer_stop = threading.Event()

        def pty_to_terminal_and_log():
            """后台线程：把 PTY 主端读到的字节原样写到用户终端 + 日志文件。"""
            try:
                while not pty_writer_stop.is_set():
                    # 100ms 轮询，避免阻塞主线程的 stop_flag 检查
                    rfds, _, _ = _select.select([master_fd], [], [], 0.1)
                    if not rfds:
                        # 顺便检查子进程是否已退出，退出后立刻排空 PTY 剩余数据
                        if process is not None and process.poll() is not None:
                            # 把剩余数据读完再退出
                            try:
                                while True:
                                    chunk = os.read(master_fd, 4096)
                                    if not chunk:
                                        break
                                    os.write(sys.stdout.fileno(), chunk)
                                    log_fh.write(chunk.decode("utf-8", errors="replace"))
                                    log_fh.flush()
                            except OSError:
                                pass
                            return
                        continue
                    try:
                        chunk = os.read(master_fd, 4096)
                    except OSError:
                        return
                    if not chunk:
                        return
                    # 写一份到用户终端
                    try:
                        os.write(sys.stdout.fileno(), chunk)
                    except OSError:
                        pass
                    # 写一份到日志文件
                    log_fh.write(chunk.decode("utf-8", errors="replace"))
                    log_fh.flush()
            except Exception:  # noqa: BLE001
                pass

        writer_thread = threading.Thread(target=pty_to_terminal_and_log, daemon=True)
        writer_thread.start()

        process = subprocess.Popen(
            cmd,
            cwd=str(project_dir),
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
            start_new_session=True,
        )
        # 子进程拿到自己的 slave fd 后我们就不再需要它了，关掉避免卡死
        os.close(slave_fd)
        # 登记给模块级引用，signal handler 二次 Ctrl+C 时能强杀它
        _current_process["proc"] = process

        # 等待子进程退出，同时响应 stop_flag
        while True:
            if stop_flag is not None and stop_flag.get("stop") and process.poll() is None:
                print("\n[调度器] 检测到停止请求，向子进程发送 SIGTERM ...", flush=True)
                _terminate_process(process)
                break
            result = process.poll()
            if result is not None:
                break
            time.sleep(0.2)
        # 等待后台 writer 线程把 PTY 剩余数据写完
        pty_writer_stop.set()
        writer_thread.join(timeout=2)
        # 关掉 master 和日志文件
        try:
            os.close(master_fd)
        except OSError:
            pass
        log_fh.close()
        # 子进程已结束，清掉全局引用，避免下一次 signal handler 误以为它还在跑
        if _current_process.get("proc") is process:
            _current_process["proc"] = None
    except FileNotFoundError:
        logger.error("CLI 未找到: %s，请确认已安装并在 PATH 中", cmd[0])
        return False
    except Exception as exc:  # noqa: BLE001
        logger.error("执行 CLI 异常: cli=%s, err=%s", cli, exc)
        if process is not None and process.poll() is None:
            _terminate_process(process)
        return False

    print(f"========== 盯盘结束 {dt.datetime.now():%H:%M:%S} ==========\n", flush=True)

    if result == 0:
        logger.info("盯盘完成: cli=%s, returncode=0, stderr日志=%s", cli, log_file.name)
        return True

    # 退出非零：按 AGENTS.md 规范把详细入参与关联变量打出来（CLI 名 + 退出码 + 日志路径）
    logger.error(
        "CLI 退出非零: cli=%s, prompt=%s, returncode=%d, stderr日志=%s, 可查看文件了解详情",
        cli,
        prompt,
        result,
        log_file.name,
    )
    return False


def _terminate_process(process: subprocess.Popen, grace_seconds: float = 2.0) -> None:
    """礼貌地终止子进程：先 SIGTERM 等 grace_seconds，不退就 SIGKILL 强杀整个进程组。"""
    import signal as sig

    if process.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(process.pid), sig.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(process.pid), sig.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        process.wait(timeout=2)


def install_signal_handlers(logger: logging.Logger, stop_flag: dict) -> None:
    """注册 SIGINT / SIGTERM，两段式退出：
    - 第 1 次信号：优雅退出 —— 调度器停止触发新一轮，并把标志位传给 run_cli，让其执行完当前 CLI 再返回
    - 第 2 次信号：强杀 —— 立刻终止当前子进程组（SIGTERM → 2 秒后 SIGKILL），调度器再退出
    """
    state = {"escalated": False}

    def handle(signum, _frame):  # noqa: ANN001
        if state["escalated"]:
            # 已升级过一次：再次收到信号，强制杀掉当前子进程组，调度器立即退出
            current = _current_process.get("proc")
            if current is not None and current.poll() is None:
                logger.warning("再次收到信号 %s，强杀当前子进程组后退出", signum)
                _terminate_process(current, grace_seconds=0.5)
            else:
                logger.warning("再次收到信号 %s，强制退出", signum)
            os._exit(130)
        state["escalated"] = True
        logger.info(
            "收到信号 %s，将等当前 CLI 跑完再退出（再按一次 Ctrl+C 强制终止）",
            signum,
        )
        stop_flag["stop"] = True

    signal.signal(signal.SIGINT, handle)
    signal.signal(signal.SIGTERM, handle)


# 模块级引用：记录当前正在跑的 CLI 子进程，供 signal handler 强杀时使用
_current_process: dict = {"proc": None}


def main() -> int:
    """主循环：按时间表触发 CLI，单次失败不影响后续轮次。

    当指定 --once 时，跳过常驻循环，仅执行一次对应动作（盯盘/复盘）后退出。
    """
    args = parse_args()
    logger = setup_logger(args.log_dir)
    stop_flag = {"stop": False}
    install_signal_handlers(logger, stop_flag)

    # 单次执行模式：不写 PID 文件、不进循环，直接跑一次对应 prompt 后退出
    if args.once is not None:
        prompt = args.prompt_watch if args.once == "watch" else args.prompt_review
        logger.info("单次执行模式: mode=%s, cli=%s, prompt=%s", args.once, args.cli, prompt)
        ok = run_cli(args.cli, prompt, args.project_dir, args.log_dir, logger, stop_flag)
        logger.info("单次执行完成: mode=%s, ok=%s", args.once, ok)
        return 0 if ok else 1

    # 写 PID 文件，便于从其他终端用 kill 精确控制
    # 启动时若发现已有同 pid 在跑，立即拒绝启动（防重复实例）
    args.pid_file.parent.mkdir(parents=True, exist_ok=True)
    if args.pid_file.exists():
        try:
            existing_pid = int(args.pid_file.read_text().strip())
            os.kill(existing_pid, 0)  # 仅探测，不发信号
            logger.error("已有调度器在运行: pid=%d, pid_file=%s", existing_pid, args.pid_file)
            return 1
        except (ProcessLookupError, ValueError, PermissionError):
            logger.warning("残留 PID 文件: %s，将被覆盖", args.pid_file)
    args.pid_file.write_text(str(os.getpid()))
    logger.info("PID 文件: %s (pid=%d)", args.pid_file, os.getpid())

    interval = max(1, args.interval)
    review_dt = dt.time(hour=args.review_hour, minute=args.review_minute)
    today_review_done: str | None = None

    logger.info(
        "调度器启动: cli=%s, interval=%dmin, project=%s, 复盘=%02d:%02d, log_dir=%s",
        args.cli,
        interval,
        args.project_dir,
        args.review_hour,
        args.review_minute,
        args.log_dir,
    )
    logger.info(
        "盘中窗口: 上午 %02d:%02d-%02d:%02d, 下午 %02d:%02d-%02d:%02d, 周末不盯盘",
        MORNING_START[0], MORNING_START[1], MORNING_END[0], MORNING_END[1],
        AFTERNOON_START[0], AFTERNOON_START[1], AFTERNOON_END[0], AFTERNOON_END[1],
    )
    logger.info(
        "触发节奏: 启动后立即触发第 1 次盯盘，之后每隔 %d 分钟触发一次（仅在交易窗口内执行）",
        interval,
    )

    # 触发节奏：
    # - 启动后立即触发第 1 次（启动时刻记为 last_trigger，next_due = 启动时刻），
    #   这样用户启动脚本就能立刻看到效果，不用等 10 分钟
    # - 之后每次 = last_trigger + interval，与盘口/对齐/下一个交易窗口都解耦
    # - 非交易时段启动：sleep 到下个窗口起点再触发第 1 次
    start_time = dt.datetime.now()
    last_trigger_at: dt.datetime | None = None  # None 表示「第 1 次还没跑过」
    next_due = start_time  # 第 1 次到期 = 启动时刻（如果正在交易窗口）

    try:
        while not stop_flag["stop"]:
            now = dt.datetime.now()

            # 是否到触发时间（每次 sleep 后重新判断）
            if now < next_due:
                # 长 sleep 优化：非交易时段 + 不是复盘窗口 → 直接睡到下个窗口起点，节省 CPU
                in_review_window = (now.time() >= dt.time(15, 0)) and (now.time() < review_dt)
                if not in_trading_window(now) and not in_review_window:
                    wait = seconds_until_window(now)
                    logger.info("非交易时段，睡眠 %d 秒到下个窗口", wait)
                    _interruptible_sleep(wait, stop_flag)
                    if stop_flag["stop"]:
                        break
                    continue
                # 交易时段内：sleep 到 next_due，每秒检查 stop_flag
                wait = int((next_due - now).total_seconds())
                if wait > 0:
                    _interruptible_sleep(wait, stop_flag)
                    if stop_flag["stop"]:
                        break
                continue

            # 到点了 —— 区分复盘 vs 盘中盯盘
            now = dt.datetime.now()
            # 复盘点：每个交易日 review_dt 触发一次
            if (
                now.time().hour == review_dt.hour
                and now.time().minute == review_dt.minute
                and not is_weekend(now)
            ):
                today_str = now.date().isoformat()
                if today_review_done != today_str:
                    ok = run_cli(args.cli, args.prompt_review, args.project_dir, args.log_dir, logger, stop_flag)
                    logger.info("复盘结果: ok=%s", ok)
                    # 复盘失败延时 10 秒后重试一次（仅一次），再失败则放弃当天复盘
                    if not ok and not stop_flag["stop"]:
                        logger.info("复盘失败，延时 10 秒后重试一次")
                        _interruptible_sleep(10, stop_flag)
                        if not stop_flag["stop"]:
                            ok = run_cli(args.cli, args.prompt_review, args.project_dir, args.log_dir, logger, stop_flag)
                            logger.info("复盘重试结果: ok=%s", ok)
                    today_review_done = today_str
                # 不论成功失败都把"下一次到期"推后 interval 分钟
                last_trigger_at = now
                next_due = last_trigger_at + dt.timedelta(minutes=interval)
                continue

            # 盘中盯盘：仅在交易窗口内触发
            if in_trading_window(now) and not is_weekend(now):
                if last_trigger_at is None:
                    logger.info("启动后第 1 次盯盘（启动时刻 %s）", start_time.strftime("%H:%M:%S"))
                else:
                    logger.info("本次盯盘距上次 %d 分钟", interval)
                ok = run_cli(args.cli, args.prompt_watch, args.project_dir, args.log_dir, logger, stop_flag)
                logger.info("盯盘结果: ok=%s", ok)
                # 失败延时 10 秒后重试一次（仅一次），再失败则放过等下轮
                if not ok and not stop_flag["stop"]:
                    logger.info("盯盘失败，延时 10 秒后重试一次")
                    _interruptible_sleep(10, stop_flag)
                    if not stop_flag["stop"]:
                        ok = run_cli(args.cli, args.prompt_watch, args.project_dir, args.log_dir, logger, stop_flag)
                        logger.info("盯盘重试结果: ok=%s", ok)
                last_trigger_at = now
                next_due = last_trigger_at + dt.timedelta(minutes=interval)
            else:
                # 当前不在交易窗口（但 next_due 到了）—— 跳过本轮，10 分钟后再判
                logger.info("当前不在交易时段，跳过本轮盯盘")
                last_trigger_at = now
                next_due = last_trigger_at + dt.timedelta(minutes=interval)

    except KeyboardInterrupt:
        logger.info("收到 Ctrl+C，退出")

    # 清理 PID 文件（仅当记录的就是本进程时才删，避免误删别人覆盖写入的）
    try:
        if args.pid_file.exists() and args.pid_file.read_text().strip() == str(os.getpid()):
            args.pid_file.unlink()
    except OSError as exc:
        logger.warning("清理 PID 文件失败: %s, err=%s", args.pid_file, exc)

    logger.info("调度器已退出")
    return 0


def _interruptible_sleep(seconds: int, stop_flag: dict) -> None:
    """可中断的 sleep，每秒检查一次退出标志。"""
    for _ in range(seconds):
        if stop_flag["stop"]:
            return
        time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
