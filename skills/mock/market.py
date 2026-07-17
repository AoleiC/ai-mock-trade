"""
行情查询 SDK

大盘、板块、个股、热点、事件驱动等行情数据的查询入口。
所有接口封装为函数，agent 直接 import 调用即可，无需自行构造 HTTP 请求。

认证与请求基础设施（_BASE_URL / DEFAULT_SECRET_KEY / _get）见 _http.py。
"""

from typing import Optional

from skills.mock._http import _get, _post


# ==================== 一、大盘维度 ====================

# 获取首页大盘指标汇总（指标数组、交易阶段 stage 等）
def get_summary() -> dict:
    """
    获取首页大盘指标汇总

    入参：无

    返回 -> dict（直接返回业务数据，无信封包装）：
        {
            "indicators": list[dict],            # 指标数组，每项含 id/name/span/today/color/yestoday
            "is_trading_day": bool,              # 当前是否交易日
            "is_trading_time": bool,             # 当前是否交易时间
            "next_refresh_at": int | None,       # 下一次应请求的时间戳（秒），None 表示立即刷新
            "trading_sessions": list[dict]       # 当天交易时段 [{"start":"09:30","end":"11:30"}, ...]
            "date": str,                         # 当前日期 YYYY-MM-DD
            "time": str,                         # 当前时间 HH:MM:SS
            "datetime": str,                     # 完整日期时间 YYYY-MM-DD HH:MM:SS
            "weekday": int,                      # 星期几（0=周一，6=周日）
            "stage": str,                        # 当前交易阶段：休市/盘前准备/集合竞价/开盘黄金期/盘中盯盘/午休/尾盘/盘后复盘
            "stage_action": str                  # 阶段对应的 action：none/overnight_review/auction_watch/opening_trade/intraday_monitor/lunch_break/closing/post_close_review
        }

    涨停时间轴已拆为独立接口 `get_zt_timeline()`，本接口不再返回 `zt_list`。

    indicators.color 含义：1=红色（正向），2=绿色（反向）
    """
    return _get("/api/web/summary")


# 获取今日涨停时间轴（盯盘页右上半区使用）
def get_zt_timeline() -> dict:
    """
    获取今日涨停时间轴数据，用于盯盘页右上半区时间轴展示。

    入参：无

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            code: str       - 股票代码
            name: str       - 股票名称
            high_days: str  - 连板数（如 "2连板"），仅涨停且 > 1 板时才有
            zdf: float      - 涨跌幅（%）
            zdt_time: str   - 涨跌停时间 HH:MM
            reason: str     - 涨停原因
            zdt_type: str   - zt（涨停） / dt（跌停） / zb（炸板）
            type: str       - am（上午涨停） / pm（下午涨停） / dt（跌停）
            theme: str      - 所属题材
    """
    return _get("/api/web/zt_timeline")


# 获取指标分时趋势线（平均股价/主力净额/大盘情绪温度等）
def get_indicator_trendline(code: str) -> dict:
    """
    获取指标分时趋势线

    入参：
        code: str（必传）- 指标代码
            pjgj       - 平均股价（当日分时）
            zjln       - 增减量能（当日分时）
            zlje       - 主力净额（当日分时）
            ztjs       - 总涨停数/连板（当日分时，取涨停数）
            dmjs       - 总跌停数/大面（当日分时，取跌停数）
            zbl        - 炸板率（当日分时）
            szjs       - 涨跌比/上涨家数（当日分时）
            temperature - 大盘情绪温度（返回最近 20 天日级趋势，非分时）
                          数据来源为 LLM 分析的 score（0-100）

    返回 -> dict（直接返回业务数据，无信封包装）：
        {
            "labels": list[str],                # 时间标签，如 ["09:30", "09:31", ...]
            "y1": {                             # TrendlineAxis 结构
                "title": str,                   # 轴标题，如 "主力净额"
                "unit": str,                    # 数据单位，如 "亿"
                "data": list[float],            # 按时间顺序排列的数值
                "min": float,                   # data 中的最小值
                "max": float                    # data 中的最大值
            }
        }

    temperature 特殊返回：
        y1.title 固定为 "大盘情绪温度"，unit 为空，
        data 为每日 LLM 分析的 score（0-100），min=0, max=100
        y1.names 为每日对应的标签名称（如 "冰点"、"修复" 等）
    """
    return _get("/api/web/indicator_trendline", {"code": code})


# 获取大盘指标综合分析信息（大盘情绪温度、LLM 推理等）— 已下线，改用 get_summary().indicators + get_indicator_trendline('temperature')


# 获取历史指标矩阵数据（复盘用）
def get_daily_indicators_history(days: int = 30) -> dict:
    """
    获取历史指标矩阵数据（复盘用）

    入参：
        days: int（可选，默认 30）- 查询天数，范围 1-60

    返回 -> dict（信封格式，data 为业务数据）：
        data: {
            "dates": list[str],                 # 日期列表 ["2025-08-25", ...]
            "rows": list[dict],                 # 指标行，每项含 label + values
            "hot_spots": list[dict]             # 每日热点排名行，每项含 rank/label/values
        }
    """
    return _get("/api/web/daily_indicators_history", {"days": days})


# ==================== 二、板块维度 ====================

# 获取热点分类列表
def get_hot_spot_list(
    sort_by: str = "dr_count",
    sort_order: str = "desc",
    limit: int = 20,
) -> dict:
    """
    获取热点分类列表

    入参：
        sort_by: str（可选，默认 "dr_count"）- 排序字段
            avg_zdf  - 平均涨幅
            zt_count - 涨停数
            lb_count - 连板数
            dr_count - 大肉数
        sort_order: str（可选，默认 "desc"）- 排序方向：desc 降序 / asc 升序
        limit: int（可选，默认 20）- 返回数量限制

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            name: str        - 热点分类名称，如 "算力/芯片"
            hot_score: int   - 热度评分
            avg_zdf: float   - 平均涨跌幅（%）
            zt_count: int    - 涨停个股数
            lb_count: int    - 连板个股数
    """
    return _get("/api/web/hot_spot_list", {
        "sort_by": sort_by,
        "sort_order": sort_order,
        "limit": limit,
    })


