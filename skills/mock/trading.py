"""
模拟交易 SDK

账号、持仓、委托、买卖、撤单、自选股管理、历史成交等交易操作入口。
所有接口封装为函数，agent 直接 import 调用即可，无需自行构造 HTTP 请求。

认证与请求基础设施（_BASE_URL / DEFAULT_SECRET_KEY / _get / _post）见 _http.py。
所有接口通过 cookie 中的 secret_key 进行身份认证，无需手动传递 account_id。
"""

from typing import Optional

from skills.mock._http import _get, _post


# ==================== 快速成交价格调整 ====================
# 买入委托价上浮比例：相对传入价格上浮，便于快速成交
BUY_PRICE_PREMIUM = 0.006
# 卖出委托价下浮比例：相对传入价格下浮，便于快速成交
SELL_PRICE_DISCOUNT = 0.006
# A 股最小报价单位为 0.01 元
PRICE_TICK = 0.01


# 将价格保留到 A 股最小报价单位（0.01 元）
def _round_to_tick(price: float) -> float:
    """
    将价格按 A 股最小报价单位（0.01 元）四舍五入取整

    入参：
        price: float - 待取整的价格

    返回 -> float：保留 2 位小数的价格
    """
    # 用 round(price * 100) / 100 实现 0.01 元精度取整，规避浮点误差
    return round(round(price / PRICE_TICK) * PRICE_TICK, 2)


# ==================== 一、账号查询 ====================

# 获取当前认证账号详情
def get_account(secret_key: str = None) -> dict:
    """
    获取当前认证账号详情

    入参：
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: dict，含账号详情，字段如下：
            id: int                       - 账号 ID
            account_name: str             - 账号名称
            account_type: int             - 账号类型
            account_status: int           - 1=正常 / 2=冻结 / 3=销户 / 4=超限暂停
            total_amount: float           - 总资产（元）
            available_amount: float       - 可用资金（元）
            frozen_amount: float          - 冻结资金（元）
            market_value: float           - 持仓市值（元）
            total_profit: float           - 累计盈亏（元），自开户以来
            total_profit_ratio: float     - 总收益率（%，= (当前总资产 - 初始资金) / 初始资金 × 100）
            daily_profit: float           - 今日盈亏（元）= 当前总资产 - 开盘前资金
            daily_profit_ratio: float     - 今日收益率（%，= daily_profit / 开盘前资金 × 100）
            initial_amount: float         - 初始资金（元）
            min_amount: float             - 资金下限（元）
            max_amount: float             - 资金上限（元）
            create_time: int              - 创建时间（Unix 秒级时间戳）
            update_time: int              - 更新时间（Unix 秒级时间戳）

    注意：
        - daily_profit 为 0 表示今日无盈亏变化（可能建号当天或确实无操作）
    """
    return _get("/api/web/mock/account", secret_key=secret_key)


# ==================== 二、持仓查询 ====================

# 获取持仓列表
def get_positions(secret_key: str = None) -> dict:
    """
    获取持仓列表

    入参：
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            stock_code: str        - 股票代码
            stock_name: str        - 股票名称
            volume: int            - 总持仓（股）
            available_volume: int  - 可卖数量（股），A 股 T+1 当日买入的不可卖
            avg_price: float       - 成本价
            current_price: float   - 当前价
            market_value: float    - 持仓市值
            profit: float          - 盈亏金额
            profit_ratio: float    - 盈亏比例（%）

    注意：
        - volume 为总持仓，available_volume 为可卖数量
        - A 股 T+1：当日买入的股票当日不可卖出
        - 卖出时必须以 available_volume 为准
    """
    return _get("/api/web/mock/positions", secret_key=secret_key)


# ==================== 三、委托查询 ====================

