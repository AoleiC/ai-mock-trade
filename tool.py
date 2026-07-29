#!/usr/bin/env python3
"""柚子 AI 项目自更新工具：连接服务端接口，按模块增量更新本地 skills / 系统指令 / memory。

复用 /api/web/skills/download 的整包 zip，配合版本门禁（list 接口的 project_last_updated）
与本地 zip 缓存，实现"同一服务端版本下多次模块更新只占一次下载配额"。覆盖前自动备份。

自包含设计：直接用 requests 发 HTTP，不 import skills.mock._http —— 本工具职责是更新
skills/，若依赖被更新的对象，更新过程中 _http.py 出问题会让工具自身瘫痪。

用法：
  python tool.py update [skills|memory|agents|claude|all]   # 缺省 = skills
  python tool.py check                                       # 仅检查服务端是否有更新，不下载
  python tool.py status                                      # 显示本地版本、服务端版本、缓存状态
  python tool.py update --force                              # 跳过版本门禁强制下载（list 失败时兜底）
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import logging
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

import requests

# ========== 常量与配置 ==========
# 脚本所在目录即项目根（与 watch_scheduler.py 一致，本文件位于项目根）
_SCRIPT_DIR = Path(__file__).resolve().parent
# .env 配置文件路径（含 STOCK_API_BASE_URL / STOCK_SECRET_KEY）
_ENV_PATH = _SCRIPT_DIR / ".env"
# 备份与缓存根目录（tool.py 专属产物，git 忽略）
_BACKUPS_DIR = _SCRIPT_DIR / "backups"
# zip 缓存目录（按版本号命名，命中即复用，省下载配额）
_CACHE_DIR = _BACKUPS_DIR / "cache"
# 本地状态文件（记录 last_updated_ts / 缓存 zip 路径等）
_STATE_PATH = _BACKUPS_DIR / "state.json"

# zip 包内项目目录前缀（服务端打包 arcname = "ai-mock-trade/<rel>"）
_ZIP_ROOT = "ai-mock-trade"

# 模块 → 覆盖目标（kind=dir 递归整目录，kind=file 单文件）
# skills：SDK 代码，最常更新；memory：心法/策略（用户定制资产，覆盖前必备份）；
# agents/claude：AGENTS.md + CLAUDE.md（互为别名，同步覆盖）；all：上述全部 + 顶层文件
MODULE_TARGETS: dict[str, list[tuple[str, str]]] = {
    "skills": [("dir", "skills")],
    "memory": [("dir", "memory")],
    "agents": [("file", "AGENTS.md"), ("file", "CLAUDE.md")],
    "all": [
        ("dir", "skills"),
        ("dir", "memory"),
        ("file", "AGENTS.md"),
        ("file", "CLAUDE.md"),
        ("file", "README.md"),
        ("file", "LICENSE"),
        ("file", "watch_scheduler.py"),
        ("file", "tool.py"),
        ("file", ".env.example"),
        ("file", ".gitignore"),
        ("dir", "assets"),
    ],
}
# 模块别名：claude 与 agents 等价（都覆盖 AGENTS.md + CLAUDE.md）
_MODULE_ALIASES = {"claude": "agents"}

# 永久黑名单（按路径任意段匹配，任何模块都不覆盖）
# .env 含本地密钥；data 是用户运行时交易日志；backups 是工具自身产物；
# __pycache__ / .DS_Store 是缓存与系统文件
_BLACKLIST_SEGMENTS = {".env", "data", "backups", "__pycache__", ".DS_Store"}

# 服务端接口路径
_LIST_PATH = "/api/web/skills/list"        # 公开接口，返回 skills 列表 + project_last_updated
_DOWNLOAD_PATH = "/api/web/skills/download"  # 需登录，下载整包 zip，有每日配额

logger = logging.getLogger("tool")


class ToolError(Exception):
    """工具业务错误（认证失败 / 配额超限等），用于在子命令内中断流程。"""


# ========== 配置加载 ==========
# 读 .env 加载 STOCK_API_BASE_URL / STOCK_SECRET_KEY 到 os.environ
def load_env() -> None:
    """
    读取项目根 .env 并加载到 os.environ

    解析规则：跳过空行与 # 注释行；按 "=" 拆分键值去首尾空白与成对引号；
    已存在的环境变量不覆盖（运行时注入的值优先）。
    """
    if not _ENV_PATH.exists():
        return
    for line in _ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


# 取服务端基地址（末尾去除斜杠，便于拼接路径）
def get_base_url() -> str:
    """返回服务端基地址，优先 STOCK_API_BASE_URL，默认 https://stock.objie.com。"""
    return os.environ.get("STOCK_API_BASE_URL", "https://stock.objie.com").rstrip("/")


