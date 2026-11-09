# 上架检查清单 / Publishing Checklist

目标：把 `zkcoding.snug-sql-formatter` 发布到 VS Code Marketplace。

**状态：1.1.1 已于 2026-11-09 上架**（公开）。仓库地址导致的裂图 / 失效链接已全部修复。
本清单保留完整流程作为留档；当前待办是发 **1.1.2**（P0 修复 + 重录演示动图，见 §4）。

下面按顺序做，每一步都写了"成功时看到什么"和"常见报错怎么办"。

---

## 0. 代码侧已就绪（本轮已完成，无需再动）

| 项 | 状态 |
|---|---|
| 许可合规 | `LICENSE.txt` 含 `Portions Copyright (c) 2019 Clark Yu`；`NOTICE.md` 保留上游 MIT 全文 |
| 署名 | `ACKNOWLEDGEMENTS.md`、`README.md`、`CHANGELOG.md` 均如实说明衍生关系 |
| 回归 | `npm test` 271 / 271 |
| 语法 | `npm run check` 通过 |
| 诊断自检 | `npm run lint` 27 / 27 |
| 打包 | `vsce package` 成功，22 个文件 / 515 KB |
| 排除项 | `test/`、`AUDIT-REPORT.md`、`PUBLISH-CHECKLIST.md`、`images/demo2.gif` 不进包 |

想自己复验一遍：

```powershell
npm run check && npm run lint && npm test
npx @vscode/vsce ls          # 看打包清单
npx @vscode/vsce package     # 出 vsix
```

`vsce package` 会先自动跑 `vscode:prepublish`（= 四个文件的 `node --check` + `node test/run.js`），
任何一条回归失败都会中止打包。

> 这里刻意**不再**写成 `npm run check && npm test`：vsce 通过 shell 调 npm，
> 嵌套的 `npm run` 会触发 `NPM_REENTRY_LIMIT`，打包直接失败。语义没变，只是把两条脚本内联了。

---

## 1. 注册 publisher ✅ 已完成（2026-11-09）

| 项 | 值 |
|---|---|
| Publisher ID | `zkcoding` |
| publisherId（GUID） | `bdd6286b-8ed7-41f0-bc4e-c33c738056cd` |
| 显示名 | huan huan zhou |

流程（留档）：<https://marketplace.visualstudio.com/manage> → Microsoft 账号登录 →
「Create publisher」→ ID 填 `zkcoding` → 同意 Marketplace Publisher Agreement → Create。

> publisher 属于 **Microsoft 账号**，与 GitHub 账号是两回事（本项目的 GitHub 仓库在
> `huanhuanzhoukang-pixel` 下，两者不必同名）。
> 目录名 `zkcoding.snug-sql-formatter-1.0.0` 不影响发布 ——
> vsix 内的身份只由 `package.json` 的 `publisher` + `name` 决定。

---

## 2. 拿到发布凭据（三种方式，选一种）

### 方式 A：Azure DevOps PAT（最通用）

1. 打开 <https://dev.azure.com>，右上角 User settings → **Personal access tokens**
2. 「New Token」：
   - **Organization**：选 **All accessible organizations**（选单个组织会报 401）
   - **Scopes**：勾 **Marketplace → Manage**（只需这一项）
   - 有效期按需（最长 1 年）
3. 复制 token（只显示一次）

### 方式 B：Entra ID 交互登录（不用管 token，适合首次）

```powershell
npx @vscode/vsce login zkcoding
```

按提示在浏览器里完成 Microsoft 登录，凭据会存在本机。
之后 `vsce publish` 不再需要 `-p`。

### 方式 C：OIDC 可信发布（CI 用，个人发布可跳过）

`vsce publish --oidc`，需在 Azure 侧配置 federated credential。

---

## 3. 建 GitHub 仓库（**别跳过**）

