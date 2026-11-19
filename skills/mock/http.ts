// 柚子 AI skill 共用 HTTP 封装：.env 加载、服务基地址、默认认证密钥、cookie 构造、统一 GET/POST
// 行为对齐原 Python _http.py：cookie 认证、10s 超时、禁重定向（3xx 视为协议/配置错直接抛）
import { loadEnv } from "../env.ts";

// 模块加载即加载 .env（与原实现一致；已存在的环境变量优先）
loadEnv();

// 服务基地址（优先 STOCK_API_BASE_URL）
export function getBaseUrl(): string {
  return (process.env.STOCK_API_BASE_URL ?? "https://stock.objie.com").replace(/\/+$/, "");
}

// 默认认证密钥（优先 STOCK_SECRET_KEY）
export function getDefaultSecretKey(): string {
  return process.env.STOCK_SECRET_KEY ?? "";
}

// 构造 cookie 头（secret_key 认证；空密钥时不带 cookie，由服务端返回 401 信封）
function cookieHeader(secretKey?: string): string {
  const key = secretKey || getDefaultSecretKey();
  return key ? `secret_key=${key}` : "";
}

// ── 全局并发闸（信号量）：所有 SDK HTTP 调用共用，防 Promise.all 齐发拖垮服务端 ──
// 上限固定 4（调用方保持并行写法，超发 FIFO 排队等待）。
// 作用域为本进程（调度器机械层与每轮 pipeline 是两个进程，各自 4 路，单机合计 ≤8 并发）
const MAX_HTTP_CONCURRENCY = 4;
let httpActive = 0;
const httpWaiters: Array<() => void> = [];

// 占用一个并发名额（超上限则挂起排队，被唤醒后占位返回）
async function httpAcquire(): Promise<void> {
  if (httpActive < MAX_HTTP_CONCURRENCY) {
    httpActive += 1;
    return;
  }
  await new Promise<void>((resolve) => httpWaiters.push(resolve));
  httpActive += 1;
}

// 归还一个并发名额并唤醒队首等待者
function httpRelease(): void {
  httpActive -= 1;
  httpWaiters.shift()?.();
}

// GET 查询串构造（跳过 null/undefined，布尔转小写——与 requests 的 params 序列化对齐）
function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return "";
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    qs.set(k, typeof v === "boolean" ? String(v) : String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

// 发送 GET 请求（携带 cookie 认证）并返回 JSON；3xx/超时/网络异常抛 Error；全局限并发闸内执行
export async function apiGet(path: string, params?: Record<string, unknown>, secretKey?: string): Promise<unknown> {
  await httpAcquire();
  try {
    const resp = await fetch(`${getBaseUrl()}${path}${buildQuery(params)}`, {
      headers: { Cookie: cookieHeader(secretKey) },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status >= 300) {
      throw new Error(`${resp.status} ${resp.statusText} for url: ${resp.url}`);
    }
    return await resp.json();
  } finally {
    httpRelease();
  }
}

// 发送 POST 请求（JSON 体 + cookie 认证）并返回 JSON；3xx/超时/网络异常抛 Error；全局限并发闸内执行
export async function apiPost(path: string, json: Record<string, unknown>, secretKey?: string): Promise<unknown> {
  await httpAcquire();
  try {
    const resp = await fetch(`${getBaseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader(secretKey) },
      body: JSON.stringify(json),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status >= 300) {
      throw new Error(`${resp.status} ${resp.statusText} for url: ${resp.url}`);
    }
    return await resp.json();
  } finally {
    httpRelease();
  }
}