# 获取委托列表
def get_orders(
    secret_key: str = None,
    start_time: Optional[int] = None,
    end_time: Optional[int] = None,
) -> dict:
    """
    获取委托列表

    入参：
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥
        start_time: int（可选，默认当天 0 点）- 开始时间戳（秒级）
        end_time: int（可选，默认当天 23:59:59）- 结束时间戳（秒级）

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            order_no: str      - 委托单号
            stock_code: str    - 股票代码
            stock_name: str    - 股票名称
            order_type: int    - 1=买入 / 2=卖出
            order_price: float - 委托价格
            order_volume: int  - 委托数量（股）
            deal_volume: int   - 已成交数量（股）
            order_status: int  - 委托状态（0待报/1已报/2部成/3已成/4已撤/5废单）
            order_time: int    - 委托时间（Unix 秒级时间戳）
    """
    params = {}
    if start_time is not None:
        params["start_time"] = start_time
    if end_time is not None:
        params["end_time"] = end_time
    return _get("/api/web/mock/orders", params, secret_key=secret_key)


# ==================== 四、交易操作 ====================

# 买入下单
def buy(
    stock_code: str = "",
    price: float = 0,
    volume: int = 0,
    secret_key: str = None,
) -> dict:
    """
    买入下单

    入参：
        stock_code: str（必传）- 股票代码（纯数字，如 "603019"）
        price: float（必传）- 委托价格（元）
        volume: int（必传）- 委托数量（股，必须为 100 的整数倍）
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: {"success": bool, "order_no": str}

    注意：
        - 下单前建议调用 get_account() 确认可用资金
        - 委托为限价单，由撮合引擎异步处理
        - 为快速成交，函数内部会将委托价在传入价格基础上
          上浮 BUY_PRICE_PREMIUM（默认 0.6%），便于穿越当前价快速撮合
    """
    # 买入时在传入价基础上小幅上浮，提升撮合优先级
    adjusted_price = _round_to_tick(price * (1 + BUY_PRICE_PREMIUM))
    return _post("/api/web/mock/buy", {
        "stock_code": stock_code,
        "price": adjusted_price,
        "volume": volume,
    }, secret_key=secret_key)


# 卖出下单
def sell(
    stock_code: str = "",
    price: float = 0,
    volume: int = 0,
    secret_key: str = None,
) -> dict:
    """
    卖出下单

    入参：
        stock_code: str（必传）- 股票代码
        price: float（必传）- 委托价格（元）
        volume: int（必传）- 委托数量（股，不超过 available_volume）
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: {"success": bool, "order_no": str}

    注意：
        - 下单前务必调用 get_positions() 确认可卖数量（available_volume）
        - A 股 T+1：当日买入的股票当日不可卖出
        - 为快速成交，函数内部会将委托价在传入价格基础上
          下浮 SELL_PRICE_DISCOUNT（默认 0.6%），便于穿越当前价快速撮合
    """
    # 卖出时在传入价基础上小幅下浮，提升撮合优先级
    adjusted_price = _round_to_tick(price * (1 - SELL_PRICE_DISCOUNT))
    return _post("/api/web/mock/sell", {
        "stock_code": stock_code,
        "price": adjusted_price,
        "volume": volume,
    }, secret_key=secret_key)


# 撤单
def cancel(order_no: str = "", secret_key: str = None) -> dict:
    """
    撤单

    入参：
        order_no: str（必传）- 委托单号
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: {"success": bool}

    注意：仅状态为 0（待报）或 1（已报）的委托可撤
    """
    return _post("/api/web/mock/cancel", {
        "order_no": order_no,
    }, secret_key=secret_key)


# ==================== 五、历史查询 ====================

# 获取历史成交记录
def get_trade_history(limit: int = 100, secret_key: str = None) -> dict:
    """
    获取历史成交记录

    入参：
        limit: int（可选，默认 100）- 返回记录数量，最大 500
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            id: int               - 记录 ID
            order_no: str         - 委托单号
            stock_code: str       - 股票代码
            stock_name: str       - 股票名称
            trade_type: int       - 1=买入 / 2=卖出
            trade_price: float    - 成交价格
            trade_volume: int     - 成交数量（股）
            trade_amount: float   - 成交金额
            trade_fee: float      - 交易手续费
            realized_profit: float - 已实现盈亏（卖出时才有）
            avg_cost_price: float - 成交后成本价（卖出时才有）
            trade_time: int       - 成交时间（Unix 秒级时间戳）
            trade_date: int       - 交易日（当天 0 点的 Unix 时间戳）
    """
    return _get("/api/web/mock/history", {"limit": limit}, secret_key=secret_key)


