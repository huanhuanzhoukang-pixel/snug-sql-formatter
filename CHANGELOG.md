# 更新日志 / Changelog

## 1.1.1 — 2026-11-09

### 修正：上架后发现的失效链接

1.1.0 是首发版本，发布后发现 `package.json` 的 `repository` 指向
`https://github.com/zkcoding/snug-sql-formatter`，而该仓库并不存在（GitHub API 返回 404）。
`vsce` 打包时会把 README 里的相对路径自动改写成仓库地址，于是：

- Marketplace 页面上的**三张演示图全部裂图**（`images/demo.gif` / `comma.png` / `tablevswhitespace.png`）
- README 里 `NOTICE.md` / `LICENSE.txt` 的链接 404 —— 而这两个文件正是 MIT 合规声明所在
- 页面侧栏的 Source / Issues 按钮 404
- 用户在「问题」面板点规则 id，跳转的 `RULES_URL` 也是 404

现在改为真实仓库 `https://github.com/huanhuanzhoukang-pixel/snug-sql-formatter`：

- `package.json` → `repository.url`
- `extension.js` → `var RULES_URL = '...'`（锚点仍是 `#规则表`，DG-17 会校验它在 README 里真实存在）

> publisher ID 仍是 `zkcoding`，扩展 ID 仍是 `zkcoding.snug-sql-formatter` ——
> publisher 属于 Microsoft 账号，与 GitHub 账号本来就是两回事，不需要一致。

### 仓库维护

- `.gitignore` 补上 `.reasonix/**`（工具会话缓存，内含剪贴板截图）与 `test/preview/`
  （图标验收图），避免首次推送到公开仓库时带出本地数据。

### 回归

268 / 268 全绿，`npm run lint` 27 / 27，`npm run check` 通过。

---

## 1.1.0 — 2026-11-05

### 新增：SQL 诊断 / Lint

格式化时顺带检查 SQL 的错误写法与不规范写法，结果显示在 VS Code 的「问题」面板里，
波浪线精确落在出错的那个字符上。共 **20 条规则**，分三级：

- **error（8 条）** 语法层面确定错误：括号不配对、字符串未闭合、块注释未闭合、
  列表末尾多余逗号、子句顺序错、重复子句、保留字当别名、`IN ()` 空列表。
- **warning（7 条）** 能跑但结果几乎一定不是预期：`= NULL`、`DELETE`/`UPDATE` 缺 `WHERE`、
  笛卡尔积、`NOT IN` 接子查询、`JOIN` 缺 `ON`、`AND`/`OR` 混用无括号、`SELECT *`。
- **info（5 条）** 写法建议：隐式连接、`LIKE` 前置通配、`UNION` 未加 `ALL`、
  按列序号排序、`DISTINCT` 与 `GROUP BY` 冗余。

**设计取向：宁可漏报，不可误报。** 每条规则都只在文本本身足以证明时才开火 ——
`EXISTS (SELECT *)` 不报、`CROSS`/`NATURAL`/`ARRAY JOIN` 不要求 `ON`、
子句顺序只在括号深度 0 判定、`IS NULL` 不报、括号内的 `OR` 混用不报。

诊断与格式化**共用同一个词法器**，所以 `#` 是注释还是异或、反斜杠算不算转义、
`$$…$$` 在哪里结束，两边的判断必然一致。

### 新增配置

- `snugSql.lint.enabled`（默认 `true`）—— 总开关
- `snugSql.lint.disabledRules`（默认 `[]`）—— 要静音的规则 id

### 新增命令

- `snugSql.relint`（`Snug SQL Formatter: Re-check SQL`）—— 手动重跑当前文档的诊断

### 实现

- `src/lint.js` 是**纯函数**：`lint(text, opts)` → `{ ok, issues }`，不碰 VS Code API，
  可独立测试、可复用。
- 内核新增薄入口 `tokenizeForLint(text, dialect)`，只做分词 + 关键字标记，
  不改动任何全局态 —— 诊断是只读的，不应受格式化路径影响。
- 接入层在 `extension.js`：打开/切换文档立即分析、改动后 500 ms 防抖、
  关闭文档清诊断、配置变化全量重算。用**内容指纹**跳过重复分析。
- 超过 400 KB 的文档直接跳过（给 mysqldump 挂几千个波浪线只会让编辑器卡死）。

### 复检修正（2026-11-05，发布前）

新增的诊断功能在自检和集成测试里都是绿的，但复检时找出 6 个真缺陷，已全部修掉：

