# Snug SQL Formatter 审计报告

- **被测目标**：`zkcoding.snug-sql-formatter` 1.1.0（目录 `C:\Users\zhoukang.YW\.vscode\extensions\zkcoding.snug-sql-formatter-1.0.0`）。
  1.1.1 是本报告的收尾补丁版，只改仓库地址与文档，审计结论不随之变化
- **审计日期**：2026-11-05
- **代码规模**：`extension.js` 1958 行、`src/kernel.js` 10498 行、`src/lint.js` 1255 行、`test/run.js` 2284 行，运行时零依赖（数字为 2026-11-09 复核时）
- **审计方式**：全文通读 + 100 余个针对性探测脚本（在 `$TMPDIR` 下运行，未写入仓库）+ 3000 轮随机 fuzz + 真实语料回归
- **基线**：审计当时 `npm test` 162/162、`npm run lint` 27/27；**2026-11-09 复核时**为 `npm test` 268/268、`npm run lint` 27/27。下文缺陷均已用脚本复现，均**不在**审计当时的回归覆盖范围内

---

## 0. 结论摘要

工程质量总体偏高：词法器覆盖了大量方言细节，安全网（token 等价 + 危险粘连指纹）设计思路正确，注释里记录的历次修复基本都能在代码里对上。但存在 **3 条会改写用户内容 / 破坏脚本语义的 P0 缺陷**，以及 **一批接入层与诊断引擎的行为缺陷**。

| 级别 | 数量 | 概述 |
|---|---|---|
| P0 | 3 | `ADD JAR/FILE` 路径被拼接成不存在的路径；通配符路径把后续 SQL 变成注释（代码被注释掉）；选区格式化改写跨行字符串内部的换行 |
| P1 | 8 | `Re-check SQL` 误走格式化管线并弹假警告、多选区重复执行；T-SQL `GO` 批分隔导致误报；诊断未复用路径分词；CTAS 误报保留字别名；`UNNEST/LATERAL JOIN` 误报缺 `ON`；未闭合块注释被报成"字符串未闭合"；`screen_width<80` 被静默抬升；改 `dialect` 不刷新诊断 |
| P2 | 11 | CTAS 带括号内容被拆坏、DDL 的 `comma_location` 与 `bracket_char` 失效、注释独占行产生孤立逗号、同表多条 INSERT 生成重复 DDL、`extract` 的 EOL 判定被字面量带偏、未闭合 dollar-quote 未检出、`INTO table` 大小写不一致等 |
| P3 | 6 | 文档与 `package.json` 数字不一致、README 声称"默认格式化器"但未配置、死代码、常量未使用、性能边界 |

**最重要的三件事**（建议发布前必修）：

1. `add jar /a/x.jar /b/y.jar` → `ADD JAR /a/x.jar/b/y.jar`：生成的路径不存在，且**安全网放行**；
2. `add jar /dir/*.jar;` 后面的整段脚本被 `/*` 注释吞掉，**后续 SQL 不再执行**；
3. 选区/命令格式化会把跨行字符串内部的 `\r\n` 与 `\n` 互换，**改变字符串值**。

---

## 1. 审计范围与方法

### 1.1 已读文件

| 文件 | 作用 |
|---|---|
| `extension.js` | VS Code 接入层：配置读取、宽度推导、屏幕探测与缓存、命令、选区合并、缩进保护、诊断接入 |
| `src/kernel.js` | 格式化内核：词法器 → 子句状态机 → 折行 → 对齐；安全网；LRU 缓存；DDL 与 Extract |
| `src/lint.js` | 诊断引擎：20 条规则，纯函数，复用内核词法器 |
| `test/run.js` | 审计当时 162 条回归；2026-11-09 复核时 268 条（内核 / 诊断 / 接入层 / 复核组） |
| `package.json`、`README.md`、`CHANGELOG.md`、`PUBLISH-CHECKLIST.md`、`.vscodeignore`、`probe.ps1`、`ACKNOWLEDGEMENTS.md` | 元数据与文档一致性核对 |

### 1.2 验证手段

1. **定向探测**：按功能分区构造输入（词法边界、子句、折行、对齐、DDL、Extract、诊断规则、接入层桩），逐条对比 `输入 → 输出 → lastDiagnostics()`。
2. **不变量 fuzz**：3000 轮随机 token 拼接，断言"幂等""字符串 token 逐字节不变""注释内容不变""不抛异常"——全部通过，说明核心不变量在常见组合下是稳的。
3. **真实语料**：53 条典型 Hive/Spark/MySQL/PG/Oracle/T-SQL/BigQuery/ClickHouse 语句，全部 `formatted`，无异常回退。
4. **接入层桩**：用最小 `vscode` 桩 + 真实行/列→偏移换算，端到端跑 `applyToEditor`、`runExtractCommand`、`refreshDiagnostics`、命令 handler。
5. **性能**：400 KB 中文 SQL lint 77 ms / format 254 ms；2000 列 + 5000 项 IN 的 format 189 ms；4000 条语句 339 ms。

---

## 2. P0 缺陷（会改写内容或破坏脚本语义）

### P0-1 `ADD JAR / FILE / ARCHIVE` 的多个路径被拼接成一个不存在的路径

**现象**

```
输入：add jar /a/x.jar /b/y.jar
输出：ADD JAR /a/x.jar/b/y.jar          ← 第二个路径丢了开头的空白，与第一个粘在一起
```

同样影响 `add file /tmp/x.txt /tmp/y.txt` → `ADD file /tmp/x.txt/tmp/y.txt`，以及三个路径的情况。

**根因**

