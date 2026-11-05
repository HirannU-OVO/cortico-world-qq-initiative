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

## 工具列表

本扩展向模型注册了以下主动搭话相关的诊断与控制工具：

| 工具名 | 权限分类 | 作用与机制 |
| :--- | :---: | :--- |
| `qq_initiative_status(address?)` | 只读 | 查询当前主动搭话引擎的运行状态、作息时段、今日配额消耗及目标会话活跃度 |
| `qq_initiative_trigger(address, scene?, force?)` | 执行 | 手动触发对指定白名单会话的主动搭话测试（仍受白名单与基础安全约束） |
| `qq_initiative_reset(target, address?)` | 管理 | 手动重置每日已发配额或指定会话的未回复冷却计数 |
| `qq_initiative_send(to, text)` | 执行 | builtin 模式专用发信通道：向 `private:<QQ号>` / `group:<群号>` 发送一条消息，成功以平台回执为准 |

---

## 配置参数速查

所有配置项位于 `worlds.qq-initiative` 下：

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :---: | :--- | :--- |
| `enabled` | boolean | `false` | 主动搭话总开关（需先配置白名单） |
| `mode` | string | `"private"` | 搭话模式：`private`（私聊）、`group`（群聊）或 `all` |
| `whitelistPrivate` | string | `""` | 允许主动联系的私聊 QQ 号列表（纯数字，逗号分隔） |
| `whitelistGroup` | string | `""` | 允许主动发言的群号列表 |
| `dailyQuota` | number | `20` | 每日全局最大主动搭话次数 |
| `unrepliedThreshold` | number | `3` | 连续未回复阈值，达到后进入静默避让状态 |
| `privateMinIntervalMin` | number | `60` | 对同一好友搭话的最小时间间隔（分钟） |
| `routineEnabled` | boolean | `true` | 是否启用作息时间控制 |
| `sleepStart` / `sleepEnd` | string | `"23:30"` / `"08:00"` | 夜间深睡时段起止时间（`HH:mm`） |

### 运营层（配置文件，不进面板）

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `outboundMode` | `"builtin"` | 发信通道：`builtin` / `external` / `bridge`，改完需重启本 World |
| `outboundHttpUrl` | `"http://127.0.0.1:3000"` | OneBot v11 HTTP 服务端地址（builtin 模式） |
| `outboundHttpToken` | `""` | OneBot 访问 Token（亦可经环境变量 `QQ_PROACTIVE_ONEBOT_TOKEN` 提供） |
| `outboundTool` 等字段映射 | 见源码 | `external`/`bridge` 模式下的发信工具名与参数名映射 |

---

## 参考与致谢

本项目为原创实现。下表列明所参考的项目、参考内容及其边界：

| 项目 | 许可 | 我们参考了什么 |
| :--- | :--- | :--- |
| [OneBot v11 规范](https://github.com/botuniverse/onebot-11) | 见上游仓库 | 发信接口与消息段格式（协议标准） |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) / [SnowLuma](https://github.com/SnowLuma/SnowLuma) | 见上游仓库 | 本机 OneBot 实现（部署依赖，未包含其代码） |
| [cortico-world-qq-final](https://www.npmjs.com/package/cortico-world-qq-final) | MIT | 分段发送的消息形态与 `[表情包:路径]` 标记约定；实现独立编写 |
| [cortico-world-astrbot](https://www.npmjs.com/package/cortico-world-astrbot) | MIT | 桥接模式下 `astrbot_send_message` 的工具名与参数约定（依赖，未包含其代码） |

> **边界声明**：本仓库不包含任何第三方项目的源代码；与上游的交互均通过公开接口、协议或工具名约定完成。若权利人认为有不妥之处，欢迎提 issue 沟通处理。

---

## 许可证

[MIT License](LICENSE) © 2026 HirannU
