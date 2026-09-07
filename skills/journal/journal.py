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
import re
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


# ==================== 市场阶段状态机（裁决层，执行唯一权威） ====================
#
# 转移规则的人审表述见 memory/strategies/00-regime-machine.md，设计依据与 60 日
# 重放口径见 memory/design/2026-09-03-multi-regime-strategy.md（附录 B 即本节实现规格）。
# 二者必须同步修订；agent 只读本节代码输出，禁止手工推演转移表。

# 状态枚举 → 中文标签（摘要行「阶段」字段用，映射固定勿改）
_STATE_LABELS = {
    "defense": "防守",
    "ice_point": "冰点",
    "uptrend_ready": "主升预备",
    "uptrend": "主升",
    "oscillation": "高位震荡",
}

# 状态机阈值常量（变更须用户批准，且与 00-regime-machine.md 同步修订，只改一处即判定漂移）
_ICE_THRESHOLD = 25          # 冰点阈值：收盘短线温度 s <= 25 进入 / 延续冰点聚簇
_UP_THRESHOLD = 55           # 主升确认阈值：连续 2 日 s >= 55 进主升预备，第 3 日仍强放行
_MID_LOW = 45                # 回落区间下沿：主升退守 / 震荡入口的下边界（45 <= s < 55）
_PEAK_THRESHOLD = 70         # 段内极值阈值：主升段内曾 s >= 70 才允许回落转高位震荡
_OSC_EXIT = 40               # 震荡出口：s < 40 退防守（45 进 40 出，回差防边界抖动）
_CLUSTER_SUSPEND_LIMIT = 3   # 聚簇挂起上限：冰点日后第 3 个交易日收盘仍无冰则簇终结清零
_CHANNEL_DEPTH_MIN = 2       # 试错通道簇深下限：双冰及以上才开放试错通道（A/A2/B 共用资格）
_CHANNEL_DEPTH_MAX = 4       # 试错通道簇深上限：>= 5 视为长熊防御关闭（样本外保守外推，前向验证）
_HOLIDAY_GAP_DAYS = 4        # 长假重置代理：相邻交易日自然日差 >= 4 全量重置（journal 无交易日历）
_STALE_GAP_DAYS = 5          # 陈旧检测阈值：读取日与更新日自然日差 > 5 判复盘任务断档
_HISTORY_KEEP = 90           # history 滚动保留条数（> 60 日重放窗口，供阈值重拟合）

# 状态机持久化文件名（滚动单文件，整体原子覆盖写，不参与按日清理）
_REGIME_FILE = "regime-state.json"


# 返回盲初始化状态（防守 + 全计数清零，重放起点 / 长假重置用）
def _blank_regime() -> dict:
    """返回盲初始化运行态（防守 + 计数清零）。重放起点偏差有界且方向保守。"""
    return {
        "current_state": "defense",   # 当前阶段枚举值
        "cluster_depth": 0,           # 冰点聚簇深度
        "days_since_ice": None,       # 距最近冰点日的交易日数（冰点日 = 0；无活动簇为 None）
        "up_count": 0,                # 连续 s >= 55 计数（主升预备确认用）
        "mid_count": 0,               # 连续 45 <= s < 55 计数（未见极值主升段的双日回落出口用）
        "saw_peak_70": False,         # 本主升段内是否曾 s >= 70（震荡出口用，跨段重置）
        "missing_count": 0,           # 连续缺数日计数（>= 2 强制防守）
        "last_change_date": None,     # 最近一次状态切换日
    }


# 解析温度值（"保守(20)" / 全角括号 "偏保守(38）" 容错；提取失败返回 None 作缺数日）
def _parse_temperature(value) -> Optional[int]:
    """从 `标签(分数)` 格式中提取温度数值；扫描数字提取，兼容全角括号，失败返回 None。"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    m = re.search(r"\d+", str(value))
    return int(m.group()) if m else None


# 规范化 CLI 传入的可空温度（"None" / "null" / "" → None；其余转 int）
def _normalize_temperature(value) -> Optional[int]:
    """把 CLI 传入的温度参数规范为 int 或 None（agent 缺值时传字符串 None / null）。"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    if text.lower() in ("none", "null", ""):
        return None
    return int(text)


