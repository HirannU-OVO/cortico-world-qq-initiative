# cortico-world-qq-initiative

> **Cortico World 扩展**：为 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 桌面宠物提供的**独立 QQ 主动搭话**扩展。按作息与白名单，在恰当的时机主动与好友或群聊互动。

- World id：`qq-initiative`；包名：`cortico-world-qq-initiative`
- 发信通道：三种模式二选一——内置 OneBot v11 HTTP 直发（**以平台确认回执为准**）、交给外部 World 的工具、或经 AstrBot 桥（模型调 `astrbot_send_message`）
- 配图联动：主动轮不自行发图，配图交给 `cortico-world-qq-stickers` 的 `qq_sticker_send`（掷骰与频控由表情扩展唯一裁决）
- 安全机制：装好后默认**处于关闭状态**且白名单为空，未经明确配置绝不主动打扰任何人

---

## 核心特性

- **作息感知与保护**：深度感知主人作息，深睡时段全面静默，午休时段降低互动频次；
- **白名单硬排除**：不在白名单内的对象绝不主动发起对话；
- **配额与冷却仲裁**：支持每日最大发言限额，对同一个人或同一个群设置独立的最小发言间隔；
- **防打扰与回话重置**：检测未回复次数，对方长时间未回应则自动休眠，对方一旦回话立即解除冷却；
- **三态事务化记账**：先校验资格并预占，只有底层真正收到发送成功回执才计入配额；
- **静默优先原则**：允许模型自主决策「此刻不适合打扰」，主动放弃搭话不扣除每日配额；
- **多通道发信适配**：`builtin`（OneBot 直发）、`external`（交给外部 World 的发信工具）、`bridge`（AstrBot 桥接，模型调桥的发信工具）三种模式，切换需重启本 World。

---

## 架构与工作流程

```text
Coopanion 桌宠调度器 (定时巡检 / 触发事件)
  │  触发主动搭话判定
  ▼
cortico-world-qq-initiative (裁决引擎)
  ├─ 作息状态机检查：深睡完全静默，午休降频
  ├─ 安全白名单过滤：硬排除未登记的好友与群聊
  ├─ 频控与配额仲裁：每日配额、单会话最小间隔、未回复静默避让
  ▼
大模型推理决策 (Agent)
  │  根据情境生成问候台词，或自主决策保持沉默（不扣配额）
  │  可选联动：调用 qq_sticker_send 进行情绪配图
  ▼
发信通道分发 (三模式)
  ├─ builtin  ── 本机 OneBot v11 HTTP 接口直发（NapCatQQ / SnowLuma）
  ├─ external ── 委派给宿主中其他 QQ 发信扩展
  └─ bridge   ── 经 AstrBot 桥由 astrbot_send_message 发出
```

---


## 配套插件