# 获取委托撮合日志
def get_match_logs(
    stock_code: str = "",
    order_no: str = "",
    log_date: int = 0,
    secret_key: str = None,
) -> dict:
    """
    获取委托撮合日志

    入参：
        stock_code: str（可选）- 股票代码（用于筛选）
        order_no: str（可选）- 委托单号（用于筛选）
        log_date: int（可选）- 当天 0 点的 Unix 时间戳（秒级）
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            match_time: int       - 撮合检查时间（Unix 秒级时间戳）
            current_price: float  - 当时最新价
            b1_price: float       - 买一价
            s1_price: float       - 卖一价
            match_result: int     - 0=未成交 / 1=成交
            fail_reason: str      - 未成交原因
    """
    return _get("/api/web/mock/match_logs", {
        "stock_code": stock_code,
        "order_no": order_no,
        "log_date": log_date,
    }, secret_key=secret_key)


# 获取账号收益率曲线（基于每日收盘快照）
def get_profit_curve(secret_key: str = None) -> dict:
    """
    获取账号收益率曲线数据

    返回该账号最近约 1 年（最多 365 个交易日 + 今日实时点）的累计收益率序列。
    收益率 = (总资产 - 初始资金) / 初始资金 × 100%。

    入参：
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: list[dict]，按日期升序，每项含：
            date: str         - 日期 YYYY-MM-DD
            rate: float       - 累计收益率（%，保留 4 位小数）
            total_amount: float - 当日总资产（元，保留 2 位小数）
    """
    return _get("/api/web/mock/profit_curve", secret_key=secret_key)


# ==================== 六、自选股操作 ====================

# 添加自选股
def add_favorite(
    stock_code: str,
    stock_name: str = "",
    add_price: float = 0,
    remark: str = "",
    secret_key: str = None,
) -> dict:
    """
    添加自选股

    入参：
        stock_code: str（必传）- 股票代码
        stock_name: str（可选）- 股票名称
        add_price: float（可选）- 添加时价格
        remark: str（可选）- 备注
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        {"code": 200, "message": "success", "data": {...}}
    """
    return _post("/api/web/mock/favorite/add", {
        "stock_code": stock_code,
        "stock_name": stock_name,
        "add_price": add_price,
        "remark": remark,
    }, secret_key=secret_key)


# 移除自选股
def remove_favorite(stock_code: str, secret_key: str = None) -> dict:
    """
    移除自选股

    入参：
        stock_code: str（必传）- 股票代码
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        {"code": 200, "message": "success", "data": {...}}
    """
    return _post("/api/web/mock/favorite/remove", {
        "stock_code": stock_code,
    }, secret_key=secret_key)


# 获取自选股列表（含实时行情）
def get_favorite_list(secret_key: str = None) -> dict:
    """
    获取自选股列表（含实时行情）

    入参：
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            stock_code: str       - 股票代码
            stock_name: str       - 股票名称
            add_price: float      - 添加时价格
            current_price: float  - 当前价格
            zdf: float            - 涨跌幅（%）
    """
    return _get("/api/web/mock/favorite/list", secret_key=secret_key)


# 检查股票是否在自选股中
def check_favorite(stock_code: str, secret_key: str = None) -> dict:
    """
    检查股票是否在自选股中

    入参：
        stock_code: str（必传）- 股票代码
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: {"is_favorite": bool}
    """
    return _get("/api/web/mock/favorite/check", {"stock_code": stock_code}, secret_key=secret_key)


# 搜索股票（模糊匹配代码和名称）
def search_stocks(keyword: str, secret_key: str = None) -> dict:
    """
    搜索股票（模糊匹配代码和名称，返回最多 20 条）

    入参：
        keyword: str（必传）- 搜索关键词（股票代码或名称）
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: list[dict]，最多 20 条，每项含：
            code: str       - 股票代码
            name: str       - 股票名称
            industry: str   - 所属行业
    """
    return _get("/api/web/mock/favorite/search", {"keyword": keyword}, secret_key=secret_key)


# ==================== 七、辅助接口 ====================