1. `src/kernel.js:2281 markPathTokens()` 把**连续紧贴**的 token 标成 `path`。两个路径之间本来有空格，但下一段 `/b/y.jar` 的第一个 `/` 与上一段的最后一个 token 之间有空白，理论上应在 `if (prev.end !== tk.start) break;` 处断开——实际断开的只是**段**，随后 `formatTokens`（`src/kernel.js:3930`）在拼接阶段判断 `if (prevTok && prevTok.path)`，把**前一段的 path 属性当成同段**，于是把两个独立路径段直接用 `appendToken` 粘起来。
2. 安全网没拦住：`significant()` 对非字符串 token 做 `value.replace(/\s+/g, '').toUpperCase()` 比较，路径被切成 `/`、`a`、`x`、`.`、`jar`……去掉空白后两段完全相同，`sameTokenStream()` 返回 `true`（已用 `probe70.js` 直接验证 `sameTokenStream(a,b) === true`）。`dangerGlue` 也不覆盖"两个 path 段之间少了一个空格"。

**影响**

Hive CLI 里 `add jar` 是可以带多个路径的（`ADD JAR path1 path2`）。格式化后路径不存在，作业启动即 `ClassNotFoundException`。这是**会把能跑的脚本改成跑不了**的缺陷。

**建议**

- `formatTokens` 的路径拼接阶段改为按"段起点是否与上一段末 token 相邻"判断，而不是只看 `prevTok.path`；
- `sameTokenStream` 增加一条路径不变量：把 `path` token 的原文按段收集成数组，要求**段数与段内文本完全一致**（不能只看拼接后的字符流）。

**复现**：`probe64.js` / `probe66.js` / `probe96.js`（端到端写入文档）。

---

### P0-2 通配符路径 `*.jar` 把后续脚本变成块注释

**现象**

```
输入：
  add jar /user/hive/lib/*.jar;
  select a, b from t where a = 1;
输出：
  ADD JAR /user/hive/lib
  /*.jar;
  select a, b from t where a = 1;
```

输出里 `/*.jar` 被当成**块注释起点**，后面整段脚本（包括真正的 SQL）都落在未闭合的注释里，实际执行时被整体忽略。`lastDiagnostics().status === 'formatted'`，安全网判定通过。

**根因**

`/user/hive/lib/*.jar` 里 `/*` 紧贴，词法器先命中块注释分支（`/*` 到文件末尾，`unterminated = true`），把一个"路径里的星号"解释成注释开头；随后排版在注释前插入换行，注释把后续语句全部吞掉。`significant()` 对注释只要求"逐字节相同"，而注释内容确实没变，于是通过。

**影响**

比 P0-1 更严重：它不会报错，而是**静默地把整段 SQL 变成注释**。用户格式化后执行，得到的是"什么都没做"。

**建议**

- 词法器在判定 `/*` 为块注释前，先排除"处于路径上下文"的情形（前一个 token 与 `/` 紧贴且更早出现过 `/` 或路径特征）；
- 更稳妥：把"未闭合块注释"直接视为不可格式化输入（`status = 'unterminated-comment'`，原样返回），而不是照排；
- 安全网增加：格式化前后 `client/path/comment` token 的数量与类型序列必须一致。

**复现**：`probe103.js` / `probe110.js`。

---

### P0-3 选区/命令格式化改写跨行字面量内部的换行（字符串值被改）

**现象**（`extension.js:814 preserveRangeIndent` 的 `parts.join(nlStr)`）

| 文档 EOL | 字符串原文 | 格式化后 | 结果 |
|---|---|---|---|
| LF | `'a\r\nb'` | `'a\nb'` | 值被改 |
| CRLF | `'a\nb'` | `'a\r\nb'` | 值被改 |

内核自己是对的：`sql()` 用 `maskLiteralEols()` 把字面量内的 `\r\n` / `\r` 换成私有区占位符（`src/kernel.js:8645`），单独调用内核时 `'a\r\nb'` 原样保留（`probe23.js` 已验证）。

问题出在接入层：`preserveRangeIndent` 为了"按文档 EOL 拼接"，把结果 `split(/\r\n|\n|\r/)` 再 `join(nlStr)`。它虽然用 `buildLiteralMask` 判断"要不要给这一行补缩进"，但**重新 join 时对数据区内的换行一视同仁**，等于把内核刚保护好的字面量换行又统一成了文档 EOL。

**影响**

在 PG（`\r` 是值的一部分）、Hive/Spark 多行字符串、以及任何"字符串里含换行"的脚本里，格式化会**改变数据**。安全网查不出来：`significant()` 先做 EOL 归一，再比较 token 值。

**建议**

- `preserveRangeIndent` 只对**代码行**做 join：先按行切分，数据区内部保持原样（用 `collectLiteralSpans` 的结果判断该行的换行是否属于数据区），或直接复用内核的 `applyEolText` 思路（只替换代码区的 `\n`）；
- 增加回归：LF 文档 + 字面量内 CRLF、CRLF 文档 + 字面量内裸 LF，断言字符串 token 逐字节不变。

**复现**：`probe99.js` / `probe100.js`（两个方向都验证了"字面量值被改写: true"）。

---

## 3. P1 缺陷（功能错误 / 明显误报 / 配置失效）

### P1-1 `Re-check SQL` 命令误走格式化管线

`extension.js:1720` 的注册方式：

```js
registerCommand(context, 'snugSql.relint', function () { ... relintActive(); });
```

而 `registerCommand`（`extension.js:1088`）的约定是"第三个参数是 transform 函数"：

```js
function registerCommand(context, name, transform, extract) {
    context.commands.registerCommand(name, function () {
        return extract ? runExtractCommand(transform) : runCommand(transform);
    });
}
```

于是 `Re-check SQL` 实际执行的是 `runCommand(relintActive)`：它先做屏幕探测等待、再 `collectRanges()`、再对**每个选区**调用一次 `relintActive()`，并把返回值（`undefined`）当格式化结果处理。可观测后果：

