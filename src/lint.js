'use strict';
/* ============================================================================
 * 诊断引擎 / SQL linter
 *
 * 目标不是"把 SQL 改对"，而是**在问题点给出可核对的位置**：
 * 一条诊断 = 规则 id + 严重级 + 一句话说明 + 精确的 line/character 范围。
 * 要不要改、怎么改，由用户判断 —— 格式化器只负责排版，不替用户改语义。
 *
 * 三条设计原则
 *
 *   1) **宁可漏报，不可误报。**
 *      一条动不动就亮的波浪线，用户第一件事就是把整个功能关掉。
 *      所以每条规则都只在"文本本身足以证明"时才开火：
 *        · `SELECT *` 要排除 `EXISTS (SELECT *)` 这个惯用写法；
 *        · `JOIN 缺 ON` 要排除 CROSS / NATURAL / ARRAY JOIN；
 *        · 子句顺序只在括号深度 0 判定（子查询有自己的子句顺序）；
 *        · `LIKE '%x'` 只看字符串字面量，不猜 concat 出来的值。
 *
 *   2) **复用内核的词法器。**
 *      不另写一套切词：`#` 是注释还是异或、反斜杠算不算转义、`$$…$$` 到哪里结束，
 *      两套实现必然给出不同答案 —— 用户看到的波浪线就会和排版结果对不上。
 *
 *   3) **纯函数。**
 *      输入 (text, dialect)，输出 issues 数组，不碰 VS Code。
 *      这样它能在 node 里被回归套件直接测，也能被别的前端复用。
 *
 * 严重级取值（与 VS Code 的 DiagnosticSeverity 一一对应）：
 *   error   —— 语法层面确定错误，多数数据库会直接拒绝执行
 *   warning —— 能跑，但结果几乎一定不是用户想要的
 *   info    —— 写法/性能上的建议，不影响正确性
 * ==========================================================================*/

var kernel = require('./kernel');

var SEV = { error: 'error', warning: 'warning', info: 'info' };

/* ---------------------------------------------------------------- 规则清单
 * id 使用 `类别.短横线名`，直接显示在「问题」面板的 code 列上，便于 --disable 引用。
 * 这张表同时是文档与测试的单一来源：README 的规则表、回归套件的覆盖检查都读它。 */
var RULES = [
  /* ---- 语法错误 ---- */
  { id: 'syntax.unbalanced-paren', sev: SEV.error,
    title: '括号不配对',
    desc: '左括号与右括号数量不一致。多数数据库会直接报语法错误。' },

  { id: 'syntax.unterminated-string', sev: SEV.error,
    title: '字符串未闭合',
    desc: '引号没有配对（注意反斜杠转义与单引号双写这两种转义方式）。' },

  { id: 'syntax.unterminated-comment', sev: SEV.error,
    title: '块注释未闭合',
    desc: '`/*` 之后再也找不到 `*/`，注释会把后面的整段 SQL 都吞掉；执行时这部分等于不存在。' },

  { id: 'syntax.trailing-comma', sev: SEV.error,
    title: '列表末尾多余的逗号',
    desc: '逗号后面直接跟着子句关键字、右括号或语句结束。' },

  { id: 'syntax.clause-order', sev: SEV.error,
    title: '子句顺序错误',
    desc: 'SQL 子句有固定顺序：SELECT → FROM → WHERE → GROUP BY → HAVING → ORDER BY → LIMIT。' },

  { id: 'syntax.duplicate-clause', sev: SEV.error,
    title: '重复的子句',
    desc: '同一条查询里出现两次相同子句（需要合并条件）。' },

  { id: 'syntax.reserved-alias', sev: SEV.error,
    title: '保留字被直接用作别名',
    desc: '别名是保留字时必须加引号，否则解析器会把它当成下一个子句。' },

  { id: 'syntax.empty-in-list', sev: SEV.error,
    title: 'IN 后面是空列表',
    desc: '`IN ()` 不是合法语法；空列表会让整条语句无法解析。' },

  /* ---- 高危写法 ---- */
  { id: 'danger.null-comparison', sev: SEV.warning,
    title: '用 = / <> 比较 NULL',
    desc: 'NULL 参与的任何比较结果都是 UNKNOWN，`= NULL` 永远不成立，必须用 IS NULL / IS NOT NULL。' },

  { id: 'danger.delete-update-no-where', sev: SEV.warning,
    title: 'DELETE / UPDATE 没有 WHERE',
    desc: '会把整张表的数据删掉或改掉。' },

  { id: 'danger.cartesian-product', sev: SEV.warning,
    title: '多表逗号连接且没有 WHERE',
    desc: '结果是笛卡尔积，行数 = 各表行数之积。' },

  { id: 'danger.not-in-subquery', sev: SEV.warning,
    title: 'NOT IN 接子查询',
    desc: '子查询结果里只要出现一个 NULL，整个条件就恒为 UNKNOWN，查询返回空集。建议改 NOT EXISTS 或 LEFT JOIN … IS NULL。' },

  { id: 'danger.join-without-on', sev: SEV.warning,
    title: 'JOIN 缺少连接条件',
    desc: '没有 ON / USING 的 JOIN 等价于笛卡尔积（CROSS JOIN 除外）。' },

  { id: 'danger.and-or-mixed', sev: SEV.warning,
    title: 'AND 与 OR 混用且没有括号',
    desc: 'AND 的优先级高于 OR，但读代码的人几乎总是按从左到右理解。请显式加括号。' },

  /* ---- 写法 / 性能建议 ---- */
  { id: 'style.select-star', sev: SEV.warning,
    title: 'SELECT *',
    desc: '表结构一变，下游拿到的列就跟着变。生产 SQL 建议显式列出列名。' },

  { id: 'style.implicit-join', sev: SEV.info,
    title: '隐式连接（FROM a, b WHERE …）',
    desc: '把连接条件写在 WHERE 里，容易漏写而变成笛卡尔积。建议改成 JOIN … ON。' },

  { id: 'style.leading-wildcard-like', sev: SEV.info,
    title: 'LIKE 以通配符开头',
    desc: 'LIKE 的匹配串以通配符开头，无法使用普通 B-Tree 索引，会全表扫描。' },

  { id: 'style.union-vs-union-all', sev: SEV.info,
    title: 'UNION 没有加 ALL',
    desc: 'UNION 会额外做一次排序去重；确认不需要去重时用 UNION ALL 更快。' },

  { id: 'style.order-by-ordinal', sev: SEV.info,
    title: '按列序号排序 / 分组',
    desc: '`ORDER BY 1` 在 SELECT 列表调整后会悄悄指向别的列，不利于维护。' },

  { id: 'style.distinct-with-groupby', sev: SEV.info,
    title: 'DISTINCT 与 GROUP BY 同时出现',
    desc: 'GROUP BY 已经产生唯一分组，DISTINCT 通常是多余的。' }
];

/* id → 元信息，供外部查询（README 生成、测试覆盖检查、禁用规则提示）。 */
var RULE_MAP = Object.create(null);
for (var _ri = 0; _ri < RULES.length; _ri++) RULE_MAP[RULES[_ri].id] = RULES[_ri];

/* ---------------------------------------------------------------- 位置换算 */

/* 预先算出每一行的起始偏移。
 * CRLF 必须当成**一个**换行：把 \r 与 \n 各算一行，位置会整体偏一行。 */