本扩展与 **[cortico-world-qq-stickers](https://github.com/HirannU-OVO/cortico-world-qq-stickers)** 配合使用：

- 主动搭话轮只负责把正文发出去，配图交给 `qq-stickers` 的 `qq_sticker_send`——掷骰、保底与冷却由表情扩展唯一裁决，本扩展不自行发图、不重复记账；
- 表情扩展未安装或被停用时，主动轮自然只发纯文字，不影响搭话本身。

两个插件可独立安装，同装时自动配合。

---

## 安装与快速上手

### 1. 放置扩展
将扩展目录放置于桌宠扩展目录：
```
%COOPANION_DIR%/data/extensions/local/cortico-world-qq-initiative/
```

### 2. 依赖服务
本扩展通过 OneBot v11 HTTP 接口发信，需确保本机已运行兼容的 OneBot 实现（如 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 或 [SnowLuma](https://github.com/SnowLuma/SnowLuma)）。

### 3. 安全启用步骤
1. **配置白名单**：在面板中填入允许主动对话的 QQ 号（`whitelistPrivate`）；
2. **测试与预览**：先使用「仅生成搭话词预览」功能检查语气与生成的台词；
3. **开启总开关**：确认发信服务正常后，开启 `enabled` 开始工作。

---

## 工具 / 接口列表

本扩展向模型注册了以下主动搭话相关的诊断与控制工具：

| 工具名 | 权限分类 | 作用与机制 |
| :--- | :---: | :--- |
| `qq_initiative_status(address?)` | 只读 | 查询当前主动搭话引擎的运行状态、作息时段、今日配额消耗及目标会话活跃度 |
| `qq_initiative_trigger(address, scene?, force?)` | 执行 | 手动触发对指定白名单会话的主动搭话测试（仍受白名单与基础安全约束） |
| `qq_initiative_reset(target, address?)` | 管理 | 手动重置每日已发配额或指定会话的未回复冷却计数 |
| `qq_initiative_send(to, text)` | 执行 | builtin 模式专用发信通道：向 `private:<QQ号>` / `group:<群号>` 发送一条消息，成功以平台回执为准 |

---

## 配置参数速查

### 面板可见：基础设置（`worlds.qq-initiative`）

| 面板显示名 | 配置 id | 类型 | 默认值 | 说明 |
| :--- | :--- | :---: | :---: | :--- |
| 发信通道 | `outboundMode` | 单选 | `builtin` | 发信链路：`builtin`（OneBot直发）/ `external`（外部扩展）/ `bridge`（AstrBot桥），改完需重启本 World |
| 允许它主动找你说话 | `enabled` | 布尔 | `false` | 主动搭话总开关，开启前需填入白名单 |
| 对谁主动说话 | `mode` | 单选 | `private` | 搭话模式：`private`（私聊）、`group`（群聊）或 `all`（两者） |
| 能主动找的 QQ 号 | `whitelistPrivate` | 字符串 | 无 | 允许主动联系的好友 QQ 号列表（纯数字，留空谁都不找） |
| 能主动说话的群号 | `whitelistGroup` | 字符串 | 无 | 允许主动发言的群号列表（纯数字，留空不在任何群里说） |
| 每天最多主动找你几次 | `dailyQuota` | 整数 | `20` | 每日全局最大主动搭话次数上限 |
| 连着几次没回就先不说 | `unrepliedThreshold` | 整数 | `3` | 连续未回复阈值，达到后进入静默避让状态，对方回话即重置 |
| 对同一个人最快多久说一次（分钟） | `privateMinIntervalMin` | 整数 | `60` | 私聊最小间隔，默认 60 分钟 |
| 对同一个人最久隔多久说一次（分钟） | `privateMaxIntervalMin` | 整数 | `360` | 私聊最大间隔，默认 360 分钟（6 小时） |
| 对同一个群最快多久说一次（分钟） | `groupMinIntervalMin` | 整数 | `180` | 群聊最小间隔，默认 180 分钟（3 小时） |
| 对同一个群最久隔多久说一次（分钟） | `groupMaxIntervalMin` | 整数 | `720` | 群聊最大间隔，默认 720 分钟（12 小时） |
| 按作息说话 | `routineEnabled` | 布尔 | `true` | 是否启用作息控制，深睡完全静默，午休降频 |
| 几点开始睡（HH:mm） | `sleepStart` | 字符串 | `23:30` | 夜间深睡起始时间 |
| 几点睡醒（HH:mm） | `sleepEnd` | 字符串 | `08:00` | 早晨醒来起始时间 |
| 几点开始午休（HH:mm） | `lazyStart` | 字符串 | `12:30` | 午休降频起始时间 |
| 几点午休结束（HH:mm） | `lazyEnd` | 字符串 | `14:00` | 午休结束时间 |

### 面板可见：高级设置（`worlds.qq-initiative:advanced`）

| 面板显示名 | 配置 id | 类型 | 默认值 | 说明 |
| :--- | :--- | :---: | :---: | :--- |
| 允许它判断「现在不该打扰」就闭嘴 | `allowSilence` | 布尔 | `true` | 允许模型自主决策此刻保持沉默，放弃搭话不扣配额 |
| 提示它称呼对方名字 | `withNickname` | 布尔 | `true` | 是否引导模型带上对方称呼，显得更自然 |
| 作息切换时主动说一句 | `announceRoutine` | 布尔 | `true` | 早/午/晚时段交替时主动发送问候 |
| 让它知道今天的额度和规矩 | `promptEnabled` | 布尔 | `true` | 是否在提示词中注入配额与纪律说明 |
| 自定义说话风格 | `promptText` | 字符串 | 无 | 附加提示词说明，留空使用内置人设风格 |

### 运营层（配置文件，不进面板）

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `outboundHttpUrl` | `"http://127.0.0.1:3000"` | OneBot v11 HTTP 服务端地址（builtin 模式） |
| `outboundHttpToken` | `""` | OneBot 访问 Token（亦可经环境变量 `QQ_PROACTIVE_ONEBOT_TOKEN` 提供） |
| `outboundHttpTimeoutMs` | `8000` | OneBot 请求超时（毫秒） |
| `outboundTool` 等字段映射 | 见源码 | `external`/`bridge` 模式下的发信工具名与参数名映射 |

---

## 常见排障

| 现象 | 原因 | 处理 |
| :--- | :--- | :--- |
| 开启后桌宠始终不主动搭话 | 未配置白名单或当前处于深睡时段 | 检查 `whitelistPrivate` 是否已填入你的 QQ 号（白名单为空时硬排除）；检查当前系统时间是否在 `sleepStart` ~ `sleepEnd` 之间 |
| 手动触发测试报 `QUOTA_EXCEEDED` 或 `UNREPLIED_LIMIT` | 每日配额耗尽或连续未回复达到阈值 | 等待次日配额重置或对方在 QQ 中回复一句；亦可调用 `qq_initiative_reset(target="all")` 手动重置 |
| 发信报错 `ECONNREFUSED` 或无反应 | OneBot HTTP 接口未启动或发信通道选错 | 检查本机 OneBot 服务（NapCatQQ / SnowLuma）是否正常监听；若走 AstrBot 桥接请将 `outboundMode` 改为 `bridge` 并重启本 World |

---

## 依赖与参考

| 上游项目 | 用途 | 许可 |
| :--- | :--- | :--- |
| [OneBot v11 规范](https://github.com/botuniverse/onebot-11) | 发信接口与消息段格式遵循的协议标准 | 见上游仓库 |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) / [SnowLuma](https://github.com/SnowLuma/SnowLuma) | 本机 OneBot 实现，作为部署运行依赖 | 见上游仓库 |
| [cortico-world-qq-final](https://www.npmjs.com/package/cortico-world-qq-final) | 分段发送与 `[表情包:路径]` 标记的消息形态约定参考 | MIT |
| [cortico-world-astrbot](https://www.npmjs.com/package/cortico-world-astrbot) | 桥接模式下 `astrbot_send_message` 的工具名与参数约定参考 | MIT |


## 许可证

[MIT License](LICENSE) © 2026 HirannU