- 状态栏提示被打印 **N 次**（N = 选区数，实测 2 个选区 → 2 次 "发现 2 处问题"）；
- 用户存在多选区时，命令行为变成"逐个选区重复诊断"；
- `applyToEditor` 在"结果为空"分支弹出与本操作无关的警告：`Snug SQL Formatter：选中的内容不是可识别的 SQL（或提取不到列），未做修改。`（`probe55.js` / `relint9.js` / `relint13.js` 已复现）。

**修复**：给 `relint` 单独注册，不要复用 `registerCommand` 的格式化封装。

### P1-2 T-SQL `GO` 批分隔符导致 `duplicate-clause` 误报

```
输入（tsql）：
  select a from t where a = 1
  GO
  select b from u where b = 1
诊断：syntax.duplicate-clause @ line 2（×2）
```

内核的 `splitStatements()`（`src/kernel.js:4189`）专门处理了 `GO`，但**诊断引擎自己另写了一份** `splitStatements()`（`src/lint.js:248`），只按 `;` 切分，`GO` 两侧的两条独立查询被当成一条语句，于是 "第二个 SELECT/FROM/WHERE" 被判成重复子句。

同一份文件里"格式化正确、诊断错误"，违反 README "诊断与格式化共用同一个词法器" 的承诺（共用的是词法器，不是语句切分）。

**修复**：把语句切分抽到内核统一导出（`splitStatementsForLint`），或在 lint 的切分里同样把深度 0 的 `GO` 当分隔符。

### P1-3 诊断引擎没有复用路径标记，导致路径里的 `from` / `where` 被当子句

`kernel.tokenizeForLint()`（`src/kernel.js:9953`）只调用了 `markGenericTypes` + `markKeywords`，**跳过了 `markPathTokens`**：

```
输入：add jar /a/where/b.jar
      select a from t order by a
诊断：syntax.clause-order ×2      ← 路径里的 where 被当成 WHERE 子句
```

路径含 `from` 时更糟：`syntax.clause-order` + `syntax.duplicate-clause`（`probe114.js`）。而未加引号的 `LOCATION /x/from/y` 同样触发。

**修复**：`tokenizeForLint` 里补上 `markPathTokens()`；或在 lint 的 `looksLikeSql`/`scanClauses` 之前把 path token 整体跳过。

### P1-4 CTAS / `CREATE VIEW … AS SELECT` 被误报"保留字被用作别名"

```
create table t as select a from s     → syntax.reserved-alias（指向 SELECT 这个词）
create or replace view v as select …  → syntax.reserved-alias
create table t as with x as (…) …     → syntax.reserved-alias
```

`ruleReservedAlias()`（`src/lint.js:445`）只要看到 `AS` 后面的第一个 word 在 `RESERVED_ALIAS` 表里就报错，没有排除"`AS` 后面接查询体（`SELECT` / `WITH` / `VALUES` / `TABLE`）"这种 DDL 语义。这是**每次用 CTAS 都会亮**的高频误报，与 README "宁可漏报，不可误报" 的取向直接冲突。

**修复**：`AS` 后若是 `SELECT` / `WITH` / `VALUES` / `TABLE` / `(` 则跳过；或在 `ruleReservedAlias` 里先判断语句头是否为 `CREATE … AS`。

### P1-5 `JOIN UNNEST(...)` / `JOIN LATERAL (...)` 被误报"JOIN 缺少 ON"

```
select a from t join unnest(arr) as v          → danger.join-without-on
select a from t join lateral (select 1) x      → danger.join-without-on
select a from t join (select id from u) x      → danger.join-without-on（Spark/Hive 隐式关联也报）
```

`ruleJoinWithoutOn()`（`src/lint.js:585`）只排除了 `CROSS` / `NATURAL` / `ARRAY` 三种前缀，没有覆盖 Trino 的 `CROSS JOIN UNNEST`、Hive 的 `LATERAL VIEW`、`JOIN UNNEST`、以及"右侧是子查询且没有 ON"的方言写法。虽然 `ruleCommaJoin` 已经为 `UNNEST/LATERAL/APPLY` 做了豁免，但同一条语句会从另一条规则重新亮起来。

**修复**：把"右表是函数调用（`UNNEST`/`TABLE`/`generate_series`）或 `LATERAL` 子查询"的形态从 `join-without-on` 排除；`JOIN (subquery) alias` 在没有 `ON` 时按方言决定是否报。

### P1-6 未闭合块注释被报成"字符串未闭合"，且定位错误

```
select 'ok' from t /* 未闭合        → syntax.unterminated-string @ 'ok'
select a from t where b = 'x' /* oops → syntax.unterminated-string @ 'x'
select q'[abc]' from t where b = 'x  → syntax.unterminated-string @ q'[abc]'
select N'x' … where b = 'oops        → syntax.unterminated-string @ N'x'
```

`ruleUnterminatedString()`（`src/lint.js:353`）只看 `toks.unterminated` 这一个布尔量，而词法器把"未闭合块注释""未闭合 dollar-quote""未闭合 q-quote"全都置成同一个标记；随后它按"首尾字符是否成对"扫描**所有**字符串 token，于是把前面那些**闭合正常**的字符串报成错误，真正的出错位置反而被掩盖。

**修复**：词法器把 `unterminated` 拆成 `{string: idx, blockComment: bool, dollarQuote: idx, qQuote: idx}`；诊断按类型分别报，并为"未闭合块注释"新增规则（目前完全漏报）。

### P1-7 `screen_width` 小于 80 时被静默抬到 80

```
snugSql.screen_width = 40  →  maxLine=64, hardLine=80（用户期望 32/40）
snugSql.max_line_length = 50 → maxLine=40, hardLine=50（对照：正确）
```

