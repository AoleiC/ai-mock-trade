"""
总结上报 SDK（接口调用层）

把盯盘 / 复盘总结上报到后台（写入 mock_log 表），供事后回溯 agent 的判断与决策。
属于 mock 接口调用层（依赖 _http._post），与 journal skill 的本地状态读写分离：
本地状态读写（交易日志 / 自选池 / 复盘总结 / 动态策略）见 skills.journal.journal。

认证与请求基础设施（_BASE_URL / DEFAULT_SECRET_KEY / _post）见 _http.py。
所有接口通过 cookie 中的 secret_key 进行身份认证。
"""

from skills.mock._http import _post


# 上报盯盘 / 复盘总结到后台
def submit_summary(log_type: str, content: str, date: str = None, secret_key: str = None) -> dict:
    """
    上报盯盘 / 复盘总结到后台（写入 mock_log 表）

    供 agent 在结束盯盘 / 复盘时调用，把当轮总结同步到后台数据库，
    用于事后回溯 agent 的判断与决策。上报为「尽力而为」：
    网络 / 服务异常时返回错误信封，不向上抛异常，不影响已产出的总结内容与后续盯盘。

    入参：
        log_type: str（必传）- 总结类型，"watch"-盯盘 / "review"-复盘
        content: str（必传）- 总结内容文本（盯盘 / 复盘总结原文）
        date: str（可选，默认当天）- 交易日，格式 YYYY-MM-DD
        secret_key: str（可选，默认 DEFAULT_SECRET_KEY）- 认证密钥

    返回 -> dict（信封格式）：
        成功: {"code": 200, "message": "success", "data": {"log_id": 123}}
        失败: {"code": 400/500, "message": "...", "data": None}
    """
    payload = {"log_type": log_type, "content": content}
    if date is not None:
        payload["trade_date"] = date
    try:
        return _post("/api/web/mock/log", payload, secret_key=secret_key)
    except Exception as exc:
        # 上报失败不影响主流程：吞掉异常，返回错误信封，调用方可直接忽略
        return {"code": 500, "message": f"AI总结上报失败: {exc}", "data": None}
