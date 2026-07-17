"""
状态读写 SDK（总结与写文档）

负责读写数字人的本地状态文件：交易日志、自选池、每日总结、动态策略等。
纯本地文件读写，不依赖网络接口；总结上报（submit_summary）在 skills.mock.report。
agent 通过 cli.py 调用，不直接操作文件。

文件存储约定（均相对工作区根 = 项目根目录）：
    - data/trade-log-{date}.json       每日交易日志（操作记录 + 情绪快照）
    - data/watchlist-{date}.json       每日自选池（标的、买点、止损位）
    - data/daily-summary-{date}.json   每日复盘总结（盈亏、反思、次日计划）
    - memory/dynamic-strategy.md       动态交易策略（仅按需改写，不复盘时自动写）

目录推算：本文件位于 skills/journal/journal.py，向上 3 层 dirname 即项目根目录，
用于定位 data/ 与 memory/ 目录。
"""

import json
import os
from datetime import datetime
from typing import Optional

# 项目根目录（向上 3 层：skills/journal/journal.py → skills/journal → skills → 项目根）
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# 运行时数据文件目录
_DATA_DIR = os.path.join(_PROJECT_ROOT, "data")
# 记忆目录（动态策略等）
_MEMORY_DIR = os.path.join(_PROJECT_ROOT, "memory")


def _read_json(filename: str) -> dict:
    """读取 _DATA_DIR 下的 JSON 状态文件，不存在则返回空 dict"""
    path = os.path.join(_DATA_DIR, filename)
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_json(filename: str, data: dict) -> None:
    """写入 _DATA_DIR 下的 JSON 状态文件（ensure_ascii=False，缩进 2 空格）"""
    path = os.path.join(_DATA_DIR, filename)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ==================== 交易日志 ====================

# 读取交易日志
def read_trade_log(date: Optional[str] = None) -> dict:
    """
    读取交易日志

    入参：
        date: str（可选，默认当天）- 交易日期，格式 YYYY-MM-DD

    返回 -> dict：
        {
            "date": "2025-05-22",           # str，交易日期
            "actions": list[dict],          # 交易动作列表，每项含：
                time: str                   - 操作时间，如 "09:31"
                action: str                 - "buy" 或 "sell"
                stock: str                  - 股票代码
                name: str                   - 股票名称
                price: float                - 成交价格
                volume: int                 - 成交数量（股）
                reason: str                 - 操作理由
            "emotions": list[dict],         # 情绪快照列表，每项含：
                time: str                   - 快照时间，如 "09:45"
                phase: str                  - 短线情绪阶段（主升/回暖/混沌/退潮）
                zt_count: int               - 当时涨停数
                lb_height: int              - 当时连板高度
                main_line: str              - 当时主线名称
            "stop_loss_triggered": list,    # 触发止损的记录
            "summary": str                  # 日志摘要
        }
    """
    if date is None:
        date = datetime.now().strftime("%Y-%m-%d")
    return _read_json(f"trade-log-{date}.json")


# 写入交易日志
def write_trade_log(data: dict, date: Optional[str] = None) -> None:
    """
    写入交易日志

    入参：
        data: dict（必传）- 完整的交易日志数据，结构同 read_trade_log 返回值
        date: str（可选，默认当天）- 交易日期，格式 YYYY-MM-DD

    返回：无
    """
    if date is None:
        date = datetime.now().strftime("%Y-%m-%d")
    _write_json(f"trade-log-{date}.json", data)


# 追加一条交易动作到今日日志
def append_trade_action(
    action: str,
    stock_code: str,
    stock_name: str,
    price: float,
    volume: int,
    reason: str,
) -> None:
    """
    追加一条交易动作到今日日志

    入参：
        action: str（必传）- "buy" 或 "sell"
        stock_code: str（必传）- 股票代码
        stock_name: str（必传）- 股票名称
        price: float（必传）- 成交价格
        volume: int（必传）- 成交数量（股）
        reason: str（必传）- 操作理由

    返回：无
    """
    log = read_trade_log()
    if "actions" not in log:
        log["actions"] = []
        log["date"] = datetime.now().strftime("%Y-%m-%d")
    log["actions"].append({
        "time": datetime.now().strftime("%H:%M"),
        "action": action,
        "stock": stock_code,
        "name": stock_name,
        "price": price,
        "volume": volume,
        "reason": reason,
    })
    write_trade_log(log)