# 取认证密钥（cookie 中的 secret_key）
def get_secret_key() -> str:
    """返回 STOCK_SECRET_KEY（已 strip）；空表示未配置。"""
    return os.environ.get("STOCK_SECRET_KEY", "").strip()


# ========== HTTP ==========
# 带 cookie 的 GET（自包含，不依赖 skills.mock._http）
def api_get(path: str, params: dict | None = None, stream: bool = False, timeout: int = 30) -> requests.Response:
    """
    发送带 secret_key cookie 的 GET 请求

    :param path: 接口路径，拼接到 base_url 之后
    :param params: 查询参数
    :param stream: 是否流式下载（zip 大文件用 True）
    :param timeout: 超时秒数
    :returns: requests.Response（不抛 HTTPError，由调用方读 status_code 判断）
    """
    cookies = {"secret_key": get_secret_key()} if get_secret_key() else {}
    return requests.get(
        f"{get_base_url()}{path}",
        params=params,
        cookies=cookies,
        timeout=timeout,
        stream=stream,
        allow_redirects=False,
    )


# 调 list 接口拿服务端 project_last_updated
def fetch_remote_version() -> dict | None:
    """
    GET /api/web/skills/list 取 project_last_updated

    :returns: {"ts": int, "text": str}；接口失败（网络/解析异常）返回 None
    """
    try:
        resp = api_get(_LIST_PATH, timeout=10)
    except requests.RequestException as e:
        logger.error("list 接口请求失败: 错误=%s, url=%s", e, _LIST_PATH)
        return None
    if resp.status_code != 200:
        logger.error("list 接口异常: status=%s, url=%s", resp.status_code, _LIST_PATH)
        return None
    try:
        plu = resp.json().get("data", {}).get("project_last_updated", {})
    except ValueError as e:
        logger.error("list 响应解析失败: 错误=%s, url=%s", e, _LIST_PATH)
        return None
    ts = plu.get("ts")
    if not ts:
        logger.error("list 返回无 project_last_updated.ts: 响应=%s", plu)
        return None
    return {"ts": ts, "text": plu.get("text", "")}


# ========== zip 下载缓存 ==========
# 确保指定版本的 zip 就绪（命中缓存则复用，否则下载落盘）
def ensure_zip(remote_ts: int | None, force: bool) -> Path:
    """
    版本门禁 + 缓存复用：命中缓存则跳过下载（省配额），否则下载并落盘

    :param remote_ts: 服务端 ts；force 模式下为 None
    :param force: 是否强制下载（list 失败兜底，无 ts，用时间戳命名，不命中常规缓存）
    :returns: zip 文件路径
    :raises ToolError: 认证失败(401) / 配额超限(429) / 网络异常
    """
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    # 门禁命中：本地 ts 与服务端 ts 一致，且该版本缓存 zip 已存在 → 复用，不占配额
    if not force and remote_ts is not None:
        cache = _CACHE_DIR / f"ai-mock-trade-{remote_ts}.zip"
        if cache.exists():
            logger.info("命中缓存复用 zip: 版本=%s, 路径=%s", remote_ts, cache.name)
            return cache

    # 下载新 zip
    if force:
        stamp = dt.datetime.now().strftime("%Y%m%d%H%M%S")
        cache = _CACHE_DIR / f"ai-mock-trade-force-{stamp}.zip"
    else:
        cache = _CACHE_DIR / f"ai-mock-trade-{remote_ts}.zip"

    # 下载（捕获网络异常：超时/连接失败 → 提示并中止，不占配额、不动状态）
    try:
        resp = api_get(_DOWNLOAD_PATH, stream=True, timeout=60)
    except requests.RequestException as e:
        logger.error("下载失败: 网络异常 错误=%s, url=%s", e, _DOWNLOAD_PATH)
        raise ToolError("网络异常")
    # 认证失败：中间件返回 401 JSON（未登录/密钥失效）
    if resp.status_code == 401:
        logger.error("下载失败: 认证失败 status=401, url=%s, 原因=请检查 .env 的 STOCK_SECRET_KEY", _DOWNLOAD_PATH)
        raise ToolError("认证失败")
    # 配额超限：服务端返回 429 JSON {used, limit}
    if resp.status_code == 429:
        try:
            quota = resp.json().get("data", {})
        except ValueError:
            quota = {}
        logger.error(
            "下载失败: 配额超限 status=429, url=%s, used=%s, limit=%s, 原因=今日下载次数已达上限",
            _DOWNLOAD_PATH, quota.get("used"), quota.get("limit"),
        )
        raise ToolError("配额超限")
    if resp.status_code >= 300:
        logger.error("下载失败: status=%s, url=%s, 原因=%s", resp.status_code, _DOWNLOAD_PATH, resp.reason)
        raise ToolError(f"下载失败 status={resp.status_code}")

    # 流式落盘
    with cache.open("wb") as f:
        for chunk in resp.iter_content(8192):
            if chunk:
                f.write(chunk)
    logger.info("下载完成: 版本=%s, 路径=%s, 大小=%s 字节", remote_ts, cache.name, cache.stat().st_size)
    return cache


