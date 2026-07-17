#!/usr/bin/env python3
"""journal skill 通用方法调用器（CLI runner）。

让 agent 无需写任何临时脚本，通过一行命令调用 journal 模块的状态读写方法，
结果以 JSON 输出到 stdout。本文件与 skills/mock/cli.py 结构一致、各自独立白名单，
保持两个 skill 物理解耦（mock=接口调用，journal=总结与写文档）。

用法：
    python skills/journal/cli.py <method> [位置参数...] [--key value ...]
    python skills/journal/cli.py --list          # 列出全部可用方法
    python skills/journal/cli.py --help          # 打印本说明

示例：
    # 无参方法
    python skills/journal/cli.py read_trade_log
    python skills/journal/cli.py read_watchlist
    python skills/journal/cli.py read_daily_summary
    python skills/journal/cli.py read_dynamic_strategy

    # 位置参数（按方法签名类型注解自动转换：str/int/float）
    python skills/journal/cli.py append_trade_action buy 603019 中科曙光 45.0 100 "主线龙头符合买点"

    # 具名参数（覆盖默认值；支持 --key value 与 --key=value 两种写法）
    python skills/journal/cli.py read_trade_log --date 2026-07-06
    python skills/journal/cli.py append_emotion_snapshot 主升 65 5 AI算力 --extra='{"note":"放量"}'

约定：
    - 工作区根 = 项目根目录（脚本所在的最外层目录）；本文件位于 skills/journal/cli.py，启动时自动把项目根目录注入 sys.path
    - 类型转换严格按方法签名的类型注解：stock_code（str）保持字符串；dict/list 走 JSON；无注解时智能推断
    - 方法返回值原样 JSON 输出；返回 None 时输出 {"ok": true}
    - 任意异常输出结构化错误 JSON + 退出码非零，agent 可直接解析
"""

from __future__ import annotations

import inspect
import json
import re
import sys
import types
import typing
from pathlib import Path

# 把项目根目录注入 sys.path 最前，使 `from skills.journal import ...` 无论 cwd 在哪都能解析。
# __file__ = <项目根>/skills/journal/cli.py → parents[2] = 项目根目录
_PROJECT_ROOT = str(Path(__file__).resolve().parents[2])
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from skills.journal import journal  # noqa: E402

# 模块白名单：本 skill 只暴露 journal 模块（本地状态读写），与 mock 接口层隔离
_MODULES = {"journal": journal}

# 方法名合法字符（防 method 含点号 / 斜杠等做路径穿越）
_METHOD_NAME_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")

# 用法说明（--help 时打印）
_USAGE = """journal skill 通用方法调用器（总结与写文档）

用法:
    python skills/journal/cli.py <method> [位置参数...] [--key value ...]
    python skills/journal/cli.py --list          列出全部可用方法
    python skills/journal/cli.py --help          打印本说明

模块白名单: journal（交易日志 / 自选池 / 复盘总结 / 动态策略 的本地读写）

示例:
    python skills/journal/cli.py read_trade_log
    python skills/journal/cli.py read_watchlist
    python skills/journal/cli.py read_daily_summary
    python skills/journal/cli.py read_dynamic_strategy
    python skills/journal/cli.py read_trade_log --date 2026-07-06
    python skills/journal/cli.py append_trade_action buy 603019 中科曙光 45.0 100 "主线龙头符合买点"
    python skills/journal/cli.py append_emotion_snapshot 主升 65 5 AI算力 --extra='{"note":"放量"}'
    python skills/journal/cli.py write_dynamic_strategy --content '...'

类型转换: 按方法签名类型注解自动转换（str/int/float/bool/dict/list）。
输出: 方法返回值 JSON；异常输出结构化错误 JSON 且退出码非零。
"""


class _ArgError(Exception):
    """命令行参数解析错误，携带可直接展示给 agent 的中文说明。"""


# 解析 Optional[X] / X | None，返回去掉 None 的内层类型；非 Union 原样返回
def _unwrap_optional(annotation: object) -> object:
    """剥掉 Optional[X] / X | None 的 None 分支，返回内层具体类型 X。"""
    origin = typing.get_origin(annotation)
    if origin is None:
        return annotation
    # typing.Union（Optional[X] 的底层）或 Python 3.10+ 的 X | Y（types.UnionType）
    is_union = origin is typing.Union or (
        hasattr(types, "UnionType") and isinstance(annotation, types.UnionType)
    )
    if is_union:
        non_none = [a for a in typing.get_args(annotation) if a is not type(None)]
        # 只剩一个非 None 分支时才剥（Optional[X]），X | Y 这种多分支保持原样交由 JSON 兜底
        if len(non_none) == 1:
            return non_none[0]
    return annotation