function buildLineStarts(text) {
  var starts = [0];
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if (c === 10) {
      starts.push(i + 1);
    } else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/* 偏移 → {line, character}。二分查找，O(log 行数)。 */
function posOf(starts, off) {
  var lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return { line: lo, character: off - starts[lo] };
}

/* ---------------------------------------------------------------- 小工具 */

function isP(t, v) { return !!t && t.type === 'punct' && t.value === v; }
function isW(t, u) { return !!t && t.type === 'word' && String(t.upper || '').toUpperCase() === u; }
function hasPos(t) { return !!t && typeof t.start === 'number' && typeof t.end === 'number'; }

/* 下一个非注释 token 的下标（-1 = 没有了）。 */
function nextCode(st, i) {
  for (var k = i + 1; k < st.length; k++) {
    if (st[k].type !== 'comment') return k;
  }
  return -1;
}

/* 前一个非注释 token 的下标。 */
function prevCode(st, i) {
  for (var k = i - 1; k >= 0; k--) {
    if (st[k].type !== 'comment') return k;
  }
  return -1;
}

/* 第一层的"语句级"子句关键字。带 BY 的两个词要连读，否则 `GROUP` 单独出现
 * （例如 `CREATE TABLE … GROUP` 不成立，但列名叫 group 时）会误判。 */
var CLAUSE_RANK = {
  SELECT: 1, FROM: 2, WHERE: 3, GROUP: 4, HAVING: 5, ORDER: 6, LIMIT: 7
};

/* 结束一份"连接列表 / 条件域"的词。 */
var SCOPE_ENDS = {
  WHERE: 1, GROUP: 1, HAVING: 1, ORDER: 1, LIMIT: 1, OFFSET: 1,
  UNION: 1, EXCEPT: 1, INTERSECT: 1, MINUS: 1,
  JOIN: 1, INNER: 1, LEFT: 1, RIGHT: 1, FULL: 1, CROSS: 1, NATURAL: 1,
  OUTER: 1, SEMI: 1, ANTI: 1
};

/* 保留字表：只收"出现在别名位置会直接造成语法错误"的那批。
 * 故意不收 DATE / USER / TYPE 这类软关键字 —— 它们在绝大多数数据库里
 * 本来就能当别名，收进来只会制造误报。 */
var RESERVED_ALIAS = {
  SELECT: 1, FROM: 1, WHERE: 1, GROUP: 1, ORDER: 1, HAVING: 1, BY: 1,
  JOIN: 1, INNER: 1, LEFT: 1, RIGHT: 1, FULL: 1, CROSS: 1, NATURAL: 1,
  OUTER: 1, ON: 1, USING: 1, UNION: 1, EXCEPT: 1, INTERSECT: 1, MINUS: 1,
  AND: 1, OR: 1, NOT: 1, IN: 1, IS: 1, NULL: 1, LIKE: 1, BETWEEN: 1,
  LIMIT: 1, OFFSET: 1, INSERT: 1, UPDATE: 1, DELETE: 1, INTO: 1,
  VALUES: 1, SET: 1, CREATE: 1, DROP: 1, ALTER: 1, TABLE: 1, AS: 1,
  CASE: 1, WHEN: 1, THEN: 1, ELSE: 1, END: 1, DISTINCT: 1, WITH: 1
};

/* ---------------------------------------------------------------- 上下文 */

function Ctx(text, toks, opts, lex) {
  this.text = text;
  this.toks = toks;
  this.starts = buildLineStarts(text);
  this.opts = opts || {};
  this.lex = lex || {};
  this.dialect = String(this.opts.dialect || '').toLowerCase();
  this.issues = [];
  this.disabled = this.opts.disabledRules || [];
}

Ctx.prototype.at = function (ruleId, startOff, endOff) {
  if (this.disabled.indexOf(ruleId) >= 0) return;
  var meta = RULE_MAP[ruleId];
  if (!meta) return;
  var len = this.text.length;
  var a = Math.max(0, Math.min(startOff, len));
  var b = Math.max(a, Math.min(endOff === undefined ? startOff + 1 : endOff, len));
  var p1 = posOf(this.starts, a);
  var p2 = posOf(this.starts, b);
  this.issues.push({
    rule: ruleId,
    severity: meta.sev,
    title: meta.title,
    message: meta.desc,
    line: p1.line,
    character: p1.character,
    endLine: p2.line,
    endCharacter: p2.character
  });
};

/* 用 token 定位。endTok 给了就把范围拉到它的末尾（用于跨多个 token 的问题）。 */
Ctx.prototype.tok = function (ruleId, t, endTok) {
  if (!hasPos(t)) return;
  var e = (endTok && hasPos(endTok)) ? endTok.end : t.end;
  this.at(ruleId, t.start, e);
};

/* ---------------------------------------------------------------- 语句切分 */

/* 按分号切语句（只切深度 0 的分号），客户端命令行各自独立成段。
 * 与内核的 splitStatements 不同：这里不需要 terminated 之类的元信息。
 *
 * P1-2（2026-11-05 复核）：T-SQL 的 `GO` 是**批分隔符**，它前面没有分号。
 * 旧实现只按 `;` 切，于是
 *     select a from t where a = 1
 *     GO
 *     select b from u where b = 1
 * 两条独立查询被当成一条语句，第二个 SELECT/FROM/WHERE 被判成"重复子句"，
 * 一按保存就亮两条红波浪线 —— 而同一段文本格式化出来完全正确，
 * 两边说法互相矛盾。这里用与内核相同的判据：`GO` 单独成行（前有换行，
 * 或它是第一个 token）且这一行后面没有别的代码。 */
function splitStatements(toks) {
  var out = [], cur = [], depth = 0;
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i];
    if (t.type === 'client') {
      if (cur.length) { out.push(cur); cur = []; }
      out.push([t]);
      depth = 0;
      continue;
    }
    /* GO 批分隔符：先结束当前语句，GO 自己单独成段（它不是子句词，
     * 单独成段不会被任何语句规则命中）。 */
    if (t.type === 'word' && String(t.upper || '').toUpperCase() === 'GO' && depth === 0) {
      var prevG = toks[i - 1];
      var nextG = toks[i + 1];
      var aloneOnLine = (t.nl > 0 || !prevG);
      var endsHere = !nextG || nextG.nl > 0 || nextG.type === 'comment';
      if (aloneOnLine && endsHere) {
        if (cur.length) { out.push(cur); cur = []; }
        out.push([t]);
        continue;
      }
    }
    cur.push(t);
    if (t.type === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth = Math.max(0, depth - 1);
      else if (t.value === ';' && depth === 0) { out.push(cur); cur = []; }
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/* 扫描深度 0 的子句关键字，返回 [{word, idx, rank, endIdx}]。
 * UNION 系作为分隔标记（rank 0）一起返回，供"分段"使用 ——
 * UNION 前后各自有完整的 SELECT/FROM，不算重复子句。
 *
 * 有一条**必须**排除的形态：`AS <保留字>`。别名允许是任意带引号的词，
 * 而未加引号的保留字（`select a as from from t`）虽然本身是错的，
 * 那个 `from` 在语法上是别名位置，不是子句起始 —— 把它当子句会让
 * 后面的真实 FROM 被误判成"重复"或"顺序错"，一个错误炸出三条诊断。 */
function scanClauses(st) {
  var out = [];
  var depth = 0;
  for (var i = 0; i < st.length; i++) {
    var t = st[i];
    if (t.type === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || t.type !== 'word') continue;
    /* 别名位置：`AS` 直接后面的词不是子句。 */
    var pv = prevCode(st, i);
    if (pv >= 0 && isW(st[pv], 'AS')) continue;
    var u = String(t.upper || '').toUpperCase();
    if (u === 'UNION' || u === 'EXCEPT' || u === 'INTERSECT' || u === 'MINUS') {
      out.push({ word: u, idx: i, rank: 0, endIdx: i, union: true });
      continue;
    }
    if (u === 'GROUP' || u === 'ORDER') {
      var n = nextCode(st, i);
      if (n < 0 || !isW(st[n], 'BY')) continue;
      /* `GROUP BY` 必须是关键字身份；列名叫 order 后面又恰好跟 BY 的概率极低，
       * 但加上 keyword 判定更稳。 */
      if (t.keyword === false) continue;
      out.push({ word: u + ' BY', idx: i, rank: CLAUSE_RANK[u], endIdx: n });
      continue;
    }
    if (CLAUSE_RANK[u] && t.keyword !== false) {
      out.push({ word: u, idx: i, rank: CLAUSE_RANK[u], endIdx: i });
    }
  }
  return out;
}

/* 按 UNION 把子句列表切成若干段（每段 = 一个查询块）。 */
function clauseSegments(clauses) {
  var segs = [], cur = [];
  for (var i = 0; i < clauses.length; i++) {
    if (clauses[i].union) {
      if (cur.length) segs.push(cur);
      cur = [];
      continue;
    }
    cur.push(clauses[i]);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

/* ---------------------------------------------------------------- 全局规则 */

/* 括号配对与引号闭合要看整篇，不能按语句看：
 * 一条残缺的 `select (a from t` 后面再接一条正常语句时，括号会在文件级别对上，
 * 但每一条都是错的。这里按 token 流线性扫，报第一个出错位置。 */
function ruleUnbalancedParen(ctx, toks) {
  var stack = [];
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i];
    if (t.type === 'client') { stack.length = 0; continue; }
    if (!isP(t, '(') && !isP(t, ')')) continue;
    if (t.value === '(') {
      stack.push(t);
    } else {
      if (!stack.length) {
        ctx.tok('syntax.unbalanced-paren', t);
      } else {
        stack.pop();
      }
    }
  }
  for (var k = 0; k < stack.length; k++) {
    ctx.tok('syntax.unbalanced-paren', stack[k]);
  }
}

function ruleUnterminatedString(ctx, toks) {
  if (!toks.unterminated) return;
  /* P1-6（2026-11-05 复核）：`unterminated` 现在带**类型**。
   * 旧实现只看到布尔量，就按"首尾字符是否成对"扫描**所有**字符串 token，
   * 于是未闭合的块注释 / q-quote / dollar-quote 会让前面那些**闭合正常**的
   * 字符串被报成错误，真正的出错位置反而被掩盖。
   * 现在：
   *   · kind === 'block-comment' → 报 syntax.unterminated-comment；
   *   · 起点已知（unterminatedStart）时直接定位到那个 token；
   *   · 其余情况仍按首尾配对兜底（老宿主/老调用点没有类型信息）。 */
  var kind = toks.unterminatedKind || '';
  var at = typeof toks.unterminatedStart === 'number' ? toks.unterminatedStart : -1;

  if (kind === 'block-comment') {
    for (var c0 = 0; c0 < toks.length; c0++) {
      var ct = toks[c0];
      if (ct.type !== 'comment') continue;
      if (at >= 0 && (ct.start !== at)) continue;
      if (ct.value.indexOf('/*') === 0 && ct.value.indexOf('*/') < 0) {
        ctx.tok('syntax.unterminated-comment', ct);
        return;
      }
    }
    /* 找不到对应 token：退化成"整篇未闭合"的提示，指向最后一个注释。 */
    for (var c1 = toks.length - 1; c1 >= 0; c1--) {
      if (toks[c1].type === 'comment') { ctx.tok('syntax.unterminated-comment', toks[c1]); return; }
    }
    return;
  }

  /* 已知起点：直接定位到覆盖该偏移的字符串 token，不做全文猜测。 */
  if (at >= 0) {
    for (var k = 0; k < toks.length; k++) {
      var kt = toks[k];
      if (kt.type !== 'string' && kt.type !== 'quoted') continue;
      if (typeof kt.start === 'number' && typeof kt.end === 'number' &&
          at >= kt.start && at < kt.end) {
        ctx.tok('syntax.unterminated-string', kt);
        return;
      }
    }
  }

  /* 找到第一个"开了没关"的字面量。判断依据是首尾字符是否成对：
   * 词法器把一个未闭合的字符串一直吃到文件末尾，所以它的 value 末尾
   * 不会出现与开头相同的引号。 */
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i];
    if (t.type !== 'string' && t.type !== 'quoted') continue;
    var v = String(t.value || '');
    if (v.length < 2) { ctx.tok('syntax.unterminated-string', t); return; }
    var head = v.charAt(0);
    var tail = v.charAt(v.length - 1);
    var pair = (t.type === 'quoted' && t.style === 'bracket') ? (head === '[' && tail === ']')
      : (head === tail);
    if (!pair) { ctx.tok('syntax.unterminated-string', t); return; }
  }
  /* 兜底：找到不具体位置时，指向最后一个字面量 token。 */
  for (var j = toks.length - 1; j >= 0; j--) {
    if (toks[j].type === 'string' || toks[j].type === 'quoted') {
      ctx.tok('syntax.unterminated-string', toks[j]);
      return;
    }
  }
}

