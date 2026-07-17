# 柚子 AI · A 股 AI Agent 项目包

面向 Claude Code / opencode / Codex 的 A 股 AI 研究项目包：行情查询、AI 盯盘、每日复盘、研究型模拟持仓记录、定时调度一体化 SDK。内置柚子 AI 完整系统指令与纪律 / 策略心法，用自然语言对话即可驱动，也可终端无人值守运行。

> **仅供学习研究，不构成任何投资建议。** 系统的所有数据均来源于互联网整理，会有一定的滞后性和不准确性，据此投资造成的财产损失概不负责。所有「交易」均基于**模拟账号**，不涉及真实资金。

> 官网：<https://stock.objie.com/>　·　密钥获取与赞赏见下方[获取密钥、使用与赞赏](#获取密钥使用与赞赏)

---

## 它能做什么

一套完整的 A 股 AI 研究系统 = 四组能力 + 两套 AI 系统指令 + 两份心法 / 策略文件 + 一个常驻调度器。AI IDE 打开本目录后会自动加载系统指令，你只需用自然语言对话，柚子 AI 会自己调用对应能力，**不需要手动敲命令**。

- **行情查询**（`skills/mock/market.py`）：大盘汇总、热点板块、个股详情与分时、连板天梯、主力资金、主题与「今天炒什么」事件、LLM 盘面分析、自然语言选股
- **研究型持仓**（`skills/mock/trading.py`）：账号资金、持仓、买卖委托、撤单、自选股、关注主题 / 事件（**不含真实资金**）
- **总结上报**（`skills/mock/report.py`）：把盯盘 / 复盘总结同步到后台
- **状态读写**（`skills/journal/journal.py`）：本地交易日志、自选池、每日复盘总结、动态策略（纯本地文件，不依赖网络）

---

## 快速上手

下载解压完成（或手动复制）后，有两种互相独立的使用方式——可任选其一，也可搭配使用。

### 方式 A · 在 AI IDE 内对话（交互式）

用 Claude Code / opencode / Codex 打开本项目目录，`CLAUDE.md` / `AGENTS.md` 与 `.env` 密钥会自动加载，直接用大白话说需求即可。适合临时查行情、做研究、手动记录操作。

```
# 用 AI IDE 打开 ai-mock-trade/，直接对话（示例）
> 执行一次盯盘
> 今天行情那么好你为什么还不开仓？
> 今天大盘怎么样？
```

### 方式 B · 终端启动定时盯盘（无人值守）

在本目录下跑一行命令启动常驻进程：盘中每 5 分钟自动盯盘、每晚 21:00 自动复盘，**不依赖 IDE**，挂着就行。适合「让它自己跑」。

```bash
python watch_scheduler.py
```

