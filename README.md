# cortico-world-qq-initiative

给 Coopanion / Cortico 桌宠用的**独立 QQ 主动搭话**扩展：按作息与白名单，自己在合适的时机找对方说句话。

- World id：`qq-initiative`；包名：`cortico-world-qq-initiative`
- 发信走自建 OneBot v11 HTTP 通道，**成功与否以平台回执为准**，拿不到回执一律不算发出
- 装好默认**关闭**且白名单为空，不配置就绝对不会向任何人发消息

> 文档里所有号码（如 `private:<QQ号>`）都是占位写法，仓内不含任何真实 QQ 号、令牌或内网地址。

---

## 1. 特性

| 能力 | 说明 |
| --- | --- |
| 作息感知 | 深睡时段完全不发，午休时段说得更少 |
| 白名单硬排除 | 不在名单里的对象任何情况下都不主动发，`force` 也不能越过 |
| 配额与间隔 | 每天最多几次、对同一个人最快多久一次，都可调 |
| 防打扰 | 连着几次没回就先不说，对方一回话就重新算 |
| 三天性事务 | 先「预备」→ 真的发出去了才「记账」，没发出去自动退回，不虚记配额 |
| 静默优先 | 默认允许模型判断「现在不该打扰」就不发，配额不损失 |
| 中文人话日志 | 面向用户的消息只讲结论，技术细节走 debug |

---

## 2. 安装

### 2.1 前置条件