# ========== 状态读写 ==========
# 读 state.json（不存在或损坏视为首次运行）
def load_state() -> dict:
    """
    加载本地状态

    :returns: 状态 dict；文件缺失或 JSON 损坏时返回空 dict（视为首次运行）
    """
    if not _STATE_PATH.exists():
        return {}
    try:
        return json.loads(_STATE_PATH.read_text(encoding="utf-8"))
    except (ValueError, OSError) as e:
        logger.warning("state.json 解析失败，当作首次运行: 错误=%s, 路径=%s", e, _STATE_PATH)
        return {}


# 写 state.json
def save_state(state: dict) -> None:
    """持久化状态到 backups/state.json（先确保目录存在）。"""
    _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


# ========== 覆盖算法辅助 ==========
# 判断相对路径是否命中永久黑名单（按路径任意段匹配）
def _is_blacklisted(rel: str) -> bool:
    """rel 的任一路径段在 _BLACKLIST_SEGMENTS 中即为命中。"""
    return any(seg in _BLACKLIST_SEGMENTS for seg in Path(rel).parts)


# 判断相对路径是否属于模块覆盖范围
def _match_target(rel: str, targets: list[tuple[str, str]]) -> bool:
    """dir 类型匹配该目录前缀，file 类型精确匹配文件名。"""
    for kind, tgt in targets:
        if kind == "file" and rel == tgt:
            return True
        if kind == "dir" and (rel == tgt or rel.startswith(tgt + "/")):
            return True
    return False


# 收集解压目录中属于该模块的文件相对路径集合
def _collect_zip_files(extract_root: Path, module: str) -> set[str]:
    """遍历 extract_root/ai-mock-trade/ 下所有文件，过滤黑名单与模块范围。"""
    zip_proj = extract_root / _ZIP_ROOT
    if not zip_proj.is_dir():
        return set()
    targets = MODULE_TARGETS[module]
    rels: set[str] = set()
    for f in zip_proj.rglob("*"):
        if not f.is_file():
            continue
        rel = f.relative_to(zip_proj).as_posix()
        if _is_blacklisted(rel):
            continue
        if _match_target(rel, targets):
            rels.add(rel)
    return rels


# 收集本地属于该模块的文件相对路径集合
def _collect_local_files(module: str) -> set[str]:
    """遍历模块目标在本地对应的文件（dir 用 rglob，file 判断存在），过滤黑名单。"""
    rels: set[str] = set()
    for kind, tgt in MODULE_TARGETS[module]:
        p = _SCRIPT_DIR / tgt
        if kind == "dir":
            if p.is_dir():
                for f in p.rglob("*"):
                    if f.is_file():
                        rel = f.relative_to(_SCRIPT_DIR).as_posix()
                        if not _is_blacklisted(rel):
                            rels.add(rel)
        else:  # file
            if p.is_file() and not _is_blacklisted(tgt):
                rels.add(tgt)
    return rels


# 计算文件 sha256（用于比对 zip 内与本地是否一致）
def _sha256(p: Path) -> str:
    """分块读取计算 sha256，避免大文件一次性占内存。"""
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# 备份单个本地文件到备份目录（保留相对路径结构）
def _backup_file(src: Path, backup_dir: Path, rel: str) -> None:
    """将 src 复制到 backup_dir/<rel>（自动创建父目录）。"""
    bp = backup_dir / rel
    bp.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, bp)