`package.json` 的 `repository` 与 `extension.js` 里的 `RULES_URL`
都指向 `https://github.com/huanhuanzhoukang-pixel/snug-sql-formatter`。
1.1.0 上架时这个地址还指向 `github.com/zkcoding/...`（该仓库不存在），
导致 Marketplace 页面的三张图、`NOTICE.md` / `LICENSE.txt` 链接、
Source / Issues 按钮全部 404 —— 已改为真实仓库地址并在 1.1.1 重新发布。

不建仓库的后果：

- Marketplace 页面的 **Source / Issues** 链接打不开
- README 里的三张演示图全部加载失败（`vsce` 会把相对路径改写成仓库 raw 地址）
- 用户在「问题」面板点规则 id，会跳到 404（`RULES_URL` 的 `#规则表` 锚点）

做法：

1. GitHub 上新建仓库 `huanhuanzhoukang-pixel/snug-sql-formatter`（公开）
   —— ✅ 已完成
2. 若换了账号或仓库名，改两处：
   - `package.json` → `repository.url`
   - `extension.js` → `var RULES_URL = '...'`（改完锚点必须仍是 `#规则表`，
     `test/run.js` 的 DG-17 会校验锚点在 README 里真实存在）
3. 推送 —— ✅ 已完成（`git init -b main` 在 1.1.1 那一轮做的）：

```powershell
git remote add origin https://github.com/huanhuanzhoukang-pixel/snug-sql-formatter.git
git push -u origin main
```

后续每次发版只要：

```powershell
git add -A
git commit -m "1.1.x: <改了什么>"
git push
```

> 推送前先跑一次 `git status` 确认 `.reasonix/` 与 `test/preview/` 不在待提交列表里。
> 两者都已在 `.gitignore` 里；`.reasonix/attachments/` 自带的 `.gitignore` 写的是 `*`，
> 工具会话截图不会被推上去。

`.gitignore` 已排除 `*.vsix`、`node_modules/`、`backup-*`、`.reasonix/`、`test/preview/`。
`AUDIT-REPORT.md`、`PUBLISH-CHECKLIST.md` 会进 GitHub（开发文档，公开无妨），
但不进 vsix。

> **顺序很重要**：先推 GitHub 再传 vsix。`vsce` 会把 README 里的相对路径改写成
> 仓库 raw 地址，仓库里没有对应文件时页面上就是裂图（1.1.0 就栽在这上面）。

---

## 4. 决定版本号

| 版本 | 状态 |
|---|---|
| `1.1.0` | ✅ 已于 2026-11-09 上架（首发）。因 `repository` 指向不存在的仓库，页面三张图 / `NOTICE.md` / `LICENSE.txt` 全部 404 |
| `1.1.1` | ✅ 已于 2026-11-09 上架。修复仓库地址，裂图与失效链接全部恢复 |
| `1.1.2` | 待发。修复 P0：`q` 开头的标识符被判成未闭合 q-quote，整篇 SQL 拒绝格式化；同时重录演示动图 |

**不要**用 `1.0.0`：`CHANGELOG.md` 里它是更早的里程碑，倒着发会让版本历史读起来矛盾。

版本号一旦发布**不能复用**（即使 unpublish，Marketplace 也会拒绝同号重发）——
所以 1.1.0 里那个错误的仓库地址没法就地改掉，只能靠发新版覆盖。

---

## 5. 发布

### 方式 A：网页上传（当前采用，不需要 PAT）

1. 本地打包：

```powershell
cd C:\Users\zhoukang.YW\.vscode\extensions\zkcoding.snug-sql-formatter-1.0.0
npx @vscode/vsce package
# → snug-sql-formatter-1.1.1.vsix
```

2. 打开 <https://marketplace.visualstudio.com/manage>，进入 publisher `zkcoding`
3. 点 **New extension → Visual Studio Code**，把 vsix 拖进去
4. 等几分钟做病毒扫描，通过后自动公开

1.1.0 就是这样发出去的（2026-11-09 07:37 UTC，`flags: validated, public`）。