var GLOBAL_RULES = [ruleUnbalancedParen, ruleUnterminatedString];

/* ---------------------------------------------------------------- 语句规则 */

/* 1) 列表末尾多余的逗号。
 *    判据：逗号后面（跳过注释）直接跟着 `)`、`;`、或"结束一个列表"的子句关键字，
 *    或者根本没有下一个 token。
 *
 *    2026-11-07 复核（P1-3）：BigQuery 与 DuckDB 的 **SELECT 列表**明确允许
 *    尾逗号（`select a, b, from t`），照旧报 error 等于在合法方言上挂红线。
 *    这两种方言下只放行 SELECT 列表里的尾逗号；`f(a,)`、`in (1,2,)`、
 *    `select a, ;` 这类仍然报 —— 它们的合法性没有被方言保证。 */
var COMMA_END_WORDS = {
  FROM: 1, WHERE: 1, GROUP: 1, HAVING: 1, ORDER: 1, LIMIT: 1, OFFSET: 1,
  UNION: 1, EXCEPT: 1, INTERSECT: 1, MINUS: 1, VALUES: 1, INTO: 1, SET: 1
};

/* 允许 SELECT 列表尾逗号的方言（语言 id 与配置里的方言名都要认）。 */
function dialectAllowsSelectTrailingComma(ctx) {
  var d = String((ctx && ctx.dialect) || '').toLowerCase();
  return d === 'bigquery' || d === 'sql-bigquery' || d === 'duckdb';
}

/* 结束 SELECT 列表的词。比 COMMA_END_WORDS 窄：只收"接在 SELECT 列表后面"
 * 才成立的那些，避免把 `select a, into` 之类也放过。 */
