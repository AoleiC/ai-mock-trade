"""
柚子 AI skill 共用 HTTP 封装

承载所有 skill 共享的基础设施：.env 加载、服务基地址、默认认证密钥、cookie 构造、
统一的 GET/POST 请求。market.py 与 trading.py 通过绝对导入复用本模块，避免重复实现。

约定：
    - 工作区根为项目根目录（脚本所在的最外层目录），agent 运行时 cwd = 项目根目录
    - 所有远程接口通过 cookie 中的 secret_key 认证
"""

import os

import requests


# 从项目根目录的 .env 文件加载配置
def _load_env() -> None:
    """
    读取项目根目录下的 .env 文件，加载到 os.environ

    解析规则：
        - 跳过空行与 # 开头的注释行
        - 按 "=" 拆分键值，去除首尾空白与成对引号
        - 已存在的环境变量不覆盖（优先用运行时注入的值）

    _env_path 推算：本文件位于 skills/mock/_http.py，向上 3 层 dirname 即项目根目录，
    与原 skills/<name>/client.py 的深度一致。
    """
    _env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".env")
    if not os.path.exists(_env_path):
        return
    with open(_env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key not in os.environ:
                    os.environ[key] = value


# 模块导入即加载 env，与原 client.py 在模块顶部调用 _load_env() 的行为一致
_load_env()

# 服务基地址，优先读环境变量 STOCK_API_BASE_URL
_BASE_URL = os.environ.get("STOCK_API_BASE_URL", "https://stock.objie.com")
# 默认认证密钥，优先读环境变量 STOCK_SECRET_KEY
DEFAULT_SECRET_KEY = os.environ.get("STOCK_SECRET_KEY", "")


def _cookies(secret_key: str = None) -> dict:
    """
    构造包含 secret_key 的 cookie 字典

    入参：
        secret_key: str（可选）- 认证密钥；为 None 时回退 DEFAULT_SECRET_KEY

    返回 -> dict：形如 {"secret_key": "..."} 的 cookie 字典
    """
    return {"secret_key": secret_key or DEFAULT_SECRET_KEY}


def _get(path: str, params: dict = None, secret_key: str = None) -> dict:
    """
    发送 GET 请求（携带 cookie 认证）并返回 JSON 响应

    入参：
        path: str（必传）- 接口路径，会拼接到 _BASE_URL 之后
        params: dict（可选）- 查询参数
        secret_key: str（可选）- 认证密钥，None 时用 DEFAULT_SECRET_KEY

    返回 -> dict：接口返回的 JSON（已 raise_for_status 校验 HTTP 状态）
    """
    resp = requests.get(
        f"{_BASE_URL}{path}",
        params=params,
        cookies=_cookies(secret_key),
        timeout=10,
        # 禁用重定向：避免 HTTP→HTTPS 跳转时被库改方法（GET 不变，但 POST 会退化为 GET
        # 命中错误路由，错误信息完全无法定位），让协议/域名配置错误立即以 3xx 暴露
        allow_redirects=False,
    )
    # 3xx 视为协议/配置错（allow_redirects=False 时不该有 3xx），手动抛 HTTPError
    # 比后续 resp.json() 解析空 HTML 报 JSONDecodeError 更易定位；
    # 4xx/5xx 不抛 —— 本服务业务信封就是 {code:400/401/500} 包在 200/401 响应体里，
    # 由调用方读 envelope['code'] 判断；只有协议级异常（3xx/超时/连接错）才在此处抛
    if resp.status_code >= 300:
        raise requests.HTTPError(f"{resp.status_code} {resp.reason} for url: {resp.url}", response=resp)
    return resp.json()


def _post(path: str, json_data: dict, secret_key: str = None) -> dict:
    """
    发送 POST 请求（携带 cookie 认证）并返回 JSON 响应

    入参：
        path: str（必传）- 接口路径，会拼接到 _BASE_URL 之后
        json_data: dict（必传）- 请求体 JSON
        secret_key: str（可选）- 认证密钥，None 时用 DEFAULT_SECRET_KEY

    返回 -> dict：接口返回的 JSON（已 raise_for_status 校验 HTTP 状态）
    """
    resp = requests.post(
        f"{_BASE_URL}{path}",
        json=json_data,
        cookies=_cookies(secret_key),
        timeout=10,
        # 禁用重定向：避免 HTTP→HTTPS 跳转时 POST 退化为 GET 命中错误路由而误报 405，
        # 让协议/域名配置错误立即以 3xx 暴露
        allow_redirects=False,
    )
    # 3xx 视为协议/配置错（allow_redirects=False 时不该有 3xx），手动抛 HTTPError
    # 比后续 resp.json() 解析空 HTML 报 JSONDecodeError 更易定位；
    # 4xx/5xx 不抛 —— 本服务业务信封就是 {code:400/401/500} 包在 200/401 响应体里，
    # 由调用方读 envelope['code'] 判断；只有协议级异常（3xx/超时/连接错）才在此处抛
    if resp.status_code >= 300:
        raise requests.HTTPError(f"{resp.status_code} {resp.reason} for url: {resp.url}", response=resp)
    return resp.json()