# 获取热点分类的成分股列表
def get_hot_spot_components(
    name: str,
    sort_by: str = "zdf",
    sort_order: str = "desc",
) -> dict:
    """
    获取热点分类的成分股列表

    入参：
        name: str（必传）- 热点分类名称
        sort_by: str（可选，默认 "zdf"）- 排序字段
            zdf          - 涨跌幅
            price        - 价格
            main_amount  - 主力
            turn_z       - 换手
            market_value - 市值
        sort_order: str（可选，默认 "desc"）- 排序方向

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            stock_code: str   - 股票代码
            stock_name: str   - 股票名称
            price: float      - 当前价格
            zdf: float        - 涨跌幅（%）
    """
    return _get("/api/web/hot_spot_components", {
        "name": name,
        "sort_by": sort_by,
        "sort_order": sort_order,
    })


# 获取热点分类中被淘汰的股票列表
def get_hot_spot_eliminated(name: str) -> dict:
    """
    获取热点分类中被淘汰的股票列表

    入参：
        name: str（必传）- 热点分类名称

    返回 -> dict（信封格式）：
        data: list[dict]，格式同 get_hot_spot_components
    """
    return _get("/api/web/hot_spot_eliminated", {"name": name})


# 获取热点分类的主力资金分时趋势线
def get_hot_spot_trendline(name: str) -> dict:
    """
    获取热点分类的主力资金分时趋势线

    入参：
        name: str（必传）- 热点分类名称

    返回 -> dict（信封格式）：
        data: {
            "hot_spot_name": str,               # 热点分类名称
            "labels": list[str],                # 时间标签
            "main_amount_data": list[float]     # 主力资金数据（按时间顺序）
        }
    """
    return _get("/api/web/hot_spot_trendline", {"name": name})


# 获取热点分类详细信息（融资/主力/成交趋势、龙头个股标签）— 已下线，改用 get_hot_spot_list / get_hot_spot_components / get_hot_spot_trendline


# 获取某日热点分类统计数据（复盘用）
def get_hot_spot_daily_stats(date: Optional[str] = None) -> dict:
    """
    获取某日热点分类统计数据（复盘用）

    入参：
        date: str（可选，默认最近交易日）- 交易日期，格式 YYYY-MM-DD

    返回 -> dict（信封格式）：
        data: list[dict]，每项含 hot_spot_name/score/rank/zt_count 等
    """
    params = {}
    if date:
        params["date"] = date
    return _get("/api/web/hot_spot_daily_stats", params)


# 批量获取多日热点分类统计数据（趋势分析用）
def get_hot_spot_daily_stats_batch(
    name: str,
    days: int = 10,
) -> dict:
    """
    批量获取多日热点分类统计数据（趋势分析用）

    入参：
        name: str（必传）- 热点分类名称
        days: int（可选，默认 10）- 查询天数

    返回 -> dict（信封格式）：
        data: list[dict]，每项含 trade_date/hot_spot_name/zt_count 等
    """
    return _get("/api/web/hot_spot_daily_stats_batch", {"name": name, "days": days})


# 获取某日排名前 N 的热点分类
def get_top_hot_spots(
    date: Optional[str] = None,
    limit: int = 10,
) -> dict:
    """
    获取某日排名前 N 的热点分类

    入参：
        date: str（可选，默认最近交易日）- 交易日期，格式 YYYY-MM-DD
        limit: int（可选，默认 10）- 返回数量，范围 1-100

    返回 -> dict（信封格式）：
        data: list[dict]，每项含 hot_spot_name/rank/score 等
    """
    params = {"limit": limit}
    if date:
        params["date"] = date
    return _get("/api/web/top_hot_spots", params)


# 获取热点分类在指定日期的成分股历史快照
def get_hot_spot_components_by_date(name: str, date: str) -> dict:
    """
    获取热点分类在指定日期的成分股历史快照

    入参：
        name: str（必传）- 热点分类名称
        date: str（必传）- 交易日期，格式 YYYY-MM-DD

    返回 -> dict（信封格式）：
        data: list[dict]，格式同 get_hot_spot_components
    """
    return _get("/api/web/hot_spot_components_by_date", {"name": name, "date": date})


# ==================== 三、个股维度 ====================

# 获取个股详情信息（名称、代码、市值、换手率、热点标签、涨停原因等）
def get_stock_info(stock_code: str) -> dict:
    """
    获取个股详情信息（名称、代码、市值、换手率、热点标签、涨停原因等）

    入参：
        stock_code: str（必传）- 股票代码（纯数字，如 "603019"）

    返回 -> dict（直接返回结构化业务数据，无信封包装）：
        {
            "name": str,                # 股票名称
            "code": str,                # 股票代码
            "price": float | None,      # 当前价格（元）
            "zdf": float | None,        # 涨跌幅（%）
            "turn_z": float | None,     # 自由换手率（%）
            "value_z": float | None,    # 自由市值（元）
            "amount": float | None,     # 成交额（元）
            "hot_categories": list[str],     # 关联热点分类名称（可点击跳转）
            "hot_category_identities": dict, # 各热点分类对应的身份
                # key: 热点名称（与 hot_categories 元素一一对应）
                # value: "龙头" | "中军" | "自选" | "跟风" | "候选" | "龙头退位" | "中军退位" | ""
                # 未在 hot_spot_stock 表收录时为 ""
            "yd_tags": list[str],       # 异动/涨停标签（不可点击）
            "up_reason": str | None,    # 涨停原因文本（不可点击）
        }

    字段可能为 None（无 NowStock 实时数据时），调用方需按 None 显示占位。
    """
    return _get("/api/web/stock_info", {"code": stock_code})


# 获取日 K 线数据
def get_daily_k_data(code: str, days: int = 30) -> list[dict]:
    """
    获取日 K 线数据

    入参：
        code: str（必传）- 股票代码
        days: int（可选，默认 30）- 查询天数

    返回 -> list[dict]（直接返回，无信封包装）：
        每项含：
            date: str      - 日期，如 "2025-08-25"
            open: float    - 开盘价
            close: float   - 收盘价
            high: float    - 最高价
            low: float     - 最低价
            volume: int    - 成交量
            amount: float  - 成交额
            zdf: float     - 涨跌幅（%）
    """
    return _get("/api/web/daily_k_data", {"scene": "stock", "code": code, "days": days})


