// stderr 结构化日志：一切进度/诊断走 stderr（stdout 只留给最终结果 JSON，见设计文档 §4）
// 长消息按终端显示宽度自动换行（CJK 全角占 2 列），续行缩进与正文对齐——日志是给人看的，不靠终端软换行
import process from "node:process";

// 单个码点的终端显示宽度（CJK 全角 / 谚文 / 全角标点 = 2，零宽字符 = 0，其余 = 1）
function charW(cp: number): number {
  if (cp === 0) return 0;
  // 零宽：组合附标 / 零宽空格族 / BOM / 软换行
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff || cp === 0x2028) return 0;
  // 全角：谚文 Jamo / CJK 部首~彝文 / 谚文扩展与音节 / CJK 兼容 / 全角形式 / 全角货币 / emoji / CJK 扩展平面
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

// 字符串的终端显示宽度（逐码点累加）
function textW(s: string): number {
  let w = 0;
  for (const ch of s) w += charW(ch.codePointAt(0) ?? 0);
  return w;
}

// 目标行宽：直连终端取其实宽；被调度器管道接管（columns 丢失）时用 LOG_WIDTH 或默认 120
function lineWidth(): number {
  const cols = Number(process.stderr.columns ?? 0) || Number(process.env.LOG_WIDTH ?? 0) || 0;
  return cols > 20 ? cols : 120;
}

// 断点候选字符：空格（断后丢弃）与常用中英文标点（断后保留在行尾——如「｜」分隔的池明细天然逐段换行）
const CUT_PUNCT = new Set(["｜", "，", "、", "；", "：", "。", "！", "？", "）", "】", "》", "」", "》", "→", ",", ";", ")"]);

// 按显示宽度软折行：优先在断点处换行（空格 / 标点），整段无断点才硬折（中文逐字可断）；保留显式 \n
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const src of text.split("\n")) {
    let cur = "";
    let curW = 0;
    let cut = -1; // cur 内可断的下标（该字符之后断开）
    let cutDrop = 0; // 断点处需丢弃的字符数（空格=1，标点=0）
    for (const ch of src) {
      const w = charW(ch.codePointAt(0) ?? 0);
      if (curW + w > width && cur.length > 0) {
        if (cut >= 0) {
          out.push(cur.slice(0, cut + 1 - cutDrop)); // 空格断点不含空格本身，标点断点保留标点在行尾
          cur = cur.slice(cut + 1);
        } else {
          out.push(cur);
          cur = "";
        }
        curW = textW(cur);
        cut = -1;
        cutDrop = 0;
      }
      if (ch === " " && cur.length === 0) continue; // 断行后的前导空格丢弃（防续行多一格错位）
      cur += ch;
      curW += w;
      if (ch === " ") {
        cut = cur.length - 1;
        cutDrop = 1;
      } else if (CUT_PUNCT.has(ch)) {
        cut = cur.length - 1;
        cutDrop = 0;
      }
    }
    out.push(cur);
  }
  return out;
}

// 本地时区 HH:MM:SS（日志时间戳跟随服务器 / 本机时区，不用 UTC——与 trace.ts 的 attention 时间同口径）
function localHMS(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 输出一条带时间戳与分类的日志到 stderr（调度器镜像到终端与 run-*.log；超宽自动换行，续行与正文对齐）
export function log(category: string, msg: string): void {
  const ts = localHMS();
  const prefix = `[${ts}] [${category}] `;
  const width = Math.max(20, lineWidth() - textW(prefix));
  const lines = wrapText(msg, width);
  process.stderr.write(`${prefix}${lines[0] ?? ""}\n`);
  const contIndent = " ".repeat(textW(prefix));
  for (const line of lines.slice(1)) process.stderr.write(`${contIndent}${line}\n`);
}

// 截断长文本用于日志展示（保留首尾，中间以省略号标注总长）
export function brief(text: string, max = 200): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(共${s.length}字符)`;
}