# 获取股票实时价格（下单前确认价格用）
def get_stock_price(stock_code: str) -> dict:
    """
    获取股票实时价格（下单前确认价格用）

    入参：
        stock_code: str（必传）- 股票代码

    返回 -> dict（信封格式）：
        data: {
            "stock_code": str,     # 股票代码
            "stock_name": str,     # 股票名称
            "price": float         # 实时价格
        }
    """
    return _get(f"/api/web/mock/stock_price/{stock_code}")


# ==================== 八、主题关注管理 ====================

# 关注主题
def add_favorite_theme(
    theme_code: str,
    theme_name: str = "",
    secret_key: str = None,
) -> dict:
    """
    关注主题（主题体系）

    入参：
        theme_code: str（必传）- 主题代码（level1_code）
        theme_name: str（可选）- 主题名称
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        {"code": 200, "message": "success", "data": {"success": bool, ...}}
    """
    return _post("/api/web/mock/favorite_theme/add", {
        "theme_code": theme_code,
        "theme_name": theme_name,
    }, secret_key=secret_key)


# 取消关注主题
def remove_favorite_theme(theme_code: str, secret_key: str = None) -> dict:
    """
    取消关注主题

    入参：
        theme_code: str（必传）- 主题代码
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        {"code": 200, "message": "success", "data": {"success": bool, ...}}
    """
    return _post("/api/web/mock/favorite_theme/remove", {
        "theme_code": theme_code,
    }, secret_key=secret_key)


# 查询关注主题列表
def get_favorite_theme_list(secret_key: str = None) -> dict:
    """
    查询当前账号的关注主题列表

    入参：
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            theme_code: str  - 主题代码
            theme_name: str  - 主题名称
            add_time: int    - 关注时间戳（秒级）
    """
    return _get("/api/web/mock/favorite_theme/list", secret_key=secret_key)


# 检查主题是否已关注
def check_favorite_theme(theme_code: str, secret_key: str = None) -> dict:
    """
    检查主题是否在当前账号的关注列表中

    入参：
        theme_code: str（必传）- 主题代码
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: {"is_favorite": bool}
    """
    return _get("/api/web/mock/favorite_theme/check", {"theme_code": theme_code}, secret_key=secret_key)


# 批量聚合各关注主题的成分股（顶部关注区域一次性拉取）
def get_favorite_theme_stocks(
    field: str = "zdf",
    sort: str = "desc",
    secret_key: str = None,
) -> dict:
    """
    批量聚合各关注主题的成分股（供顶部关注区域一次性渲染）

    入参：
        field: str（可选，默认 "zdf"）- 排序字段，白名单：
            zdf          - 涨幅
            amount_main  - 主力
            非法值回退为 "zdf"
        sort: str（可选，默认 "desc"）- 排序方向，"desc" 降序 / "asc" 升序，非法值回退 "desc"
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: list[dict]，每个元素含：
            theme_code: str   - 主题代码
            theme_name: str   - 主题名称
            stocks: list[dict] - 成分股列表（前 15 只，结构同 get_theme_stock_list）
    """
    return _get("/api/web/favorite_theme_stocks", {
        "field": field,
        "sort": sort,
    }, secret_key=secret_key)


# 单个关注主题的成分股（排序局部刷新用）
def get_favorite_theme_block_stocks(
    theme_code: str,
    field: str = "zdf",
    sort: str = "desc",
    secret_key: str = None,
) -> dict:
    """
    查询单个关注主题的成分股（供某一块排序后局部刷新）

    入参：
        theme_code: str（必传）- 主题代码
        field: str（可选，默认 "zdf"）- 排序字段，白名单 {zdf, amount_main}，非法值回退 "zdf"
        sort: str（可选，默认 "desc"）- 排序方向，"desc" 降序 / "asc" 升序，非法值回退 "desc"
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: dict | None，单个主题块：
            theme_code: str   - 主题代码
            theme_name: str   - 主题名称
            stocks: list[dict] - 成分股列表
            未关注或已取消时 data 为 None
    """
    return _get("/api/web/favorite_theme_block_stocks", {
        "theme_code": theme_code,
        "field": field,
        "sort": sort,
    }, secret_key=secret_key)