# 获取个股当日分时趋势线
def get_stock_trendline(code: str) -> dict:
    """
    获取个股当日分时趋势线

    入参：
        code: str（必传）- 股票代码

    返回 -> dict（信封格式）：
        data: {
            "stock_code": str,                  # 股票代码
            "stock_name": str,                  # 股票名称
            "labels": list[str],                # 时间标签
            "zdf_data": list[float]             # 涨跌幅数据（按时间顺序）
        }
    """
    return _get("/api/web/stock_trendline", {"code": code})


# 获取个股分时趋势线（多轴：涨跌幅 + 主力资金）
def get_stock_minute_trendline(code: str) -> dict:
    """
    获取个股分时趋势线（多轴：涨跌幅 + 主力资金）

    入参：
        code: str（必传）- 股票代码

    返回 -> dict（直接返回业务数据，无信封包装）：
        {
            "labels": list[str],                # 时间标签
            "y1": {                             # TrendlineAxis 结构 - 涨跌度
                "title": "涨跌度",
                "unit": "%",
                "data": list[float],
                "min": float,
                "max": float
            },
            "y2": {                             # TrendlineAxis 结构 - 主力资金
                "title": "主力",
                "unit": "亿",
                "data": list[float],
                "min": float,
                "max": float
            }
        }
    """
    return _get("/api/web/minute_trendline", {"scene": "stock", "code": code})


# 获取个股历史分时趋势线（复盘用）
def get_stock_trendline_history(code: str, date: str) -> dict:
    """
    获取个股历史分时趋势线（复盘用）

    入参：
        code: str（必传）- 股票代码
        date: str（必传）- 交易日期，格式 YYYY-MM-DD

    返回 -> dict（信封格式）：
        data: {
            "stock_code": str,                  # 股票代码
            "stock_name": str,                  # 股票名称
            "trade_date": str,                  # 交易日期
            "labels": list[str],                # 时间标签
            "zdf_data": list[float]             # 涨跌幅数据
        }
    """
    return _get("/api/web/stock_trendline_history", {"code": code, "date": date})


# 获取某日连板股列表
def get_lianban_stocks(
    date: Optional[str] = None,
    limit: int = 200,
) -> dict:
    """
    获取某日连板股列表

    入参：
        date: str（可选，默认最近交易日）- 交易日期，格式 YYYY-MM-DD
        limit: int（可选，默认 200）- 返回数量限制，最大 500

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            stock_code: str    - 股票代码
            stock_name: str    - 股票名称
            up_count: int      - 连板天数
            up_reason: str     - 涨停原因
            zdf: float         - 涨跌幅（%）
    """
    params = {"limit": limit}
    if date:
        params["date"] = date
    return _get("/api/web/lianban_stocks", params)


# 获取某只股票近 N 个交易日的 daily_stock 完整行情数据（复盘用）
def get_stock_daily_history(code: str, days: int = 5) -> dict:
    """
    获取某只股票近 N 个交易日的 daily_stock 完整行情数据（复盘用）

    数据来源：daily_stock 表，按 stock_code 过滤 + trade_date 倒序取前 N 条。
    用于复盘页个股浮动面板，展示该股最近 N 天日级全量字段：
    开高低收、量价、换手、涨跌幅、MA5/10/20/30 均线、主力资金（开+收）、
    涨跌停封单/封成比、涨跌停时间戳等。

    入参：
        code: str（必传）- 股票代码（纯数字，如 "603019"）
        days: int（可选，默认 5）- 查询最近的交易日天数，范围 1-30

    返回 -> dict（信封格式）：
        data: list[dict]，按 trade_date 倒序（最近一天在前），每项含：
            # 基础信息
            stock_code: str
            stock_name: str
            trade_date: str                  # YYYY-MM-DD
            trade_time: int                  # 当日时间戳
            # 价格/成交
            open: float | int               # 开盘价
            close: float | int              # 收盘价
            high: float | int               # 最高价
            low: float | int                # 最低价
            volume: int                     # 成交量（股）
            change: float | int             # 涨跌额（元）
            pre_close: float | int          # 昨收（元）
            # 市值/涨跌幅
            value_z: int                    # 自由市值（元）
            zdf_high: float | int           # 最高涨跌幅（%）
            zdf_low: float | int            # 最低涨跌幅（%）
            # MA 均线（ma5/ma10/ma20/ma30 各自的 avg_price 和 volume）
            ma5_avg_price: float | int
            ma5_volume: int
            ma10_avg_price: float | int
            ma10_volume: int
            ma20_avg_price: float | int
            ma20_volume: int
            ma30_avg_price: float | int
            ma30_volume: int
            # 开盘指标（turn_o 换手%, zdf_o 涨跌幅%, 其余为元）
            turn_o: float | int
            zdf_o: float | int
            amount_o: int
            amount_main_o: int              # 开盘主力净流入
            amount_main_jingong_o: int      # 开盘主力主买进攻
            amount_main_hupan_o: int        # 开盘主力被买护盘
            amount_main_yapan_o: int        # 开盘主力被卖压盘
            amount_main_zapan_o: int        # 开盘主力主卖砸盘
            # 收盘指标（字段命名同开盘，_c 后缀）
            turn_c: float | int
            zdf_c: float | int
            amount_c: int
            amount_main_c: int
            amount_main_jingong_c: int
            amount_main_hupan_c: int
            amount_main_yapan_c: int
            amount_main_zapan_c: int
            # 涨跌停
            zdt_amount_max: int             # 最大涨跌停封单金额
            zdt_volume_max: int             # 最大涨跌停封单量
            zdt_ratio_max: float | int      # 最大涨跌停封成比（%）
            zdt_amount_c: int               # 收盘涨跌停封单金额
            zdt_volume_c: int               # 收盘涨跌停封单量
            zdt_ratio_c: float | int        # 收盘涨跌停封成比（%）
            zdt_flag: int                   # 0/1 涨停/2 跌停
            zdt_type: int                   # 涨跌停类型（100-203）
            zdt_time: int | None            # 首次涨跌停时间戳
            zdt_time_end: int | None        # 涨跌停最后回封时间戳
    """
    return _get("/api/web/stock_daily_history", {"code": code, "days": days})