### 方式 B：命令行发布（需要 PAT）

```powershell
npx @vscode/vsce publish -p <你的PAT>
```

或者先打包、检查、再单独发布：

```powershell
npx @vscode/vsce package
npx @vscode/vsce publish -p <你的PAT> --packagePath .\snug-sql-formatter-1.1.1.vsix
```

成功时会打印：

```
DONE  Published zkcoding.snug-sql-formatter v1.1.1.
```

⚠️ **PAT 不要写进任何文件或提交进仓库**。用环境变量更安全：

```powershell
$env:VSCE_PAT = "<token>"
npx @vscode/vsce publish
```

### 常见报错

| 报错 | 原因 / 处理 |
|---|---|
| `ERROR This publisher is not verified` / `401` | PAT 的 Organization 没选 **All accessible organizations**，或 scope 缺 `Marketplace → Manage` |
| `ERROR The Personal Access Token verification has failed` | PAT 过期；或 `publisher` 字段与登录账号的 publisher ID 不一致 |
| `ERROR Make sure to edit the README.md file` | README 太短或缺少必需段落；本项目已满足 |
| `ERROR Extension entrypoint(s) missing` | `main` 指向的文件不存在；本项目 `./extension.js` 存在 |
| `ERROR Vsce can't package extension with a missing repository` | `repository` 字段缺失（本项目已有） |
| `ERROR Version already exists` | 同号已发布；升版本号，或加 `--skip-duplicate` |
| `ERROR Icon not found` | `icon` 路径错；本项目 `images/icon-128.png` 已确认 128×128 PNG |

---

## 6. 发布后自检（10 分钟内能做完）

1. 打开 `https://marketplace.visualstudio.com/items?itemName=zkcoding.snug-sql-formatter`
   - 图标、演示 GIF、README 排版是否正常
   - **About 区块里应能看到**「本项目包含衍生自 SQL Beautify 的代码（MIT © 2019 Clark Yu）」
2. 在干净环境安装验证（不要用本地手工目录）：

```powershell
code --install-extension zkcoding.snug-sql-formatter
```

3. 打开一个 `.sql` 文件，确认：
   - `Alt+Shift+S` 格式化生效
   - `Shadow` 无 —— 扩展面板里应只有 Marketplace 版本，没有本地目录残留
4. 删掉本地手工目录 `~/.vscode/extensions/zkcoding.snug-sql-formatter-1.0.0`
   （它和 Marketplace 版 ID 相同，会互相覆盖；装完 Marketplace 版后它就是冗余的）

---

## 7. 后续发版

```powershell
# 改代码 → 更新 CHANGELOG → 升版本
npx @vscode/vsce publish patch   # 1.1.0 → 1.1.1
npx @vscode/vsce publish minor   # 1.1.0 → 1.2.0
npx @vscode/vsce publish major   # 1.1.0 → 2.0.0
```

`vsce` 会自动改 `package.json` 版本号并打 git tag（仓库必须是干净的）。

---

## 当前身份

| 项 | 值 |
|---|---|
| 扩展 ID | `zkcoding.snug-sql-formatter` |
| Publisher ID | `zkcoding`（GUID `bdd6286b-8ed7-41f0-bc4e-c33c738056cd`） |
| GitHub 仓库 | `huanhuanzhoukang-pixel/snug-sql-formatter` |
| 已上架版本 | `1.1.1`（2026-11-09，公开；修复了 1.1.0 的仓库地址错误） |
| 本地待发版本 | `1.1.2`（修复 `q` 开头标识符被判成未闭合 q-quote 的 P0 缺陷 + 重录演示动图） |
| 许可 | MIT（`Copyright (c) 2026 zkcoding` + `Portions Copyright (c) 2019 Clark Yu`） |
| 运行时依赖 | 无 |
| 回归 | 271 / 271 |
| 诊断规则 | 20 条 |
| 打包 | 22 个文件 / 515 KB |
