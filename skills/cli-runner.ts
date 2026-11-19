// skill 通用 CLI 调用器（运行时）：行为对齐原 Python cli.py——token 清洗、位置/具名参数、
// 类型转换（int/float/bool/json/智能推断）、@文件引用、结构化错误 JSON + 非零退出码
import { existsSync, readFileSync } from "node:fs";

// 参数类型（guess = 无注解智能推断：int → float → JSON → str，对齐 Python _coerce 的空注解分支）
export type ParamType = "str" | "int" | "float" | "bool" | "json" | "guess";

// 单参数规格（positional=true 表示可按声明顺序接收位置参数）
export interface ParamSpec {
  type: ParamType;
  required?: boolean;
  positional?: boolean;
}

// 方法规格：invoke 接收按参数名聚合的对象（fn 自带 TS 默认值，未传的键不注入）
export interface MethodSpec {
  invoke: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  params: Record<string, ParamSpec>;
}

// 输出一行 JSON 到 stdout（对齐 Python json.dumps(ensure_ascii=False)）
function emitJson(obj: unknown): void {
  console.log(JSON.stringify(obj));
}

// 输出结构化错误 JSON 并返回退出码 1
function emitError(code: number, message: string, target = "", extra?: Record<string, unknown>): number {
  const payload: Record<string, unknown> = { code, error: message };
  if (target) payload.method = target;
  if (extra) Object.assign(payload, extra);
  emitJson(payload);
  return 1;
}

// 无类型注解时的智能推断：int → float → JSON → str
function guess(value: string): unknown {
  if (/^[+-]?\d+$/.test(value)) return parseInt(value, 10);
  const f = Number(value);
  if (value !== "" && Number.isFinite(f)) return f;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// 把 `@path` 形式的值展开为文件内容（仅当 @ 后路径存在；解决长 JSON / 多行文本 shell 转义问题）
function expandFileRef(value: string): string {
  if (!value.startsWith("@")) return value;
  const p = value.slice(1);
  if (!p || !existsSync(p)) return value;
  return readFileSync(p, "utf-8");
}

// 按参数类型把命令行字符串转换为对应值；失败抛中文错误
function coerce(value: string, type: ParamType): unknown {
  if (type === "json" || type === "guess" || type === "str") value = expandFileRef(value);
  switch (type) {
    case "str":
      return value;
    case "bool":
      return ["true", "1", "yes", "y"].includes(value.trim().toLowerCase());
    case "int": {
      const n = Number(value);
      if (!Number.isInteger(n)) throw new Error(`参数期望 int，但传入 ${JSON.stringify(value)} 无法转为整数`);
      return n;
    }
    case "float": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`参数期望 float，但传入 ${JSON.stringify(value)} 无法转为浮点数`);
      return n;
    }
    case "json":
    case "guess":
    default:
      return guess(value);
  }
}

// 把命令行 token 序列拆成位置参数与具名参数（--key value / --key=value；负数归位置参数）
function parseTokens(tokens: string[]): { positionals: string[]; kwargs: Record<string, string> } {
  const positionals: string[] = [];
  const kwargs: Record<string, string> = {};
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok.startsWith("--")) {
      let key = tok.slice(2);
      if (key.includes("=")) {
        const eq = key.indexOf("=");
        const value = key.slice(eq + 1);
        key = key.slice(0, eq);
        if (!key) throw new Error(`具名参数名为空: ${JSON.stringify(tok)}`);
        kwargs[key] = value;
        i += 1;
        continue;
      }
      if (!key) throw new Error(`具名参数名为空: ${JSON.stringify(tok)}`);
      if (i + 1 >= tokens.length) throw new Error(`具名参数 ${JSON.stringify(tok)} 缺少取值`);
      kwargs[key] = tokens[i + 1]!;
      i += 2;
    } else {
      positionals.push(tok);
      i += 1;
    }
  }
  return { positionals, kwargs };
}

// CLI 主流程：解析 → 校验 → 类型转换 → 调用 → JSON 输出；返回进程退出码
export async function runCli(
  methods: Record<string, MethodSpec>,
  rawArgv: string[],
  usage: string,
  helpHeader: string,
): Promise<number> {
  // 清洗 token 首尾空白与控制字符（LLM 生成命令偶发混入 \r 等不可见字符）
  const argv = rawArgv.map((t) => t.trim()).filter((t) => t.length > 0);

  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    console.log(usage);
    return 0;
  }
  if (argv[0] === "--list") {
    console.log(helpHeader);
    for (const name of Object.keys(methods)) console.log(name);
    return 0;
  }

  const target = argv[0]!;
  const spec = methods[target];
  if (!spec) {
    return emitError(404, `方法 ${JSON.stringify(target)} 不在白名单（可用: ${Object.keys(methods).join(", ")}）`, target);
  }

  let positionals: string[];
  let kwargs: Record<string, string>;
  try {
    ({ positionals, kwargs } = parseTokens(argv.slice(1)));
  } catch (exc) {
    return emitError(400, exc instanceof Error ? exc.message : String(exc), target);
  }

  // 位置参数按声明顺序绑定；具名参数校验存在性；必填缺失报 400
  const paramNames = Object.keys(spec.params);
  try {
    if (positionals.length > paramNames.length) {
      return emitError(
        400,
        `位置参数过多：传入了 ${positionals.length} 个，但方法 ${target} 最多接收 ${paramNames.length} 个`,
        target,
        { passed_positionals: positionals },
      );
    }
    const unknown = Object.keys(kwargs).filter((k) => !(k in spec.params));
    if (unknown.length > 0) {
      return emitError(400, `方法 ${target} 不存在参数 ${unknown.join(",")}（合法参数: ${paramNames}）`, target);
    }
    const args: Record<string, unknown> = {};
    positionals.forEach((v, idx) => {
      const name = paramNames[idx]!;
      (args as Record<string, unknown>)[name] = coerce(v, spec.params[name]!.type);
    });
    for (const [k, v] of Object.entries(kwargs)) {
      args[k] = coerce(v, spec.params[k]!.type);
    }
    for (const [name, p] of Object.entries(spec.params)) {
      if (p.required && args[name] === undefined) {
        return emitError(400, `参数 ${name} 必填`, target);
      }
    }

    // 调用方法（捕获业务异常，输出结构化错误）
    const result = await spec.invoke(args);
    emitJson(result === undefined || result === null ? { ok: true } : result);
    return 0;
  } catch (exc) {
    if (exc instanceof Error && exc.message.startsWith("参数")) {
      return emitError(400, exc.message, target);
    }
    return emitError(500, `方法执行异常: ${exc instanceof Error ? exc.message : String(exc)}`, target, {
      traceback: exc instanceof Error ? exc.message : String(exc),
    });
  }
}

// 按 CLI 约束表收敛参数（对齐 Python _PARAM_CONSTRAINTS：未传填收敛默认，数值越界钳到范围）
export function applyConstraints(
  args: Record<string, unknown>,
  constraints: Record<string, [defaultV: number | boolean, lo: number | null, hi: number | null]>,
): Record<string, unknown> {
  for (const [name, [def, lo, hi]] of Object.entries(constraints)) {
    if (args[name] === undefined) {
      args[name] = def;
    } else if (typeof args[name] === "number" && !Array.isArray(args[name])) {
      const v = args[name] as number;
      if (lo !== null && v < lo) args[name] = lo;
      else if (hi !== null && v > hi) args[name] = hi;
    }
  }
  return args;
}