# 获取当天成交额前 30 的个股
def get_amount_top() -> dict:
    """
    获取当天成交额前 30 的个股

    入参：无

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            stock_code: str      - 股票代码
            stock_name: str      - 股票名称
            zdf: float           - 涨跌幅（%）
            amount: str          - 成交额（已格式化，如 "125.5亿"）
            main_amount: str     - 主力净额（已格式化，如 "2.3亿"）
            turn_z: float        - 自由换手率（%）
            intraday: list[float] - 当日分时涨跌幅序列（按时间正序）
    """
    return _get("/api/web/amount_top")


# 获取大市值高涨幅个股（涨跌各返回）
def get_large_cap_stocks() -> dict:
    """
    获取大市值高涨幅个股（涨跌各返回）

    筛选条件：自由流通市值 > 200 亿，涨幅绝对值 > 3%，主力净流入/出 > 5000 万

    入参：无

    返回 -> dict（信封格式）：
        data: {
            "up": list[dict],                   # 大涨个股，每项含 stock_code/stock_name/zdf/amount_main(float)
            "down": list[dict]                  # 大跌个股，每项含 stock_code/stock_name/zdf/amount_main(float)
        }

    注意：data 是 dict（含 up/down 两个 list），不是 list
    """
    return _get("/api/web/large_cap_stocks")


# 获取主力净流出前 20 的个股
def get_main_outflow_top() -> dict:
    """
    获取主力净流出前 20 的个股

    入参：无

    返回 -> dict（信封格式）：
        data: list[dict]，每项含 stock_code/stock_name/zdf(float)/main_amount(str)
    """
    return _get("/api/web/main_outflow_top")


# 获取策略趋势股列表
def get_strategy_trend_stocks(
    strategy_id: int,
    mode: str = "",
    limit: int = 30,
) -> dict:
    """
    获取策略趋势股列表

    入参：
        strategy_id: int（必传）- 策略 ID
            6 - 创业板趋势股（强趋势：10 日内涨幅 > 7%）
            7 - 沪深主板趋势股（强趋势：10 日内涨幅 > 7%）
            8 - 近期涨幅巨大
            10 - 创业+科创板大趋势（涨幅 > 3% 且 15 日内 > 9%，覆盖创业+科创板）
        mode: str（可选，默认 ""）- 数据模式
            ""           - 策略选股（默认）
            "amount_top" - 成交额排名前 N
        limit: int（可选，默认 30）- 返回数量上限

    返回 -> dict（信封格式）：
        data: list[dict]，每项含 stock_code/stock_name/zdf/price/turn_z/
              amount(str)/main_amount(str)/intraday(list[float])
    """
    return _get("/api/web/strategy_trend_stocks", {
        "strategy_id": strategy_id,
        "mode": mode,
        "limit": limit,
    })


# 获取小时热度榜前 30 的个股
def get_hourly_hot_top(sort_by: str = "rank") -> dict:
    """
    获取小时热度榜前 30 的个股

    入参：
        sort_by: str（可选，默认 "rank"）- 排序字段
            rank         - 热度排名
            zdf          - 涨幅
            amount_main  - 主力

    返回 -> dict（信封格式）：
        data: list[dict]，每项含 stock_code/stock_name/zdf(float)/main_amount(str)
    """
    return _get("/api/web/hourly_hot_top", {"sort_by": sort_by})


# 获取近 11 个交易日的重点监控异动股名单（**禁买名单**）
def get_key_watch_stocks() -> dict:
    """
    获取近 11 个交易日的重点监控异动股名单（**禁买名单**）

    数据来源：daily_unusual_fluctuate 表（东方财富 RPT_WATCH_UNUSUAL_FLUCTUATE），
    同时取已发生的严重异动（is_happen=1）与即将发生的预期异动（is_happen=0）。
    这些个股短期累计涨幅已触发或即将触发监管异动规则，
    存在核查停牌、特停、监管函等不确定风险，**禁止买入**（详见 trading-mindset.md §1.1）。

    入参：无

    返回 -> dict（信封格式）：
        data: list[dict]，按交易日倒序、同交易日内涨幅倒序，每项含：
            stock_code: str          - 股票代码
            stock_name: str          - 股票名称
            zdf: float               - 触发当日涨跌幅（%）
            is_happen: int           - 是否已发生：1=已发生异动，0=预期即将发生异动
            change_rate_target: float - 距触发严重异动还差涨幅（%），预期记录的异动上限
            trade_date: str          - 触发交易日（YYYY-MM-DD）
            trade_date_short: str    - 触发交易日（MM-DD，仅月日）
    """
    return _get("/api/web/key_watch_stocks")


# 获取主力净流入前 20 的个股
def get_main_inflow_top() -> dict:
    """
    获取主力净流入前 20 的个股

    入参：无

    返回 -> dict（信封格式）：
        data: list[dict]，每项含 stock_code/stock_name/zdf(float)/main_amount(str)
    """
    return _get("/api/web/main_inflow_top")


# 获取近四日连板天梯数据
def get_consecutive_board_ladder(end_date: Optional[str] = None) -> dict:
    """
    获取近四日连板天梯数据

    按连板层级（高位 / 三板 / 二板 / 首板一字板）× 日期排列，
    单元格内含个股详情：股票代码、名称、涨跌幅、所属板块、涨停分组。
    涨跌幅优先使用实时 NowStock 数据；非交易日取最近四个交易日历史数据。

    入参：
        end_date: str（可选，默认 None）- 截止交易日期（YYYY-MM-DD），
                  缺省时以最近一个交易日为终点向前取 4 个交易日

    返回 -> dict（信封格式）：
        data: {
            "dates": list[str],                # 日期标签（升序），如 ["05-28", "05-29", ...]
            "rows": list[dict]                 # 连板层级行，每项：
                #   level: int                  # 连板层级（>=4 表示高位）
                #   level_name: str             # 层级名（"高位"/"三板"/"二板"/"首板"）
                #   columns: list[list[dict]]   # 与 dates 一一对应的列
            }
        }
    """
    params = {}
    if end_date:
        params["end_date"] = end_date
    return _get("/api/web/consecutive_board_ladder", params)