`extension.js:250` 对**自动探测路径**套用了 `MIN_WIDTH = 80`。但 `screen_width` 是用户显式配置，`package.json` 允许 `minimum: -1` 且描述为"显式指定列数 W，跨机器结果一致"。设 40 的用户拿到 80，属于"设了没用"。`max_line_length` 路径在 M9 已经改成 `MIN_CONFIGURED_WIDTH = 20`，`screen_width` 这条路径没有跟着改，两处口径不一致。

**修复**：显式配置的 `screen_width` 用 `MIN_CONFIGURED_WIDTH`；只有"探测/推断出来的宽度"才夹到 `[MIN_WIDTH, MAX_WIDTH]`。

### P1-8 修改 `snugSql.dialect` 不刷新诊断

`extension.js:1707`：

```js
context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (ev) {
    if (ev && ev.affectsConfiguration && !ev.affectsConfiguration('snugSql.lint')) return;
    ...
}));
```

只有 `snugSql.lint.*` 变更才重算，但指纹里明明包含了 `dialect`（`extension.js:1416`），注释也写着"用户改了 `snugSql.dialect` 或切换了文档语言模式，诊断却还是按旧方言算出来的"——**指纹算了，但没有事件来触发重算**。`probe54.js` 实测：把 `dialect` 从 `mysql` 改成 `pgsql` 后 `DiagnosticCollection` 的 set/delete 次数为 0。

**修复**：`affectsConfiguration` 判断加上 `snugSql.dialect`（以及 `snugSql.uppercase` 之外的其它影响规则的键）；或统一改成"任何 `snugSql.*` 变更都重算"。

---

## 4. P2 缺陷（细节错误 / 配置部分失效 / 观感倒退）

### P2-1 `CREATE TABLE … AS (SELECT …)` 的括号内容被当成列定义拆坏

```
输入：create table t as (select a, b from s)
输出：CREATE TABLE t AS
      (
          SELECT a
                ,b
          FROM s
      )
```

`ddl()` 的 CTAS 早退判据（`src/kernel.js:6109-6124`）要求 `AS` 的**下一个 token** 是 `SELECT` / `WITH`。带括号时下一个 token 是 `(`，判据不成立，于是 `(` 被当成列定义列表起点；`select` 作为"列名"原样保留小写，`a, b` 被拆成两列并各自缩进——整段结构被误读。

同类：`create table t (a int) as (select a from s)` 输出 `AS (SELECT a FROM s)`（内容不再换行排版）。

**修复**：CTAS 判据改为"`AS` 之后跳过任意个 `(`，再看是否 `SELECT`/`WITH`"；或者在 `sqlddl` 里先做一次顶层 `AS (` 检测。

### P2-2 `Beautify SQL DDL` 的 `comma_location` 完全不生效

`package.json` 声称 DDL 也跟随 `comma_location`，`sqlddl()` 也确实把它传进了 `Formatter`（`src/kernel.js:9851`）和缓存键。但 `ddl()` 渲染列清单时写死的是**前置逗号**（`src/kernel.js:6266`）：

```js
if (i !== rows.length - 1) colLines[lastColLine] += ',';
```

实测 `comma_location=false/true` 输出完全相同（`probe118.js`）。`convertCommaLocation` 只在 `formatLines()` 里被调用，`ddl()` 走的是自己的渲染循环。

**修复**：`ddl()` 按 `ddlOpts.commaLocation` 决定逗号挂在上一列行尾还是下一列行首；或在 `ddl()` 输出后过一遍 `convertCommaLocation`。

### P2-3 `Beautify SQL DDL` 的 `bracket_char` / `tabWidth` 在 CTAS / `CREATE VIEW` 的嵌套 SQL 里失效

`renderDdlGroup` 的 `nestedSql()`（`src/kernel.js:9536`）把 `bracketChar` 放进了 `extra`，但 `SQLBeautifyKernel.prototype.sql()` 只读**第 4 个位置参数** `bracket_char`，`extra.bracketChar` 全文没有任何读取点（`probe95.js`：`extra.bracketChar=true` 时输出仍含 `\t`）。

于是：

```
create table t as select a from (select b as a from s) x
   bracketChar=true  → 内层仍是 Tab 缩进
   bracketChar=false → 内层仍是 Tab 缩进
```

`CREATE VIEW … AS SELECT` 同样。用户的 `bracket_char` / `editor.insertSpaces` 在 DDL 命令里对嵌套查询失效，而同一份 SQL 用 `Beautify SQL` 却是对的。

**修复**：`sql()` 里 `bracket_char` 缺省时回落到 `extra.bracketChar`（并在缓存键里已经包含它）；或 `nestedSql` 直接把 `gBracket` 传在第 4 个位置参数上。

### P2-4 注释独占一行时产生"只有逗号的一行"

```
输入：select a,
      -- c
      b from t
输出：SELECT a
            ,
      -- c
            b
      FROM t
```

回归套件里有一条 `W-3 不再出现"只有逗号的一行"`，但它只覆盖了"折行导致"的场景；这个形态由"用户原文里注释独占一行 + 逗号前置"触发，输出里 `,` 单独占一行，随后一行注释、再一行列名——可读性反而变差，也与 `W-3` 的意图矛盾。（幂等性没问题，`probe30.js` 已验证。）

**修复**：`formatTokens` 在"逗号后紧跟注释 token"时把注释与逗号一起处理（逗号留在上一行行尾，注释跟在后面），或在 `convertCommaLocation` 里把"只有逗号的行 + 下一行注释"合并。

### P2-5 多条 INSERT 写同一张表时生成重复的 `CREATE TABLE`

```
输入：insert into t select a from s1; insert into t select b from s2;
输出：CREATE TABLE t ( a STRING )   ← 只有 a
      CREATE TABLE t ( b STRING )   ← 只有 b
```