var SELECT_LIST_END_WORDS = {
  FROM: 1, WHERE: 1, GROUP: 1, HAVING: 1, ORDER: 1, LIMIT: 1, OFFSET: 1,
  UNION: 1, EXCEPT: 1, INTERSECT: 1, MINUS: 1, QUALIFY: 1, WINDOW: 1,
  CLUSTER: 1, DISTRIBUTE: 1, SORT: 1
};

/* SELECT 列表区间：`[SELECT 之后的下标, 列表结束词/右括号的下标)`。
 * 每个区间带自己的括号深度 —— 否则 `select f(a,) from t` 里函数参数列表的
 * 尾逗号会落在外层 SELECT 区间的索引范围内，被误当成"合法的列表尾逗号"。
 *
 * 子查询里的 SELECT 也收（BigQuery 同样允许 `(select a, b, from u)`），
 * 它的区间在遇到对应的 `)` 时结束。 */
function selectListSpans(st) {
  var spans = [];
  var depths = [];
  var depth = 0;
  var open = [];

  function closeDepthAbove(d, endIdx) {
    while (open.length && open[open.length - 1].depth > d) {
      var o = open.pop();
      spans.push({ start: o.start, end: endIdx, depth: o.depth });
    }
  }

  for (var i = 0; i < st.length; i++) {
    var t = st[i];
    depths[i] = depth;
    if (t.type === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') {
        depth = Math.max(0, depth - 1);
        closeDepthAbove(depth, i);
      }
      continue;
    }
    if (t.type !== 'word') continue;
    var u = String(t.upper || '').toUpperCase();
    if (u === 'SELECT') {
      open.push({ start: i + 1, depth: depth });
      continue;
    }
    if (t.keyword !== false && SELECT_LIST_END_WORDS[u]) {
      if (open.length && open[open.length - 1].depth === depth) {
        var o = open.pop();
        spans.push({ start: o.start, end: i, depth: o.depth });
      }
    }
  }
  while (open.length) {
    var o2 = open.pop();
    spans.push({ start: o2.start, end: st.length, depth: o2.depth });
  }
  return { spans: spans, depths: depths };
}

function ruleTrailingComma(ctx, st) {
  var allowSelectTrailing = dialectAllowsSelectTrailingComma(ctx);
  var scanned = allowSelectTrailing ? selectListSpans(st) : null;

  function insideSelectList(i) {
    if (!scanned) return false;
    var d = scanned.depths[i];
    for (var s = 0; s < scanned.spans.length; s++) {
      var sp = scanned.spans[s];
      /* 深度必须一致：括号里的逗号不属于外层的 SELECT 列表。 */
      if (sp.depth === d && i > sp.start && i < sp.end) return true;
    }
    return false;
  }

  for (var i = 0; i < st.length; i++) {
    if (!isP(st[i], ',')) continue;
    var n = nextCode(st, i);
    if (n < 0) { ctx.tok('syntax.trailing-comma', st[i]); continue; }
    var nt = st[n];
    if (isP(nt, ')') || isP(nt, ';')) { ctx.tok('syntax.trailing-comma', st[i]); continue; }
    if (nt.type === 'word' && COMMA_END_WORDS[String(nt.upper || '').toUpperCase()]) {
      /* `SELECT a, FROM t` 里的 FROM 确实是列表结束；但如果逗号是函数参数
       * 列表的结尾（`f(a, ` 后面跟 FROM 不成立），不会走到这里。 */
      if (allowSelectTrailing && insideSelectList(i) &&
          SELECT_LIST_END_WORDS[String(nt.upper || '').toUpperCase()]) continue;
      ctx.tok('syntax.trailing-comma', st[i]);
    }
  }
}

/* 2) 子句顺序 + 3) 重复子句。两者共用一次 scanClauses。
 *
 * 一个错误只报一条：同一个子句重复出现时，只报「重复」，不再拿它的 rank
 * 参与顺序判定 —— `select … from t where x=1 from u` 既是"FROM 重复"也是
 * "FROM 排在 WHERE 之后"，但用户要修的是同一处。顺序判定只看每个子句的
 * **首次出现**，这样一条语句里每类错误最多亮一次。 */
function ruleClauseOrderAndDup(ctx, st) {
  var clauses = scanClauses(st);
  if (!clauses.length) return;

  var segs = clauseSegments(clauses);
  for (var s = 0; s < segs.length; s++) {
    var seg = segs[s];
    var lastRank = 0;
    var seen = Object.create(null);

    for (var c = 0; c < seg.length; c++) {
      var cl = seg[c];
      var rangeEnd = (cl.endIdx !== cl.idx) ? st[cl.endIdx] : undefined;

      if (seen[cl.word]) {
        /* SELECT 不参与重复检查：`INSERT … SELECT` 与某些方言的嵌套形态
         * 里出现两次是正常的。 */
        if (cl.word !== 'SELECT') ctx.tok('syntax.duplicate-clause', st[cl.idx], rangeEnd);
        continue;
      }
      seen[cl.word] = 1;

      if (cl.rank < lastRank) {
        ctx.tok('syntax.clause-order', st[cl.idx], rangeEnd);
      } else {
        lastRank = cl.rank;
      }
    }
  }
}

/* 4) 保留字被直接用作别名：`AS <保留字>`。
 *    只认显式 AS —— 隐式别名（`SELECT a from`）本来就解析不了，
 *    但那种写法几乎不可能出现在能跑起来的代码里，报了也是噪声。 */
/* P1-4（2026-11-05 复核）：`CREATE TABLE t AS SELECT …` / `CREATE VIEW v AS …`
 * 里的 AS 是**语句语法**，不是列别名；它后面的 SELECT / WITH / VALUES / TABLE
 * 都是查询体开头。旧实现只看"AS 后面第一个词是否在保留字表里"，于是
 * 每一条 CTAS 都会亮 syntax.reserved-alias，把这条规则变成纯噪声。
 * 现在只跳过"语句头是 CREATE/ALTER、且 AS 之后（可跨括号）就是查询体"的那一种
 * 形态 —— `select a as table from t` 这类真正的错误别名仍然会报。 */
var CTAS_BODY_HEADS = {
  SELECT: 1, WITH: 1, VALUES: 1, TABLE: 1, UNNEST: 1, LATERAL: 1
};

function stmtHeadWord(st) {
  for (var i = 0; i < st.length; i++) {
    var t = st[i];
    if (t.type === 'comment') continue;
    if (t.type === 'word') return String(t.upper || '').toUpperCase();
    return '';
  }
  return '';
}

/* 这个 AS 是否是 `CREATE … AS <query>` 里的语法词？ */
function isCtasAs(st, asIdx) {
  var head = stmtHeadWord(st);
  if (head !== 'CREATE' && head !== 'ALTER') return false;
  /* AS 必须是这条语句里**第一个**深度 0 的 AS */
  var depth = 0;
  for (var i = 0; i < asIdx; i++) {
    var t = st[i];
    if (t.type === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && t.type === 'word' && String(t.upper || '').toUpperCase() === 'AS') return false;
  }
  /* AS 之后（跳过括号）应当是查询体开头 */
  var n = nextCode(st, asIdx);
  var guard = 0;
  while (n >= 0 && guard++ < 8) {
    var nt = st[n];
    if (nt.type === 'punct' && nt.value === '(') { n = nextCode(st, n); continue; }
    if (nt.type === 'word' && CTAS_BODY_HEADS[String(nt.upper || '').toUpperCase()]) return true;
    return false;
  }
  return false;
}

