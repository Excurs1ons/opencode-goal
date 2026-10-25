# opencode-goal

An [OpenCode](https://opencode.ai) **V2** plugin that turns a session into an
autonomous goal loop:

- you give it an objective once (`/goal <objective>`);
- after every *clean* assistant turn it checks the last line for `GOAL_DONE` /
  `GOAL_BLOCKED`;
- if the goal is not finished, it adds **one short continuation line** and runs
  another round;
- provider failures use OpenCode's built-in exponential backoff first, then a
  bounded plugin-level exponential backoff;
- quota / balance / subscription exhaustion is terminal and **never** retried;
- rounds, wall clock, cost, stalled rounds and context are all bounded, so a
  dead provider or a stubborn model cannot loop forever.

The plugin does **not** register tools and does **not** add a system prompt. The
only model-visible injections are the initial objective, one short line per
round, and one short line per plugin retry.

---

## 安装

OpenCode V2 的全局插件目录是 `~/.config/opencode/plugins/`。把本目录放到：

```
~/.config/opencode/plugins/goal
```

然后在 `~/.config/opencode/opencode.json(c)` 的 `plugins` 数组里加入它：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/root/.config/opencode/plugins/goal"
  ]
}
```

路径按你的实际主目录调整；使用绝对路径最稳。保存配置后 OpenCode 会自动重载
插件，不需要重启服务。

需要选项时用对象形式：

```jsonc
{
  "plugins": [
    {
      "package": "/root/.config/opencode/plugins/goal",
      "options": {
        "maxRounds": 30,
        "maxWallClockMinutes": 180,
        "retryMaxAttempts": 4,
        "debug": false
      }
    }
  ]
}
```

## 使用

```
/goal 把 tests/ 里的失败用例全部修好，并跑通 cargo test
/goal status
/goal stop
/goal resume
/goal retry
/goal clear
```

- `/goal <objective>`：设置或替换目标，第一轮只发送一次目标文本。
- `/goal status`：显示阶段、轮数、重试次数、耗时、目标摘要。
- `/goal stop` / `pause`：暂停；正在队列里的下一条短提示仍可能执行一次，
  但暂停后不会再续轮。
- `/goal resume`：恢复，并重置轮数、墙钟、停滞和压缩计数。
- `/goal retry`：立刻按插件层重试一次（不用等退避）。
- `/goal clear` / `done` / `remove`：清除目标与持久化状态。
- `/goal help`：帮助。

保留字只有**单独出现**时才生效：`/goal stop the server` 会被当成一个目标文本，
而不是 `stop` 命令。

## 一轮是怎么走的

插件只监听 `session.execution.succeeded`（干净结束）来推进目标：

1. 取本次执行最后一个 assistant 消息的文本；
2. 如果最后一行是 `GOAL_DONE`（允许加粗/反引号/句号）→ 标记完成，停止；
3. 如果最后是 `GOAL_BLOCKED: <原因>` → 暂停并提示原因；
4. 否则检查预算（轮数 / 墙钟 / 费用 / 停滞 / 上下文）；
5. 都通过 → 发送一行：

   ```
   Continue. End: GOAL_DONE, or GOAL_BLOCKED: <reason>.
   ```

失败（`session.execution.failed`）或中断（`session.execution.interrupted`）
**不会**推进目标轮次。失败只可能进入下一节的两层重试；中断则暂停。

## 两层重试

### 第一层：OpenCode 内置指数退避

插件不改变内置行为。普通的 429、5xx、传输/DNS 错误继续由 OpenCode 自己
指数退避重试。插件只在一种情况下否决内置重试：

> 错误明确表示账户已经**没有额度/余额/套餐余量**。

此时 `retry` hook 把 `decision` 改成 `{ retry: false }`，避免在已经欠费或
超额后继续请求。

### 第二层：插件自己的指数退避

内置重试全部失败后，OpenCode 会发出 `session.execution.failed`。如果错误
属于可重试类别（普通 429、超时、传输、5xx、过载、网络），插件按自己的
退避再试：

| 次数 | 默认等待 |
| --- | --- |
| 1 | 30s |
| 2 | 60s |
| 3 | 120s |

- 每次带 ±20% 抖动，并受 `retryMaxDelayMs`（默认 15 分钟）限制；
- 如果 provider 给了 `retryAfterMs`，取它和计算值的较大者（仍受上限限制）；
- 默认最多 3 次（`retryMaxAttempts`）；
- **不会重新发送目标或原始用户消息**。原始消息已经在 transcript 里；重试只
  追加一行：

  ```
  Resume without repeating completed work. End: GOAL_DONE or GOAL_BLOCKED: <reason>.
  ```

  这样即使连续重试几次，也只会多出几条极短的行，不会把目标重复塞进上下文。

不可重试类别（直接暂停，不消耗重试预算）：

- 配额/余额/账单/套餐（见下节）；
- 鉴权失败、非法请求、内容策略；
- 用户中断 / aborted；
- 未知错误（避免对确定性 bug 无限重试；可手动 `/goal retry`）。

上下文溢出是单独的路径：先触发一次 `session.compact`，再继续；压缩达到上限
仍不降才暂停。

### 配额 / 余额熔断（重点）

以下任一信号会被判定为**不可重试**：

- HTTP `402`；
- error type `provider.quota`；
- `insufficient_quota`、`insufficient balance`、`credit balance is too low`、
  `out of credits`、`billing`、`payment required`；
- `monthly/plan/subscription/usage limit` 之类的套餐限制；
- 中文：`余额不足`、`欠费`、`套餐`、`订阅`、`充值`、`超额`、`超限`、
  `免费额度` 等。

普通的 `429 Too Many Requests` / `rate limit` / `per minute quota`
仍视为限流，可以重试——插件不会把限流误判成欠费。

一旦命中熔断：

1. 当前内置重试被否决；
2. 目标立即暂停；
3. 不再安排插件重试；
4. 发一条简短提示，告诉你去充值/换 provider，然后 `/goal resume`。

这样订阅超额或余额不足后不会出现“无限重试 → 一直烧钱/烧时间”的情况。

## 预算与防 OOM

每次续轮前检查：

| 保护 | 默认 | 行为 |
| --- | --- | --- |
| `maxRounds` | 25 | 续轮次数用完 → 暂停 |
| `maxWallClockMinutes` | 120 | 墙钟用完 → 暂停 |
| `maxCostUSD` | 0（关闭） | 本次目标累计费用超过 → 暂停 |
| `maxStalledRounds` | 3 | 连续多轮最终文本完全相同 → 暂停 |
| `compactAtRatio` | 0.75 | 上下文达到模型窗口的 75% 时先压缩 |
| `maxCompactions` | 2 | 连续压缩仍不降 → 暂停 |

内存方面：

- 每个执行只保留最后一个 assistant 消息的文本（最多 64 KiB，最多 4 条）；
- 每个会话状态只保留一个目标、一个小 Map 和一个定时器；
- 会话删除/`/goal clear` 会清掉状态与定时器；
- 事件流断开后按 1s → 30s 退避重连，不会堆积订阅；
- 所有重试都有次数/时间/延迟上限。

## 持久化

目标状态按会话存在插件 storage 里（key: `goal.v1.<sessionID>`）。插件重载或
服务重启后：

- 目标会恢复为 **paused**，绝不自动续跑；
- 发一条 “restored as paused” 提示；
- 你确认后 `/goal resume` 继续。

## 配置

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭整个插件 |
| `commandName` | `"goal"` | 命令名（默认 `/goal`） |
| `providerIDs` | 全部 | 只对这些 provider 注册 retry hook |
| `debug` | `false` | 输出 `[goal]` 调试日志 |
| `maxGoalChars` | `8000` | 目标文本上限 |
| `maxRounds` | `25` | 自动续轮上限 |
| `maxWallClockMinutes` | `120` | 单次目标墙钟上限 |
| `maxCostUSD` | `0` | 费用上限，0 = 关闭 |
| `maxStalledRounds` | `3` | 连续无进展判定 |
| `compactAtRatio` | `0.75` | 触发预防性压缩的上下文比例 |
| `maxCompactions` | `2` | 连续压缩上限 |
| `reinjectAfterCompaction` | `true` | 压缩后那一轮重新带一次目标（截断到 2000 字符） |
| `pauseOnUserPrompt` | `false` | 用户插话时是否暂停目标 |
| `retryEnabled` | `true` | 关闭插件层重试 |
| `retryDelaysMs` | `[30000,60000,120000]` | 插件层退避表 |
| `retryMaxAttempts` | `3` | 插件层重试次数 |
| `retryJitter` | `0.2` | 抖动比例 |
| `retryMaxDelayMs` | `900000` | 单次等待上限 |
| `retryAfterTools` | `true` | 工具已执行后仍允许插件层重试 |

## 与其他重试插件的顺序

如果你同时使用强制重试 429 的插件（例如
[`opencode-nim-retry`](https://github.com/Excurs1ons/opencode-nim-retry)），
把 `goal` 放在 `plugins` 数组的**最后**。多个 retry hook 按注册顺序执行，
靠后的 hook 能看到并覆盖前面的决定；`goal` 的“欠费不重试”才能最终生效。

```jsonc
"plugins": [
  "@tarquinen/opencode-dcp",
  "/root/.config/opencode/plugins/nim-retry",
  "/root/.config/opencode/plugins/goal"
]
```

## 已知限制

- 插件**无法提高 OpenCode 内置的最大重试次数**（文档里明确是硬上限）。第二层
  重试只能通过“重新唤醒会话 + 一行短提示”实现，不能重放完全相同的失败请求。
- 如果某个 step 已经开始流式输出，OpenCode 不会重试它；本插件也只能等整个
  execution 失败后才介入。
- 模型必须按约定输出 `GOAL_DONE` / `GOAL_BLOCKED`。如果模型不遵守，轮数上限
  会兜底停止。
- 状态/暂停提示使用的是 `session.synthetic(..., resume: false)`：它不会唤醒
  模型，但会留在 inbox 里，可能在下一次真实对话时作为一条 synthetic 消息出现。
- 恢复后不会自动续跑（防止重启后意外花钱）。

## 自测

仓库内包含单元测试和一个不调用真实模型的集成测试 harness：

```sh
npm install
npm run typecheck
npm test
```

当前覆盖：

- 错误分类：普通 429 / 欠费 429 / 402 / 403 限流 / 403 鉴权 / 5xx / 网络 /
  上下文溢出 / 内容策略 / 中文余额不足 / “per minute quota” 不误判；
- 标记解析：`GOAL_DONE`、`GOAL_BLOCKED`、格式化、代码围栏、引用误判；
- 退避：抖动范围、递增、封顶；
- 状态机：干净结束才续轮、`GOAL_DONE` 停止、`GOAL_BLOCKED` 暂停、
  失败后只发短重试行、欠费不重试、重试预算耗尽、轮数预算耗尽、
  重启恢复为 paused、跨 location 事件过滤。

## License

MIT