# 追加一次情绪快照到今日日志
def append_emotion_snapshot(
    phase: str,
    zt_count: int,
    lb_height: int,
    main_line: str,
    extra: Optional[dict] = None,
) -> None:
    """
    追加一次情绪快照到今日日志

    入参：
        phase: str（必传）- 短线情绪阶段（主升/回暖/混沌/退潮）
        zt_count: int（必传）- 当前涨停数
        lb_height: int（必传）- 当前连板高度
        main_line: str（必传）- 当前主线名称
        extra: dict（可选）- 额外信息，会被合并到快照记录中

    返回：无
    """
    log = read_trade_log()
    if "emotions" not in log:
        log["emotions"] = []
        log["date"] = datetime.now().strftime("%Y-%m-%d")
    entry = {
        "time": datetime.now().strftime("%H:%M"),
        "phase": phase,
        "zt_count": zt_count,
        "lb_height": lb_height,
        "main_line": main_line,
    }
    if extra:
        entry.update(extra)
    log["emotions"].append(entry)
    write_trade_log(log)


# ==================== 自选池 ====================

# 读取自选池
def read_watchlist(date: Optional[str] = None) -> dict:
    """
    读取自选池

    入参：
        date: str（可选，默认当天）- 交易日期，格式 YYYY-MM-DD

    返回 -> dict：
        {
            "date": "2025-05-22",           # str，交易日期
            "main_line": "算力/芯片",       # str，主线板块名称
            "stocks": list[dict],           # 标的列表，每项含：
                code: str                   - 股票代码
                name: str                   - 股票名称
                role: str                   - 角色（如 "龙头"、"跟风"）
                buy_point: float            - 买点价格
                stop_loss: float            - 止损价格
                auction_threshold: str      - 竞价条件（如 "放量>5%"）
            "position_limit": float,        # 仓位上限（0-1 之间，如 0.6 表示 6 成）
            "conditions": str               # 买入条件描述
        }
    """
    if date is None:
        date = datetime.now().strftime("%Y-%m-%d")
    return _read_json(f"watchlist-{date}.json")


# 写入自选池
def write_watchlist(data: dict, date: Optional[str] = None) -> None:
    """
    写入自选池

    入参：
        data: dict（必传）- 完整的自选池数据，结构同 read_watchlist 返回值
        date: str（可选，默认当天）- 交易日期，格式 YYYY-MM-DD

    返回：无
    """
    if date is None:
        date = datetime.now().strftime("%Y-%m-%d")
    _write_json(f"watchlist-{date}.json", data)


# ==================== 每日总结 ====================

# 读取每日复盘总结
def read_daily_summary(date: Optional[str] = None) -> dict:
    """
    读取每日复盘总结

    入参：
        date: str（可选，默认当天）- 交易日期，格式 YYYY-MM-DD

    返回 -> dict：
        {
            "date": "2025-05-22",           # str，交易日期
            "profit_loss": 1500.0,          # float，当日盈亏金额
            "trades_count": 3,              # int，交易次数
            "hit_stop_loss": false,         # bool，是否触发止损
            "main_line": "算力/芯片",       # str，当日主线
            "emotions": list[dict],         # 当日情绪快照列表
            "reflection": "今日操作...",    # str，操作反思
            "next_day_plan": dict,          # 次日计划，含：
                main_line_candidates: list[str]  - 主线候选列表
                watchlist: list[dict]            - 次日自选列表
                position_limit: float            - 仓位上限
                conditions: str                  - 买入条件
            "strategy_changes": list        # 策略调整记录
        }
    """
    if date is None:
        date = datetime.now().strftime("%Y-%m-%d")
    return _read_json(f"daily-summary-{date}.json")


# 写入每日复盘总结
def write_daily_summary(data: dict, date: Optional[str] = None) -> None:
    """
    写入每日复盘总结

    入参：
        data: dict（必传）- 完整的复盘数据，结构同 read_daily_summary 返回值
        date: str（可选，默认当天）- 交易日期，格式 YYYY-MM-DD

    返回：无
    """
    if date is None:
        date = datetime.now().strftime("%Y-%m-%d")
    _write_json(f"daily-summary-{date}.json", data)


# ==================== 动态策略 ====================

# 读取动态交易策略
def read_dynamic_strategy() -> str:
    """
    读取动态交易策略

    入参：无

    返回 -> str：
        memory/dynamic-strategy.md 的完整文本内容（Markdown 格式）
        文件不存在时返回空字符串 ""
    """
    path = os.path.join(_MEMORY_DIR, "dynamic-strategy.md")
    if not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


# 写入动态交易策略（仅按需改写）
def write_dynamic_strategy(content: str) -> None:
    """
    写入动态交易策略（仅按需改写）

    入参：
        content: str（必传）- 完整的 Markdown 策略文本

    返回：无
    """
    path = os.path.join(_MEMORY_DIR, "dynamic-strategy.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