function ruleReservedAlias(ctx, st) {
  for (var i = 0; i < st.length; i++) {
    if (!isW(st[i], 'AS')) continue;
    var n = nextCode(st, i);
    if (n < 0) continue;
    var nt = st[n];
    /* 字面量 / 带引号的标识符都是合法别名，不再检查。 */
    if (nt.type !== 'word') continue;
    var nu = String(nt.upper || '').toUpperCase();
    if (!RESERVED_ALIAS[nu]) continue;
    /* CTAS / CREATE VIEW 的语法 AS：不是别名。 */
    if (isCtasAs(st, i)) continue;
    ctx.tok('syntax.reserved-alias', nt);
  }
}

/* 5) `IN ()` 空列表。 */
function ruleEmptyInList(ctx, st) {
  for (var i = 0; i < st.length; i++) {
    if (!isW(st[i], 'IN')) continue;
    var n = nextCode(st, i);
    if (n < 0 || !isP(st[n], '(')) continue;
    var m = nextCode(st, n);
    if (m >= 0 && isP(st[m], ')')) {
      ctx.tok('syntax.empty-in-list', st[i], st[m]);
    }
  }
}

/* 6) `= NULL` / `<> NULL` / `!= NULL`（以及 NULL 在左侧的写法）。 */
var NULL_CMP_OPS = { '=': 1, '<>': 1, '!=': 1, '==': 1 };

function ruleNullComparison(ctx, st) {
  for (var i = 0; i < st.length; i++) {
    var t = st[i];
    if (t.type !== 'punct' || !NULL_CMP_OPS[t.value]) continue;
    var n = nextCode(st, i);
    if (n >= 0 && isW(st[n], 'NULL')) { ctx.tok('danger.null-comparison', t, st[n]); continue; }
    var p = prevCode(st, i);
    if (p >= 0 && isW(st[p], 'NULL')) { ctx.tok('danger.null-comparison', st[p], t); }
  }
}

/* 7) DELETE / UPDATE 没有 WHERE。 */
function ruleDeleteUpdateNoWhere(ctx, st) {
  var first = -1;
  for (var i = 0; i < st.length; i++) {
    if (st[i].type === 'comment' || isP(st[i], '(')) continue;
    first = i; break;
  }
  if (first < 0) return;
  var head = st[first];
  if (!isW(head, 'DELETE') && !isW(head, 'UPDATE')) return;

  var clauses = scanClauses(st);
  for (var c = 0; c < clauses.length; c++) {
    if (clauses[c].word === 'WHERE' || clauses[c].word === 'LIMIT') return;
  }
  ctx.tok('danger.delete-update-no-where', head);
}

/* 取 FROM 子句的 token 区间 [fromIdx, endIdx)。 */
function fromSpan(st, clauses) {
  for (var i = 0; i < clauses.length; i++) {
    if (clauses[i].word !== 'FROM') continue;
    var start = clauses[i].endIdx + 1;
    var end = st.length;
    for (var j = i + 1; j < clauses.length; j++) { end = clauses[j].idx; break; }
    return { start: start, end: end, clauseAt: i };
  }
  return null;
}

/* 逗号连接区里出现这些词时，整个规则不判定。
 *
 * LATERAL / UNNEST / APPLY 是**关联**子查询：右侧本来就可以引用左侧的列，
 * 即便没有 WHERE 也不构成笛卡尔积。把它们当普通逗号连接报出来是纯误报。
 * 这类写法频率不高，但代价一样 —— 用户看到一次错报就会怀疑整个功能。 */
var CORRELATED_WORDS = { LATERAL: 1, UNNEST: 1, APPLY: 1, TABLE: 1 };

/* 统计区间内深度 0 的逗号、以及是否出现 JOIN / 关联子查询。 */
function scanJoinArea(st, start, end) {
  var depth = 0, commas = 0, hasJoin = false, correlated = false;
  for (var i = start; i < end && i < st.length; i++) {
    var t = st[i];
    if (t.type === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth = Math.max(0, depth - 1);
      else if (t.value === ',' && depth === 0) commas++;
      continue;
    }
    if (depth !== 0 || t.type !== 'word') continue;
    var u = String(t.upper || '').toUpperCase();
    if (u === 'JOIN') hasJoin = true;
    else if (CORRELATED_WORDS[u]) correlated = true;
  }
  return { commas: commas, hasJoin: hasJoin, correlated: correlated };
}

/* 8) 多表逗号连接。
 *    有 WHERE → info（隐式连接，写法建议）；
 *    没有 WHERE 且不止一张表 → warning（笛卡尔积）。
 *    区间里已经出现 JOIN 的一律不管 —— 混合写法的可能性太多，
 *    说不清就不说。 */ 
function ruleCommaJoin(ctx, st) {
  var clauses = scanClauses(st);
  var span = fromSpan(st, clauses);
  if (!span) return;
  var area = scanJoinArea(st, span.start, span.end);
  if (area.commas <= 0 || area.hasJoin || area.correlated) return;

  var hasWhere = false;
  for (var i = 0; i < clauses.length; i++) if (clauses[i].word === 'WHERE') hasWhere = true;

  var fromTok = st[clauses[span.clauseAt].idx];
  if (!hasWhere) { ctx.tok('danger.cartesian-product', fromTok); return; }
  ctx.tok('style.implicit-join', fromTok);
}

/* 9) NOT IN (子查询)。 */
function ruleNotInSubquery(ctx, st) {
  for (var i = 0; i < st.length; i++) {
    if (!isW(st[i], 'NOT')) continue;
    var n = nextCode(st, i);
    if (n < 0 || !isW(st[n], 'IN')) continue;
    var m = nextCode(st, n);
    if (m < 0 || !isP(st[m], '(')) continue;
    var k = nextCode(st, m);
    if (k >= 0 && isW(st[k], 'SELECT')) {
      ctx.tok('danger.not-in-subquery', st[i], st[k]);
    }
  }
}

/* 10) JOIN 缺 ON / USING。
 *     跳过 CROSS / NATURAL / ARRAY JOIN（这三种本来就不需要连接条件）。 */
var JOIN_TERMINATORS = {
  WHERE: 1, GROUP: 1, HAVING: 1, ORDER: 1, LIMIT: 1, OFFSET: 1,
  UNION: 1, EXCEPT: 1, INTERSECT: 1, MINUS: 1,
  JOIN: 1, INNER: 1, LEFT: 1, RIGHT: 1, FULL: 1, CROSS: 1, NATURAL: 1,
  OUTER: 1, SEMI: 1, ANTI: 1
};

/* P1-5（2026-11-05 复核）：JOIN 的右表是**表函数**或 LATERAL 子查询时，
 * 本来就不存在（也不需要）ON 条件：
 *     select a from t join unnest(arr) as v                 -- Trino / Presto
 *     select a from t join lateral (select 1) x             -- PG
 *     select a from t join generate_series(1, 10) g         -- PG
 *     select a from t join explode(arr) e                   -- Hive
 * 旧实现只排除了 CROSS / NATURAL / ARRAY，于是这些写法全被报成
 * "JOIN 缺少连接条件"，而同一份 SQL 格式化出来完全正常。
 * 判据看 JOIN 之后第一个非注释 token：是 LATERAL，或是一个自带括号的
 * 表函数名 —— 两者都不可能再用 ON 连接。普通的 `join u` 仍然照报。 */