# 获取近三天热点分类中出现过涨停的所有股票
def get_hot_spot_zt_stocks() -> dict:
    """
    获取近三天热点分类中出现过涨停的所有股票

    数据来源：近 3 个交易日的 daily_stock_up_ths（zdt_type == 'zt'），
    关联 hot_spot_stock 获取所属热点分类，并批量取实时涨跌幅。
    只保留热点分类内涨停股 > 8 的分组，按数量降序最多返回 10 个分类。

    入参：无

    返回 -> dict（信封格式）：
        data: list[dict]，每项：
            hot_spot_name: str                 # 热点分类名称
            stocks: list[dict]                 # 成分股，按 zdf 倒序，含 stock_code/stock_name/zdf
            avg_zdf: float                     # 组内平均涨跌幅
            count: int                         # 涨停股数量
    """
    return _get("/api/web/hot_spot_zt_stocks")


# 获取近 N 日热点轮动数据
def get_hot_spot_rotation(days: int = 5, top_n: int = 9) -> dict:
    """
    获取近 N 日热点轮动数据（按板块涨停数 + 大肉数排序）

    数据来源：HotSpotDailyStats 表，每天取 (zt_count + dr_count) 最高的 top_n 个板块。

    入参：
        days: int（可选，默认 5）- 查询最近交易日天数，范围 1-10
        top_n: int（可选，默认 9）- 每天取排名前 N 的板块

    返回 -> dict（信封格式）：
        data: {
            "dates": list[str],            # 日期列表（从旧到新），如 ["06-08", "06-09"]
            "rank_labels": list[int],      # 排名标签，如 [1, 2, 3, ...]
            "cells": list[list[dict]]      # 每行一个排名，每列一个日期
                # 每个元素含 name/score/zt_count/dr_count/all_avg_zdf
        }
    """
    return _get("/api/web/hot_spot_rotation", {"days": days, "top_n": top_n})


# 获取最新一条盘中 LLM 盘面分析结果
def get_intraday_analysis() -> dict:
    """
    获取最新一条盘中 LLM 盘面分析结果（agent 盘面分析的唯一权威源）

    数据来源：intraday_llm_analysis 表，按 id 倒序取第一条。
    分析由 compute_intraday_analysis.py 计算并写入。
    LLM 已从大盘情绪温度、短线情绪温度、资金方向、热点轮动等方面做综合评估，
    agent 应围绕本接口返回的字段执行盯盘/选股/交易，**不再自行计算或对照硬阈值**。

    入参：无

    返回 -> dict（信封格式）：
        data: dict | None
        # 当 data 为 None 或 status="failed" 时，agent 应输出"LLM 分析缺位，无法判定"并跳过本轮

    ====== 顶层字段 ======
        # 必用字段（实测 100% 返回）
        id: int
        trade_date: str                              # YYYY-MM-DD
        analyze_time: str                            # HH:MM
        status: str                                  # "success" / "failed"
        error_message: str                           # 失败原因（成功时为空串）
        temperature_score: int                       # 大盘情绪温度分值（0-100）
        temperature_label: str                       # 大盘情绪阶段标签（冰点/退潮/修复/升温/高潮/降温）
        temperature_reasoning: str                   # 温度推理原文
        attack_directions: list[DirectionDict]       # 顶层进攻方向（用于交叉验证，**不直接选股**）
        retreat_directions: list[DirectionDict]      # 顶层撤退方向
        sentiment_analysis: SentimentDict            # 短线情绪温度分析
        capital_analysis: CapitalDict                # 资金面分析
        final_analysis: FinalDict                    # 最终汇总分析（含 position_limit）
        hot_rotation_analysis: HotRotationDict       # 热点轮动分析
        model_used: str                              # 使用的 LLM 模型名

        # 可选字段（历史表结构有，但部分记录缺位；agent 不消费）
        concept_hype: list | dict | str | None       # 概念炒作方向 — 已不在 API 响应中，agent 忽略

    ====== DirectionDict（attack_directions / retreat_directions 共用结构）======
        {
            "direction": str,                        # 方向名，如"算力/CPO/AI算力基础设施"
            "stocks": [                              # 关联个股列表
                {
                    "name": str,                     # 股票名称
                    "code": str,                     # 股票代码（纯数字）—— 极少数情况为空串，如"京东方A"
                    "reason": str                    # 入选原因
                }
            ],
            "evidence": str                          # 入选证据（多源数据汇总）
        }

    ====== SentimentDict（sentiment_analysis）======
        {
            "sentiment_label": str,                  # 短线情绪温度（激进/偏激进/中性/偏保守/保守）—— **仓位主锚**
            "confidence": str,                       # LLM 置信度（高/中/低）
            "sentiment_score": int,                  # 短线情绪分值（0-100）
            "reasoning": str,                        # 推理原文
            "key_signals": [                         # 关键信号列表
                {
                    "signal": str,                   # 信号描述
                    "direction": str,                # 看多/看空/中性
                    "strength": str                  # 强/中/弱
                }
            ]
        }

    ====== CapitalDict（capital_analysis）======
        {
            "attack_directions": [DirectionDict, ...],     # 资金进攻方向（带 persistence 字段）
            "retreat_directions": [DirectionDict, ...],    # 资金撤退方向
            "capital_flow_summary": str,                   # 资金面总结
            "institutional_signal": str                    # 机构资金信号
        }
        # 注：DirectionDict 在 capital_analysis 里每项额外有 "persistence": str（强/中/弱）

    ====== FinalDict（final_analysis）—— agent 决策核心 =====
        {
            "market_overview": str,                        # 盘面综述
            "sentiment_capital_alignment": str,            # 共振/警惕/撤退
            "attack_directions": [DirectionDict, ...],     # 本期确认的进攻方向（**主用**）
            "retreat_directions": [DirectionDict, ...],    # 本期确认的撤退方向（**主用**）
            "position_limit": int,                         # **当日仓位上限（0-100）—— 直接采用，不自行调档**
            "position_reasoning": str,                     # 仓位建议理由（仅供日志）
            "vs_prev_analysis": str,                       # 与上次分析的差异
            "action_advice": str,                          # **操作建议 —— 必读**
            "risk_warnings": [str, ...]                    # 风险提示列表
        }

    ====== HotRotationDict（hot_rotation_analysis）—— 盘中即时决策 =====
        {
            "snapshot_time": str,                          # 盘中快照时间点（如 10:30/14:00）
            "attack_sectors": [                            # 资金正在进攻的方向（最多 3 个，按强度排序）
                {
                    "sector": str,                         # 板块名
                    "intensity": str,                      # 强/中/弱
                    "quality": str,                        # 大票共振/游资主导/机构配置/小票乱涨
                    "catalyst": str,                       # 今日催化事件（50 字内）
                    "trade_implication": str,              # 即时动作：可追/可低吸/观察
                    "today_zt": int,                       # 今日涨停数（可选）
                    "today_inflow": str,                   # 今日主力净流入（可选，如 +15亿）
                    "today_big_face": int,                 # 今日大肉家数（可选）
                    "key_stocks": [str, ...],              # 龙头股名称列表（可选）
                    "evidence": str                        # 反复活跃+热点效应的数据证据
                }
            ],
            "retreat_sectors": [                           # 资金正在撤退的方向（最多 3 个）
                {
                    "sector": str,                         # 板块名
                    "retreat_evidence": str,               # 主力流出/涨停骤降/大面扩散的具体数据
                    "risk_level": str                      # 板块内风险/可能蔓延
                }
            ],
            "emerging_sectors": [                          # 新冒头方向（最多 2 个，只观察不参与）
                {
                    "sector": str,                         # 板块名
                    "signal": str,                         # 今日新出现的涨停/流入信号
                    "watch_reason": str                    # 为什么值得观察
                }
            ],
            "market_structure": str,                       # 市场结构：健康/分散/混沌/退潮（描述当下状态，不预测）
            "instant_conclusion": str                      # 即时结论（100 字内，结论先行）
        }

    ====== 字段缺位判定标准 ======
        - data is None .......................... 无 LLM 分析记录（未运行 / 计算失败）
        - data["status"] == "failed" ........... LLM 分析失败，看 error_message
        - data["final_analysis"] is None ....... 汇总缺失（部分场景）
        - data["final_analysis"]["position_limit"] is None ... LLM 未给仓位建议（极少见）
        - 任一必用字段为 None / 空列表 / 空字符串 → 输出"该字段为空，无法判定"并跳过依赖该字段的判定

    ====== 嵌套路径速查（agent 调用示例）======
        data["temperature_score"]                                  # 大盘温度分值
        data["temperature_label"]                                  # 大盘温度标签
        data["sentiment_analysis"]["sentiment_label"]               # 短线情绪（仓位主锚）
        data["final_analysis"]["position_limit"]                    # 当日仓位上限（必用）
        data["final_analysis"]["position_reasoning"]               # 仓位理由（日志）
        data["final_analysis"]["sentiment_capital_alignment"]       # 共振/警惕/撤退
        data["final_analysis"]["action_advice"]                    # 操作建议（必读）
        data["final_analysis"]["risk_warnings"]                    # 风险提示列表
        data["final_analysis"]["attack_directions"]                # 进攻方向
        data["final_analysis"]["retreat_directions"]               # 撤退方向
        data["hot_rotation_analysis"]["attack_sectors"]             # 资金进攻方向（活跃方向来源之一）
        data["hot_rotation_analysis"]["retreat_sectors"]            # 资金撤退方向
        data["hot_rotation_analysis"]["market_structure"]           # 市场结构（健康/分散/混沌/退潮）
        data["capital_analysis"]["capital_flow_summary"]           # 资金面总结
        data["capital_analysis"]["institutional_signal"]            # 机构资金信号
    """
    return _get("/api/web/intraday_analysis")