1. **指纹碰撞导致诊断停在旧内容上**（最严重）。内容指纹原本是
   「长度 + 首字符 + 末字符 + 中点字符」四点采样。把 `where b = 1` 改成
   `where c = 1` 时四个分量全都不变 → 指纹相同 → 跳过重算，
   波浪线停在**已经不存在的代码**上。改用 FNV-1a 全串散列
   （400 KB 以内 < 1 ms，3.3 MB 也就 8.9 ms）。
2. **全局 `LEX.dialect` 泄漏**。`markKeywords` 内部读进程级全局量，
   而那个值由上一次次 `sql()` 调用决定 —— 先用 ClickHouse 格式化一次，
   之后用 MySQL 方言做诊断，`array(1,2)` 会被误判成标识符。
   `tokenizeForLint` 现在临时设置并在 `finally` 里还原。
3. **防抖计时器全局共用**。分屏同时编辑两个文件时，后一次改动会
   `clearTimeout` 掉前一次，前一个文档的诊断永远停在旧内容。
   改为按 uri 各存一个计时器，关文档时取消。
4. **非 SQL 文档也被诊断**。事件回调不分语言：扩展被某个 `.sql` 激活后，
   在日志里打一行 `INFO select * from t took 120ms` 会被挂上「SELECT *」警告。
   自动触发现在只认 SQL 家族的语言标识；「重新检查」命令仍可强制检查任意文档。
5. **`relint` 命令可能没注册**。原本写在 `if (diagnosticCollection)` 里，
   宿主没有诊断 API 时命令面板会留下一个点了报 "command not found" 的条目。
   改为无条件注册，执行时再提示不可用。
6. **`LATERAL` / `UNNEST` 被当成笛卡尔积**。关联子查询右侧本来就可以
   引用左侧的列，即便没有 WHERE 也不是笛卡尔积。

每个缺陷都补了一条守卫测试（DG-12 ~ DG-16 及 LX 扩展），
并做了变异验证：把修复改回原样时对应测试必须变红。

### 修正

- 所有提示文案与输出通道名统一为 `Snug SQL Formatter`（22 处旧名残留已清）。

### 回归

- 新增 49 条诊断单测 + 17 条接入层测试，总数 **71 → 162**，全绿。
- 诊断用例里有 15 条是**反向断言**（不该报的绝不报），专门守着误报。

### 发布前补充（2026-11-09）

#### 修复（发布阻塞项）

- **`comma_location` 语义在 SQL 与 DDL 两条路径上相反**。SQL 路径里 `true` = 逗号补到
  上一行行尾（与原插件一致），DDL 列清单却写成了 `true` = 行首。现在统一为
  **`true` = 行尾、`false`（默认）= 行首**，`PARTITIONED BY` 分区列与 `Extract DDL`
  也一并跟随该配置。配置描述与 README 同步改正。
- **BigQuery / DuckDB 的 SELECT 尾逗号被误报 error**。这两种方言明确允许
  `select a, b, from t`，现在只在 SELECT 列表内放行（按括号深度判定），
  `f(a,)`、`in (1,2,)`、语句结尾仍报。
- **字号变化后屏幕宽度不重算**。缓存改存探测到的**像素**宽度，可见列数按当前
  `editor.fontSize` 实时换算。
- **运行中改宽度配置不生效**。新增 `refreshScreenProbe`，改动
  `detectScreenWidth` / `max_line_length` / `screen_width` 时重新探测。
- **未闭合 `q'[…]'` 被静默拆成 `q` + `'[…]`**、**`max/min` 猜成 STRING 不提示**、
  **DDL 的 EOL 被字面量内 CRLF 带偏**、**用户文本里的 U+E010/E011 被改写**、
  **CRLF 文档的单行 SQL 被写成裸 LF**、**`partial` 状态下缩进逐次累积** —— 均已修复。
- **诊断规则误报/漏报**：`BETWEEN … AND` 的 AND 不再计入逻辑与、
  `NATURAL [LEFT|FULL OUTER|INNER] JOIN` 不要求 `ON`、`SELECT *` 检查覆盖整个列表项。
- **Hive CLI 的 `list …` / `source …` 行级命令没被识别**。`HIVE_CLI_RE` 里有这两个分支，
  但 `tokenizeRaw` 的入口守卫只看首字符 `d` / `!` / `:`，于是 `list jar` 被当 SQL
  排版成 `list JAR`、`source x.sql` 与下一句并成一条语句 —— 用户拿去执行的脚本被改坏。
  守卫补上 `l` / `L` / `s` / `S`；`add …` 仍走 SQL 路径（ADD 是关键字，
  多路径与通配符由 `markPathTokens` 处理，产物 `ADD JAR /a/x.jar` 本来就对）。