var TABLE_FUNCTION_WORDS = {
  UNNEST: 1, LATERAL: 1, TABLE: 1, GENERATE_SERIES: 1, STRING_SPLIT: 1,
  EXPLODE: 1, EXPLODE_OUTER: 1, POSEXPLODE: 1, INLINE: 1, FLATTEN: 1,
  JSON_TABLE: 1, OPENJSON: 1, VALUES: 1, DUAL: 1
};

function joinRightIsTableFunction(st, i) {
  var n = nextCode(st, i);
  if (n < 0) return false;
  var t = st[n];
  if (t.type !== 'word') return false;
  var u = String(t.upper || '').toUpperCase();
  /* LATERAL 后面可以是子查询、也可以是表函数 —— 都是关联右侧。 */
  if (u === 'LATERAL') return true;
  if (!TABLE_FUNCTION_WORDS[u]) return false;
  /* 必须紧跟括号才算函数调用（`join table t` 里的 table 是修饰词）。 */
  var m = nextCode(st, n);
  return m >= 0 && isP(st[m], '(');
}

/* JOIN 前面的修饰词。`NATURAL LEFT JOIN` / `LEFT OUTER JOIN` 这类写法里，
 * JOIN 紧邻的前一个词是 LEFT / OUTER，而不是 NATURAL。 */
var JOIN_PREFIX_WORDS = {
  LEFT: 1, RIGHT: 1, FULL: 1, INNER: 1, OUTER: 1, CROSS: 1,
  NATURAL: 1, SEMI: 1, ANTI: 1
};

/* 收集 JOIN 之前连续的修饰词（从近到远）。 */
function joinPrefixOf(st, joinIdx) {
  var words = [];
  var k = prevCode(st, joinIdx);
  while (k >= 0 && st[k].type === 'word' &&
         JOIN_PREFIX_WORDS[String(st[k].upper || '').toUpperCase()]) {
    words.push(String(st[k].upper || '').toUpperCase());
    k = prevCode(st, k);
  }
  return words;
}

function ruleJoinWithoutOn(ctx, st) {
  for (var i = 0; i < st.length; i++) {
    if (!isW(st[i], 'JOIN')) continue;
    var p = prevCode(st, i);
    var pu = (p >= 0 && st[p].type === 'word') ? String(st[p].upper || '').toUpperCase() : '';
    if (pu === 'CROSS' || pu === 'NATURAL' || pu === 'ARRAY') continue;
    /* P1-5（2026-11-06 复核）：`NATURAL LEFT JOIN` / `NATURAL FULL OUTER JOIN`
     * 里 JOIN 紧邻的前一个词是 LEFT / OUTER，旧判据只看这一个词，于是
     * NATURAL JOIN 家族的大部分写法都被报成"缺 ON"。这里回溯整个修饰词序列。 */
    var prefix = joinPrefixOf(st, i);
    if (prefix.indexOf('NATURAL') >= 0 || prefix.indexOf('CROSS') >= 0) continue;
    if (joinRightIsTableFunction(st, i)) continue;

    var depth = 0, found = false;
    for (var k = i + 1; k < st.length; k++) {
      var t = st[k];
      if (t.type === 'punct') {
        if (t.value === '(') depth++;
        else if (t.value === ')') depth = Math.max(0, depth - 1);
        else if (t.value === ';' && depth === 0) break;
        continue;
      }
      if (depth !== 0 || t.type !== 'word') continue;
      var u = String(t.upper || '').toUpperCase();
      if (u === 'ON' || u === 'USING') { found = true; break; }
      if (JOIN_TERMINATORS[u]) break;
    }
    if (!found) ctx.tok('danger.join-without-on', st[i]);
  }
}

/* 11) AND / OR 混用且没有任何括号。
 *     只看 WHERE 与 HAVING 的域内、深度 0。
 *
 * P1-4（2026-11-06 复核）：`BETWEEN x AND y` 里的 AND 是 BETWEEN 语法的一部分，
 * 不是逻辑与。旧实现只数 AND / OR 个数，于是
 *     where a between 1 and 2 or b = 3
 * 被报成"AND 与 OR 混用"——这是最常见的区间查询写法，误报率极高。
 * 现在遇到 BETWEEN（含 NOT BETWEEN）后，把**下一个**深度 0 的 AND 消掉。 */
function ruleAndOrMixed(ctx, st) {
  var clauses = scanClauses(st);
  for (var ci = 0; ci < clauses.length; ci++) {
    var cl = clauses[ci];
    if (cl.word !== 'WHERE' && cl.word !== 'HAVING') continue;
    var start = cl.endIdx + 1;
    var end = st.length;
    for (var j = ci + 1; j < clauses.length; j++) { end = clauses[j].idx; break; }

    var depth = 0, ands = 0, ors = 0, parens = 0, pendingBetween = 0;
    for (var i = start; i < end && i < st.length; i++) {
      var t = st[i];
      if (t.type === 'punct') {
        if (t.value === '(') { depth++; parens++; }
        else if (t.value === ')') depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth !== 0 || t.type !== 'word') continue;
      var u = String(t.upper || '').toUpperCase();
      if (u === 'BETWEEN') { pendingBetween++; continue; }
      if (u === 'AND') {
        if (pendingBetween > 0) { pendingBetween--; continue; }   /* BETWEEN … AND */
        ands++;
      } else if (u === 'OR') {
        ors++;
      }
    }
    if (ands > 0 && ors > 0 && parens === 0) {
      ctx.tok('danger.and-or-mixed', st[cl.idx]);
    }
  }
}

/* 12) SELECT *。
 *     `EXISTS (SELECT *)` 是惯用写法，跳过；`COUNT(*)` 的 `*` 在函数括号里，
 *     不是 SELECT 列表，天然不会命中。
 *
 * P1-2（2026-11-06 复核）：旧实现只看 SELECT 后**第一个** token，于是
 *     select a, * from t / select a, b, * from t / select t.*, b from t
 * 全部漏报 —— 规则在 README 里写成"SELECT *"，实际只覆盖 `SELECT *` 开头的形态。
 * 现在扫描整个深度 0 的 SELECT 列表，逐项判断。判据仍然是
 * "列表项起始位置上的 `*`"，所以乘号（`a * 2`）不会被误报。 */
var SELECT_LIST_TERMINATORS = {
  FROM: 1, WHERE: 1, GROUP: 1, HAVING: 1, ORDER: 1, LIMIT: 1, OFFSET: 1,
  UNION: 1, EXCEPT: 1, INTERSECT: 1, MINUS: 1, INTO: 1, WINDOW: 1,
  QUALIFY: 1, SETTINGS: 1, PREWHERE: 1, CONNECT: 1, START: 1, RETURNING: 1
};