# 单日前推（转移表 + 聚簇挂起合并 + 连续计数 + 通道预计算的唯一权威实现）
def _advance_one(run: dict, trade_date: str, s: Optional[int]) -> dict:
    """按附录 B 口径把运行态向前推进一个交易日（纯函数，每日至多转移一次）。

    入参：
        run: dict（必传）- 推进前运行态（含 updated_date 与全部计数字段）
        trade_date: str（必传）- 推进到的交易日，格式 YYYY-MM-DD
        s: int | None（必传）- 当日收盘短线温度定格值；None 走缺数日规则

    返回 -> dict：推进后的运行态（新 dict，不改入参）。
    """
    st = dict(run)
    prev_date = st.get("updated_date")
    # 长假重置（先于一切）：相邻交易日自然日差 >= 4 → 全量重置回防守、计数清零
    # （保守代理：正常周末差 3，差 4 = 中间至少 3 个连续休市自然日；误判方向仅多保守）
    if prev_date:
        gap = (datetime.strptime(trade_date, "%Y-%m-%d") - datetime.strptime(prev_date, "%Y-%m-%d")).days
        if gap >= _HOLIDAY_GAP_DAYS:
            st = _blank_regime()
    st["updated_date"] = trade_date

    # 缺数日规则：透明跳过（不计入任何连续计数、簇深度与 days_since_ice 均不变），状态沿用
    if s is None:
        st["missing_count"] += 1
        # 连续 2 日缺数 → 强制防守（连续计数清零、聚簇信息保留）
        if st["missing_count"] >= 2:
            st["current_state"] = "defense"
            st["up_count"] = 0
            st["mid_count"] = 0
            st["saw_peak_70"] = False
        st["next_day_channel_open"] = False
        return st
    st["missing_count"] = 0

    # 连续计数（收盘 s 序列的纯函数，与当日所处状态无关）
    st["up_count"] = st["up_count"] + 1 if s >= _UP_THRESHOLD else 0
    st["mid_count"] = st["mid_count"] + 1 if _MID_LOW <= s < _UP_THRESHOLD else 0

    # 聚簇挂起合并：s <= 25 深度 +1 且 days_since_ice 归零；
    # 有活动簇且当日未冰 → days_since_ice +1，第 3 个交易日收盘仍无冰 → 簇终结清零
    if s <= _ICE_THRESHOLD:
        st["cluster_depth"] += 1
        st["days_since_ice"] = 0
    elif st["cluster_depth"] > 0:
        st["days_since_ice"] += 1
        if st["days_since_ice"] >= _CLUSTER_SUSPEND_LIMIT:
            st["cluster_depth"] = 0
            st["days_since_ice"] = None

    # 转移表（表序自上而下首个命中生效；首行全局规则：任意非冰点态 s <= 25 → 冰点）
    cur = st["current_state"]
    new = cur
    if cur != "ice_point" and s <= _ICE_THRESHOLD:
        new = "ice_point"
    elif cur == "defense":
        if st["up_count"] >= 2:
            new = "uptrend_ready"
    elif cur == "ice_point":
        # 再冰（s <= 25）保持冰点（聚簇分支已计深度）；回升未确认退防守，不允许单日跳主升
        if s > _ICE_THRESHOLD:
            new = "uptrend_ready" if st["up_count"] >= 2 else "defense"
    elif cur == "uptrend_ready":
        # 第 3 日仍强才放行（入场必慢 2 日）；确认失败回防守
        new = "uptrend" if s >= _UP_THRESHOLD else "defense"
    elif cur == "uptrend":
        if st["saw_peak_70"] and _MID_LOW <= s < _UP_THRESHOLD:
            new = "oscillation"   # 本段曾见极值，回落未崩 → 高位震荡
        elif not st["saw_peak_70"] and st["mid_count"] >= 2:
            new = "defense"       # 防卡死：未见过极值的主升段，双日确认回落即结束
        elif s < _MID_LOW:
            new = "defense"       # 主升结束
    elif cur == "oscillation":
        if s < _OSC_EXIT:
            new = "defense"       # 回差设计：45 进 40 出，防边界抖动
        elif st["up_count"] >= 2:
            new = "uptrend_ready"  # 重启确认流程

    if new != cur:
        st["current_state"] = new
        st["last_change_date"] = trade_date
        # 离开主升：段内极值标记与本段回落计数清零（跨段不继承）
        if cur == "uptrend":
            st["saw_peak_70"] = False
            st["mid_count"] = 0
    # 段内极值置位（含放行当日：进入主升当日本身即属本段，如 08-27 放行日 s=75）
    if st["current_state"] == "uptrend" and s >= _PEAK_THRESHOLD:
        st["saw_peak_70"] = True

    # 次日试错通道预计算（A/A2/B 共用资格；agent 盘中只读该字段，不自行判定）：冰点 且 2 <= 簇深 <= 4
    st["next_day_channel_open"] = (
        st["current_state"] == "ice_point"
        and _CHANNEL_DEPTH_MIN <= st["cluster_depth"] <= _CHANNEL_DEPTH_MAX
    )
    return st