两种方式的对话示例、参数与排障见下方「[可以怎么对话](#可以怎么对话)」与「[定时盯盘 watch_schedulerpy](#定时盯盘-watch_schedulerpy)」。

---

## 目录结构

```
ai-mock-trade/
├── CLAUDE.md                              # 系统总纲（Claude Code 读取）
├── AGENTS.md                              # 系统总纲（opencode 读取）
├── watch_scheduler.py                     # 定时盯盘调度器（盘中每 5 分钟 + 21 点复盘）
├── .env                                   # 密钥配置（下载包已自动写入；手动复制时参考 .env.example）
├── .env.example                           # 密钥配置模板
├── README.md                              # 本文件
├── LICENSE                                # 许可证
├── skills/
│   ├── mock/                             # 接口调用 SDK（行情、研究型模拟持仓、总结上报）
│   │   ├── SKILL.md                       # 函数索引（签名以各 .py docstring 为准）
│   │   ├── __init__.py
│   │   ├── _http.py                       # 共用 HTTP 封装
│   │   ├── market.py                      # 行情查询
│   │   ├── trading.py                     # 研究型模拟持仓（不含真实交易）
│   │   ├── report.py                      # 总结上报
│   │   └── cli.py                         # mock skill 通用方法调用器（agent 唯一入口）
│   └── journal/                           # 总结与写文档（本地状态读写）
│       ├── SKILL.md                       # 函数索引
│       ├── __init__.py
│       ├── journal.py                     # 交易日志 / 自选池 / 复盘总结 / 动态策略
│       └── cli.py                         # journal skill 通用方法调用器
├── memory/                                # 记忆（不可变纪律 + 可变策略）
│   ├── trading-mindset.md                 # 不可变：核心研究纪律（五类股、九条铁律、止损哲学、仓位红线）
│   └── dynamic-strategy.md                # 可变：动态策略（独占所有 LLM 字段消费规则 + 买点 / 止损阈值 / 输出规范）
└── data/                                  # 运行时数据（按日归档，git 忽略）
    ├── trade-log-{date}.json              # 交易日志（操作 + 情绪快照）
    ├── watchlist-{date}.json              # 自选池
    └── daily-summary-{date}.json          # 复盘总结（盈亏、反思、次日计划）
```

## 获取密钥、使用与赞赏

下载包里的 `.env` 已自动写入你的专属密钥（`STOCK_SECRET_KEY`），开箱即用。如果你是手动复制代码、或密钥需要更换，按下面的流程获取。

### 获取密钥

所有功能都依赖 `STOCK_SECRET_KEY` 这一个密钥。获取方式：访问官网，微信扫码关注公众号，即可拿到使用方式与专属密钥。

> 官网：<https://stock.objie.com/>

<p align="center">
  <img src="https://stock.objie.com/static/img/wechat_mp.jpg" width="200" alt="公众号二维码" />
</p>
<p align="center">微信扫描或长按二维码 · 关注公众号 · 获取使用方式与密钥</p>

具体步骤：

1. 打开官网 <https://stock.objie.com/>
2. 微信**扫描或长按**首页的公众号二维码，**关注公众号**
3. 在公众号内获取**使用方式与专属密钥**（`STOCK_SECRET_KEY`）

### 使用

拿到密钥后，复制配置模板并填入即可（仅手动复制场景需要）：

```bash
cp .env.example .env
# 编辑 .env，把 STOCK_SECRET_KEY 填成你拿到的密钥
```

填好 `.env` 后，两种使用方式任选其一：

- **交互对话**：用 Claude Code / opencode / Codex 打开本项目目录，直接用大白话说需求（见下方[可以怎么对话](#可以怎么对话)）
- **无人值守**：终端运行 `python watch_scheduler.py`，盘中每 5 分钟自动盯盘、每晚 21:00 自动复盘（见下方[定时盯盘](#定时盯盘-watch_schedulerpy)）

### 赞赏

如果这个工具对你的行情学习与研究有所帮助，欢迎请作者喝杯咖啡，你的支持是持续迭代的动力。

<p align="center">
  <img src="https://stock.objie.com/static/img/pay.png" width="200" alt="赞赏码" />
</p>
<p align="center">微信长按识别 · 金额随意</p>

---

## 可以怎么对话

AI IDE 打开项目后，直接用大白话说需求即可，柚子 AI 会自动调用对应能力并组织回复：

| 场景 | 示例 |
|------|------|
| 行情查询 | 「今天大盘怎么样？看看热点板块排名」 |
| 自选 / 选股 | 「把工业富联加入自选，再帮我选【算力】板块多头排列的创业板股」 |
| 研究持仓 | 「帮我记录一次买入研究：中科曙光 1000 股，价格 45 元」 |
| 柚子 AI 盯盘 | 「执行一次盯盘」 |
| 每日复盘 | 「复盘今天的研究记录」 |
| 状态查询 | 「读一下今天的交易日志和昨天的复盘总结」 |

---

## 定时盯盘 watch_scheduler.py

如果你想让柚子 AI 在行情时段自动盯盘、盘后自动复盘，运行项目内置的 `watch_scheduler.py` 即可。它是一个常驻 Python 进程，按 A 股交易时段在本地调用 AI CLI 执行盯盘 / 复盘，**不依赖任何 IDE 插件**，关掉终端前会一直跑。所有操作均用于学习研究，**不构成任何投资建议**。

### 默认行为

- 交易日（周一至周五）**09:30-11:30**、**13:00-15:00**，每 **5 分钟**触发一次「执行一次盯盘」
- 每个交易日 **21:00** 触发一次「复盘今天的行情数据」
- 非交易时段脚本只 sleep，不消耗 CPU 与网络资源；周末不盯盘
- 默认调用 `opencode`（与 `AGENTS.md` 配合），也可切换到 `Claude Code`

### 启动

在本目录下执行一行命令即可（启动后会持续在终端打印每次触发的简要结果，`Ctrl+C` 可优雅退出，会等待当前 CLI 跑完再停）：

```bash
# 默认：常驻循环（盘中每 5 分钟盯盘 + 21:00 复盘）
python watch_scheduler.py

# 常驻后台（关闭终端不被 kill）
nohup python watch_scheduler.py >> data/watch_scheduler.out 2>&1 &

# 只跑一次就退出（不进入循环）：watch=盯盘、review=复盘
python watch_scheduler.py --once watch
```

### 常用参数

CLI 参数与同名环境变量效果一致，参数优先级更高（完整列表见 `python watch_scheduler.py --help`）：

| 用途 | 命令 |
|------|------|
| 切换 Claude Code | `python watch_scheduler.py --cli claude` |
| 改为 3 分钟一次 | `python watch_scheduler.py --interval 3` |
| 自定义盯盘提示词 | `python watch_scheduler.py --prompt-watch "执行盯盘并打印当前持仓"` |
| 调整复盘时间 | `python watch_scheduler.py --review-hour 22 --review-minute 30` |
| 用环境变量配置 | `WATCH_CLI=claude WATCH_INTERVAL_MINUTES=15 python watch_scheduler.py` |

更多参数：`--project-dir`、`--prompt-review`、`--log-dir`、`--pid-file`。

### 日志与排障

日志默认写到 `data/watch_scheduler_logs/`，分两类：

- `scheduler-YYYY-MM-DD.log`：调度器自身的 INFO/ERROR，每次触发的「谁 / 做了什么 / 结果」一行
- `run-YYYYMMDD-HHMMSS.log`：每次 CLI 调用的完整 stdout/stderr，CLI 报错时优先看这个

常见排查：CLI 报 `command not found` → `which opencode` 检查 PATH；密钥失效 → 重新登录下载页拿新 `.env`；CLI 长时间无输出 → 检查网络与 provider 配额（单次失败不会中断后续轮次）。

---

## 环境准备

脚本只做调度，执行依赖本机的 Python 与 AI CLI。若启动命令报 `command not found`，说明对应工具尚未安装，请自行查阅官方文档：

- **Python 3.12+**：参见 [python.org](https://www.python.org/downloads/)
- **opencode（默认 CLI）**：参见 [opencode.ai](https://opencode.ai)，首次使用需 `opencode auth login`
- **Claude Code（备选 CLI）**：参见 [官方文档](https://docs.claude.com/en/docs/claude-code)，首次使用需 `claude login`

**链路验证**（推荐先跑一次再启动常驻调度）：在本目录下手动执行 `opencode run "执行一次盯盘"`，能正常出盘面摘要即为通畅。`.env` 下载时已自动写入密钥，手动复制场景才需要自己补。

---

## 相关文档

- 系统总纲：[`CLAUDE.md`](./CLAUDE.md)（Claude Code）/ [`AGENTS.md`](./AGENTS.md)（opencode）——角色、操作流程骨架、输出规范、执行边界
- 核心纪律：[`memory/trading-mindset.md`](./memory/trading-mindset.md)（不可变）
- 动态策略：[`memory/dynamic-strategy.md`](./memory/dynamic-strategy.md)（可变，独占所有 LLM 字段消费规则）
- 接口索引：[`skills/mock/SKILL.md`](./skills/mock/SKILL.md)、[`skills/journal/SKILL.md`](./skills/journal/SKILL.md)（函数签名以各 `.py` docstring 为准）

---

## 许可证

见 [LICENSE](./LICENSE)。
