"""
状态读写 SDK（总结与写文档）

负责读写数字人的本地状态文件：市场阶段状态机、动态策略。
纯本地文件读写，不依赖网络接口；总结上报（submit_summary）在 skills.mock.report。
agent 通过 cli.py 调用，不直接操作文件。

文件存储约定（均相对工作区根 = 项目根目录）：
    - data/regime-state.json           市场阶段状态机（滚动单文件，盘中自愈写回）
    - memory/dynamic-strategy.md       动态交易策略（仅按需改写，不复盘时自动写）

注：盯盘 / 复盘总结全文（data/watch-summary-{date}.md / review-summary-{date}.md）由
调度器从 run log 自动归档，不经本模块（总纲 §7.1 / §10.1）。

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
    "defense": "退潮期",
    "ice_point": "冰点期",
    "uptrend_ready": "回暖确认期",
    "uptrend": "高潮期",
    "oscillation": "退潮分歧期",
}

# 状态机阈值常量（变更须用户批准，且与 00-regime-machine.md 同步修订，只改一处即判定漂移）
_ICE_THRESHOLD = 25          # 冰点阈值：收盘短线温度 s <= 25 进入 / 延续冰点聚簇
_UP_THRESHOLD = 55           # 回暖确认阈值：连续 2 日 s >= 55 进回暖确认期，第 3 日仍强转高潮期（高潮期禁新开仓，见 20 分册）
_MID_LOW = 45                # 回落区间下沿：高潮期退守 / 退潮分歧期入口的下边界（45 <= s < 55）
_PEAK_THRESHOLD = 70         # 段内极值阈值：高潮段内曾 s >= 70 才允许回落转退潮分歧期
_OSC_EXIT = 40               # 退潮分歧期出口：s < 40 退退潮期（45 进 40 出，回差防边界抖动）
_CLUSTER_SUSPEND_LIMIT = 3   # 聚簇挂起上限：冰点日后第 3 个交易日收盘仍无冰则簇终结清零
_CHANNEL_DEPTH_MIN = 2       # 试错通道簇深下限：双冰及以上才开放试错通道（A/A2/B 共用资格）
_CHANNEL_DEPTH_MAX = 4       # 试错通道簇深上限：>= 5 视为长熊防御关闭（样本外保守外推，前向验证）
_HOLIDAY_GAP_DAYS = 4        # 长假重置代理：相邻交易日自然日差 >= 4 全量重置（journal 无交易日历）
_STALE_GAP_DAYS = 5          # 陈旧检测阈值：读取日与更新日自然日差 > 5 判复盘任务断档
_HISTORY_KEEP = 90           # history 滚动保留条数（> 60 日重放窗口，供阈值重拟合）

# 状态机持久化文件名（滚动单文件，整体原子覆盖写，不参与按日清理）
_REGIME_FILE = "regime-state.json"


# 返回盲初始化状态（退潮期 + 全计数清零，重放起点 / 长假重置用）
def _blank_regime() -> dict:
    """返回盲初始化运行态（退潮期 + 计数清零）。重放起点偏差有界且方向保守。"""
    return {
        "current_state": "defense",   # 当前阶段枚举值
        "cluster_depth": 0,           # 冰点聚簇深度
        "days_since_ice": None,       # 距最近冰点日的交易日数（冰点日 = 0；无活动簇为 None）
        "up_count": 0,                # 连续 s >= 55 计数（回暖确认期确认用）
        "mid_count": 0,               # 连续 45 <= s < 55 计数（未见极值高潮段的双日回落出口用）
        "saw_peak_70": False,         # 本高潮段内是否曾 s >= 70（退潮分歧期出口用，跨段重置）
        "missing_count": 0,           # 连续缺数日计数（>= 2 强制退潮期）
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
    # 长假重置（先于一切）：相邻交易日自然日差 >= 4 → 全量重置回退潮期、计数清零
    # （保守代理：正常周末差 3，差 4 = 中间至少 3 个连续休市自然日；误判方向仅多保守）
    if prev_date:
        gap = (datetime.strptime(trade_date, "%Y-%m-%d") - datetime.strptime(prev_date, "%Y-%m-%d")).days
        if gap >= _HOLIDAY_GAP_DAYS:
            st = _blank_regime()
    st["updated_date"] = trade_date

    # 缺数日规则：透明跳过（不计入任何连续计数、簇深度与 days_since_ice 均不变），状态沿用
    if s is None:
        st["missing_count"] += 1
        # 连续 2 日缺数 → 强制退潮期（连续计数清零、聚簇信息保留）
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
        # 再冰（s <= 25）保持冰点期（聚簇分支已计深度）；回升未确认退退潮期，不允许单日跳高潮期
        if s > _ICE_THRESHOLD:
            new = "uptrend_ready" if st["up_count"] >= 2 else "defense"
    elif cur == "uptrend_ready":
        # 第 3 日仍强才放行（入场必慢 2 日）；确认失败回退潮期
        new = "uptrend" if s >= _UP_THRESHOLD else "defense"
    elif cur == "uptrend":
        if st["saw_peak_70"] and _MID_LOW <= s < _UP_THRESHOLD:
            new = "oscillation"   # 本段曾见极值，回落未崩 → 退潮分歧期
        elif not st["saw_peak_70"] and st["mid_count"] >= 2:
            new = "defense"       # 防卡死：未见过极值的高潮段，双日确认回落即结束
        elif s < _MID_LOW:
            new = "defense"       # 高潮期结束
    elif cur == "oscillation":
        if s < _OSC_EXIT:
            new = "defense"       # 回差设计：45 进 40 出，防边界抖动
        elif st["up_count"] >= 2:
            new = "uptrend_ready"  # 重启确认流程

    if new != cur:
        st["current_state"] = new
        st["last_change_date"] = trade_date
        # 离开高潮期：段内极值标记与本段回落计数清零（跨段不继承）
        if cur == "uptrend":
            st["saw_peak_70"] = False
            st["mid_count"] = 0
    # 段内极值置位（含放行当日：进入高潮期当日本身即属本段，如 08-27 放行日 s=75）
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
             "state_label": "冰点期",          # str，中文标签（摘要行「阶段」字段用）
            "cluster_depth": 2,               # int，冰点聚簇深度
            "days_since_ice": 0,              # int | None，距最近冰点日的交易日数
            "next_day_channel_open": True,    # bool，当日尾盘通道是否开放（预计算字段，只读不自判）
            "updated_date": "2026-09-03",     # str，文件最近一次盘后更新日
            "defensive_reason": None,         # str | None，非空 → 当日按防守处理并记录：
                                              #   "陈旧防御（复盘断档）"（自然日差 > 5）
                                              #   "长假盘中防御"（自然日差 >= 4 且 <= 5）
                                              #   "复盘断档防御"（自然日差 == 2：相邻交易日差只可能是 1/3/>=4，差 2 必为漏复盘）
            "effective_state": "ice_point",   # str，当日实际生效阶段（defensive_reason 非空时为 defense）
            "effective_state_label": "冰点期",  # str，effective_state 的中文标签
        }
        文件缺失 / 损坏 / JSON 解析失败 → {"code": 404, "error": ..., "defensive_reason": ..., "effective_state": "defense"}
    """
    if trade_date is None:
        trade_date = datetime.now().strftime("%Y-%m-%d")
    path = os.path.join(_DATA_DIR, _REGIME_FILE)
    if not os.path.exists(path):
        return {"code": 404, "error": "regime-state.json 不存在，当日按防守处理，复盘时 regime_rebuild 重建",
                "defensive_reason": "状态文件缺失", "effective_state": "defense", "effective_state_label": "退潮期"}
    try:
        with open(path, "r", encoding="utf-8") as f:
            state = json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        return {"code": 404, "error": f"regime-state.json 读取 / 解析失败: {exc}，当日按防守处理",
                "defensive_reason": "状态文件损坏", "effective_state": "defense", "effective_state_label": "退潮期"}
    if "current_state" not in state or "updated_date" not in state:
        return {"code": 404, "error": "regime-state.json 缺少 current_state / updated_date 字段，当日按防守处理",
                "defensive_reason": "状态文件损坏", "effective_state": "defense", "effective_state_label": "退潮期"}

    # 陈旧 / 断档 / 长假盘中防御（自然日差代理，journal 无交易日历）：
    # 相邻交易日自然日差只可能是 1（周内连续）/ 3（周末）/ >=4（长假）——
    # 差 2 必然意味着中间漏了一个交易日复盘；> 5 复盘断档；>= 4 且 <= 5 长假后首个交易日
    defensive_reason = None
    try:
        gap = (datetime.strptime(trade_date, "%Y-%m-%d") - datetime.strptime(state["updated_date"], "%Y-%m-%d")).days
    except ValueError:
        return {"code": 400, "error": f"trade_date {trade_date!r} 或文件 updated_date {state['updated_date']!r} 日期格式非法",
                "defensive_reason": "日期格式异常", "effective_state": "defense", "effective_state_label": "退潮期"}
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

    # 从「退潮期 + 计数清零」盲初始化起点纯函数重放（含序列内相邻日期自然日差 >= 4 的长假重置）
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