- **点号链表名后的列清单括号丢空格**。`INSERT INTO db.t (a)` 排成 `INSERT INTO db.t(a)`，
  而同一句加引号（`db`.`t`）能得到空格 —— 因为"点号链前还有标识符 → 一定是函数调用"
  这条短路把 `db.t` 也吞了。现在补上链头前一格是否为位置词的判定，
  包/模式限定的函数调用（`dbms_output.put_line(x)`、`pkg.fn(x)`）仍保持紧贴。
- **诊断长度上限按 UTF-16 码元算，与格式化路径的字节口径不一致**。注释写"400 KB"，
  实现却比 `text.length`：400k 码元的中文实际 1.2 MB 仍会被分析。
  现在统一按 UTF-8 字节（`DEFAULT_MAX_BYTES`），旧参数名 `maxChars` 保留兼容但同样按字节解释。
- **`lastDiagnostics().changed` 把 `partial` / `partial-unbalanced` / `extracted` 报成 false**。
  `setDiag` 里写死 `changed = (status === 'formatted')`，而这三种状态其实都改动了文档。
  一旦有人拿这个字段判断"要不要写回"，就会漏写。现在允许调用方显式传 `changed`，
  不传时仍保持保守默认；同时 `cachePut` 把 `changed` 一起存进缓存并在命中时放回，
  否则同一份输入第二次调用（冷 → 热）会给出相反的结论。
- **屏幕宽度探测的诊断信息只写不读，而且只落在开发者工具控制台**。当时唯一的出口是一句
  `console.warn('屏幕宽度缓存可能已过期')` —— 用户问"为什么宽度是 160 列"时，既看不出缓存是
  哪次探测留下的、也说不出当时失败的原因。现在说明里带上 `缓存于 <ISO 时间>` /
  `上次探测失败：<reason>` / `显示器 N 台` / `窗口宽 Npx`，并经新的
  `reportScreenCacheSuspicion()` 同时写进「输出 → Snug SQL Formatter」。缓存正常时保持安静。

#### 性能

- **未知方言下的词法检测有两处纯属重复劳动**（不动主流程，只拿掉白跑的部分）：
  1. `detectLex` 为判反斜杠语义要整篇 `tokenizeRaw` 两遍（标准切法 + 反斜杠切法）。
     但 `scanQuoted` 里 `backslash` 开关只影响"遇到 `\` 时跳过下一个字符"这一个分支 ——
     文本里一个反斜杠都没有时两种切法必然逐字节相同。现在直接按标准处理。
  2. 未知方言的 `#` 启发式是一遍整篇逐字符扫描，而循环里唯一改变结论的分支都以
     `qc === '#'` 为前提。没有 `#` 时直接返回。
  3. `sql()` 里 `detectLex(text, dialect)` 调了两次、入参完全相同（纯函数），合并为一次。

  A/B 交替测量（各 5 轮取中位）：mysqldump 风格 360 KB 输入 1.02 s → 0.76 s（−26%），
  4000 条小语句 179 KB 0.47 s → 0.33 s（−29%），42 KB 0.11 s → 0.09 s（−19%）。
  同步执行与全量多趟的架构取舍**不变**，兜底仍是 `formatSizeGuard` 的 1 MB / 2 MB 两道阈值。

#### 测试框架

- `T()` 改为异步感知：旧实现 `ok: !!cond` 对 Promise 恒为 `true`，3 条异步用例
  从未真正执行过。现在等待落定并带 15 s 超时。
- 回归从左轮 162 条扩到 **268 条**，每条修复都有用例守护（并做过变异验证：
  把修复改回原样时对应用例必须变红）。

#### 许可与署名（上架前置）

- 新增 `NOTICE.md`：明确 `src/kernel.js`、`extension.js`、`probe.ps1` 衍生自
  **SQL Beautify**（MIT，© 2019 Clark Yu），并保留其完整许可原文。
- `LICENSE.txt` 增加 `Portions Copyright (c) 2019 Clark Yu`。
- `ACKNOWLEDGEMENTS.md` 删除"1.0.0 是独立实现"的表述，改为如实说明衍生关系。
- README 的「设计参考」与「许可」章节同步更新。

#### 打包

- `.vscodeignore` 排除 `AUDIT-REPORT.md`（34 KB 开发期文档）。
- `.vscodeignore` 排除 `.reasonix/**`（工具会话缓存，不该随扩展分发）。
- `.vscodeignore` 排除 `images/demo2.gif`（123 KB，README 未引用，纯占体积）。
- CHANGELOG 不再声称会自动成为 SQL 的格式化程序 —— 实际未声明
  `configurationDefaults`，首次 `Shift+Alt+F` 需要用户选择一次。

