# 柚子 AI · A 股 AI Agent 项目包

面向 Claude Code / Opencode / Codex 的 A 股 AI 研究项目包：行情查询、AI 盯盘、每日复盘、研究型模拟持仓记录、定时调度一体化 SDK。内置柚子 AI 完整系统指令与纪律 / 策略心法（`memory/` 可读可改，调教出最适合你的打法），用自然语言对话即可驱动，也可终端无人值守运行。

> **仅供学习研究，不构成任何投资建议。** 系统所有数据均来源于互联网整理，会有一定的滞后性和不准确性，据此投资造成的财产损失概不负责。所有「交易」均基于**模拟账号**，不涉及真实资金。

> 官网：<https://stock.objie.com/>　|　能力与接口文档：<https://stock.objie.com/skills>

---

## 它能做什么

- **行情查询**：大盘汇总、热点板块、个股详情与分时、连板天梯、主力资金、主题与「今天炒什么」事件、LLM 盘面分析、自然语言选股
- **AI 盯盘**：盘中自主盯盘、情绪判断、持仓止损止盈检查、选股与交易（模拟）
- **每日复盘**：盈亏与情绪复盘、次日计划、自选池整理
- **定时调度**：常驻进程按交易时段自动盯盘、盘后自动复盘，无人值守
- **状态读写**：本地交易日志、自选池、复盘总结、动态策略（纯本地文件）

---

## 快速开始

下载包里的 `.env` 已自动写入专属密钥，开箱即用。两种使用方式任选其一：

**方式 A · AI IDE 对话**

用 Claude Code / opencode / Codex 打开本项目目录，`.env` 与系统指令自动加载，直接用大白话说需求即可：

```
> 执行一次盯盘
> 今天大盘怎么样？看看热点板块排名
> 帮我记录一次买入研究：中科曙光 1000 股，价格 45 元
```

**方式 B · 终端无人值守**

```bash
python watch_scheduler.py
```

常驻进程会在交易日盘中每 5 分钟自动盯盘、每晚 21:00 自动复盘。

> 参数清单、启动选项、日志与排障详见官网：<https://stock.objie.com/skills>

### 手动复制或更换密钥

非下载包（手动复制代码）、或需要更换密钥时：

```bash
cp .env.example .env   # 编辑 .env，把 STOCK_SECRET_KEY 填成你的密钥
```

密钥获取见下方「[获取密钥](#获取密钥)」。

---

## 获取密钥

所有功能依赖 `STOCK_SECRET_KEY` 这一个密钥。微信扫码关注公众号，即可获取使用方式与专属密钥：

<p align="center">
  <img src="assets/wechat_mp.jpg" width="200" alt="公众号二维码" />
</p>
<p align="center">微信扫描或长按二维码 · 关注公众号 · 获取使用方式与密钥</p>
<p align="center"><b>不收集任何个人信息</b> · 不读取微信资料 · 全程匿名使用</p>

1. 微信**扫描或长按**上方二维码，**关注公众号**
2. 在公众号内获取**使用方式与专属密钥**（`STOCK_SECRET_KEY`），填入 `.env`

> 也可打开官网扫码：<https://stock.objie.com/#follow>

---

## 赞赏

它陪你看盘复盘、验证想法，如果为你省下过时间、或是点亮过某个灵感，欢迎请我喝杯咖啡。你的支持会变成**深夜里亮着的服务器和下一次推送的新功能**，让这份陪伴延续下去。

<p align="center">
  <img src="assets/pay.png" width="200" alt="赞赏码" />
</p>
<p align="center">微信长按识别 · 金额随心意 · 无论多少，都是我继续打磨的理由</p>

---

## 相关文档

- 系统总纲：[`CLAUDE.md`](./CLAUDE.md)（Claude Code）/ [`AGENTS.md`](./AGENTS.md)（opencode）——角色、操作流程骨架、输出规范、执行边界
- 核心纪律：[`memory/trading-mindset.md`](./memory/trading-mindset.md)（不可变）
- 动态策略：[`memory/dynamic-strategy.md`](./memory/dynamic-strategy.md)（可变，独占所有 LLM 字段消费规则）
- 接口索引：[`skills/mock/SKILL.md`](./skills/mock/SKILL.md)、[`skills/journal/SKILL.md`](./skills/journal/SKILL.md)（函数签名以各 `.py` docstring 为准）

---

## 许可证

见 [LICENSE](./LICENSE)。