# 无类型注解时的智能推断：int → float → JSON(dict/list) → str
def _guess(value: str) -> object:
    """无类型注解时按 int → float → JSON → str 顺序尝试推断。"""
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        pass
    return value


# 把 `@path` 形式的字符串值展开为文件内容（仅在 _coerce 内复合类型分支里识别，避免误伤）
def _expand_file_ref(value: str) -> str:
    """若 value 以 `@` 开头且后续路径存在文件，则读文件原文返回；否则原样返回。

    设计目的：解决长 JSON / 多行字符串在 shell 中转义被破坏的问题。
    误伤防护：仅当 `@` 后路径是已存在的文件才展开；普通以 `@` 开头的合法 JSON（如邮箱）
    会被 `_coerce` 后续分支当作 JSON 失败而回退。
    """
    if not value.startswith("@"):
        return value
    path = value[1:]
    if not path or not Path(path).is_file():
        return value
    return Path(path).read_text(encoding="utf-8")


# 按类型注解把命令行字符串值转换成对应 Python 类型
def _coerce(value: str, annotation: object) -> object:
    """按方法签名的类型注解，把命令行传入的字符串转换成对应 Python 类型。

    入参：
        value: str（必传）- 命令行原始字符串值
        annotation: object（必传）- 该参数的类型注解（可为 inspect.Parameter.empty）

    返回 -> 转换后的值；无注解或未知注解时回退到 _guess 智能推断。
    """
    # 复合类型（dict / list / 未知注解走 JSON 兜底）支持 `@path` 文件引用
    annotation_for_path = _unwrap_optional(annotation)
    if annotation_for_path in (dict, list) or annotation_for_path is inspect.Parameter.empty:
        value = _expand_file_ref(value)
    annotation = annotation_for_path
    # 无注解：智能推断
    if annotation is inspect.Parameter.empty:
        return _guess(value)
    if annotation is str:
        return value
    if annotation is bool:
        return value.strip().lower() in ("true", "1", "yes", "y")
    if annotation is int:
        try:
            return int(value)
        except ValueError as exc:
            raise _ArgError(f"参数期望 int，但传入 {value!r} 无法转为整数") from exc
    if annotation is float:
        try:
            return float(value)
        except ValueError as exc:
            raise _ArgError(f"参数期望 float，但传入 {value!r} 无法转为浮点数") from exc
    # dict / list / 其它复合类型：按 JSON 解析
    if annotation in (dict, list):
        try:
            return json.loads(value)
        except (ValueError, TypeError) as exc:
            raise _ArgError(f"参数期望 {annotation.__name__}（JSON），但传入 {value!r} 不是合法 JSON") from exc
    # 未知注解：尝试 JSON，失败则原样返回字符串
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return value


# 把命令行 token 序列拆成位置参数与具名参数
def _parse_tokens(tokens: list[str]) -> tuple[list[str], dict[str, str]]:
    """解析命令行 token 序列，拆分为位置参数列表与具名参数字典。

    规则：以 `--` 开头的 token 视为具名参数键，支持 `--key value` 与 `--key=value`；
    其余 token 按出现顺序归入位置参数。负数（如 -3）不以 `--` 开头，正确归入位置参数。

    入参：
        tokens: list[str]（必传）- 去掉目标方法名后的命令行 token 序列

    返回 -> tuple(位置参数列表, 具名参数字典)；解析失败抛 _ArgError。
    """
    positionals: list[str] = []
    kwargs: dict[str, str] = {}
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok.startswith("--"):
            key = tok[2:]
            # --key=value 形式
            if "=" in key:
                key, value = key.split("=", 1)
                if not key:
                    raise _ArgError(f"具名参数名为空: {tok!r}")
                kwargs[key] = value
                i += 1
                continue
            # --key value 形式
            if not key:
                raise _ArgError(f"具名参数名为空: {tok!r}")
            if i + 1 >= len(tokens):
                raise _ArgError(f"具名参数 {tok!r} 缺少取值")
            kwargs[key] = tokens[i + 1]
            i += 2
        else:
            positionals.append(tok)
            i += 1
    return positionals, kwargs


