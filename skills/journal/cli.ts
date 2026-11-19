#!/usr/bin/env node
// journal skill 通用方法调用器（CLI runner）：调用 journal 模块的本地状态读写方法
// 用法：node skills/journal/cli.ts <method> [位置参数...] [--key value ...]（--list / --help）
import { runCli, type MethodSpec } from "../cli-runner.ts";
import * as journal from "./journal.ts";

// 方法注册表（单模块白名单：journal；本地状态读写契约见 SKILL.md——市场节点判定已云端化，见 mock skill 的 market.read_market_node）
const METHODS: Record<string, MethodSpec> = {
  read_dynamic_strategy: { invoke: () => journal.readDynamicStrategy(), params: {} },
  write_dynamic_strategy: {
    invoke: (a) => {
      journal.writeDynamicStrategy(String(a.content));
      return undefined;
    },
    params: { content: { type: "str", required: true } },
  },
  record_decision: {
    invoke: (a) =>
      journal.recordDecision(
        String(a.trade_date),
        String(a.action),
        String(a.stock_code),
        (a.stock_name as string) ?? "",
        (a.direction as string) ?? null,
        (a.price as number) ?? 0,
        (a.volume as number) ?? 0,
        (a.reason as string) ?? "",
        (a.time_str as string) ?? null,
        (a.source as string) ?? "agent",
        null,
        (a.status as string) ?? "filled",
      ),
    params: {
      trade_date: { type: "str", required: true },
      action: { type: "str", required: true },
      stock_code: { type: "str", required: true },
      stock_name: { type: "str" },
      direction: { type: "str" },
      price: { type: "float" },
      volume: { type: "int" },
      reason: { type: "str" },
      time_str: { type: "str" },
      source: { type: "str" },
      status: { type: "str" },
    },
  },
  update_decision: {
    invoke: (a) =>
      journal.updateDecision(
        String(a.trade_date),
        String(a.action),
        String(a.stock_code),
        {
          ...(a.status !== undefined ? { status: String(a.status) } : {}),
          ...(a.price !== undefined ? { price: a.price as number } : {}),
          ...(a.volume !== undefined ? { volume: a.volume as number } : {}),
          ...(a.time_str !== undefined ? { time: String(a.time_str) } : {}),
          ...(a.direction !== undefined ? { direction: (a.direction as string) ?? null } : {}),
          ...(a.reason !== undefined ? { reason: String(a.reason) } : {}),
          ...(a.stop_loss_pct !== undefined ? { stop_loss_pct: (a.stop_loss_pct as number) ?? null } : {}),
        },
      ),
    params: {
      trade_date: { type: "str", required: true },
      action: { type: "str", required: true },
      stock_code: { type: "str", required: true },
      status: { type: "str" },
      price: { type: "float" },
      volume: { type: "int" },
      time_str: { type: "str" },
      direction: { type: "str" },
      reason: { type: "str" },
      stop_loss_pct: { type: "float" },
    },
  },
  read_decisions: {
    invoke: (a) => journal.readDecisions(a.trade_date as string | undefined),
    params: { trade_date: { type: "str" } },
  },
};

// 用法说明（--help 打印）
const USAGE = `journal skill 通用方法调用器（本地状态读写 · TypeScript / Node）

用法:
    node skills/journal/cli.ts <method> [位置参数...] [--key value ...]
    node skills/journal/cli.ts --list          列出全部可用方法
    node skills/journal/cli.ts --help          打印本说明

模块白名单: journal（动态策略 / 出手台账 的本地读写）
市场节点读取已云端化：node skills/mock/cli.ts market.read_market_node（见 skills/mock/SKILL.md）

示例:
    node skills/journal/cli.ts read_dynamic_strategy
    node skills/journal/cli.ts record_decision --trade_date 2026-10-28 --action buy --stock_code 002747 ...
    node skills/mock/cli.ts market.read_market_node   # 市场节点（盘中第 0 步，云端权威）`;

const argv = process.argv.slice(2);
runCli(METHODS, argv, USAGE, "journal 方法清单：").then((code) => process.exit(code));