# 原子写入状态文件（临时文件 + os.replace，防中断写坏）
def _write_regime_file(data: dict) -> None:
    """整体原子覆盖写 regime-state.json（tmp + rename，写入中断不留半截文件）。"""
    path = os.path.join(_DATA_DIR, _REGIME_FILE)
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


# 读取当前市场阶段状态（盘中每轮第 0 步；含陈旧 / 长假盘中防御检测）
def read_regime_state(trade_date: Optional[str] = None) -> dict:
    """
    读取市场阶段状态机当前状态（agent 盘中唯一入口，只读不推演）

    入参：
        trade_date: str（可选，默认当天）- 盘面交易日，格式 YYYY-MM-DD，
            用于与文件 updated_date 做陈旧 / 长假盘中防御检测

    返回 -> dict：
        {
            "code": 200,                      # int，200 成功；非 200 一律按防守处理
            "trade_date": "2026-09-04",       # str，传入的盘面交易日
            "current_state": "ice_point",     # str，当前阶段：defense / ice_point / uptrend_ready / uptrend / oscillation
            "state_label": "冰点",            # str，中文标签（摘要行「阶段」字段用）
            "cluster_depth": 2,               # int，冰点聚簇深度
            "days_since_ice": 0,              # int | None，距最近冰点日的交易日数
            "next_day_channel_open": True,    # bool，当日尾盘通道是否开放（预计算字段，只读不自判）
            "updated_date": "2026-09-03",     # str，文件最近一次盘后更新日
            "defensive_reason": None,         # str | None，非空 → 当日按防守处理并记录：
                                              #   "陈旧防御（复盘断档）"（自然日差 > 5）
                                              #   "长假盘中防御"（自然日差 >= 4 且 <= 5）
                                              #   "复盘断档防御"（自然日差 == 2：相邻交易日差只可能是 1/3/>=4，差 2 必为漏复盘）
            "effective_state": "ice_point",   # str，当日实际生效阶段（defensive_reason 非空时为 defense）
            "effective_state_label": "冰点",  # str，effective_state 的中文标签
        }
        文件缺失 / 损坏 / JSON 解析失败 → {"code": 404, "error": ..., "defensive_reason": ..., "effective_state": "defense"}
    """
    if trade_date is None:
        trade_date = datetime.now().strftime("%Y-%m-%d")
    path = os.path.join(_DATA_DIR, _REGIME_FILE)
    if not os.path.exists(path):
        return {"code": 404, "error": "regime-state.json 不存在，当日按防守处理，复盘时 regime_rebuild 重建",
                "defensive_reason": "状态文件缺失", "effective_state": "defense", "effective_state_label": "防守"}
    try:
        with open(path, "r", encoding="utf-8") as f:
            state = json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        return {"code": 404, "error": f"regime-state.json 读取 / 解析失败: {exc}，当日按防守处理",
                "defensive_reason": "状态文件损坏", "effective_state": "defense", "effective_state_label": "防守"}
    if "current_state" not in state or "updated_date" not in state:
        return {"code": 404, "error": "regime-state.json 缺少 current_state / updated_date 字段，当日按防守处理",
                "defensive_reason": "状态文件损坏", "effective_state": "defense", "effective_state_label": "防守"}

    # 陈旧 / 断档 / 长假盘中防御（自然日差代理，journal 无交易日历）：
    # 相邻交易日自然日差只可能是 1（周内连续）/ 3（周末）/ >=4（长假）——
    # 差 2 必然意味着中间漏了一个交易日复盘；> 5 复盘断档；>= 4 且 <= 5 长假后首个交易日
    defensive_reason = None
    try:
        gap = (datetime.strptime(trade_date, "%Y-%m-%d") - datetime.strptime(state["updated_date"], "%Y-%m-%d")).days
    except ValueError:
        return {"code": 400, "error": f"trade_date {trade_date!r} 或文件 updated_date {state['updated_date']!r} 日期格式非法",
                "defensive_reason": "日期格式异常", "effective_state": "defense", "effective_state_label": "防守"}
    if gap > _STALE_GAP_DAYS:
        defensive_reason = f"陈旧防御（复盘断档：更新日 {state['updated_date']} 距 {trade_date} 已 {gap} 自然日）"
    elif gap >= _HOLIDAY_GAP_DAYS:
        defensive_reason = f"长假盘中防御（更新日 {state['updated_date']} 距 {trade_date} 为 {gap} 自然日）"
    elif gap == 2:
        defensive_reason = f"复盘断档防御（更新日 {state['updated_date']} 距 {trade_date} 为 2 自然日，中间漏了一个交易日复盘）"

    effective = "defense" if defensive_reason else state["current_state"]
    return {
        "code": 200,
        "trade_date": trade_date,
        "current_state": state["current_state"],
        "state_label": _STATE_LABELS.get(state["current_state"], state["current_state"]),
        "cluster_depth": state.get("cluster_depth", 0),
        "days_since_ice": state.get("days_since_ice"),
        "next_day_channel_open": state.get("next_day_channel_open", False),
        "updated_date": state["updated_date"],
        "defensive_reason": defensive_reason,
        "effective_state": effective,
        "effective_state_label": _STATE_LABELS[effective],
    }