# 输出结构化错误 JSON 到 stdout，并返回退出码
def _emit_error(code: int, message: str, target: str = "", **extra) -> int:
    """输出结构化错误 JSON 到 stdout，返回退出码（非零）。

    入参：
        code: int（必传）- 错误码（400 参数错 / 404 找不到 / 500 执行异常）
        message: str（必传）- 给 agent 看的中文错误说明
        target: str（可选）- 出错的方法名
        **extra: 附加字段（如 args / traceback）

    返回 -> 固定 1（统一非零退出码，让调用方判定失败）。
    """
    payload = {"code": code, "error": message}
    if target:
        payload["method"] = target
    payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False, default=str))
    return 1


# 输出方法返回值 JSON 到 stdout
def _emit_result(result: object) -> None:
    """输出方法返回值 JSON 到 stdout；返回 None 时用 {"ok": true} 占位。"""
    if result is None:
        result = {"ok": True}
    print(json.dumps(result, ensure_ascii=False, default=str))


# 列出全部可用方法（每行一个），供 --list 发现
def _print_method_list() -> None:
    """列出 journal 模块的全部公开方法（每行一个，单模块不带前缀）。"""
    for name, obj in inspect.getmembers(journal, inspect.isfunction):
        # 跳过以下划线开头的私有函数
        if name.startswith("_"):
            continue
        print(name)


# 主入口：解析命令行、定位方法、转换参数、调用、输出
def main(argv: list[str]) -> int:
    """主入口：解析命令行 → 定位 journal 方法 → 按签名转换参数 → 调用 → JSON 输出。

    入参：
        argv: list[str]（必传）- 去掉程序名后的命令行参数

    返回 -> 进程退出码：0 成功；1 任意失败（错误详情已以 JSON 输出到 stdout）。
    """
    # 无参数或 --help：打印用法
    if not argv or argv[0] in ("-h", "--help"):
        print(_USAGE)
        return 0
    if argv[0] == "--list":
        _print_method_list()
        return 0

    method_name = argv[0]
    tokens = argv[1:]

    # 校验方法名合法字符（防路径穿越）
    if not _METHOD_NAME_RE.match(method_name):
        return _emit_error(400, f"方法名 {method_name!r} 含非法字符", method_name)

    # journal skill 单模块：直接在 journal 模块上取方法
    method = getattr(journal, method_name, None)
    if method is None or not callable(method):
        return _emit_error(404, f"journal 模块下不存在方法 {method_name!r}", method_name)

    # 解析命令行参数
    try:
        positionals, kwargs = _parse_tokens(tokens)
    except _ArgError as exc:
        return _emit_error(400, str(exc), method_name)

    # 取方法签名，按类型注解转换参数
    try:
        sig = inspect.signature(method)
        params = sig.parameters
        param_names = list(params.keys())
        # 位置参数数量不能超过方法参数总数
        if len(positionals) > len(param_names):
            return _emit_error(
                400,
                f"位置参数过多：传入了 {len(positionals)} 个，但方法 {method_name} 最多接收 {len(param_names)} 个",
                method_name,
                passed_positionals=positionals,
            )
        coerced_pos = [
            _coerce(v, params[param_names[idx]].annotation) for idx, v in enumerate(positionals)
        ]
        # 校验具名参数名是否存在于方法签名
        unknown = [k for k in kwargs if k not in params]
        if unknown:
            return _emit_error(
                400,
                f"方法 {method_name} 不存在参数 {unknown}（合法参数: {param_names}）",
                method_name,
            )
        coerced_kw = {k: _coerce(v, params[k].annotation) for k, v in kwargs.items()}
        # sig.bind 严格校验：必填参数缺失 / 重复传参会抛 TypeError（→400 客户端错误）；
        # 有默认值的可选参数不传也合法；apply_defaults 填充未传的可选参数
        bound = sig.bind(*coerced_pos, **coerced_kw)
        bound.apply_defaults()
    except _ArgError as exc:
        return _emit_error(400, str(exc), method_name)
    except TypeError as exc:
        # 参数绑定失败（必填参数缺失、重复传参等客户端错误）
        return _emit_error(400, f"参数绑定失败: {exc}", method_name)

    # 调用方法（捕获业务异常，输出结构化错误）
    try:
        result = method(*bound.args, **bound.kwargs)
    except Exception as exc:  # noqa: BLE001
        return _emit_error(
            500,
            f"方法执行异常: {type(exc).__name__}: {exc}",
            method_name,
            traceback=str(exc),
        )

    _emit_result(result)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
