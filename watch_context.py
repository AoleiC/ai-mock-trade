# 盯盘机械层：把无判断的取数 / 比对 / 自愈步骤从 agent（LLM）剥离到调度器侧（Python，零 token）
# -*- coding: utf-8 -*-
"""盯盘机械层：调度器触发 AI CLI 前的零 token 前置步骤。

职责边界（与 AGENTS.md §3.1 / §3.1.1 契约对应）：
- agent（LLM）负责判断：阶段消费、开仓过滤、通道判定、持仓复核、输出 —— 本模块一概不碰
- 本模块负责机械步骤（无判断、纯取数与比对），由调度器每轮触发 CLI 前调用：
  1. 昨日温度定格对账（每日一次，幂等落盘 data/recon-{date}.json，AGENTS.md §3.1.1）
  2. 市场阶段状态机读取 + 盘中自愈（AGENTS.md §3.1 第 0 步，journal 代码仍是唯一转移权威）
  3. 五项必读数据拉取（盘面分析 / 监管名单 / 账户 / 持仓 / 温度历史）
  4. 组装注入块拼进盯盘 prompt —— agent 直接消费注入数据，不再重复调用
- 全链路容错：任何一步失败只降级为「该项不注入 + 提示 agent 自行调用」，
  绝不向外抛异常阻塞盯盘（与总纲 §九「单次失败不中断循环」对齐）

调用方式（仅限调度器 / 人类开发者，agent 仍走 skills/*/cli.py，见 AGENTS.md §3.0）：
  from watch_context import build_watch_context
  block = build_watch_context(project_dir)   # 返回注入 prompt 块（str），失败返回 ""
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional

# 对账告警阈值（分）：|服务端定格值 − 本地尾帧值| ≥ 15 判「定格可疑」（AGENTS.md §3.1.1 第 3 步）
RECON_ALERT_THRESHOLD = 15
# 温度历史拉取天数（与 AGENTS.md §3.1 第 0 步自愈 / §3.1.1 对账共用同一次拉取）
HISTORY_DAYS = 10

# 尾帧温度锚点：匹配「短线温度 / 短线情绪」后不远处带括号数字的写法
# 实测归档样例：短线情绪 中性(60) / 短线情绪=偏激进(65分) / 短线温度定格=保守(10) /
#              短线温度保守(10) / 短线情绪「偏激进」(65) —— 共性为锚词 + ≤14 字符 + (数字[分])
_TAIL_SCORE_RE = re.compile(r"短线[温度情绪][^\n]{0,14}?[（(](\d{1,3})\s*分?[)）]")
# 尾帧时间戳锚点：总结标记（========== 盯盘总结 HH:MM:SS ==========）或摘要行（[柚子 AI] HH:MM | ...）
_TAIL_TIME_RE = re.compile(
    r"(?:==========\s*盯盘总结\s*(\d{2}:\d{2}(?::\d{2})?)\s*=*)|(?:\[柚子 AI\]\s*(\d{2}:\d{2}))"
)
# 定格值提取：「标签(分值)」括号内数字，如 偏保守(30) / 保守(10)
_LABELED_SCORE_RE = re.compile(r"[（(](\d{1,3})")


# 通用 subprocess 封装：跑 skills 下任一 cli.py 并解析 stdout JSON
def _run_sdk(cli_rel: str, args: list, project_dir: Path, timeout: int = 30) -> tuple[bool, object]:
    """执行一条 skills CLI 命令并解析 JSON 输出。

    参数:
        cli_rel: cli.py 相对项目根的路径，如 "skills/mock/cli.py" / "skills/journal/cli.py"
        args: 位置参数与具名参数列表（与命令行写法一致，如 ["--trade_date", "2026-10-20"]）
        project_dir: 项目根目录（子进程 cwd，保证 skills 内相对路径 / .env 生效）
        timeout: 秒级超时，超时杀进程按失败处理
    返回:
        (ok, result)：ok=True 时 result 为 stdout 解析出的 dict / list；
        ok=False 时 result 为错误摘要 str（stderr / 原始输出前 200 字符，供日志留痕）
    """
    cmd = [sys.executable, str(project_dir / cli_rel)] + [str(a) for a in args]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        return False, f"{type(exc).__name__}: {exc}"
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout or "")[:200]
    try:
        return True, json.loads(proc.stdout)
    except (ValueError, TypeError):
        return False, f"stdout 非 JSON: {proc.stdout[:200]}"


# 从 watch-summary 全文提取时间最晚一处的短线温度分值及其时间戳
def _extract_tail_score(text: str) -> tuple[Optional[int], Optional[str]]:
    """从昨日盯盘总结归档全文提取「时间最晚一处」的短线温度分值（§3.1.1 第 2 步）。

    参数:
        text: watch-summary-{date}.md 全文（自由文本，锚点可能缺失 / 断档 —— 尽力发现）
    返回:
        (score, time)：score 为最晚一处锚点分值；time 为该处之前最近的时间戳
        （总结标记 HH:MM:SS 或摘要行 HH:MM）。任一无法提取时对应项为 None。
    """
    best: Optional[tuple[int, Optional[str]]] = None
    # 逐个锚点匹配取「最后一个」（文件按轮次追加，最后出现的即时间最晚）
    for m in _TAIL_SCORE_RE.finditer(text):
        # 回溯找该锚点之前最近的时间戳（总结标记优先于摘要行的正则顺序无关，取位置最靠后者）
        tail_time: Optional[str] = None
        for t in _TAIL_TIME_RE.finditer(text, 0, m.start()):
            tail_time = t.group(1) or t.group(2)
        best = (int(m.group(1)), tail_time)
    if best is None:
        return None, None
    return best


# 每日一次的昨日温度定格对账（幂等，结果落盘 data/recon-{date}.json）
def run_daily_recon(project_dir: Path, logger: logging.Logger,
                    history_env: object, today: str) -> Optional[dict]:
    """执行 §3.1.1 昨日温度定格对账：服务端定格值 vs 本地尾帧值，差 ≥15 生成告警。

    纪律边界（AGENTS.md §3.1.1「防越权」原文不变）：告警不改判定 —— 对账结果仅落痕，
    状态机输入与输出照常，agent 不得以「数据可疑」为由改写任何判定。

    参数:
        project_dir: 项目根目录
        logger: 调度器 logger（对账过程留痕到调度器日志）
        history_env: get_daily_indicators_history 的接口返回（含 code/data 信封，与 regime 步共用一次拉取）
        today: 当日日期字符串（YYYY-MM-DD）
    返回:
        对账结果 dict；结构：
        {
            "trade_date": "2026-10-20",      # 对账执行日
            "target_date": "2026-10-19",     # 被对账的最近已完成交易日
            "finalized_score": 30,           # 服务端 15:10 收盘链定格的短线温度（null=提取失败）
            "tail_score": 30,                # 本地尾帧分值（null=无法提取，静默通过）
            "tail_time": "14:57",            # 尾帧时间戳（供人判断本地断档因素）
            "status": "pass|alert|skip|missing",  # pass=静默通过 alert=定格可疑 skip=尾帧无法提取/无已完成交易日
                                                  # missing=昨日盯盘记录整日缺失（留痕不告警）
            "alert_text": "..."              # status=alert 时的告警段（agent 原样写入总结正文并上报）
        }
        拉取失败 / 已对账（幂等命中）时返回 None —— 失败不落盘，下轮自动重试。
    """
    data_dir = project_dir / "data"
    recon_file = data_dir / f"recon-{today}.json"
    # 幂等：当日已对账直接读回（调度器盘中重启不重复对账）
    if recon_file.exists():
        try:
            return json.loads(recon_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass  # 文件损坏视为未对账，重做一次覆盖

    if not isinstance(history_env, dict) or history_env.get("code") != 200:
        logger.warning("对账跳过(下轮重试): 温度历史拉取失败或格式非法")
        return None
    data = history_env.get("data") or {}
    dates: list = data.get("dates") or []
    rows: list = data.get("rows") or []
    # 最近已完成交易日 = dates 中 < 当日的最后一个（盘中当日行是临时值，不算定格）
    target = next((d for d in reversed(dates) if d < today), None)

    if target is None:
        result = {"trade_date": today, "target_date": None, "finalized_score": None,
                  "tail_score": None, "tail_time": None, "status": "skip", "alert_text": None}
        recon_file.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        return result

    # 定格值：「短线温度」行对齐 target 下标的 标签(分值)（values 短于 dates 时按缺数处理，不越界）
    finalized: Optional[int] = None
    idx = dates.index(target)
    for row in rows:
        if "短线温度" in str(row.get("label", "")):
            values = row.get("values") or []
            raw_val = values[idx] if idx < len(values) else None
            if raw_val is not None:
                m = _LABELED_SCORE_RE.search(str(raw_val))
                if m:
                    finalized = int(m.group(1))
            break

    # 尾帧值：昨日 watch-summary 全文取时间最晚一处（Python 本地读取，零 token，无窗口截断漏报）
    summary_file = data_dir / f"watch-summary-{target}.md"
    if not summary_file.exists():
        # 该日调度器整日未跑：留痕不告警（agent 在总结里标注一行即可）
        result = {"trade_date": today, "target_date": target, "finalized_score": finalized,
                  "tail_score": None, "tail_time": None, "status": "missing", "alert_text": None}
        recon_file.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        return result

    tail_score, tail_time = _extract_tail_score(summary_file.read_text(encoding="utf-8", errors="replace"))

    # 判定：尾帧无法提取 → 静默通过；差 < 15 → 静默通过；差 ≥ 15 → 定格可疑告警
    if finalized is None or tail_score is None or abs(finalized - tail_score) < RECON_ALERT_THRESHOLD:
        result = {"trade_date": today, "target_date": target, "finalized_score": finalized,
                  "tail_score": tail_score, "tail_time": tail_time,
                  "status": "pass", "alert_text": None}
    else:
        diff = abs(finalized - tail_score)
        alert_text = (
            f"⚠ 温度定格对账异常：{target} 短线温度定格 {finalized}，本地尾帧（{tail_time}）记录 {tail_score}，"
            f"差 {diff} 分（≥{RECON_ALERT_THRESHOLD}）——昨日状态机输入可能失真（冰点簇 / 通道资格或受影响），"
            f"需人工核查服务端定格链路（日志 grep \"[短线情绪温度]\" 该日 14:00 后帧记录，"
            f"或查 history_min_indicator indicator_id=24 该日尾盘序列）"
        )
        result = {"trade_date": today, "target_date": target, "finalized_score": finalized,
                  "tail_score": tail_score, "tail_time": tail_time,
                  "status": "alert", "alert_text": alert_text}
        logger.warning("温度定格对账异常: target=%s, 定格=%s, 尾帧=%s(%s), 差=%d 分",
                       target, finalized, tail_score, tail_time, diff)
    recon_file.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return result


# 每轮的状态机读取 + 按 §3.1 第 0 步条件判断是否自愈重建
def run_regime_step(project_dir: Path, logger: logging.Logger,
                    history_env: object, today: str) -> tuple[Optional[dict], str]:
    """执行 §3.1 第 0 步：读市场阶段状态机，落后 / 异常时自愈重建后重读。

    自愈条件（与 AGENTS.md §3.1 第 0 步逐条对应，journal 代码是转移规则唯一执行权威）：
        code != 200 / defensive_reason 非空 / updated_date 落后于最近已完成交易日 —— 任一命中即 rebuild。
        防呆红线：updated_date == 最近已完成交易日 即为最新，不把「落后于今日」当自愈条件。
        --before_date 必须传当日（传昨日会把昨日收盘定格也裁掉，journal 代码有防倒退拦截）。

    参数:
        project_dir: 项目根目录
        logger: 调度器 logger
        history_env: 温度历史接口返回（rebuild 的 raw 来源；None 时跳过「落后」判断，降级只读）
        today: 当日日期字符串
    返回:
        (regime, note)：regime 为最终 read_regime_state 输出（dict，含 code 字段；读取彻底失败为 None）；
        note 为本次执行说明（如 "读取正常" / "已自愈重建" / "自愈后仍异常"），拼进注入块给 agent 留痕。
        自愈后仍 defensive / 失败 → 原样注入，agent 按总纲「读取失败按防守处理并记录」的既有纪律办。
    """
    def _read() -> Optional[dict]:
        ok, out = _run_sdk("skills/journal/cli.py", ["read_regime_state", "--trade_date", today],
                           project_dir, timeout=15)
        return out if (ok and isinstance(out, dict)) else None

    regime = _read()
    need_heal = regime is None or regime.get("code") != 200 or regime.get("defensive_reason")

    # 「落后」判断需要最近已完成交易日（来自温度历史 dates；拉取失败时跳过该条，避免误自愈）
    if not need_heal and isinstance(history_env, dict) and history_env.get("code") == 200:
        dates = (history_env.get("data") or {}).get("dates") or []
        target = next((d for d in reversed(dates) if d < today), None)
        if target and str(regime.get("updated_date") or "") < target:
            need_heal = True

    if not need_heal:
        return regime, "读取正常"

    # 自愈重建：raw 直接传接口信封（journal 内部自动解包），write_back 写回 + before_date=当日
    if isinstance(history_env, dict) and history_env.get("code") == 200:
        ok, out = _run_sdk(
            "skills/journal/cli.py",
            ["regime_rebuild", "--raw", json.dumps(history_env, ensure_ascii=False),
             "--write_back", "true", "--before_date", today],
            project_dir, timeout=15,
        )
        logger.info("状态机自愈重建: ok=%s, 结果=%s", ok, json.dumps(out, ensure_ascii=False)[:200])
        rebuilt = _read()
        if rebuilt is not None:
            return rebuilt, "检测到落后/异常，已自愈重建后重读"
        return regime, "自愈重建后重读失败，注入重建前读取结果"
    # history 缺失无法 rebuild：注入当前读取结果，note 说明降级原因
    return regime, "检测到异常但温度历史缺失，无法自愈（agent 按读取失败纪律处理）"


# 每轮的五项必读数据拉取（regime / history 由前两步提供，这里拉剩余四项）
def fetch_watch_data(project_dir: Path) -> dict:
    """拉取 §3.1 五项必读中除状态机 / 温度历史外的四项接口数据。

    参数:
        project_dir: 项目根目录
    返回:
        dict，键为注入块中的数据项名，值：
        - 拉取成功 → 接口原始返回（dict，含 code 信封；data=None 属正常业务缺位，agent 按 §5.2/§5.3 退化）
        - 拉取失败 → {"__fetch_error": "<错误摘要>"}（agent 按退化流程处理或自行调用补拉）
    """
    items = [
        ("盘面分析 market.get_intraday_analysis", "skills/mock/cli.py", ["market.get_intraday_analysis"]),
        ("交易所重点监管股票 market.get_key_watch_stocks", "skills/mock/cli.py", ["market.get_key_watch_stocks"]),
        ("账户资金 trading.get_account", "skills/mock/cli.py", ["trading.get_account"]),
        ("当前持仓 trading.get_positions", "skills/mock/cli.py", ["trading.get_positions"]),
    ]
    out: dict = {}
    for title, cli_rel, args in items:
        ok, result = _run_sdk(cli_rel, args, project_dir, timeout=30)
        out[title] = result if ok else {"__fetch_error": str(result)}
    return out


# 总入口：执行全部机械步骤并组装注入 prompt 块
def build_watch_context(project_dir: Path, logger: Optional[logging.Logger] = None) -> str:
    """机械层总入口：对账（每日一次）+ 状态机（读 / 自愈）+ 四项数据拉取，组装注入块。

    全容错：任何子步骤失败只影响该子步骤的注入内容（降级标注），不抛异常、不阻塞盯盘。

    参数:
        project_dir: 项目根目录
        logger: 调度器 logger（可空，空时用模块默认 logger）
    返回:
        注入 prompt 块（str）；整体异常时返回 ""（调度器降级为无注入的原 prompt，行为退回旧模式）
    """
    log = logger or logging.getLogger("watch_scheduler")
    try:
        today = dt.date.today().isoformat()
        fetched_at = dt.datetime.now().strftime("%H:%M:%S")

        # 温度历史：一次拉取，对账 + 状态机自愈 + 注入三用（§3.1「本轮必拉」的机械落点）
        ok, history_env = _run_sdk(
            "skills/mock/cli.py",
            ["market.get_daily_indicators_history", "--days", str(HISTORY_DAYS)],
            project_dir, timeout=30,
        )
        if not ok:
            history_env = None
            log.warning("机械层温度历史拉取失败: %s", history_env)

        recon = run_daily_recon(project_dir, log, history_env, today)
        regime, regime_note = run_regime_step(project_dir, log, history_env, today)
        market_data = fetch_watch_data(project_dir)

        lines = [
            f"【调度器机械层前置（{fetched_at} 完成）——以下数据与结果由调度器代取得，"
            f"除标注 __fetch_error / 拉取失败 / 需更新鲜数据外，不要重复调用对应接口，直接消费】",
            "",
            f"■ 市场阶段状态机（journal 代码唯一权威输出，{regime_note}）：",
            json.dumps(regime, ensure_ascii=False) if regime is not None
            else "读取失败（agent 按总纲「状态机读取失败 → 当日防守处理并记录」纪律执行）",
        ]

        # 对账结果注入：告警 → agent 原样写入总结正文并上报；missing → 总结标注一行；其余静默
        if recon is None:
            lines += ["", "■ 昨日温度定格对账：本轮拉取失败未完成（下轮自动重试，无需 agent 处理）"]
        elif recon.get("status") == "alert":
            lines += [
                "",
                "■ 昨日温度定格对账（调度器已完成，发现异常）：",
                str(recon.get("alert_text")),
                "→ 请把上述告警段原样写入本轮盯盘总结正文，并随 report.submit_summary 上报同一告警；"
                "仅落痕，不影响任何判定（告警不改判定纪律不变）。",
            ]
        elif recon.get("status") == "missing":
            lines += [
                "",
                f"■ 昨日温度定格对账：{recon.get('target_date')} 盯盘记录缺失，温度对账跳过"
                "（请在盯盘总结中标注这一行，留痕不告警）。",
            ]
        else:
            lines += ["", "■ 昨日温度定格对账：已完成，静默通过（无需 agent 处理）"]

        lines += ["", f"■ 五项必读之四项接口数据（第 1 项市场阶段状态机见上节；{fetched_at} 拉取快照；"
                      "标注 __fetch_error 的项按总纲退化流程处理或自行调用补拉）："]
        for i, (title, payload) in enumerate(market_data.items(), start=1):
            lines += [f"[{i}] {title}：", json.dumps(payload, ensure_ascii=False)]
        # 附带温度历史：机械层对账 / 自愈已共用该次拉取，agent 需要温度序列时直接消费不必重拉
        lines += [f"附 温度历史 market.get_daily_indicators_history --days {HISTORY_DAYS}：",
                  json.dumps(history_env, ensure_ascii=False) if history_env is not None
                  else '{"__fetch_error": "拉取失败，可自行调用补拉"}']
        return "\n".join(lines)
    except Exception as exc:  # noqa: BLE001
        log.warning("机械层前置整体异常(降级为无注入): %s: %s", type(exc).__name__, exc)
        return ""