#### 图标

- **`images/icon.svg` 是唯一真源**：深蓝圆角底 + 三色 **SQL**（S 青蓝渐变 / Q 紫 / L 灰蓝）
  + 左右两组三段横条，中间压扁的箭头把两组连起来，表达"左 → 右：格式化前后的对齐"。
- 位图由该 SVG 经 Chrome headless 以 **8 倍设备像素比**渲染（`--force-device-scale-factor=8`
  且窗口同为 1024×1024，配合 `--virtual-time-budget` / `--run-all-compositor-stages-before-draw`
  保证字体与渐变画完），再裁出内容区、用 LANCZOS **逐级**缩到 512 → 256 → 128 → 64 → 32 → 16。
  逐级缩放比一步到位更不容易把三段横条和字母边缘糊掉。
- 产物：`images/icon-16/32/64/128/256.png`；`package.json` 的 `icon` 指向
  `images/icon-128.png`（Marketplace 只接受 PNG）。
- 修改图标时**只改 `images/icon.svg` 再重新导出位图**，不要手改 PNG。
- `resources/activitybar.svg`（24×24 单色）随包附带，供将来加视图容器时使用；
  当前扩展没有 `viewsContainers`，暂未被引用。

## 1.0.0 — 2026-11-04

首个正式版本。

### 功能

- **按屏幕宽度折行**：一行超过 W × 80% 就折行，折行点向前或向后舍入到完整逻辑块的边界。
  `price * cnt` 不会被拆开，`expr AS 别名` 不会被甩到下一行。
- **屏幕宽度探测**：启动时用 `probe.ps1` 探测本机最宽显示器的像素宽度，换算成编辑器可见列数。
  探测失败依次回落到 `editor.wordWrapColumn`、120 列。
- **DDL 格式化**：`CREATE TABLE` 的列定义、注释、约束按显示宽度对齐。
- **从 INSERT 反推建表 DDL**：解析目标表名与 SELECT 的列映射，推断类型并生成
  `CREATE TABLE`。`array(...)` / `map(...)` / `named_struct(...)` 按方言给出真实集合类型。
  推断不出类型的列会列在末尾供核对；含通配符时附提示说明哪些列需手工展开。
- **逗号位置**：前置（Excel 风格）或后置，两种风格都保持列对齐。
- **`AS` / 注释对齐**：按显示宽度补空格，CJK 字符按 2 列计算。
- **多方言**：30 余种语言标识（Hive / Spark / MySQL / PostgreSQL / Oracle / Trino /
  ClickHouse / BigQuery / Snowflake / DuckDB …），`#` 注释、反引号、`::` 转型、
  `$$` 分隔符等词法歧义按方言消解。
- **安全网**：格式化结果必须与原文字符级 token 等价，否则该语句原样返回。
  整篇不通过时按语句隔离，只回退出问题的那一条。

### 配置（9 项）

| 配置 | 默认 | 说明 |
|---|---|---|
| `snugSql.uppercase` | `true` | 关键字转大写 |
| `snugSql.comma_location` | `false` | `true` = 逗号放行首 |
| `snugSql.bracket_char` | `false` | 子查询/DDL 缩进用空格代替 Tab |
| `snugSql.dialect` | `"auto"` | 方言 |
| `snugSql.as_loc_cnt` | `0` | `AS` 对齐的最大列 |
| `snugSql.screen_width` | `0` | 显式屏幕列数 W |
| `snugSql.max_line_length` | `0` | 硬上限列数 |
| `snugSql.cjk_width` | `1.81818` | 汉字相对 ASCII 的渲染宽度 |
| `snugSql.detectScreenWidth` | `true` | 启动时探测显示器宽度 |

### 命令与快捷键

| 命令 | 快捷键 |
|---|---|
| `snugSql.beautifySql` | `Alt+Shift+S` |
| `snugSql.beautifySqlddl` | `Alt+Shift+L` |
| `snugSql.extractDdl` | `Alt+Shift+;` |

另注册为 SQL 的格式化提供器：`Shift+Alt+F` 可用，**首次**按下时 VS Code 会要求
在「选择格式化程序」里挑一次本扩展（扩展不写 `configurationDefaults` 去抢
其它 SQL 格式化器的默认值）。

### 工程

- 零运行时依赖。`dependencies`、`bundledDependencies`、`node_modules/` 均为空。
- 内核在 `src/kernel.js`，不依赖任何第三方格式化库。
- 71 条回归，`npm test` 可跑。