# 盘后推进状态机一个交易日（唯一写入口；复盘任务每日调一次）
def regime_advance(trade_date: str, s=None, d=None) -> dict:
    """
    盘后推进市场阶段状态机一个交易日（转移表 + 聚簇 + 通道预计算的唯一权威实现）

    入参：
        trade_date: str（必传）- 交易日，格式 YYYY-MM-DD
        s: int | None（必传）- 当日收盘短线温度定格值；缺值传 None / "None"（走缺数日规则）
        d: int | None（可选）- 当日收盘大盘温度定格值（仅落库存档，不进转移条件）

    返回 -> dict：
        {
            "code": 200,
            "trade_date": "2026-09-04",       # str，推进到的交易日
            "s": 15,                          # int | None，实际采用的短线温度
            "d": 30,                          # int | None，实际采用的大盘温度
            "current_state": "ice_point",     # str，推进后的阶段
            "state_label": "冰点",            # str，中文标签
            "cluster_depth": 3,               # int，推进后的聚簇深度
            "next_day_channel_open": True,    # bool，次交易日尾盘通道是否开放（预计算）
            "changed": False,                 # bool，本次是否发生状态切换
            "holiday_reset": False,           # bool，本次是否触发长假重置
        }
        状态文件缺失 / 损坏 → {"code": 404, "error": ...}（调用方改用 regime_rebuild 重建）
    """
    path = os.path.join(_DATA_DIR, _REGIME_FILE)
    if not os.path.exists(path):
        return {"code": 404, "error": "regime-state.json 不存在，请用 regime_rebuild 重建"}
    try:
        with open(path, "r", encoding="utf-8") as f:
            state = json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        return {"code": 404, "error": f"regime-state.json 读取 / 解析失败: {exc}，请用 regime_rebuild 重建"}
    if "current_state" not in state:
        return {"code": 404, "error": "regime-state.json 缺少 current_state 字段，请用 regime_rebuild 重建"}

    s_val = _normalize_temperature(s)
    d_val = _normalize_temperature(d)
    prev_state = state["current_state"]
    prev_updated = state.get("updated_date")
    # 长假重置探测（用于返回标记；实际重置在 _advance_one 内完成）
    holiday_reset = bool(prev_updated) and (
        datetime.strptime(trade_date, "%Y-%m-%d") - datetime.strptime(prev_updated, "%Y-%m-%d")
    ).days >= _HOLIDAY_GAP_DAYS

    run = _advance_one(state, trade_date, s_val)

    # 组装持久化结构（契约见 00-regime-machine.md §四）并原子覆盖写
    history = state.get("history", [])
    history.append({
        "date": trade_date,
        "s": s_val,
        "d": d_val,
        "state": run["current_state"],
        "cluster_depth": run["cluster_depth"],
    })
    history = history[-_HISTORY_KEEP:]
    new_file = {
        "updated_date": trade_date,
        "current_state": run["current_state"],
        "cluster_depth": run["cluster_depth"],
        "days_since_ice": run["days_since_ice"],
        "next_day_channel_open": run["next_day_channel_open"],
        "missing_count": run["missing_count"],
        "up_count": run["up_count"],
        "mid_count": run["mid_count"],
        "saw_peak_70": run["saw_peak_70"],
        "last_change_date": run["last_change_date"],
        "history": history,
    }
    _write_regime_file(new_file)

    return {
        "code": 200,
        "trade_date": trade_date,
        "s": s_val,
        "d": d_val,
        "current_state": run["current_state"],
        "state_label": _STATE_LABELS[run["current_state"]],
        "cluster_depth": run["cluster_depth"],
        "next_day_channel_open": run["next_day_channel_open"],
        "changed": run["current_state"] != prev_state,
        "holiday_reset": holiday_reset,
    }