# 批量获取多只股票的实时涨跌幅
def get_batch_stock_zdf(codes: str) -> dict:
    """
    批量获取多只股票的实时涨跌幅

    入参：
        codes: str（必传）- 逗号分隔的股票代码列表，如 "000001,000002,600000"

    返回 -> dict（信封格式）：
        data: dict[str, float]，key 为股票代码，value 为涨跌幅（%）
    """
    return _get("/api/web/batch_stock_zdf", {"codes": codes})


# 获取"今天炒什么"近 N 个交易日的事件列表
def get_jtcsm_events(days: int = 1, limit: int = 30) -> dict:
    """
    获取"今天炒什么"近 N 个交易日的事件列表（按热度倒序）

    数据来源：DailyJtcsmEvent（主表）+ DailyJtcsmEventStock（子表）。

    入参：
        days: int（可选，默认 1）- 查询最近的交易日天数，范围 1-10
        limit: int（可选，默认 30）- 单日最大返回事件数，范围 1-100

    返回 -> dict（信封格式）：
        data: {
            "dates": list[str],          # 日期列表（升序），如 ["2026-06-10"]
            "events": list[dict]         # 事件列表，每项含：
                #   event_id: str           事件 ID
                #   title: str              事件标题
                #   investment_direction: str 投资方向
                #   heat: float             热度值（万单位）
                #   trade_date: str         交易日期
                #   summary: str            事件详情摘要（来自 detail 接口，可能为空）
                #   stocks: list[dict]      关联个股列表，每项含 stock_code/stock_name/
                #                           rise_percent/limit_up_state/reason/
                #                           show_name(子分类，多题材用 / 拼接)
        }
    """
    return _get("/api/web/jtcsm_events", {"days": days, "limit": limit})


# 获取"今天炒什么"事件关联个股在事件当天的行情快照
def get_jtcsm_event_stocks(event_id: str, date: str) -> dict:
    """
    获取"今天炒什么"事件关联个股在事件当天的行情快照

    数据来源：DailyJtcsmEventStock（按 trade_date + event_id 取关联股票 + 子分类 show_name）
             + 当天走 NowStock 实时行情，历史走 DailyStock 收盘快照。

    入参：
        event_id: str（必传）- 事件 ID
        date: str（必传）- 事件交易日，格式 YYYY-MM-DD

    返回 -> dict（信封格式）：
        data: list[dict]，按涨幅降序，每项含：
            stock_code: str          - 股票代码
            stock_name: str          - 股票名称
            price: float             - 价格（当天实时 / 历史收盘）
            zdf: float               - 涨跌幅（%）
            main_amount: str         - 主力资金（已格式化，如 "2.3亿"）
            market_value: str        - 自由市值（已格式化，如 "450.5亿"）
            turn_z: float            - 换手率（%）
            show_name: str           # 子分类（事件维度题材，子表 show_name）
            hot_categories: str      - 股票自身相关分类（now_stock / base_stock）
    """
    return _get("/api/web/jtcsm_event_stocks", {"event_id": event_id, "date": date})