# ==================== 九、"今日炒什么"事件关注管理 ====================

# 关注"今日炒什么"事件
def add_favorite_jtcsm(
    event_id: str,
    event_name: str = "",
    trade_date: str = "",
    secret_key: str = None,
) -> dict:
    """
    关注"今日炒什么"事件

    入参：
        event_id: str（必传）- 事件 ID
        event_name: str（可选）- 事件名称（投资方向名）
        trade_date: str（必传）- 事件交易日 YYYY-MM-DD
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        {"code": 200, "message": "success", "data": {"success": bool, ...}}
    """
    return _post("/api/web/mock/favorite_jtcsm/add", {
        "event_id": event_id,
        "event_name": event_name,
        "trade_date": trade_date,
    }, secret_key=secret_key)


# 取消关注"今日炒什么"事件
def remove_favorite_jtcsm(event_id: str, secret_key: str = None) -> dict:
    """
    取消关注"今日炒什么"事件

    入参：
        event_id: str（必传）- 事件 ID
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        {"code": 200, "message": "success", "data": {"success": bool, ...}}
    """
    return _post("/api/web/mock/favorite_jtcsm/remove", {
        "event_id": event_id,
    }, secret_key=secret_key)


# 查询关注事件列表
def get_favorite_jtcsm_list(secret_key: str = None) -> dict:
    """
    查询当前账号的关注"今日炒什么"事件列表

    入参：
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: list[dict]，每项含：
            event_id: str    - 事件 ID
            event_name: str  - 事件名称
            trade_date: str  - 事件交易日 YYYY-MM-DD
            add_time: int    - 关注时间戳（秒级）
    """
    return _get("/api/web/mock/favorite_jtcsm/list", secret_key=secret_key)


# 检查事件是否已关注
def check_favorite_jtcsm(event_id: str, secret_key: str = None) -> dict:
    """
    检查事件是否在当前账号的关注列表中

    入参：
        event_id: str（必传）- 事件 ID
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: {"is_favorite": bool}
    """
    return _get("/api/web/mock/favorite_jtcsm/check", {"event_id": event_id}, secret_key=secret_key)


# 批量聚合各关注事件的成分股
def get_favorite_jtcsm_stocks(
    field: str = "zdf",
    sort: str = "desc",
    secret_key: str = None,
) -> dict:
    """
    批量聚合各关注事件的成分股（供热点页第二排一次性渲染）

    入参：
        field: str（可选，默认 "zdf"）- 排序字段，白名单：
            zdf          - 涨幅
            amount_main  - 主力
            非法值回退为 "zdf"
        sort: str（可选，默认 "desc"）- 排序方向，"desc" 降序 / "asc" 升序，非法值回退 "desc"
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: list[dict]，每个元素含：
            event_id: str    - 事件 ID
            event_name: str  - 事件名称
            stocks: list[dict] - 成分股列表（前 10 只，结构同 get_jtcsm_event_stocks）
    """
    return _get("/api/web/favorite_jtcsm_stocks", {
        "field": field,
        "sort": sort,
    }, secret_key=secret_key)


# 单个关注事件的成分股（排序局部刷新用）
def get_favorite_jtcsm_block_stocks(
    event_id: str,
    field: str = "zdf",
    sort: str = "desc",
    secret_key: str = None,
) -> dict:
    """
    查询单个关注事件的成分股（供某一块排序后局部刷新）

    入参：
        event_id: str（必传）- 事件 ID
        field: str（可选，默认 "zdf"）- 排序字段，白名单 {zdf, amount_main}，非法值回退 "zdf"
        sort: str（可选，默认 "desc"）- 排序方向，"desc" 降序 / "asc" 升序，非法值回退 "desc"
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        data: dict | None，单个事件块：
            event_id: str    - 事件 ID
            event_name: str  - 事件名称
            stocks: list[dict] - 成分股列表
            未关注或已取消时 data 为 None
    """
    return _get("/api/web/favorite_jtcsm_block_stocks", {
        "event_id": event_id,
        "field": field,
        "sort": sort,
    }, secret_key=secret_key)