| 依赖 | 说明 |
| --- | --- |
| [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 或 [Cortico](https://github.com/Pal-AI-Lab/Cortico) 部署 | 提供 World 宿主、事件流与桌面宠物界面 |
| 一个 OneBot v11 HTTP 服务 | 例如 [NapCatQQ](https://github.com/NapNeko/NapCatQQ)、[SnowLuma](https://github.com/SnowLuma/SnowLuma)，需开启 HTTP 服务端（默认 `http://127.0.0.1:3000`） |
| Node.js >= 22 | 扩展直接使用内置 `fetch` 与 `AbortSignal.timeout` |

OneBot v11 协议见 [botuniverse/onebot-11](https://github.com/botuniverse/onebot-11)。启用 HTTP 服务端后，先确认 `GET /get_login_info` 能返回机器人账号。

### 2.2 放置扩展

```
<部署根>/data/extensions/local/cortico-world-qq-initiative/
```

或在宿主「扩展管理」里选择本机目录加载。加载后重启宿主进程，`worlds.qq-initiative` 配置段即可见。

### 2.3 第一次启用：按这个顺序来

装好之后它是**关闭**的，白名单也是空的，所以不会打扰任何人。建议顺序：

1. **填白名单**：在设置里把「能主动找的 QQ 号」填成自己的号（只填数字，多个用逗号或换行分开）。
2. **验证发信**：先别开总开关，用配置面板里的「仅生成搭话词预览」看一眼它要说什么，确认地址与语气都对。
3. **再开总开关**：打开「允许它主动找你说话」。当天的次数、间隔会按默认值生效。

如果发信地址与令牌没配好，启动时会直接在日志里告警（不会静默失败）。配置文件形态：

```jsonc
{
  "worlds": {
    "qq-initiative": {
      "enabled": true,
      "mode": "private",
      "whitelistPrivate": "<QQ号>",
      "whitelistGroup": "",
      "outboundMode": "builtin",
      "outboundHttpUrl": "http://127.0.0.1:3000",
      "outboundHttpToken": ""
    }
  }
}
```

令牌二选一：填 `outboundHttpToken`，或留空并设置环境变量 `QQ_PROACTIVE_ONEBOT_TOKEN`。**不要把真实令牌写进源码、截图或提交到仓库。**

### 2.4 想复用已有的 QQ World？

若部署里已经有别的 QQ World，并且希望由它统一发信：

```jsonc
{
  "worlds": {
    "qq-initiative": {
      "outboundMode": "external",
      "outboundTool": "<那个扩展注册的发信工具名>"
    }
  }
}
```

此时本扩展不注册 `qq_initiative_send`，也**看不到发信结果**——所有主动回合一律按「未发出」处理，不计配额、不做虚账。这是刻意设计：宁可漏记，不可错记。

---

## 3. 配置项

所有键都在 `worlds.qq-initiative` 下。按「改错的后果」分三层：

### 3.1 基础层（面板第一张卡，日常只用这些）

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 允许它主动找你说话。开启前先填白名单 |
| `mode` | `private` \| `group` \| `all` | `private` | 对谁主动说话 |
| `whitelistPrivate` | string | `""` | 能主动找的 QQ 号，纯数字，逗号/换行分隔。留空 = 谁都不找 |
| `whitelistGroup` | string | `""` | 能主动说话的群号，纯数字，逗号/换行分隔 |
| `dailyQuota` | number | `20` | 每天最多主动找你几次，说完休息到第二天 |
| `unrepliedThreshold` | number | `3` | 连着几次没回就先不说，对方回话就重新算 |
| `privateMinIntervalMin` | number | `60` | 对同一个人最快多久说一次（分钟，60 = 1 小时） |
| `privateMaxIntervalMin` | number | `360` | 对同一个人最久隔多久说一次（分钟） |
| `groupMinIntervalMin` | number | `180` | 对同一个群最快多久说一次（分钟） |
| `groupMaxIntervalMin` | number | `720` | 对同一个群最久隔多久说一次（分钟） |
| `routineEnabled` | boolean | `true` | 按作息说话：睡觉时间完全不发 |
| `sleepStart` / `sleepEnd` | string | `23:30` / `08:00` | 几点睡、几点醒（`HH:mm`） |
| `lazyStart` / `lazyEnd` | string | `12:30` / `14:00` | 午休起止（`HH:mm`），午休说得更少 |

### 3.2 高级层（面板第二张卡，不确定就保持默认）

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `allowSilence` | boolean | `true` | 允许它判断「现在不该打扰」就闭嘴；关掉会变成到点必发 |
| `withNickname` | boolean | `true` | 提示它称呼对方名字 |
| `announceRoutine` | boolean | `true` | 作息切换时主动说一句 |
| `promptEnabled` | boolean | `true` | 让它知道自己今天的额度和规矩 |
| `promptText` | string | `""` | 自定义说话风格，留空用内置模板 |

### 3.3 运营 / 危险层（**面板不显示，只能改配置文件**）

这些项改错会「功能消失 / 发错地方 / 泄露凭据」，所以不放进面板。改完需重启宿主。

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `outboundMode` | `builtin` \| `external` | `builtin` | 发信通道：本插件自己发，或交给别的扩展发（后者不可观测）。**改错会完全发不出消息** |
| `outboundHttpUrl` | string | `""` | QQ 机器人框架的 HTTP 地址；留空时用内置默认 `http://127.0.0.1:3000`。**填错一条都发不出去** |
| `outboundHttpToken` | string | `""` | 框架的访问令牌（不是 QQ 密码），留空读环境变量 `QQ_PROACTIVE_ONEBOT_TOKEN`。**泄露 = 别人能用你的号发消息** |
| `outboundHttpTimeoutMs` | number | `8000` | 单次请求超时（1000–60000 毫秒），超时按失败处理 |
| `outboundTool` | string | `qq_initiative_send` | 模型应调用的发信工具名；`external` 模式下改成对方实际注册的工具名 |
| `outboundToField` / `outboundTextField` | string | `to` / `text` | 与自定义发信工具对接时的参数名。**不是开发者请保持默认** |
| `channelPrefix` | string | `""` | 地址前缀（如 `qq:`），用于对齐宿主地址格式。不确定就留空 |
| `tickIntervalMs` | number | `60` | 内部检查频率（秒），不影响「多久说一次话」。**改小会白耗资源** |
| `whitelist` | string[] \| string | `[]` | 历史字段，仅作兼容读取；会被合并进上面两个白名单。**新配置请不要用它** |

环境变量：

| 变量 | 说明 |
| --- | --- |
| `QQ_PROACTIVE_ONEBOT_TOKEN` | `outboundHttpToken` 留空时读取的 OneBot 访问令牌 |

启动时的自动体检（发现问题降级并告警，不会静默失效）：

| 检查 | 处置 |
| --- | --- |
| 最快间隔 > 最久间隔 | 自动对调 + 告警 |
| 最快间隔 < 1 分钟 | 抬到 1 分钟 + 告警 |
| 每日上限 = 0 | 告警「等于不限次数」 |
| 未回复阈值 = 0 | 告警「不会因没回而停」 |
| 发信地址不是完整网址 | 告警「可能全部失败」 |
| 通道 = `external` | 告警「看不到结果，按未发出处理」 |
| 已开启但白名单为空 | 告警「不会发出任何消息」 |
| 开启 + 不限次数 + 间隔 ≤ 1 分钟 | 记为错误，自动把每日上限降回 20 |

---

## 4. 工具清单

| 工具名 | 标签 | 作用 |
| --- | --- | --- |
| `qq_initiative_send` | `speak` | 主动搭话专用发信渠道；成功返回平台 `message_id`，失败返回 `[send failed] <原因>`，**不抛异常** |
| `qq_initiative_status` | `read` | 运行状态、作息阶段、今日配额、白名单、会话活跃度；传 `address` 可查单会话 |
| `qq_initiative_trigger` | `write` | 手动触发一次主动搭话（调试用），受白名单与作息约束，`force` 只放宽配额与最小区间 |
| `qq_initiative_reset` | `write` | 重置今日配额（`daily_quota`）、指定会话冷却（`session`）或全部（`all`） |

`qq_initiative_send` 的入参：

```json
{
  "type": "object",
  "properties": {
    "to": { "type": "string", "description": "投递地址：private:<QQ号> 或 group:<群号>" },
    "text": { "type": "string", "description": "消息正文（1~3 句，说完整）" }
  },
  "required": ["to", "text"]
}
```

---

## 5. 事件清单

| 事件类型 | 方向 | 说明 |
| --- | --- | --- |
| `im.proactive.turn` | 本扩展推送 | 主动回合唤醒：携带目标地址、场景、时段与本次标识，提示模型发起一次主动搭话。事件 `source` 为 `qq-initiative` |

```json
{
  "type": "im.proactive.turn",
  "ts": "2026-01-01T09:00:00+08:00",
  "source": "qq-initiative",
  "text": "【主动搭话】现在主动找 示例昵称 说句话。…",
  "meta": {
    "channel": "qq",
    "targetAddress": "private:<QQ号>",
    "targetKind": "private",
    "targetName": "示例昵称",
    "scene": "idle_chat",
    "outboundTool": "qq_initiative_send",
    "pledgedAt": 1767229200000,
    "pledgeId": "p-1767229200000-abc123"
  }
}
```

- nudge 正文控制在 400 字符内，只写「发给谁、什么场景、用哪个渠道」；长期状态在环境提示词里，两处不重复。
- `pledgeId` 是不透明标识，用于把后续结算与回滚精确归属到这一笔；消费方原样保留即可。
- 入站消息由扩展通过事件存储游标增量读取，只处理 `meta.conv` 给出的 `private:<QQ号>` / `group:<群号>`。

---

## 6. 环境提示词占位符

`src/ENV_PROMPT.md` 的占位符与 `envPromptVars()` 的 key 完全一致，渲染后整体控制在 220 字符内：

| 占位符 | 内容 |
| --- | --- |
| `{{proactiveStatus}}` | 启用状态与当前作息阶段 |
| `{{proactiveWhitelist}}` | 白名单列表 |
| `{{proactiveQuota}}` | 今日已说 / 上限 |
| `{{outboundTool}}` | 当前生效的发信工具名 |
| `{{proactiveGuidance}}` | 说话风格总原则（自定义或内置） |

---

## 7. 验收命令

```bash
# 静态类型检查
npm run typecheck

# 全部测试：引擎状态机 / 作息与 Nudge / V1–V25 验收套件
npm test

# 只跑验收套件（可带编号只跑单项，如 node verify/run.mjs V21）
npm run test:acceptance

# 构建 WebUI 客户端与样式
npm run build:webui
```

验收套件覆盖：V1–V16（契约、入站观测、白名单、配额与防打扰）、V21（nudge ≤ 400 字符）、V22（环境提示词 ≤ 220 字符）、V23（用户可见文案不点名其他工具）、V24（连续 3 次主动回合只用自建渠道）、V25（每次 `to` 与目标一致、无 `target_mismatch`），以及「默认配置不会向任何地址发送消息」。

人工验收（真实通道，需 NapCat/SnowLuma 已登录）：

1. 把 `whitelistPrivate` 设成自己的 QQ，确认 `outboundHttpUrl` 指向已开启的 OneBot HTTP 服务。
2. 让桌宠调用 `qq_initiative_trigger`（`address: "private:<你的QQ号>"`），观察回合里的 `qq_initiative_send` 回执。
3. 期望：回执为 `成功已发送到 private:<号>（message_id=...）`，QQ 端真实收到，`qq_initiative_status` 的今日次数 +1。
4. 把 `outboundMode` 改为 `external` 再触发：期望回执为 `[send failed] external_mode_unobservable`，次数不增加、审计记录为回滚。

---

## 8. 目录结构

```
cortico-world-qq-initiative/
├── package.json
├── describe.json               # 自描述：工具 + 事件
├── README.md
├── src/
│   ├── index.ts                # World 装配、自驱调度、入站观测、钩子结算
│   ├── config.ts               # 配置定义、三层分级、安全默认值、白名单解析
│   ├── types.ts                # 领域实体（会话活跃度、质押、回执）
│   ├── cortico-ambient.d.ts    # Core 契约类型镜像（不含契约外成员）
│   ├── outbound/
│   │   ├── adapter.ts          # 地址归一化与精确比对
│   │   ├── onebot.ts           # OneBot v11 HTTP 客户端（错误脱敏）
│   │   └── sender.ts           # builtin / external 双模式发信器
│   ├── tools/send.ts           # qq_initiative_send 工具
│   ├── state/{manager,quota}.ts# 原子持久化、三阶段配额状态机
│   ├── engine/{scheduler,routine}.ts
│   ├── monitor/activity.ts     # 入站观测与静默时长
│   ├── prompt/nudge_builder.ts # 主动回合提示（≤400 字符）
│   ├── webui/{panel,client}.ts # 控制台面板
│   └── ENV_PROMPT.md           # 环境提示词模板（≤220 字符）
├── test_engine.mjs
├── test_routine.mjs
└── verify/run.mjs              # V1–V25 验收套件（真实事件库 + 真实 HTTP + 真实钩子）
```

---

## 9. 致谢 / Credits

本扩展在设计与实现上参考了下列开源项目，代码与文案均为自行实现，未直接复制上游源码（除非在条目中明确写出）：

### 9.1 [Pal-AI-Lab/Cortico](https://github.com/Pal-AI-Lab/Cortico)

- **参考了什么**：World 契约本身——`World`（`envPromptVars` / `tools` / `start` / `stop` / `onRunPhase` / `onTurnEnded` / `onEventsSettled`）、`WorldHost`（`pushEvent` / `store`）、`ToolDef`（`tags` / `barrierAfter` / `endsTurn` / `handler`）、`RunPhase`，以及配置组 JSON Schema 的写法；仓内内置 QQ World 的「地址即 `conv`、群聊 `group:<群号>`、私聊 `private:<QQ号>`」约定。
- **改了什么**：本扩展不静态 import 框架运行时值（`cortico/*` 只做 `import type`），自带 OneBot HTTP 发信通道与事务化配额，World id 用独立的 `qq-initiative`，与内置 QQ World 并存而不冲突。

### 9.2 [Pal-AI-Lab/Coopanion](https://github.com/Pal-AI-Lab/Coopanion)

- **参考了什么**：桌面宠物宿主的装配方式、扩展目录布局与运行时数据目录（`ctx.dataDir`）。
- **改了什么**：本扩展只消费宿主提供的事件流与 `persist` 能力，不修改宿主代码。

### 9.3 [hth768/cortico-world-qq-final](https://github.com/hth768/cortico-world-qq-final)

- **参考了什么**：其 QQ 发信工具声明的风格（`tags: ['speak']` + `barrierAfter` + `endsTurn`）、「一次说完整段」的工具文案思路、失败回执统一带 `[send failed]` 前缀便于模型识别，以及 `meta.conv` 地址格式。
- **改了什么**：本扩展不依赖该扩展即可发信——`builtin` 模式自己走 OneBot v11 HTTP；它的发信工具只作为 `external` 模式的可选对接目标，本扩展不复用其连接、监听与媒体能力。

### 9.4 fat-fish 的 `qq_bot` 插件

- **参考了什么**：上游的 README 指出其本体来自 fat-fish 仓库的 `qq_bot` 插件（Python，含 `QQPlugin` / `QQAdapter` / 情绪模块）；本扩展只借鉴产品思路——私聊/群聊分流、白名单、按会话记录活跃度。
- **改了什么**：完全重写为 TypeScript 的 World 扩展，无 Python 运行时、无表情包/语音等媒体能力。
- **说明**：未能核实该仓库的公开地址，因此只写名称，不给链接，避免给出失效或错误的 URL。

### 9.5 协议与实现参考

- [OneBot v11 协议](https://github.com/botuniverse/onebot-11) — HTTP API 与 `send_private_msg` / `send_group_msg` / `get_login_info` 的返回结构。
- [NapCatQQ](https://github.com/NapNeko/NapCatQQ)、[SnowLuma](https://github.com/SnowLuma/SnowLuma) — 实际使用的 OneBot 协议端。

---

## 10. 版本历史

完整更新日志见 [CHANGELOG.md](CHANGELOG.md)。

---

## 11. 许可

MIT。