`extractddl` 对每个 INSERT 各生成一份 DDL（`src/kernel.js:7108 units`），没有按目标表名合并。README 说"多条 INSERT 时每条目标表各生成一条 CREATE TABLE"——同一张表出现两次时，两条 DDL 都不完整（分别只有一半的列），复制执行第二条会报 "table already exists"，且两份都不含 s1/s2 的并集。

**修复**：按 `unit.target` 归并列清单；同一目标表的多条 INSERT 合成一条 DDL，并在重复列上给出提示。

### P2-6 `extractddl` 的 EOL 判定会被字面量内部的 CRLF 带偏

`src/kernel.js:6830`：

```js
var eolIn = /\r\n/.test(str) ? '\r\n' : (/\r/.test(str) ? '\r' : '\n');
```

裸文本正则，不看数据区。LF 文档里只要有一个跨行字符串含 `\r\n`，整份产出就被拼成 CRLF（`probe111.js`：纯 LF 文档 0 个 CRLF；加入一个字面量内 CRLF 后变成 5 个 CRLF、0 个裸 LF）。

`sql()` / `sqlddl()` 早就改用 `detectDocEol(text, lex)`（只看代码区），`extractddl` 漏改。

**修复**：改用 `detectDocEol(str, lex)`。

### P2-7 未闭合的 `$tag$…` dollar-quote 不报错，且被当 SQL 重排

```
select $tag$abc from t where x=1
  → formatted: SELECT $tag$abc\nFROM t\nWHERE x = 1
```

`matchDollarQuote()`（`src/kernel.js:1291`）找不到结束标记时返回 `-1`，词法器于是把 `$tag` 当普通标识符、`$abc` 当变量，后续 SQL 照常格式化。`$$abc` 这种恰好被切成 `$` + `$abc` 的情况会触发安全网回退（`reverted`），但带标签的 `$tag$` 不会。

而 `tokenizeForLint` 的 `unterminated` 也没有覆盖这种情况（`probe34.js` 显示 `unterminated=false`），诊断完全静默。

**修复**：`matchDollarQuote` 匹配失败时若形态确实是 `$tag$` 开头，置 `unterminated = 'dollar-quote'`，并让 `sql()` 直接原样返回（这类输入多半是函数体被截断）。

### P2-8 `INTO table` 里 `table` 保持小写，与同族关键字不一致

```
insert into table t select a from s  →  INSERT INTO table t
insert overwrite table t …           →  INSERT OVERWRITE TABLE t
truncate table t                     →  TRUNCATE TABLE t
```

`markKeywords` 的"位置词之后是表名"规则（`src/kernel.js:854`）把 `INTO` 后面的 `table` 判成表名并 `tk.keyword = false`。Hive 的 `INSERT INTO TABLE t` 里 `TABLE` 是关键字（与 `INSERT OVERWRITE TABLE` 对称），同一族语句两种大小写，很显眼。

**修复**：把 `TABLE` 从"位置词之后即表名"的排除名单里豁免（`INTO table` / `FROM table` 里的 `table` 仍可能是表名，可用"后面还跟一个标识符"作为判据）。

### P2-9 带引号的表名后紧跟 `(` 时丢空格

```
insert into `table` (a) values (1)   →  INSERT INTO `table`(a) VALUES (1)
insert into "db"."table" (a) …       →  INSERT INTO "db"."table"(a) VALUES (1)
insert into [table] (a) …            →  INSERT INTO [table](a)
```

`spaceBeforeParen`（`src/kernel.js:2319`）处理 `prev.type === 'quoted'` 时落到末尾的 `return false`。同一份 SQL 里未加引号的表名会得到 `t (a)`，加引号就变成 `t(a)`——语义等价，但风格不一致，且与 `sql-formatter` / `sqlfluff` 的输出习惯相反。

**修复**：`quoted` 类型沿用 word 的判定（看 `prevPrev` 是否为 `INTO`/`TABLE`/`FROM` 等位置词）。

**复核补充（2026-11-09）**：上面这条修复只覆盖了 `quoted` / `string` 两种引号形态。
**未加引号的点号链表名**走的是 word 分支，被更早的一条短路拦住了：

```
insert into t (a) values (1)          →  INSERT INTO t (a) ...          ✔
insert into `t` (a) values (1)        →  INSERT INTO `t` (a) ...        ✔
insert into db.t (a) values (1)       →  INSERT INTO db.t(a) ...        ✘
insert into `db`.`t` (a) values (1)   →  INSERT INTO `db`.`t` (a) ...   ✔
```

原因是 P3-1 为了修 `dbms_output.put_line(i)` 而加的"点号链前面还有标识符 → 一律不留空格"。
它把 `db.t` 也当成包限定函数了。修法与引号分支对齐：再往前看一格（`last4`），
是 `INTO` / `TABLE` / `FROM` 这类位置词时判为"库名.表名 + 列清单"，留空格。
`dbms_output.put_line(i)` 的 `last4` 是 `begin`，不受影响。回归用例 RV-4 / RV-5 守这对相反行为。

### P2-10 `as_loc_cnt` 的负数分支在接入层被"归零"

`extension.js:260-262`：

```js
var asLocCnt = Number(cfg.get('as_loc_cnt'));
if (!isFinite(asLocCnt)) asLocCnt = 0;
if (asLocCnt === 0) asLocCnt = maxLine;
```

负数原样传给内核是**对的**（内核把它映射成 `Infinity`），但 `readOptions` 返回的 `asLocCnt = -2` 与 `package.json` 的 `minimum: -1` 不符（配置层会拒绝 `-2`，所以只是潜在问题）。更实际的问题：`asLocCnt = -1` 表示"不限制"，但 `alignAsGroup` 里 `c <= asLocCnt` 对 `Infinity` 成立，行为正确——这条更多是"配置语义没有测试覆盖"。

### P2-11 `not-ddl` / `ambiguous-escape` 两条失败原因在命令路径上完全静默

