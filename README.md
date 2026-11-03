# GitCracken

GitKraken 非商业用途工具集。

> 本仓库为维护分支。原项目停在 GitKraken 9.x，本分支新增 **GitKraken 10.x – 12.x** 支持
> （在 12.5.0 / Windows 上实测；macOS 与 Linux 的 ASAR 结构相同）。

## 支持的 GitKraken 版本

| GitKraken 版本 | 处理方式 | 特性名 |
|---|---|---|
| **10.x – 12.x**（当前 12.5.0） | 在 `app.asar` 内就地修补 `getLicensedFeatures` 选择器 | `v12`（别名 `advanced`） |
| ≤ 9.x | 旧的解包 / diff 补丁 / 重打包流程 | `pro`、`individual`、`standalone`、`selfhosted`、`development`、`staging` |

## 旧的 `pro` 补丁为什么失效

9.x 及更早版本中，`pro` 补丁改写的是 `decodeBody()`：让解码后的 phone-home 响应体
始终带上 `licensedFeatures: ["pro"]`。这条路径只在应用与授权服务器通信（即已登录）时执行。

GitKraken 10+ 有两处变化：

1. 付费档位改由 redux 选择器 `getLicensedFeatures` 决定，它读取的是**本地**
   `appSettings.licensedFeatures`；登出状态下启动流程根本不会调用 `decodeBody`，
   而登出分支还会把该设置重置为 `[]`。
2. 档位名称变了。`pro` 是旧档位，真正的付费判定是
   `advanced` / `teamsLicense` / `enterprise`，状态栏徽章跟随 `getIsAdvancedLicensed`。
   因此只写 `["pro"]` 仍然显示 `COMMUNITY`。

`v12` 特性直接改判定入口，而不是网络响应，所以不依赖登录状态。

## 环境要求

- Node.js 12 LTS 或更高（构建与测试使用 Node 24）
- `yarn`（或 `npm`）安装依赖

## 构建

```bash
yarn install
yarn build
```

## 使用

```bash
node dist/bin/gitcracken.js patcher [options] [actions...]
```

### 自动模式（推荐）

```bash
node dist/bin/gitcracken.js patcher
```

- GitKraken 10+ → `backup` + `patch`（`v12`，就地修改，不重新打包）
- GitKraken ≤ 9 → `backup` + `unpack` + `patch` + `pack` + `remove`（`pro`）

脚本会从 `app-X.Y.Z` 目录名识别已安装版本，并自动选择对应策略。

### 选项

| 选项 | 说明 |
|---|---|
| `-a`, `--asar <file>` | 指定 `app.asar`（默认：自动查找最新安装的 GitKraken） |
| `-d`, `--dir <dir>` | 指定解包后的 `app` 目录 |
| `-f`, `--feature <value>` | 特性名，可重复。10+ 用 `v12` / `advanced`；旧版本用 [`patches`](patches) 目录中的文件名 |
| `-c`, `--check` | 只检查 v12 补丁状态，不写入 |
| `--no-backup` | 不创建 `app.asar` 备份 |
| `-h`, `--help` | 显示帮助 |

### 动作

| 动作 | 说明 |
|---|---|
| `backup` | 备份 `app.asar`。v12 模式只生成一次 `app.asar.bak-before-gitcracken`；旧模式生成带时间戳的副本 |
| `patch` | v12 模式直接修补归档；旧模式修补解包目录 |
| `unpack` | 解包 `app.asar` 到 `app` 目录（仅旧模式） |
| `pack` | 将 `app` 目录重新打包为 `app.asar`（仅旧模式） |
| `remove` | 删除解包出的 `app` 目录（仅旧模式） |
| `revert` | 从 `app.asar.bak-before-gitcracken` 还原 `app.asar` |

不指定动作时，使用上面的自动序列。

### 示例