function ruleSelectStar(ctx, st) {
  for (var i = 0; i < st.length; i++) {
    if (!isW(st[i], 'SELECT')) continue;

    /* 已经是 EXISTS (SELECT …) 就别报了。 */
    var p = prevCode(st, i);
    if (p >= 0 && isP(st[p], '(')) {
      var pp = prevCode(st, p);
      if (pp >= 0 && isW(st[pp], 'EXISTS')) continue;
    }

    var depth = 0;
    var atItemStart = true;
    for (var k = i + 1; k < st.length; k++) {
      var t = st[k];
      if (t.type === 'comment') continue;

      if (t.type === 'punct') {
        if (t.value === '(') { depth++; atItemStart = false; continue; }
        if (t.value === ')') {
          if (depth === 0) break;          /* SELECT 在子查询括号里，列表到此结束 */
          depth--;
          atItemStart = false;
          continue;
        }
        if (depth !== 0) continue;          /* 函数参数 / 子查询内部不算列表项 */
        if (t.value === ',') { atItemStart = true; continue; }
        if (t.value === ';') break;
        if (t.value === '*') {
          /* 只有"列表项起始"位置的 `*` 才是通配符；`a * 2` 里的 `*` 是乘号 */
          if (atItemStart) ctx.tok('style.select-star', t);
          atItemStart = false;
          continue;
        }
        atItemStart = false;
        continue;
      }

      if (depth !== 0) continue;

      var u = String(t.upper || '').toUpperCase();
      if (SELECT_LIST_TERMINATORS[u]) break;

      if (atItemStart && (u === 'DISTINCT' || u === 'ALL')) {
        /* `SELECT DISTINCT ON (a, b) *` 里括号是 DISTINCT 的一部分，
         * 不是列表项，跳过它之后仍然是列表项起始。 */
        if (u === 'DISTINCT') {
          var dn = nextCode(st, k);
          var dop = dn >= 0 && isW(st[dn], 'ON') ? nextCode(st, dn) : -1;
          if (dop >= 0 && isP(st[dop], '(')) {
            var d2 = 0;
            for (var m = dop; m < st.length; m++) {
              if (isP(st[m], '(')) d2++;
              else if (isP(st[m], ')')) { d2--; if (d2 === 0) { k = m; break; } }
            }
          }
        }
        continue;
      }

      if (atItemStart) {
        /* `SELECT t.*` / `SELECT db.t.*` */
        var d = nextCode(st, k);
        if (d >= 0 && isP(st[d], '.')) {
          var s2 = nextCode(st, d);
          if (s2 >= 0 && isP(st[s2], '*')) ctx.tok('style.select-star', t, st[s2]);
        }
      }
      atItemStart = false;
    }
  }
}

/* 13) LIKE 以 % 或 _ 开头。 */
function ruleLeadingWildcardLike(ctx, st) {
  for (var i = 0; i < st.length; i++) {
    if (!isW(st[i], 'LIKE')) continue;
    var n = nextCode(st, i);
    if (n < 0 || st[n].type !== 'string') continue;
    /* value 含引号本身，形如 '%abc' 或 N'%abc'。取第一个引号之后的首字符判断。 */
    var v = String(st[n].value || '');
    var q = -1;
    for (var k = 0; k < v.length; k++) {
      var c = v.charAt(k);
      if (c === "'" || c === '"') { q = k; break; }
    }
    if (q < 0 || q + 1 >= v.length) continue;
    var ch = v.charAt(q + 1);
    if (ch === '%' || ch === '_') ctx.tok('style.leading-wildcard-like', st[n]);
  }
}

/* 14) UNION 没有 ALL。 */
function ruleUnionAll(ctx, st) {
  for (var i = 0; i < st.length; i++) {
    if (!isW(st[i], 'UNION')) continue;
    var n = nextCode(st, i);
    if (n >= 0 && isW(st[n], 'ALL')) continue;
    ctx.tok('style.union-vs-union-all', st[i]);
  }
}

/* 15) GROUP BY / ORDER BY 用了列序号。 */
function ruleOrderByOrdinal(ctx, st) {
  var clauses = scanClauses(st);
  for (var i = 0; i < clauses.length; i++) {
    var w = clauses[i].word;
    if (w !== 'GROUP BY' && w !== 'ORDER BY') continue;
    var n = nextCode(st, clauses[i].endIdx);
    if (n >= 0 && st[n].type === 'number') {
      ctx.tok('style.order-by-ordinal', st[clauses[i].idx], st[n]);
    }
  }
}

/* 16) SELECT DISTINCT … GROUP BY 冗余。 */
function ruleDistinctWithGroupBy(ctx, st) {
  var clauses = scanClauses(st);
  var hasGroup = false;
  for (var i = 0; i < clauses.length; i++) if (clauses[i].word === 'GROUP BY') hasGroup = true;
  if (!hasGroup) return;

  for (var k = 0; k < clauses.length; k++) {
    if (clauses[k].word !== 'SELECT') continue;
    var n = nextCode(st, clauses[k].endIdx);
    if (n >= 0 && isW(st[n], 'DISTINCT')) {
      ctx.tok('style.distinct-with-groupby', st[clauses[k].idx], st[n]);
    }
  }
}

var STMT_RULES = [
  ruleTrailingComma,
  ruleClauseOrderAndDup,
  ruleReservedAlias,
  ruleEmptyInList,
  ruleNullComparison,
  ruleDeleteUpdateNoWhere,
  ruleCommaJoin,
  ruleNotInSubquery,
  ruleJoinWithoutOn,
  ruleAndOrMixed,
  ruleSelectStar,
  ruleLeadingWildcardLike,
  ruleUnionAll,
  ruleOrderByOrdinal,
  ruleDistinctWithGroupBy
];

/* ---------------------------------------------------------------- 是不是 SQL */

/* 判断一段文本值不值得诊断。
 *
 * 这个门槛存在的理由很具体：只要文件的语言标识被设成 sql（或者用户把
 * .txt 切成了 sql），诊断就会运行。而现实里 `.sql` 文件经常混着别的东西 ——
 * 文件头注释、从日志里粘来的片段、被截断的半条语句。对那些内容挂一屏波浪线，
 * 用户只会把整个功能关掉。
 *
 * 判据刻意宽松：**只要出现过一个语句级关键字**就认为是 SQL。
 * 不做"必须能完整解析"的强判定 —— 那会把用户正在写的半条语句也毙掉，
 * 而那恰恰是最需要诊断的时候。
 */
var SQL_HINT = {
  SELECT: 1, INSERT: 1, UPDATE: 1, DELETE: 1, CREATE: 1, DROP: 1, ALTER: 1,
  WITH: 1, MERGE: 1, TRUNCATE: 1, EXPLAIN: 1, SHOW: 1, DESCRIBE: 1, USE: 1,
  CALL: 1, GRANT: 1, REVOKE: 1, COMMENT: 1, ANALYZE: 1, VACUUM: 1, REFRESH: 1
};

function looksLikeSql(toks) {
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i];
    if (t.type !== 'word') continue;
    if (SQL_HINT[String(t.upper || '').toUpperCase()]) return true;
  }
  return false;
}

/* ---------------------------------------------------------------- 入口 */

/* 长度上限的单位是 **UTF-8 字节**，不是 UTF-16 码元。
 *
 * P3-4（2026-11-06 复核）：旧实现用 `text.length`，注释却写着"约 400 KB"。
 * 两者在中文上差 1.5 倍（UTF-16 里一个汉字 1 码元，UTF-8 里 3 字节），
 * 400k 码元的中文实际是 1.2 MB —— 语义上限形同虚设；反过来纯 ASCII 的
 * 400 KB 又恰好在边界上，两端口径都不一致。
 * 现在与格式化路径（extension.js 的 textByteLength）统一按字节判定。 */