```
Alt+Shift+L 对一段普通 SELECT → 什么都没发生，无任何提示
```

`applyToEditor` 的 `untouched` 名单里包含 `not-ddl` / `ambiguous-escape`，但"没有替换时"的提示分支（`extension.js:929-960`）只区分 `empty` / `reverted` / `unbalanced` / `errored` / `notSql` / `unchanged`。`not-ddl` 与 `ambiguous-escape` 落到最后，什么都不弹（`probe55.js` / `probe71.js` 实测 `msgs=[]`）。

内核 `lastDiagnostics().reason` 里其实写好了完整原因（"这不是 DDL 语句…" / "文本里的反斜杠转义有歧义…请设置 snugSql.dialect"），只是没被展示。`reportNoChange`（`extension.js:1542`）的过滤名单也漏了这两种。

**修复**：把 `not-ddl` / `ambiguous-escape` / `partial-unbalanced` / `partial` 一并纳入提示分支，直接展示 `diag.reason`。

---

## 5. P3 问题与不足（文档、一致性、可维护性）

### P3-1 文档与实现不一致

| 位置 | 声明的数字 | 实际 |
|---|---|---|
| `README.md:83` | "共 9 项" 配置 | `package.json` 实际 11 项（含 `lint.enabled` / `lint.disabledRules`） |
| `package.json` `dialect.enumDescriptions` | 18 个枚举值 | 只有 11 条描述，`trino` / `presto` / `redshift` / `duckdb` / `sqlite` / `db2` / `databricks` 缺描述 |
| `README.md:173` | "本扩展注册为 SQL 的默认格式化器" | `package.json` 里**没有** `contributes.configurationDefaults`（`[sql].editor.defaultFormatter`），首次 `Shift+Alt+F` 会弹出"选择格式化程序" |
| `PUBLISH-CHECKLIST.md:88` | "npm run lint # 诊断引擎自检 27 条" | 与 README 的"19 条规则"表述口径不同，容易被误读为规则数 |

**复核结论（2026-11-09）：以上四条均已修，本表仅作历史记录。**
README 已改为"共 11 项"；`enumDescriptions` 已补齐到 18 条；
"默认格式化器"的表述已删除并改为"首次需选择格式化程序"；
`PUBLISH-CHECKLIST.md` 的分项已注明"27 条自检"指的是自检用例数、规则数为 20 条。
回归用例 PK-2 守着文档表述与 `package.json` 的一致性。

### P3-2 死代码与未使用常量

- `extension.js:46` `DEFAULT_MAX_LINE` 计算后**从未被引用**；
  **复核结论（2026-11-09）**：`extension.js` 里已不存在该常量（`src/kernel.js:16`
  那个是有引用的默认宽度），条目过时；
- `src/kernel.js` 的 `HIVE_CLI_RE` 有四类行级命令（`list` / `delete` / `source` / `add`），
  但 `tokenizeRaw` 的入口守卫只看首字符 `d` / `!` / `:`，`l` / `s` 开头的行根本进不来
  —— `list jar` 会被当 SQL 大写成 `list JAR`，`source x.sql` 与下一句并成一条语句。
  **已修（2026-11-09）**：守卫补上 `l` / `L` / `s` / `S`，`add …` 仍走 SQL 路径
  （ADD 是关键字，`markPathTokens` 负责多路径与通配符，产物 `ADD JAR /a/x.jar` 正确）。
  回归用例 RV-1 / RV-2 守正向，RV-3 守"`list`/`source` 作列名不被误伤"的反向。
- `extension.js:318-322` 的注释写着"屏幕探测（可选，默认关闭）"，与同文件 190 行"探测默认启用"和 `package.json` 的 `default: true` 矛盾，属于历史注释未清理；
  **复核结论（2026-11-09）**：该注释已改为"屏幕探测（可选，默认启用）"，条目过时；
- `screenCacheSuspicion()` 只在 `console.warn` 里用一次，`cachedScreenInfo` 的大部分字段没有消费方
  （**已修 2026-11-09**）：诊断说明现在带 `缓存于 <ISO 时间>` / `上次探测失败：<reason>` /
  `显示器 N 台` / `窗口宽 Npx`，并经新的 `reportScreenCacheSuspicion()` 写进
  「输出 → Snug SQL Formatter」通道（不再只落在开发者工具控制台）。
  `at` / `error` / `monitorCount` / `windowPx` 四个字段从只写变成真实消费，
  回归用例 SD-3.1 / SD-3.2 / SD-3.3 守住正向、通道与"正常时不报警"三个方向。

### P3-3 `lastDiagnostics().changed` 语义不完整

`setDiag(status)`（`src/kernel.js:8473`）把 `changed` 定义为 `status === 'formatted'`。于是 `partial` / `partial-unbalanced` / `extracted` / `unchanged` 的 `changed` 都是 `false`，即使 `partial` 确实改动了文档（`probe68.js` 的 `partial-unbalanced` 输出已明显变化，但 `changed: false`）。目前扩展层没有消费这个字段，属于"埋着的坑"——一旦有人用它判断是否写回，就会漏写。

**已修（2026-11-09）**：`setDiag` 增加第三个参数 `changed`，不传时保持原来的保守默认。
`partial` / `partial-unbalanced` 显式传 `true`，`extracted` 按 `r !== text` 实算。
同时补掉了配套的一处：`cachePut` 只存了 `{status, reason}`，第二次调用命中缓存时
`changed` 会退回默认值 —— 现在把 `changed` 一起存进缓存并在命中时原样放回，
冷热路径结论一致。回归用例 RV-8 / RV-9 / RV-10 分别守"改动了要报 true"、
"没改动必须是 false"、"冷热缓存一致"。

### P3-4 诊断的长度上限口径与格式化不一致