```bash
# 查看当前补丁状态
node dist/bin/gitcracken.js patcher --check

# 指定安装路径
node dist/bin/gitcracken.js patcher --asar "C:\Users\me\AppData\Local\gitkraken\app-12.5.0\resources\app.asar"

# 不覆盖已有备份
node dist/bin/gitcracken.js patcher --no-backup

# 回滚到打补丁前的归档
node dist/bin/gitcracken.js patcher revert

# 旧版 GitKraken（≤ 9.x）
node dist/bin/gitcracken.js patcher -f pro backup unpack patch pack remove
```

## v12 补丁原理

GitKraken 把授权逻辑打进 `app.asar` 中的三个 webpack bundle：

```
src/main/static/main.bundle.js
src/render/static/entryPoints/main/render.bundle.js
src/render/static/entryPoints/requestHandler/requestHandler.bundle.js
```

三者都包含同一个选择器：

```js
getLicensedFeatures=(0,ce.createSelector)(getAppSettings,(({licensedFeatures:re})=>re))
```

补丁把选择器的结果函数改成常量：

```js
getLicensedFeatures=(0,ce.createSelector)(getAppSettings,(()=>["advanced"]           ))
```

关键点：

- **等长替换。** 尾部空格把替换串补到与原串完全相同的字节长度，因此 ASAR 头部的
  offset / size 全部保持有效，归档是**就地**修改的。整个过程不执行 `asar pack`，
  也就不会重蹈旧流程把 `app.asar.unpacked` 全部打进包内、使安装体积从约 450 MB
  膨胀到约 900 MB 的覆辙。
- **不需要登录 / 联网。** 该选择器为 `getIsAdvancedLicensed`、`getIsAdvancedTierOrAbove`、
  `getIsProTierOrAbove`、`getIsPaidUser`、`getIsAboveFreeTier` 提供数据，
  覆盖所有付费闸门与状态栏徽章。
- **同步解包目录。** 如果存在旧流程遗留的 `resources/app` 目录，会对其中同名文件
  做同样的修改以保持一致；Electron 优先加载 `app.asar`，这一步只是兜底。

补丁成功后，状态栏会显示 `ADVANCED` 而不是 `COMMUNITY`。
`isPro` 为 `false` 是正常现象：12.x 中 `advanced` 高于 `pro`，持有高级授权后
不再报告为 `pro`。

### 校验

```bash
node dist/bin/gitcracken.js patcher --check
# ==> selectors to patch: 0 | patched markers: 3 | state: patched
```

或者使用 npm 脚本：

```bash
npm run check
```

## 免构建脚本

仓库根目录的 `gkcrack.js` 用纯 Node 实现了同一套就地修补，无需安装依赖、
无需构建，适合在只有 Node 的机器上使用：

```bash
node gkcrack.js --check   # 查看状态
node gkcrack.js           # 打补丁（备份：app.asar.bak-before-gitcracken）
node gkcrack.js --revert  # 还原备份
```

## GitKraken 更新之后

GitKraken 更新会安装新的 `app-X.Y.Z` 目录，补丁**不会继承**。每次更新后重新运行：

```bash
node dist/bin/gitcracken.js patcher
```

如需彻底阻止自动更新，在 hosts 文件中加入：

```text
0.0.0.0 release.gitkraken.com
```

## 常见问题

| 现象 | 处理 |
|---|---|
| 仍然显示 `COMMUNITY` | 退出 GitKraken，执行 `patcher --check`；若显示 `not patched`，再执行一次 `patcher` |
| 报错 `pattern match failed` | 该 GitKraken 版本改动了选择器写法。请附上版本号与 `--check` 输出提交 issue |
| 提示 `Already patched, nothing to do` | 归档中已有补丁，无需处理 |
| 遗留的 `resources/app` 目录 | 可以直接删除；Electron 加载的是 `app.asar`，该目录只是旧流程的解包残留 |
| 旧的 `app-X.Y.Z` 目录 | 可以直接删除；Squirrel 只使用最新的版本目录 |

## 作者

PMExtra、KillWolfVlad、Yifan

## 许可证

MIT。使用风险自负，不提供任何担保。