var DEFAULT_MAX_BYTES = 400000;   /* 约 400 KB（UTF-8 字节）：再大不值得每次击键都分析 */

/* 按 UTF-8 真实字节数。Node 环境用 Buffer.byteLength；极老宿主退回
 * "码元数 × 3" 的保守上界 —— 宁可早跳过，不要卡死编辑器。 */
function utf8Length(text) {
  if (typeof text !== 'string') return 0;
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(text, 'utf8');
  }
  return text.length * 3;
}

/* lintText(text, opts) → { ok, issues, reason }
 *
 * opts:
 *   dialect       —— languageId 或方言名，决定 `#` / 反斜杠的语义
 *   disabledRules —— 要静音的规则 id 数组
 *   maxBytes      —— 超过这个**字节数**直接跳过（返回 ok:false, reason:'too-large'）
 *   maxChars      —— maxBytes 的旧名，保留兼容：数值按字节解释
 */
function lintText(text, opts) {
  var res = { ok: false, issues: [], reason: '' };
  if (typeof text !== 'string' || !text) { res.ok = true; return res; }

  opts = opts || {};
  var limit = opts.maxBytes || opts.maxChars || DEFAULT_MAX_BYTES;
  if (utf8Length(text) > limit) {
    res.reason = 'too-large';
    return res;
  }

  var packed;
  try {
    packed = kernel.tokenizeForLint(text, opts.dialect);
  } catch (e) {
    res.reason = 'tokenize-failed';
    return res;
  }

  var toks = (packed && packed.tokens) || [];
  res.ok = true;
  if (!toks.length) return res;

  /* `unterminated` 是词法器挂在数组上的标记，但 markGenericTypes 会重建数组。
   * 内核已经把它单独传出来，这里把它重新挂回 token 数组，规则函数才能看到。
   * P1-6（2026-11-05 复核）：类型与起点也要一起挂回去 —— 否则诊断只能
   * 按"首尾引号是否成对"猜，未闭合的块注释会把**闭合正常**的字符串报成错误。 */
  if (packed && packed.unterminated) {
    toks.unterminated = true;
    toks.unterminatedKind = packed.unterminatedKind || '';
    toks.unterminatedStart = typeof packed.unterminatedStart === 'number'
      ? packed.unterminatedStart : -1;
  }

  /* 不是 SQL 就不诊断。这里返回 ok:true + 空 issues：调用方应当清空诊断，
   * 而不是报告"跳过" —— 用户不关心这个文件为什么没波浪线。 */
  if (!looksLikeSql(toks)) {
    res.reason = 'not-sql';
    return res;
  }

  var ctx = new Ctx(text, toks, opts, packed.lex);

  for (var gi = 0; gi < GLOBAL_RULES.length; gi++) {
    try { GLOBAL_RULES[gi](ctx, toks); } catch (e) { /* 单条规则出错不能拖垮整次诊断 */ }
  }

  var stmts = splitStatements(toks);
  for (var si = 0; si < stmts.length; si++) {
    var st = stmts[si];
    if (!st.length) continue;
    if (st.length === 1 && st[0].type === 'client') continue;
    for (var ri = 0; ri < STMT_RULES.length; ri++) {
      try { STMT_RULES[ri](ctx, st, si); } catch (e) { /* 同上 */ }
    }
  }

  ctx.issues.sort(function (a, b) {
    if (a.line !== b.line) return a.line - b.line;
    return a.character - b.character;
  });
  res.issues = ctx.issues;
  return res;
}

module.exports = {
  lint: lintText,
  RULES: RULES,
  ruleMeta: function (id) { return RULE_MAP[id] || null; },
  buildLineStarts: buildLineStarts,
  posOf: posOf
};

/* ------------------------------------------------------------------ 自检
 *
 * `node src/lint.js --selftest`：不依赖 VS Code、不依赖回归套件，
 * 单独跑一遍每条规则和几条"不该报"的对照。用来在改动规则表后快速确认
 * 没把引擎写坏 —— `npm run lint` 走的就是这条路。
 *
 * 之所以放在文件内而不是 test/：诊断引擎是纯函数，它自己的冒烟不该
 * 依赖整个扩展的测试脚手架。
 */
if (require.main === module && process.argv.indexOf('--selftest') > 0) {
  var pass = 0, fail = 0;
  function expect(label, sql, want) {
    var r = lintText(sql, { dialect: 'mysql' });
    var got = r.issues.map(function (x) { return x.rule; }).sort().join(',');
    var wantStr = (want || []).slice().sort().join(',');
    if (got === wantStr) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + '  got[' + got + '] want[' + wantStr + ']'); }
  }

  console.log('诊断引擎自检（' + RULES.length + ' 条规则）');
  expect('SELECT *', 'select * from t', ['style.select-star']);
  expect('= NULL', 'select a from t where b = NULL', ['danger.null-comparison']);
  expect('DELETE 无 WHERE', 'delete from t', ['danger.delete-update-no-where']);
  expect('括号不配对', 'select (a from t', ['syntax.unbalanced-paren']);
  expect('字符串未闭合', "select a from t where b = 'abc", ['syntax.unterminated-string']);
  expect('末尾逗号', 'select a, b, from t', ['syntax.trailing-comma']);
  expect('IN 空列表', 'select a from t where a in ()', ['syntax.empty-in-list']);
  expect('NOT IN 子查询', 'select a from t where a not in (select id from u)', ['danger.not-in-subquery']);
  expect('JOIN 缺 ON', 'select a.x from ta a join tb b where a.id = 1', ['danger.join-without-on']);
  expect('笛卡尔积', 'select a.x from ta a, tb b', ['danger.cartesian-product']);
  expect('UNION 无 ALL', 'select a from t union select b from u', ['style.union-vs-union-all']);
  expect('ORDER BY 序号', 'select a, b from t order by 1', ['style.order-by-ordinal']);
  expect('LIKE 前缀通配', "select a from t where n like '%abc'", ['style.leading-wildcard-like']);
  expect('DISTINCT + GROUP BY', 'select distinct a from t group by a', ['style.distinct-with-groupby']);
  expect('AND/OR 混用', 'select a from t where x = 1 and y = 2 or z = 3', ['danger.and-or-mixed']);
  expect('保留字别名', 'select a as from from t', ['syntax.reserved-alias']);
  expect('重复 WHERE', 'select a from t where x = 1 where y = 2', ['syntax.duplicate-clause']);
  expect('子句顺序', 'select a where x = 1 from t', ['syntax.clause-order']);
  expect('隐式连接', 'select a.x from ta a, tb b where a.id = b.id', ['style.implicit-join']);

  console.log('  --- 不该报的 ---');
  expect('EXISTS(SELECT *)', 'select 1 from t where exists (select * from u where u.id = t.id)', []);
  expect('COUNT(*)', 'select count(*) from t', []);
  expect('CROSS JOIN', 'select a from t cross join u', []);
  expect('JOIN 有 ON', 'select a.x from t a join u b on a.id = b.id', []);
  expect('IS NULL', 'select a from t where b is null', []);
  expect('括号内 OR', 'select a from t where (x = 1 or y = 2) and z = 3', []);
  expect('普通文本', 'hello world', []);
  expect('JSON', '{"a": 1}', []);

  console.log('');
  console.log('自检结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exitCode = fail ? 1 : 0;
}