`MAX_LINT_CHARS = 400000` 是 **UTF-16 码元数**（`extension.js:1399` 用 `text.length`），而格式化路径用 `textByteLength()` 按 UTF-8 字节判断。一份 400k 字符的中文 SQL 实际 1.2 MB，会被 lint 分析（实测 77 ms，尚可接受），但语义上"400 KB"的注释与实现不符；反过来纯 ASCII 的 400 KB 文件恰好在边界上。建议统一用字节数，并在注释里写明单位。

**已修（2026-11-09）**：`MAX_LINT_CHARS` 改名 `MAX_LINT_BYTES` 并在 `extension.js` 与 `src/lint.js` 两端都改用 UTF-8 字节判定（`textByteLength` / `utf8Length`）。旧参数名 `maxChars` 保留兼容，但数值同样按字节解释。回归用例 RV-6 / RV-7 守这两个口径。

### P3-5 性能边界

- 4000 条语句（175 KB）format 339 ms、lint 98 ms。`formatOnSave` 默认 750 ms 预算下，这个规模已经接近上限，但仍是**同步**执行、占用扩展宿主主线程（`formatSizeGuard` 只在 1 MB / 2 MB 设阈值）。
- `compactLines` / `wrapLines` / `alignAs` / `alignComments` 都是全量 O(n) 多趟，没有增量或分块策略。对 2 MB 以下的输入可接受，但对 `mysqldump` 类的混合文件（多为 `INSERT`，本可快速跳过）仍会全量排版。

**复核结论（2026-11-09）：部分已修，架构取舍部分保持不改。**

已经拿掉的是三处**纯重复劳动**，都不动主流程：

1. `detectLex` 在未知方言下为判反斜杠语义要整篇 `tokenizeRaw` **两遍**。而
   `scanQuoted` 里 `backslash` 开关只影响"遇到 `\` 时跳过下一个字符"这一个分支 ——
   文本里一个反斜杠都没有时两种切法必然逐字节相同，这两遍是白跑的。现在直接按标准处理。
2. 未知方言的 `#` 启发式是一遍整篇逐字符扫描，而循环里唯一改变结论的分支都以
   `qc === '#'` 为前提。没有 `#` 时直接返回。
3. `sql()` 里 `detectLex(text, dialect)` 调了两次、入参完全相同，而它是纯函数 —— 合并为一次。

实测（A/B 交替测量、各 5 轮取中位）：mysqldump 风格 360 KB 输入 1.02 s → 0.76 s（−26%），
4000 条小语句 179 KB 0.47 s → 0.33 s（−29%），42 KB 0.11 s → 0.09 s（−19%）。
`PF-1…PF-8` 八条用例守住"短路没有改变语义"（含 PF-2 歧义反斜杠仍原样返回、
PF-6/PF-7 明确方言时捷径必须让路）以及一条宽松的上限（4000 条 < 1500 ms）。

**仍然成立、且刻意不改的部分**：同步执行 + `compactLines` / `wrapLines` / `alignAs` /
`alignComments` 全量多趟。改成异步或分块会动到内核主流程，首次上架不值得承担这个风险；
兜底仍是 `formatSizeGuard` 的 1 MB / 2 MB 两道阈值。mysqldump 类文件（多为 `INSERT`）
仍会全量排版。

### P3-6 测试覆盖的结构性缺口

审计当时 162 条用例质量不错，但**所有 P0/P1 都测不出来**，原因是断言方式集中在"某个子串存在"：

- `A-05` / `E-1` 只测了 LF 文档 + 单个跨行字符串，没有测"文档 EOL 与字面量内换行不同"的交叉情形（P0-3）；
- `W-3` 只测"折行产生"的孤立逗号，没有测"原文注释独占行"（P2-4）；
- 没有 `ADD JAR` / 通配符路径 / `GO` 批次 / `UNNEST JOIN` / CTAS 的用例（P0-1、P0-2、P1-2、P1-4、P1-5）；
- 接入层测试的 `vscode` 桩里 `registerCommand` 只是记录名字，没有验证"命令 handler 的返回值/副作用是否符合预期"，所以 `relint` 走错管线（P1-1）没被发现。

建议补一组"**不变量测试**"（对所有语料断言：字符串 token 逐字节不变、注释不变、`path` 段数与内容不变、幂等），比逐条枚举更能防止回归。

**复核结论（2026-11-09）**：前三条已补齐 —— `R-1` / `R-2` 覆盖 `ADD JAR` 多路径与通配符，
`R-15` / `R-16` 覆盖字面量内换行与 EOL 交叉，`AG-1` / `AG-1.2` 覆盖 `partial` 幂等与缩进稳定，
`LX-54` 覆盖 `UNNEST JOIN`。第四条（`registerCommand` 只记名字）**已补齐**：
`registerCommand` / `registerTextEditorCommand` 的桩改为保留回调，`workspace.openTextDocument`
补上实现并记录产物，新增 `CH-1…CH-5` 五条端到端用例 ——
`beautifySql` 真的写回、`extractDdl` 开新文档且不动源编辑器、`relint` 只写诊断不碰文本、
无编辑器时给提示而不抛异常、JSON 不被当 SQL 写回。`AG` 组之外，
命令 handler 的返回值与副作用现在都有断言。

同时补了 `SD-3.1…SD-3.3`（屏幕缓存诊断必须带时间戳 / 失败原因 / 显示器台数，
并真正写进输出通道）与 `PF-1…PF-8`（词法短路没有改变语义，且守一条宽松的性能下限）。

---

## 6. 架构层面的观察

### 6.1 做得好的地方