# 获取个股近 N 个交易日命中的"今天炒什么"投资方向列表
def get_stock_jtcsm_directions(code: str, days: int = 5) -> dict:
    """
    获取个股近 N 个交易日命中的"今天炒什么"投资方向（概念）列表

    数据来源：DailyJtcsmEventStock（按 stock_code + 近 N 个交易日定位命中事件）
             + DailyJtcsmEvent（反查 investment_direction 投资方向）。

    用于个股浮动面板右侧上部，展示该股近期被关联到的"今日炒什么"概念。

    入参：
        code: str（必传）- 股票代码
        days: int（可选，默认 5）- 查询交易日天数，范围 1-30

    返回 -> dict（信封格式）：
        data: list[dict]，按代表事件热度倒序，每项含：
            investment_direction: str - 投资方向（概念名称）
            event_id: str             - 代表事件 ID（最近日期 + 最高热度，用于精确查询个股列表）
            heat: float               - 代表事件热度（万单位）
            trade_date: str           - 最近命中日期 YYYY-MM-DD
            title: str                - 代表事件标题
    """
    return _get("/api/web/stock_jtcsm_directions", {"code": code, "days": days})


# 获取指定"今天炒什么"事件包含的个股列表（关联实时行情）
def get_jtcsm_direction_stocks(event_id: str, exclude_code: str = "") -> dict:
    """
    获取指定"今天炒什么"事件包含的个股列表（关联实时行情）

    数据来源：DailyJtcsmEventStock（按 event_id 精确定位单个事件关联个股）
             + NowStock（关联实时涨跌幅、主力资金）。

    用于个股浮动面板右侧下部，点击概念标签切换个股列表。
    按 event_id 查询单事件，天然避免按概念名称反查多事件导致的个股重复；
    子表内"同股不同题材"按 stock_code 去重，仅保留首条。

    入参：
        event_id: str（必传）- 事件 ID（概念标签携带的代表事件 ID）
        exclude_code: str（可选，默认 ""）- 需排除的股票代码（当前查看个股）

    返回 -> dict（信封格式）：
        data: list[dict]，按今日涨跌幅降序（None 排末尾），每项含：
            stock_code: str          - 股票代码
            stock_name: str          - 股票名称
            zdf: float | None        - 今日涨跌幅（%）
            main_amount: str         - 主力资金（已格式化，无数据为 "--"）
            main_amount_raw: float   - 主力资金原始值（元）
            turn_z: float | None     - 自由换手率（%）
            price: float | None      - 当前价格
            show_name: str           # 子分类（事件维度题材）
    """
    params = {"event_id": event_id}
    if exclude_code:
        params["exclude_code"] = exclude_code
    return _get("/api/web/jtcsm_direction_stocks", params)


# ==================== 四、主题维度（主题体系） ====================

# 获取个股命中的"主题"标签列表
def get_stock_theme_tags(code: str) -> dict:
    """
    获取个股命中的"主题"标签列表

    数据来源：BaseThemeStock（按 stock_code 反查所属一级 / 二级主题）。

    入参：
        code: str（必传）- 股票代码（纯数字，如 "603019"）

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            theme_type: str   - 标签层级，"1"=一级主题 / "2"=二级主题
            level1_code: str  - 一级主题代码
            level2_code: str  - 二级主题代码（仅二级标签非空，一级标签为空串）
            theme_name: str   - 展示名称（一级仅一级名，二级为"一级名/二级名"组合）
            hot_num: int      - 主题人气值
    """
    return _get("/api/web/stock_theme_tags", {"code": code})


# 获取某个主题（一级或二级）下的关联个股列表（关联实时行情）
def get_theme_stocks(
    theme_code: str,
    level2_code: str = "",
    limit: int = 15,
) -> dict:
    """
    获取指定主题下的关联个股列表（关联实时行情）

    入参：
        theme_code: str（必传）- 一级主题代码（level1_code）
        level2_code: str（可选，默认 ""）- 二级主题代码，空则按一级反查全部，传值则精确反查该二级
        limit: int（可选，默认 15）- 返回数量上限，合法范围 [0, 50]，越界自动收敛

    返回 -> dict（信封格式）：
        data: list[dict]，按涨跌幅降序，每项含：
            stock_code: str       - 股票代码
            stock_name: str       - 股票名称
            zdf: float            - 今日涨跌幅（%）
            main_amount: str      - 主力资金（已格式化，如 "2.3亿"）
            main_amount_raw: float - 主力资金原始值（元）
            turn_z: float         - 自由换手率（%）
            price: float          - 当前价格
            amount: str           - 成交额（已格式化）
            amount_raw: float     - 成交额原始值（元）
            market_value: str     - 自由市值（已格式化）
            intraday: list[float] - 当日分时涨跌幅序列（绘制缩略曲线）
    """
    params = {"theme_code": theme_code, "level2_code": level2_code, "limit": limit}
    return _get("/api/web/theme_stocks", params)