# ========== 覆盖算法 ==========
# 应用单个模块的覆盖（sha256 比对 + 备份 + 写入 + 目录清理）
def apply_module(extract_root: Path, module: str, backup_dir: Path, project_root: Path = _SCRIPT_DIR) -> dict:
    """
    按文件粒度覆盖指定模块

    遍历 zip 侧与本地侧文件的并集，逐个比对 sha256：
      - zip 有、本地无 → 新增（写入）
      - 都有、内容相同 → 未变（跳过）
      - 都有、内容不同 → 备份本地后写入（更新）
      - zip 无、本地有 → 服务端已删除：
          skills/memory 目录下 .py/.md → 备份后删除（避免旧文件残留）
          其余 → 保守保留

    :returns: 统计 dict {"新增","更新","未变","删除","保留"}
    """
    stats = {"新增": 0, "更新": 0, "未变": 0, "删除": 0, "保留": 0}
    zip_proj = extract_root / _ZIP_ROOT
    zip_files = _collect_zip_files(extract_root, module)
    local_files = _collect_local_files(module)

    for rel in sorted(zip_files | local_files):
        if _is_blacklisted(rel):
            continue
        src = zip_proj / rel
        dst = project_root / rel
        in_zip = rel in zip_files
        in_local = rel in local_files

        if in_zip and not in_local:
            # 新增：zip 有、本地无
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            stats["新增"] += 1
            logger.debug("新增文件: %s", rel)
        elif in_zip and in_local:
            # 比对：都有，按 sha256 决定是否写入
            if _sha256(src) == _sha256(dst):
                stats["未变"] += 1
            else:
                _backup_file(dst, backup_dir, rel)
                shutil.copy2(src, dst)
                stats["更新"] += 1
                logger.debug("更新文件: %s", rel)
        else:
            # 服务端已删除：zip 无、本地有
            top = Path(rel).parts[0] if Path(rel).parts else ""
            suffix = Path(rel).suffix
            # skills/memory 整目录模块下 .py/.md 残留 → 备份后删除；其余保守保留
            if top in ("skills", "memory") and suffix in (".py", ".md"):
                _backup_file(dst, backup_dir, rel)
                dst.unlink()
                stats["删除"] += 1
                logger.debug("删除文件(服务端已删除): %s", rel)
            else:
                stats["保留"] += 1
                logger.debug("保留文件(服务端已删除): %s", rel)
    return stats


# ========== 子命令 ==========
# update 子命令：版本门禁 + zip 缓存 + 按模块覆盖 + 备份
def cmd_update(args: argparse.Namespace) -> int:
    """
    执行模块更新流程（§五）：

    1. 校验认证密钥
    2. list 取服务端 ts（失败且非 force 则中止）
    3. ensure_zip：门禁命中复用缓存，否则下载（占配额）
    4. 解压到临时目录
    5. apply_module：按模块覆盖（始终执行，sha256 去重）
    6. 推进 state（配额超限不推进）
    """
    secret_key = get_secret_key()
    if not secret_key:
        logger.error("认证失败: .env 未配置 STOCK_SECRET_KEY，请在 .env 填入密钥后重试")
        return 1

    # 版本检查（list 公开，但失败时无法做门禁）
    remote = fetch_remote_version()
    if remote is None:
        if not args.force:
            logger.error("无法获取服务端版本(list 接口失败)，中止 update；可用 --force 强制下载")
            return 1
        remote_ts = None
        logger.warning("list 接口失败，--force 强制下载（无版本号，不更新本地版本标记）")
    else:
        remote_ts = remote["ts"]
        logger.debug("服务端版本: ts=%s, text=%s", remote_ts, remote["text"])

    # zip 准备（门禁只决定是否下载新 zip，不阻止模块覆盖）
    try:
        zip_path = ensure_zip(remote_ts, args.force)
    except ToolError as e:
        # 认证失败/配额超限：不更新本地状态，下次可重试
        logger.error("更新中止: 原因=%s", e)
        return 1

    # 解压到临时目录后按模块覆盖
    tmp_dir = tempfile.mkdtemp(prefix="tool-update-")
    try:
        # zip 损坏/解压失败：删除损坏的缓存 zip 并提示重试（避免下次命中坏缓存死循环）
        try:
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(tmp_dir)
        except (zipfile.BadZipFile, OSError) as e:
            zip_path.unlink(missing_ok=True)
            logger.error("解压失败: 错误=%s, zip=%s, 原因=缓存 zip 损坏已删除，请重试", e, zip_path.name)
            return 1
        extract_root = Path(tmp_dir)

        # 备份目录按时间戳命名，便于回溯
        backup_stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_dir = _BACKUPS_DIR / backup_stamp

        # 解析模块别名（claude → agents）
        module = _MODULE_ALIASES.get(args.module, args.module)
        # 覆盖：磁盘满/权限不足时中止，已备份原文留在 backups/ 可手动恢复（§八）
        try:
            stats = apply_module(extract_root, module, backup_dir)
        except OSError as e:
            logger.error("覆盖失败: 错误=%s, 备份目录=backups/%s, 原文可手动恢复", e, backup_stamp)
            return 1

        # 备份目录若为空（无文件需备份）则清理，避免留空目录
        has_backup = backup_dir.exists() and any(backup_dir.rglob("*"))
        backup_info = f", 备份=backups/{backup_stamp}" if has_backup else ", 无文件需备份"
        logger.info(
            "更新完成: 模块=%s, 新增=%s/更新=%s/未变=%s/删除=%s/保留=%s%s",
            module, stats["新增"], stats["更新"], stats["未变"], stats["删除"], stats["保留"], backup_info,
        )

        # 推进本地版本标记（force 且 list 失败时无 ts，保持旧标记不动）
        if remote_ts is not None:
            try:
                rel_zip = zip_path.relative_to(_SCRIPT_DIR).as_posix()
            except ValueError:
                rel_zip = str(zip_path)
            state = load_state()
            state["last_updated_ts"] = remote_ts
            state["last_updated_text"] = remote["text"]
            state["cached_zip"] = rel_zip
            state["last_check_at"] = dt.datetime.now().isoformat(timespec="seconds")
            save_state(state)
        return 0
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# check 子命令：仅比对版本，不下载
def cmd_check(args: argparse.Namespace) -> int:
    """调 list 取服务端版本，与本地 state 比对，报告是否有更新。"""
    remote = fetch_remote_version()
    if remote is None:
        logger.error("无法获取服务端版本(list 接口失败)，请检查网络或稍后重试")
        return 1
    state = load_state()
    local_ts = state.get("last_updated_ts")
    local_text = state.get("last_updated_text", "")
    if local_ts == remote["ts"]:
        logger.info("已是最新: 本地=%s (%s), 服务端=%s (%s)", local_ts, local_text, remote["ts"], remote["text"])
    else:
        logger.info("有更新: 本地=%s (%s), 服务端=%s (%s)", local_ts, local_text, remote["ts"], remote["text"])
    return 0