- **安全网的分层设计**：`significant()`（token 级）+ `dangerGlue()`（粘连指纹）+ `ambiguous-escape` 早退，三层互补；`neutral` / `guarded` / `hard` 三档的取舍有清晰的注释解释。
- **语句级隔离**：整篇不通过时 `formatByStatement()` 逐条重试，把损失限制在出问题的语句上。
- **字面量保护**：`maskLiteralEols` / `protectLiteral` / `protectedRanges` 这一套把"数据区"和"代码区"分得很清楚，内核路径上几乎所有 EOL 处理都走它。
- **方言词法**：`BACKSLASH_DIALECT` / `HASH_DIALECT` / `PG_ONLY_OPS` / `pgOpAllowed` 对 `#`、反斜杠、PG 运算符的处理相当细致，并且有"未知方言走启发式 + 歧义即原样返回"的兜底。
- **缓存正确性**：`SQL_CACHE` 的 key 覆盖了全部影响输出的参数 + 进程级全局态快照（`snapGlobals`/`restoreGlobals`），并用双哈希 + 完整 key 二次校验防碰撞。

### 6.2 结构性风险

1. **全局态过多**：`LEX` / `JOIN_CASE` / `CJK_WIDTH_RATIO` / `TAB_WIDTH` 都是模块级可变状态，靠 `snapGlobals`/`restoreGlobals` 手工维护一致性。这是 P2-3 这类"某条路径忘了传参就失效"的根源。建议把词法选项收进 `Formatter` 实例（或显式传入 `tokenize`），只保留缓存需要的快照。
2. **两条并行的语句切分**：内核 `splitStatements()`（处理 `GO`/`DELIMITER`/括号）与 lint `splitStatements()`（只按 `;`）各写一份，已经导致 P1-2。应合并为单一实现。
3. **两条并行的"数据区"识别**：内核 `protectedRanges()` 与接入层 `collectLiteralSpans()` / `buildLiteralMask()` 各自实现，前者已修好 EOL 语义，后者在 P0-3 上漏了。应把接入层改为调用内核导出的同一套区间计算。
4. **接入层的 `untouched` 状态名单散落三处**（`applyToEditor`、`doRangeDocument`、`reportNoChange`），新增状态容易漏（P2-11 就是这么漏的）。应定义统一的 `NO_CHANGE_STATUSES` 常量。
5. **`registerCommand` 的封装过窄**：它假设"命令 = 对一个 transform 逐选区应用"，`relint` 这种"无副作用命令"被硬塞进同一个壳（P1-1）。应把 `relint` 改成独立注册。

---

## 7. 修复优先级建议

| 顺序 | 缺陷 | 理由 | 预估工作量 |
|---|---|---|---|
| 1 | P0-2 通配符路径吞语句 | 静默改变脚本执行行为，最危险 | 小（词法器 + 安全网各一处） |
| 2 | P0-1 多路径拼接 | 破坏 `ADD JAR`，作业直接失败 | 小（`formatTokens` 路径段判断） |
| 3 | P0-3 字面量换行被改写 | 改变数据值，安全网无法发现 | 中（接入层改为复用内核 EOL 逻辑） |
| 4 | P1-1 `relint` 走错管线 | 命令行为完全错误，且弹假警告 | 小（独立注册） |
| 5 | P1-3 / P1-2 / P1-5 | 三条高频诊断误报，直接损害 lint 可信度 | 小~中 |
| 6 | P1-4 / P1-6 | CTAS 必报、未闭合注释定位错 | 小~中 |
| 7 | P1-7 / P1-8 | 配置"设了没用" | 小 |
| 8 | P2-1 / P2-2 / P2-3 | DDL 命令的配置与结构问题 | 中 |
| 9 | P3 文档与测试 | 发布质量 | 小 |

---

## 8. 附录：复现脚本清单

所有脚本位于会话临时目录（未写入仓库），可直接用 `node <script>` 运行：

| 脚本 | 验证内容 |
|---|---|
| `probe64.js` / `probe66.js` | P0-1 多路径拼接 |
| `probe70.js` | P0-1 安全网为何放行（`sameTokenStream` 返回 true） |
| `probe96.js` | P0-1 端到端写入文档 |
| `probe103.js` / `probe110.js` | P0-2 通配符路径吞语句 |
| `probe99.js` / `probe100.js` | P0-3 字面量换行被改写（双向） |
| `relint9.js` / `relint13.js` | P1-1 `relint` 副作用 |
| `probe68.js` / `probe69.js` / `probe88.js` | P1-2 `GO` 误报 |
| `probe114.js` / `probe115.js` | P1-3 路径分词缺失 |
| `probe28.js` / `probe98.js` | P1-4 CTAS 误报 |
| `probe8.js` / `probe84.js` | P1-5 `UNNEST`/`LATERAL` 误报 |
| `probe37.js` / `probe47.js` | P1-6 未闭合注释误报 |
| `probe102.js` | P1-7 `screen_width` 被抬升 |
| `probe54.js` | P1-8 改 `dialect` 不刷新诊断 |
| `probe79.js` / `probe97.js` | P2-1 CTAS 括号 |
| `probe118.js` | P2-2 DDL `comma_location` 失效 |
| `probe95.js` / `probe92.js` | P2-3 DDL `bracket_char` 失效 |
| `probe30.js` / `probe49.js` | P2-4 孤立逗号行 |
| `probe8.js` / `probe116.js` | P2-5 重复 DDL |
| `probe111.js` / `probe113.js` | P2-6 `extractddl` EOL |
| `probe34.js` / `probe36.js` | P2-7 未闭合 `$tag$` |
| `probe104.js` | P2-8 `INTO table` 大小写 |
| `probe105.js` / `probe106.js` | P2-9 引号表名空格 |
| `probe55.js` / `probe71.js` | P2-11 静默失败 |

另外两项整体性验证：

- `fuzz.js`：3000 轮随机 token 拼接，`idem` / `str` / `cmt` / `crash` 四类失败均为 0，说明核心不变量在常见组合下稳定；
- `perf.js` / `probe101.js`：性能与规模数据（见 §5 P3-5）。

