# 发布前检查清单

面向"把插件交给朋友 / 公开仓库"之前逐项自查。每一项都写清**怎么查**，不写"注意脱敏"这种空话。

---

## 1. 个人信息脱敏

公开仓库里不能出现作者本人的任何真实信息。用下面的命令自查（在仓库根目录跑）：

```powershell
# 把 pattern 换成你自己的 QQ 号、昵称、常用目录，逐个搜
git grep -nE "你的QQ号|你的昵称|D:\\\\|C:\\\\|token="
git grep -nE "168[0-9]{6}|[0-9]{9,}"   # 长数字串，看是不是真号码混进来了
```

- [ ] 没有真实 QQ 号 / 群号（`123456789` 这类测试占位号可以留，但**不能出现在默认配置里**）
- [ ] 没有真实昵称（注释里的"XX优化"、测试 fixture 里的 `label` 都要改成中性的 `Alice` / `测试用户`）
- [ ] 没有本机绝对路径（`D:\Tools\...`、`C:\Users\...`）——README 里举例一律写 `<你的数据目录>`
- [ ] 没有 `outboundHttpToken`、Bearer token、API key 的明文；**截图发出去之前打码**
- [ ] 没有把真实的 `whitelistPrivate` / `whitelistGroup` 写进 README 或示例配置

> 现状（2026-11-03 自查）：`src/webui/client.ts` 注释里有作者昵称；`test_engine.mjs` / `test_routine.mjs` / `verify/run.mjs` 的 fixture 用了 `羽羽` 作 label。都不影响功能，但公开前要换掉。

## 2. 默认配置必须是安全默认

- [ ] `enabled: false`（装上默认不主动发消息）
- [ ] `whitelist` / `whitelistPrivate` / `whitelistGroup` 默认全空，**不预填任何号码**
- [ ] `outboundHttpUrl` / `outboundHttpToken` 默认空字符串，**不预填作者自己的桥接地址**
- [ ] `dailyQuota` 有上限（当前 20），不能是 `Infinity` / `0 表示无限`
- [ ] `sleepStart` / `sleepEnd` 有合理默认（当前 23:30–08:00）
- [ ] 新增配置项时，旧配置文件缺字段也能启动（走默认值），不能因为少一个 key 就崩

## 3. 状态文件与日志不进仓库

- [ ] `.gitignore` 覆盖：`node_modules/`、`*.log`、`*.jsonl`、状态文件（`proactive-state.json`、`qq-initiative-v2.json`）、`.env`
- [ ] `git status` 干净，`git ls-files` 里没有状态文件
- [ ] 状态文件里存了 `recentTopics`（**真实聊天摘要**），确认它不在仓库里，也不在打包的 zip 里
- [ ] `dist/` 的提交策略明确：要么忽略、要么只提交构建产物并与源码版本对应

## 4. 文案与提示词

- [ ] 用户可见文案里不点名其他插件 / 工具（发送工具名走配置，别硬编码）
- [ ] `ENV_PROMPT` 保持精简（当前 169 字符）；加东西前先问"这句能不能删"
- [ ] 报错信息说人话：不抛栈、不出现内部变量名
- [ ] 不承诺做不到的事（例如"自动回复所有消息"）

## 5. 版本与元数据一致

- [ ] **版本已收敛成干净的 `MAJOR.MINOR.PATCH`（去掉开发期的 `-dev.N` 后缀）**
      - 收敛步骤：改 `package.json` 的 `version`；`CHANGELOG.md` 顶部条目标题同步改回三段；两者必须一致
      - 校验：`CHANGELOG.md` 里有与 `package.json` 完全相同的 `## [版本号]` 标题
- [ ] `package.json` 的 `version`、`describe.json` 的版本、README 里的版本号三处一致
- [ ] `describe.json` 里的工具名、参数 schema 与 `src/` 实现一致（改过工具名要重新生成）
- [ ] `README.md` 有：安装、配置示例（脱敏）、能做什么 / 不能做什么、许可
- [ ] `LICENSE` 存在，且与依赖许可证不冲突

## 6. 发布前跑一遍

```powershell
npx tsc --noEmit          # 0 error
npm test                  # 全绿
node verify/run.mjs       # V1–V25 全绿
```

- [ ] 三项全绿
- [ ] 至少手动走一遍"从零安装 → 填白名单 → 触发一次 → 收到消息"，不完全依赖自动化
- [ ] 关掉网络 / 桥接不可达时，插件降级而不是刷屏重试；回执里能看到失败原因

## 7. 打包给别人用

- [ ] zip 里不含 `.git/`、`node_modules/`、状态文件、`.log`
- [ ] zip 里 `describe.json` 与源码版本对应
- [ ] 附一句"先去设置页填自己的白名单再打开开关"，否则装上不会有任何动静

## 8. 交给别人测之前想清楚

- [ ] 说明哪些数据是**本机**的、哪些会**发到网络**（主动搭话必然经过模型网关）
- [ ] 说明失败时会"无损回滚"（`silence_rollback`）：没真发出去不占额度、不推进未回复阶梯
- [ ] 留一个反馈渠道（issue / 群），并说明别把带真实 QQ 号的日志贴出去