# 从日级指标历史原始结构完整重放重建状态机（文件缺失 / 损坏 / 陈旧 / 断档 / 盘中自愈 / 阈值重拟合时用）
def regime_rebuild(raw: dict, write_back: bool = False, before_date: Optional[str] = None) -> dict:
    """
    由收盘温度序列纯函数重放，完整重建市场阶段状态机

    入参：
        raw: dict（必传）- get_daily_indicators_history 返回的 data 原始结构：
            {"dates": ["2026-06-11", ...], "rows": [{"label": "短线温度", "values": ["保守(20)", ...]}, ...]}
            解析在代码内完成：从「短线温度」/「大盘温度」行提取数值，兼容全角括号，提取失败该日缺数
            （支持 @文件路径 传参，如 --raw @/tmp/history.json）
        write_back: bool（可选，默认 False）- True 时把重建结果原子覆盖写回 data/regime-state.json
        before_date: str（可选）- 只重放该日**之前**的交易日（YYYY-MM-DD）。盘中自愈必传当日：
            当日行可能是盘中临时值而非收盘定格，必须排除，保证状态文件语义 = 最近已完成交易日的收盘状态

    返回 -> dict：
        {
            "code": 200,
            "days": 60,                       # int，实际重放的交易日数（before_date 裁剪后）
            "final": {...},                   # dict，末态（current_state / cluster_depth / next_day_channel_open 等）
            "state_label": "冰点",            # str，末态中文标签
            "history": [                      # list[dict]，逐日轨迹：
                {"date": "...", "s": 20, "d": 45, "state": "ice_point", "cluster_depth": 2}
            ],
            "written": False,                 # bool，是否已写回状态文件
        }
        raw 结构非法 → {"code": 400, "error": ...}
    """
    if not isinstance(raw, dict):
        return {"code": 400, "error": f"raw 必须是 dict（get_daily_indicators_history 的 data 结构），实际 {type(raw).__name__}"}
    # 信封自动解包：agent 传入整个接口返回（含 code/data 信封）时取 data 字段
    if "dates" not in raw and isinstance(raw.get("data"), dict):
        raw = raw["data"]
    dates = raw.get("dates") or []
    rows = raw.get("rows") or []
    if not dates:
        return {"code": 400, "error": "raw.dates 为空，无法重放"}
    # before_date 裁剪：只重放该日之前的交易日（盘中自愈时排除当日临时值）
    replay_dates = [d for d in dates if before_date is None or d < before_date]
    if not replay_dates:
        return {"code": 400, "error": f"before_date={before_date} 裁剪后无可重放交易日"}

    # 解析双温度序列：行标签含「短线温度」→ s，含「大盘温度」→ d；逐日对齐 dates
    series = {date: {"s": None, "d": None} for date in dates}
    for row in rows:
        label = str(row.get("label", ""))
        key = "s" if "短线温度" in label else ("d" if "大盘温度" in label else None)
        if key is None:
            continue
        for idx, value in enumerate(row.get("values") or []):
            if idx >= len(dates):
                break
            series[dates[idx]][key] = _parse_temperature(value)

    # 从「防守 + 计数清零」盲初始化起点纯函数重放（含序列内相邻日期自然日差 >= 4 的长假重置）
    run = _blank_regime()
    run["updated_date"] = None
    history = []
    for date in replay_dates:
        run = _advance_one(run, date, series[date]["s"])
        history.append({
            "date": date,
            "s": series[date]["s"],
            "d": series[date]["d"],
            "state": run["current_state"],
            "cluster_depth": run["cluster_depth"],
        })

    written = False
    if write_back:
        new_file = {
            "updated_date": run["updated_date"],
            "current_state": run["current_state"],
            "cluster_depth": run["cluster_depth"],
            "days_since_ice": run["days_since_ice"],
            "next_day_channel_open": run["next_day_channel_open"],
            "missing_count": run["missing_count"],
            "up_count": run["up_count"],
            "mid_count": run["mid_count"],
            "saw_peak_70": run["saw_peak_70"],
            "last_change_date": run["last_change_date"],
            "history": history[-_HISTORY_KEEP:],
        }
        _write_regime_file(new_file)
        written = True

    return {
        "code": 200,
        "days": len(replay_dates),
        "final": {
            "updated_date": run["updated_date"],
            "current_state": run["current_state"],
            "cluster_depth": run["cluster_depth"],
            "days_since_ice": run["days_since_ice"],
            "next_day_channel_open": run["next_day_channel_open"],
            "up_count": run["up_count"],
            "mid_count": run["mid_count"],
            "saw_peak_70": run["saw_peak_70"],
            "last_change_date": run["last_change_date"],
        },
        "state_label": _STATE_LABELS[run["current_state"]],
        "history": history,
        "written": written,
    }