# status 子命令：显示本地状态与缓存
def cmd_status(args: argparse.Namespace) -> int:
    """展示本地版本标记、上次检查时间与缓存 zip 列表。"""
    state = load_state()
    logger.info(
        "本地状态: 版本=%s (%s), 缓存=%s, 上次检查=%s",
        state.get("last_updated_ts", "无"),
        state.get("last_updated_text", "无"),
        state.get("cached_zip", "无"),
        state.get("last_check_at", "无"),
    )
    if _CACHE_DIR.exists():
        zips = sorted(_CACHE_DIR.glob("*.zip"))
        logger.info("本地缓存 zip: 数量=%s", len(zips))
        for z in zips:
            logger.info("  %s (%s 字节)", z.name, z.stat().st_size)
    else:
        logger.info("本地缓存 zip: 无（backups/cache 目录不存在）")
    return 0


# ========== 主入口 ==========
# argparse 主入口
def main() -> int:
    """解析子命令并分发，配置日志级别（--verbose 开 DEBUG）。"""
    parser = argparse.ArgumentParser(
        prog="tool.py",
        description="柚子 AI 项目自更新工具：按模块增量更新 skills / 系统指令 / memory",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    # update：缺省 skills，支持 --force / --verbose
    p_update = sub.add_parser("update", help="更新指定模块（缺省 skills）")
    p_update.add_argument(
        "module", nargs="?", default="skills",
        choices=["skills", "memory", "agents", "claude", "all"],
        help="更新模块：skills(默认) / memory / agents / claude / all",
    )
    p_update.add_argument("--force", action="store_true", help="跳过版本门禁强制下载（list 失败时兜底）")
    p_update.add_argument("--verbose", action="store_true", help="输出 DEBUG 级日志")
    p_update.set_defaults(func=cmd_update)

    # check：仅检查版本
    p_check = sub.add_parser("check", help="检查服务端是否有更新，不下载")
    p_check.add_argument("--verbose", action="store_true", help="输出 DEBUG 级日志")
    p_check.set_defaults(func=cmd_check)

    # status：本地状态与缓存
    p_status = sub.add_parser("status", help="显示本地版本、服务端版本、缓存状态")
    p_status.add_argument("--verbose", action="store_true", help="输出 DEBUG 级日志")
    p_status.set_defaults(func=cmd_status)

    args = parser.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if getattr(args, "verbose", False) else logging.INFO,
        format="%(message)s",
        stream=sys.stderr,
    )
    load_env()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