# 获取主题看板的主题列表（按指定字段倒序，取前 N 个主题）
def get_hot_theme_list(
    limit: int = 20,
    level_only: bool = True,
    sort_field: str = "dr_count",
    keyword: str = "",
    sort_order: str = "",
) -> dict:
    """
    获取主题看板的主题列表（按指定字段倒序，取前 limit 个主题）

    入参：
        limit: int（可选，默认 20）- 主题数量上限，合法范围 [1, 50]，越界自动收敛
        level_only: bool（可选，默认 True）- 是否仅显示一级分类，True 仅一级，False 含一级 + 二级
        sort_field: str（可选，默认 "dr_count"）- 排序字段，白名单：
            dr_count        - 大肉数（涨超 8%）
            dm_count        - 大面数（跌超 8%）
            zt_count        - 涨停数
            dt_count        - 跌停数
            zdf_avg         - 涨幅
            zdf_avg_asc     - 跌幅
            amount_main     - 主力净流入
            amount_main_asc - 主力净流出
            非法值回退为 "dr_count"
        keyword: str（可选，默认 ""）- 主题名称搜索关键词，空则不过滤
        sort_order: str（可选，默认 ""）- 排序方向覆盖，"asc" 升序 / "desc" 降序，
            空 表示沿用 sort_field 的默认方向；仅对标准 key 生效，*_asc key 不受影响

    返回 -> dict（信封格式）：
        data: list[dict]，每个元素含：
            code: str          - 主题代码
            name: str          - 展示名称
            level: int         - 层级，1=一级 / 2=二级
            level1_code: str   - 一级主题代码（仅二级非空，用于挂载子级）
            zdf_dr_count: int  - 大肉数（涨超 8%）
            zdf_dm_count: int  - 大面数（跌超 8%）
            zt_count: int      - 涨停数
            dt_count: int      - 跌停数
            zdf_avg: str       - 平均涨幅（已格式化，如 "1.2%"）
            amount_main: str   - 主力资金净流入（已格式化，如 "2.3亿"）
            stock_count: int   - 成分股数量
            children: list     - 子级主题数组（level_only=True 时为空数组）
    """
    return _get("/api/web/hot_theme_list", {
        "limit": limit,
        "level_only": level_only,
        "sort_field": sort_field,
        "keyword": keyword,
        "sort_order": sort_order,
    })


# 获取指定主题下的个股列表（结构化数据 + 分时曲线，支持排序与搜索）
def get_theme_stock_list(
    code: str,
    field: str = "zdf",
    sort: str = "desc",
    limit: int = 15,
    keyword: str = "",
) -> dict:
    """
    获取指定主题下的关联个股列表（主题看板 stock-list 卡片数据）

    入参：
        code: str（必传）- 主题代码（一级主题 code，按前缀反查 BaseThemeStock）
        field: str（可选，默认 "zdf"）- 排序字段，白名单：
            zdf          - 涨幅
            amount_main  - 主力
            非法值回退为 "zdf"
        sort: str（可选，默认 "desc"）- 排序方向，"desc" 降序 / "asc" 升序，非法值回退 "desc"
        limit: int（可选，默认 15）- 返回个股数量上限，合法范围 [0, 50]，越界自动收敛
        keyword: str（可选，默认 ""）- 个股搜索关键词，非空时仅返回名称/代码命中的个股

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            stock_code: str       - 股票代码
            stock_name: str       - 股票名称
            zdf: float            - 涨跌幅（%）
            main_amount: str      - 主力金额（已格式化）
            main_amount_raw: float - 主力金额原始值（元）
            turn_z: float         - 换手率（%）
            price: float          - 当前价格
            intraday: list[float] - 当日分时涨跌幅序列（绘制缩略曲线）
    """
    return _get("/api/web/theme_stock_list", {
        "code": code,
        "field": field,
        "sort": sort,
        "limit": limit,
        "keyword": keyword,
    })


# ==================== 五、选股维度 ====================

# 自然语言选股（LLM 解析 → DSL → 多条件分组交集）
def nl_pick(query: str, secret_key: str = None) -> dict:
    """
    自然语言选股

    用 LLM 把自然语言选股描述解析为结构化条件 DSL，按 basic/ma/window/concept 四组执行
    各组命中股票，再取四组交集得到最终选股结果（关联 now_stock 实时行情）。
    仅 A 股选股场景，超长或越狱意图会被服务端拒绝。

    入参：
        query: str（必传）- 自然语言选股描述，服务端上限 200 字。
                          支持 `【概念】` 标记题材概念，如 `【AI】`、`【算力】【光模块】`。
                          概念关键词本地正则提取，**不经 LLM**，在主题 / 热点 / 今日炒什么
                          三个维度合并 LIKE 搜索；多个 `【】` 之间为 AND 关系。
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: {
            "query": str,                   # 原始输入（strip 后）
            "dsl": {                        # LLM 解析出的条件 DSL
                "query": str,               # 用户原始自然语言原样回显
                "filters": list[dict],      # 平铺条件列表，每项含 type/desc 及各原语参数。
                                            # concept 过滤器结构：{"type":"concept","keyword":"AI","desc":"概念: AI"}
                "sort": {                   # 排序设置
                    "field": str,           # 排序字段（zdf/amount/amount_main/turn_z/value_z）
                    "order": str            # desc 降序 / asc 升序
                },
                "limit": int                # 数量上限，默认 200，最大 200
            },
            "groups": list[dict],           # 各分组命中，按 basic→ma→window→concept 顺序，每项：
                #   key: str        分组标识（basic=基础过滤 / ma=均线形态 / window=历史窗口 / concept=概念题材）
                #   label: str      分组中文名
                #   descs: list[str] 该组条件中文描述
                #   count: int      该组命中股票数
            "final": list[dict],            # 四组交集最终股票列表，按 sort 排序，每项：
                #   code: str          股票代码
                #   name: str          股票名称
                #   price: float       当前价格（元）
                #   zdf: float         涨跌幅（%）
                #   value_z: int       自由流通市值（元）
                #   amount: int        成交额（元）
                #   amount_main: int   主力净额（元）
                #   turn_z: float      自由换手率（%）
                #   zdt_flag: int      0 普通 / 1 涨停 / 2 跌停
                #   zdt_type: int      涨跌停类型（100-203）
            "duration_ms": int              # 本次选股耗时（毫秒，由 API 层追加）
        }

    错误情况（信封 code 非 200）：
        - code=400：选股描述为空 / 过长 / 命中意图黑名单 / 概念关键词超长或含敏感词 / LLM 无法理解该描述
        - code=429：触发限流（60 秒内 >10 次 或 当日 >100 次）
        - code=500：选股服务异常

    注意：
        - groups 四组中任一组为空，则 final 必为空（交集为空）
        - DSL 解析细节（原语 type、字段白名单）见服务端 nl_pick_service 提示词
    """
    return _post("/api/web/nl_pick", {"query": query}, secret_key=secret_key)
