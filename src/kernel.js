'use strict';

/* ==========================================================================
 * Snug SQL Formatter - 格式化内核
 *
 * 设计思路：
 *   1) 词法分析：把 SQL 切成 token（字符串/注释/标识符/数字/符号），
 *      注释与字符串永远不会被当成分隔符处理；
 *   2) 语法级输出：按 SELECT / FROM / JOIN / ON / WHERE / GROUP BY ... 子句
 *      生成逻辑行，行内只做受控的空格规整；
 *   3) 后处理：超长行折行、AS 对齐、逗号位置、注释对齐。
 * ========================================================================== */

/* 内核在没有显式宽度时的兜底值。扩展层会传入"屏幕宽度 × 80%"，
 * 这里只是给直接调用 `kernel.sql(...)` 的场景一个合理默认。 */
var DEFAULT_MAX_LINE = 160;

/* ============================== 关键字表 ============================== */

/* 「裸用作列名必然报错」的极少几个词（豆包 BUG-9）。
 * 刻意不包含 DATE / USER / TYPE / VALUE / KEY / INDEX 这类
 * 在主流方言里可以直接当列名的词 —— 给它们加引号只是噪音。 */
var HARD_RESERVED = {
  SELECT: 1, FROM: 1, WHERE: 1, GROUP: 1, ORDER: 1, BY: 1, HAVING: 1,
  INSERT: 1, UPDATE: 1, DELETE: 1, CREATE: 1, DROP: 1, ALTER: 1, TABLE: 1,
  JOIN: 1, UNION: 1, INTERSECT: 1, EXCEPT: 1, AND: 1, OR: 1, NOT: 1,
  /* L4（第三轮审计）：这里的 `ENDAS` 是笔误 —— 本意是 `END` 与 `AS` 两个词，
   * 拼成一个不存在的词导致 `AS` 不在硬保留字表里（`select a as as from t`
   * 生成 DDL 时列名 `as` 不会加引号，复制出去是语法错误）。 */
  NULL: 1, CASE: 1, WHEN: 1, THEN: 1, ELSE: 1, END: 1, AS: 1,
  LIMIT: 1, OFFSET: 1, DESC: 1, ASC: 1, INTO: 1, VALUES: 1, SET: 1,
  PRIMARY: 1, FOREIGN: 1, REFERENCES: 1, CONSTRAINT: 1, DISTINCT: 1
};
var KEYWORDS = (function () {
  var list =
    'ADD ALL ALTER ANALYZE AND ANTI ANY ARCHIVE ARRAY AS ASC AT BETWEEN BIGINT BINARY ' +
    'BOOLEAN BOTH BY CACHE CASE CAST CHAR CLUSTER CLUSTERED COLLECTION COLUMNS COMMENT ' +
    'CONSTRAINT CREATE CROSS CUBE CURRENT CURRENT_DATE CURRENT_TIMESTAMP DATABASE ' +
    'DATABASES DATE DATETIME DAY DECIMAL DELETE DELIMITED DESC DESCRIBE DIRECTORY DISTINCT ' +
    'DISTRIBUTE DIV DOUBLE DROP ELSE END ESCAPED EXCHANGE EXISTS EXPLAIN EXPORT EXTENDED ' +
    'EXTERNAL EXTRACT FALSE FIELDS FILEFORMAT FILTER FIRST FLOAT FLOOR FOLLOWING FOR FORMAT ' +
    'FORMATTED FROM FULL FUNCTION FUNCTIONS GROUP GROUPING HAVING HOUR IF IGNORE IMPORT IN ' +
    'INDEX INDEXES INNER INPATH INPUTDRIVER INPUTFORMAT INSERT INT INTEGER INTERSECT INTERVAL ' +
    'INTO IS ITEMS JAR JOIN KEYS LAST LATERAL LEFT LIKE LIMIT LINES LOAD LOCAL LOCATION LOCK ' +
    'LONG MACRO MAP MATCHED MERGE MINUTE MONTH MSCK NONE NOT NULL NULLS NUMERIC OF OFFSET ON ' +
    'OPTIONS OR ORDER OUT OUTER OUTPUTDRIVER OUTPUTFORMAT OVER OVERWRITE PARTITION PARTITIONED ' +
    'PARTITIONS PERCENT PRECEDING PRESERVE PRIMARY PROCEDURE PURGE RANGE RCFILE READ READS ' +
    'REDUCE REFERENCES REFRESH REGEXP RENAME REPAIR REPLACE RESTRICT REVOKE RIGHT RLIKE ROLE ' +
    'ROLES ROLLBACK ROLLUP ROW ROWS SCHEMA SCHEMAS SECOND SELECT SEMI SEQUENCEFILE SERDE ' +
    'SERDEPROPERTIES SET SETS SHOW SMALLINT SORT SORTED START STATISTICS STORED STRING STRUCT ' +
    'TABLE TABLES TBLPROPERTIES TEMPORARY TERMINATED TEXTFILE THEN TINYINT TO TRANSACTION ' +
    'TRANSFORM TRUNCATE TRUE TYPE UNARCHIVE UNBOUNDED UNION UNIQUE UNLOCK UNSET UNSIGNED ' +
    'UPDATE USE USER USING UTC VALUES VARCHAR VIEW VIEWS WHEN WHERE WINDOW WITH YEAR ' +
    'ABS AVG CEIL CEILING COALESCE COLLECT_LIST COLLECT_SET CONCAT_WS CONV COUNT ' +
    'DATEDIFF DATE_ADD DATE_FORMAT DATE_SUB DENSE_RANK DECODE ENCODE EXP EXPLODE FIRST_VALUE ' +
    'FROM_UNIXTIME GET_JSON_OBJECT GREATEST HASH HEX IFNULL INLINE INSTR JSON_TUPLE LAG ' +
    'LAST_VALUE LEAD LEAST LENGTH LOWER LTRIM MAX MD5 MIN MOD NAMED_STRUCT NVL NTILE ' +
    'PARSE_URL PERCENTILE PERCENTILE_APPROX POW POWER RAND RANK ' +
    'REGEXP_EXTRACT REGEXP_REPLACE REPEAT REVERSE ROUND ROW_NUMBER RTRIM SHA1 SHA2 SIGN ' +
    'SIZE SORT_ARRAY SPLIT SQRT STACK STDDEV STR_TO_MAP SUBSTR SUBSTRING SUM TO_DATE ' +
    'TRIM TRUNC UNHEX UNIX_TIMESTAMP UPPER VARIANCE ' +
    /* 补充：Hive / Spark / BigQuery / Snowflake / T-SQL 常见但原表缺失的词 */
    'NATURAL UNCACHE COMPUTE COLUMN QUALIFY ILIKE SOME EXCEPT MINUS PIVOT UNPIVOT ' +
    'FETCH RECURSIVE TABLESAMPLE ONLY CONVERT NULLIF CASCADE FORCE MATERIALIZED ' +
    'CURRENT_USER SESSION_USER LOCALTIME OVERLAPS SIMILAR LEADING TRAILING ' +
    'POSITION OCCURRENCES REGEXP_SUBSTR REGEXP_INSTR ' +
    'TRANSACTIONAL COMPACT CONCATENATE DEFERRED IMMEDIATE VALIDATE NOVALIDATE REBUILD ' +
    'JOINS LEFTSEMI LEFTANTI ' +
    /* 补充：GRANT / SHOW / ANALYZE 等 DDL/DCL 语句里的常见词，让 `grant select ...`、
     * `msck repair table t` 这类语句的关键字也能正确大写 */
    'GRANT ROLES PRIVILEGES PRINCIPALS TTL ' +
    /* 补充：LOAD DATA / T-SQL APPLY / MySQL DISTINCTROW / Impala INT96 /
     * MySQL STRAIGHT_JOIN（P1-4） */
    'DATA APPLY DISTINCTROW INT96 STRAIGHT_JOIN ' +
    /* 补充：窗口帧关键字。它们同时也在 SOFT_IDENT_WORDS 里（因为常被当列名），
     * 由 markKeywords 的窗口帧上下文判定决定是否大写（P1-3） */
      /* 补充：表级约束与外键（H-8）、各方言常见子句词（P2-3）。
       * KEY / FOREIGN 缺失会让 `primary key (a)`、`foreign key (a)` 里的单词不被
       * 当作关键字，输出成 `PRIMARY key (a)` 这种半大写的怪样子。 */
      'KEY FOREIGN CHECK DEFAULT TIME ZONE RETURNS LANGUAGE WITHIN ESCAPING RETURNING ' +
      'CONFLICT DISTRIBUTED SKEWED BUCKETS LIFECYCLE TIMESTAMP SEQUENCE TRIGGER ' +
      /* 补充：事务控制 / 会话设置 / 维护命令（N-41、M-7）。
       * 这些词缺失时不只「不大写」这么简单 —— 它们连语句门槛都过不了，
       * 整条语句被当成非 SQL 原样返回（`set names utf8` 完全没被格式化）。 */
      'CALL COMMIT BEGIN SAVEPOINT RELEASE EXECUTE EXEC PREPARE DEALLOCATE ' +
      'VACUUM DISCARD LISTEN NOTIFY UNLISTEN DO COPY PRAGMA REINDEX CHECKPOINT ' +
      'ATTACH DETACH NAMES AUTOCOMMIT WORK CHAIN ISOLATION LEVEL WRITE ' +
      'LOCK UNLOCK RETURNS INOUT OUT INOUT TERMINATE ' +
      'UNBOUNDED FRAME GROUPS EXCLUDE TIES OTHERS ' +
      /* L-3 / L-11：过程化语句与方言专属关键字。
       * 它们全部同时是常见列名/函数名，所以也在 SOFT_IDENT_WORDS 里，
       * 只由 markKeywords 的上下文判据决定是否大写 —— 但必须**先存在于 KEYWORDS**，
       * 否则 markKeywords 第一行 `if (!KEYWORDS[u]) { tk.keyword = false; continue; }`
       * 会直接跳过，后面写多少上下文规则都没用
       * （`top` / `declare` / `prewhere` / `tables` 之前就是这样被漏掉的）。 */
      'DECLARE RETURN RETURNS FUNCTION PROCEDURE TRIGGER LANGUAGE EACH LOOP WHILE ' +
      'REPEAT UNTIL EXIT CONTINUE HANDLER SIGNAL RESIGNAL DELIMITER CURSOR OPEN CLOSE ' +
      'INOUT DETERMINISTIC IMMUTABLE STABLE VOLATILE ' +
      'TOP PREWHERE SAMPLE FINAL SETTINGS ' +
      /* N9（2026-11-04 复核）：MySQL 分区子句 `PARTITION p0 VALUES LESS THAN (…)` /
       * `SUBPARTITION sp0` —— 这两组词完全缺失时同一句 DDL 里
       * `PARTITION BY RANGE(a)` 大写、`values less than` 小写，非常显眼。
       * LESS / THAN 在 SOFT 表里（它们也可能是列名），由固定短语判据决定。 */
      'LESS THAN MAXVALUE SUBPARTITION SUBPARTITIONS ' +
      /* F-04（2026-11-04 复核）：ESCAPE / NEXT 此前**根本不在 KEYWORDS**，
       * markKeywords 第一行 `if (!KEYWORDS[u]) { tk.keyword = false; continue; }`
       * 就直接跳过，后面写多少位置判据都不可能生效：
       *   `where b like '%x\_%' escape '\'` → escape 永远小写
       *   `fetch next 10 rows only`         → next 永远小写
       * 两者都是标准 SQL 的固定短语词，缺失只会造成同句大小写混杂。 */
      'ESCAPE NEXT ' +
      /* 方言兼容性检测报告 §3.3/§3.4/§3.5：各数据库特色语法词。
       * 这些词以前根本不在 KEYWORDS 里，markKeywords 第一行就直接跳过，
       * 无论后面写多少上下文规则都没用（`engine = innodb` 永远是 `engine`、
       * `compute stats t` 永远是 `compute stats t`）。
       * 它们**同时**被加进 SOFT_IDENT_WORDS，由 markKeywords 的
       * DIALECT_SOFT 段按方言位置判据决定是否大写 —— 详见那边的注释。
       * 纯函数名（UNNEST / SAFE_CAST / IFF / FLATTEN / IDENTIFIER /
       * GENERATE_ARRAY / GENERATE_SERIES）走 BUILTIN_FUNCS（L3e 已有机制），
       * 只有紧跟 `(` 时才统一大小写，不放进这张表。 */
      'ENGINE CHARSET SEPARATOR ROWNUM IDENTITY STATS METADATA TOTALS CONNECT PRIOR ' +
      'SIBLINGS DISTKEY SORTKEY OUTPUT SYSTEM OPTIMIZE INVALIDATE FLUSH RELOAD ' +
      'AUTO_INCREMENT DICTIONARIES PRIVILEGES ' +
      'NVARCHAR DATETIME2 INT64 FLOAT64 CHARACTER ' +
      /* 第六轮审计：以下词此前完全不在 KEYWORDS 里，markKeywords 第一行就跳过，
       * 于是「它出现在关键字位置时也不大写」—— 见报告 A-4/A-5/A-9/A-11/A-14/A-16。
       * 它们都不会是常见列名，因此按硬关键字处理即可：
       *   OPTION / RECOMPILE / MAXDOP   T-SQL 查询提示（`OPTION (RECOMPILE)`）
       *   PIVOT / UNPIVOT / MATCH_RECOGNIZE  行列变换子句
       *   TABLESAMPLE                 采样子句
       *   CONFLICT / NOTHING           PG/SQLite `ON CONFLICT … DO NOTHING`
       *   DUPLICATE                    MySQL `ON DUPLICATE KEY UPDATE`
       *   NOCYCLE                      Oracle `CONNECT BY NOCYCLE`
       *   WITHOUT / ROWID              SQLite `WITHOUT ROWID`
       *   SKIP / LOCKED / NOWAIT       `FOR UPDATE SKIP LOCKED`
       *   NOLOCK / HOLDLOCK / UPDLOCK / ROWLOCK / READPAST / TABLOCK
       *                                T-SQL 表提示（`WITH (NOLOCK)`）
       *   QUARTER / WEEK / DOW / DOY   EXTRACT 的字段名
       *   FLASHBACK / UNDROP / SWAP    Oracle / Snowflake 的语句头
       *   NOCACHE / NOCYCLE_ 等省略 */
      'OPTION RECOMPILE MAXDOP PIVOT UNPIVOT MATCH_RECOGNIZE TABLESAMPLE ' +
      'CONFLICT NOTHING DUPLICATE NOCYCLE WITHOUT ROWID ' +
      'SKIP LOCKED NOWAIT NOLOCK HOLDLOCK UPDLOCK ROWLOCK READPAST TABLOCK ' +
      'QUARTER WEEK DOW DOY FLASHBACK UNDROP SWAP NOCACHE ' +
      'BEFORE AFTER ENABLE DISABLE VALIDATE NOVALIDATE MODIFY ALGORITHM ' +
      'LINESTRING UNLOAD IAM_ROLE TIMEFORMAT ' +
      /* 第六轮审计补充：ALTER TABLE 的动词族与视图约束修饰词。
       *   CHANGE       MySQL `ALTER TABLE t CHANGE a b INT`（此前完全不在表里）
       *   CASCADED / LOCAL  `WITH [CASCADED|LOCAL] CHECK OPTION` */
      'CHANGE CASCADED LOCAL';
  var obj = Object.create(null);
  list.split(/\s+/).forEach(function (w) { if (w) obj[w] = true; });
  return obj;
})();

/* 这些词后面紧跟 "(" 时需要空格：IN (1,2)、AS (SELECT ...)、FROM (...) */
var SPACE_BEFORE_PAREN = {
  IN: 1, NOT: 1, EXISTS: 1, AS: 1, FROM: 1, JOIN: 1, ON: 1, USING: 1, OVER: 1,
  UNION: 1, TABLE: 1, COLUMNS: 1, PARTITIONED: 1, SETS: 1,
  AND: 1, OR: 1, WHEN: 1, THEN: 1, ELSE: 1, SELECT: 1, WHERE: 1, HAVING: 1, LIMIT: 1,
  INTO: 1, UPDATE: 1, SET: 1, WINDOW: 1, PARTITION: 1,
  CASE: 1, LATERAL: 1, VIEW: 1, GROUP: 1, ORDER: 1, SORT: 1,
  DISTRIBUTE: 1, CLUSTER: 1,
  /* BY (：GROUP BY (a,b) / ORDER BY (a+b) / PARTITIONED BY (dt STRING)。
   * 旧表里没有 BY，`(` 走默认分支返回 false，输出成 `GROUP BY(a, b)`（P2-1）。 */
  BY: 1,
  /* 补：这些词后面接括号同样需要空格，否则会写出 BETWEEN(1)、VALUES(1,2) */
  BETWEEN: 1, LIKE: 1, RLIKE: 1, REGEXP: 1, IS: 1, VALUES: 1, FILTER: 1,
  INTERSECT: 1, EXCEPT: 1, MINUS: 1, OFFSET: 1, QUALIFY: 1, RETURNING: 1,
  NATURAL: 1, ANTI: 1, SEMI: 1, EXCHANGE: 1, REFRESH: 1, REBUILD: 1,
  /* 第六轮审计（A-5）：这些是"子句词 + 括号参数"，不是函数调用，
   * 括号前必须留空格。缺了会输出 `option(recompile)` / `PIVOT(x …)` /
   * `CONFLICT(id)` / `TABLESAMPLE(10 PERCENT)` —— 看起来像自定义函数。
   * 它们同时被加进 KEYWORDS，保证大小写统一。 */
  OPTION: 1, PIVOT: 1, UNPIVOT: 1, MATCH_RECOGNIZE: 1, TABLESAMPLE: 1,
  CONFLICT: 1, WITHOUT: 1,
  /* `UNLOAD ('select …') TO 's3://…'` —— Redshift 的卸载语句，括号里是查询文本。
   * 不加空格会输出成 `UNLOAD('select …')`，看起来像函数调用。 */
  UNLOAD: 1,
  /* 方言兼容性检测报告 §3.4：这些词后接 `(` 时语义上是"子句 + 括号参数"，
   * 不是函数调用，必须留空格。
   * **IDENTITY 除外**：`int identity(1,1)` 里它是列属性而不是子句，
   * SQL Server 官方写法就是紧贴（`IDENTITY(1,1)`），所以走 FUNCTION_WORDS。 */
  DISTKEY: 1, SORTKEY: 1,
  /* 表级约束的词后面接括号同样要空格（H-8 的 sql() 路径）：
   * `PRIMARY KEY (a)` / `UNIQUE KEY uk (a)` / `FOREIGN KEY (a)` / `CHECK (a > 0)` /
   * `INDEX idx (a)`。旧表里没有这些词，输出成 `PRIMARY KEY(a)`（缺空格）。 */
  /* 只放**不可能被当函数名**的约束头词。KEY / INDEX / FOREIGN / CHECK 常作函数名
   * （`index(a)` / `foreign(a)` / `check(a)`），放进这张表会把函数调用的空格改掉；
   * 它们在 DDL 约束里的空格由 spaceBetween 里的 tk.keyword 判定单独处理。 */
  PRIMARY: 1, UNIQUE: 1, CONSTRAINT: 1, REFERENCES: 1,
  /* L-7 / L-11：T-SQL 表提示 `WITH (nolock)`、`TOP (10)`、
   * ClickHouse 子句 `PREWHERE (`。这三个词后面接的括号都需要一个空格，
   * 旧表里没有它们，输出成 `WITH(nolock)` / `TOP(10)`（缺空格）。 */
  WITH: 1, TOP: 1, PREWHERE: 1,
  /* L3a（第三轮审计）：`UNION ALL (SELECT …)` 的 ALL 后面接括号要空格。
   * 旧表里只有 UNION 没有 ALL，输出成 `UNION ALL(SELECT …)`。 */
  ALL: 1,
  /* L-1：MERGE 的 `INSERT (id, a)` 必须留空格；INSERT 在 FROM/JOIN 这类
   * 位置词里没有，旧表里又只有 INTO，于是 `INSERT(id, a)` 贴死。 */
  INSERT: 1,
  /* F14（2026-10-29 复核）：这些是"DDL 子句词 + 括号参数"，不是函数调用。
   * 缺空格会输出 `TBLPROPERTIES('k' = 'v')`，看起来像自定义函数，
   * 与同一份 DDL 里 `PARTITIONED BY (…)` 的风格也不一致。 */
  TBLPROPERTIES: 1, SERDEPROPERTIES: 1, LIFECYCLE: 1, SETTINGS: 1,
  STORED: 1, TERMINATED: 1, LOCATION: 1, ENGINE: 1, CHARSET: 1, SEPARATOR: 1
};

/* 函数名（包括 CAST/EXTRACT 这类"关键字函数"），后面紧跟括号时不能有空格。
 * LEFT / RIGHT 既是 JOIN 修饰词也是字符串函数（P2-2）：必须放进来，
 * 否则 `left(a, 2)` 被当成关键字输出成 `LEFT (a, 2)`。
 * 同时把 DATE/TIME/... 之类的构造器型函数补齐。 */
var FUNCTION_WORDS = {
  CAST: 1, EXTRACT: 1, TRIM: 1, SUBSTRING: 1, POSITION: 1, CONVERT: 1,
  COALESCE: 1, NULLIF: 1, INTERVAL: 1, ARRAY: 1, MAP: 1, STRUCT: 1, DATE: 1, TIME: 1,
  TIMESTAMP: 1, DECIMAL: 1, NUMERIC: 1, CHAR: 1, VARCHAR: 1, BINARY: 1,
  /* LEFT(str, n) / RIGHT(str, n) 是字符串函数，不是 JOIN 修饰词（P2-2） */
  LEFT: 1, RIGHT: 1, REPLACE: 1, MOD: 1, DIV: 1, TRUNCATE: 1, ABS: 1, ROUND: 1,
  /* 方言兼容性检测报告 §3.4：`NVARCHAR(MAX)` / `DATETIME2(7)` /
   * `INT64(...)` / `CHARACTER(20)` 是**类型名 + 精度**，不是函数调用，
   * 但它们后面同样不能有空格（`NVARCHAR (MAX)` 虽然合法但很难看，
   * 更重要的是 DDL 里要和 Hive 的 `STRING` 等保持一致）。
   * 放这里等于"词 + ( 不留空格"，与 FUNCTION_WORDS 的语义一致。 */
  NVARCHAR: 1, DATETIME2: 1, INT64: 1, FLOAT64: 1, CHARACTER: 1,
  /* `int IDENTITY(1,1)`：SQL Server 官方写法就是紧贴，走"函数名"语义。 */
  IDENTITY: 1
};

/* 表名/别名之后出现 "(" 时（如 INSERT INTO t (a,b)）同样需要空格 */
var NAME_POSITION = {
  FROM: 1, JOIN: 1, INTO: 1, TABLE: 1, UPDATE: 1, ON: 1, USING: 1, AS: 1,
  EXISTS: 1, VIEW: 1, DATABASE: 1, IN: 1
};

/* 这些词后面出现的 +/- 属于一元运算符 */
var UNARY_WORDS = {
  SELECT: 1, WHERE: 1, AND: 1, OR: 1, NOT: 1, ON: 1, WHEN: 1, THEN: 1, ELSE: 1, BY: 1,
  AS: 1, IN: 1, BETWEEN: 1, LIKE: 1, IS: 1, SET: 1, RETURN: 1, HAVING: 1, LIMIT: 1,
  OFFSET: 1, VALUES: 1, CASE: 1, END: 1, DESC: 1, ASC: 1, DIV: 1, ALL: 1, ANY: 1,
  /* 值位置词之后的 +/- 是一元符号（N-27）：`DEFAULT -1.5`、`SET a = -1`、
   * `VALUES (-1)`、`OFFSET -1`。旧表里没有 DEFAULT，于是输出成 `DEFAULT - 1.5`。 */
  DEFAULT: 1, COMMENT: 1, RETURNING: 1
};

/* 子查询开始前需要换行的关键字 */
var BLOCK_OPEN_BREAK = { FROM: 1, JOIN: 1, AS: 1, UNION: 1, ALL: 1, IN: 0, EXISTS: 0 };

/* DDL 中需要独立成行的结构关键字 */
var DDL_BREAK = {
  COMMENT: 1, PARTITIONED: 1, STORED: 1, LOCATION: 1, TBLPROPERTIES: 1, CLUSTERED: 1,
  SORTED: 1, SKEWED: 1, LIFECYCLE: 1, ROW: 1, FIELDS: 1, LINES: 1, COLLECTION: 1, SERDE: 1
};

/* DDL 中 "(" 里是列定义列表 */
var DDL_PAREN_BEFORE = { TABLE: 1, PARTITIONED: 1, COLUMNS: 1, TBLPROPERTIES: 1 };

/* 多字符运算符表。**顺序即优先级**：tokenizeRaw 取第一个能匹配上的，
 * 所以长运算符必须排在它的所有前缀之前（`!~~*` 在 `!~~`/`!~` 之前）。
 *
 * PostgreSQL 的匹配类运算符（A-01）必须整体成 token：它们不在表里时，词法器会
 * 逐字符切成 `~` + `*`，spaceBetween 再插空格 → `a ~* 'x'` 变 `a ~ * 'x'`，
 * 语义直接改坏；更糟的是 dangerGlue 只在 MULTI_OP_SET 命中时记 hard 指纹，
 * 未登记的运算符输入/输出两侧都没有指纹，安全网**必然放行**。
 * 覆盖 PG 全部 6 个正则匹配符（~  ~*  !~  !~*  ~~  ~~*  !~~  !~~*）。 */
var MULTI_OPS = ['!~~*', '~~*', '!~~', '!~*', '~*', '~~', '!~',
  '<=>', '->>', '->', '=>', '>=', '<=', '<>', '!=', '||/', '||', '::', ':=', '==', '&&', '!>', '!<', '**', '<<', '>>',
  /* PostgreSQL 专用运算符。必须整体成 token，否则 spaceBetween 会把它们拆开插空格
   * （`@>` 变 `@ >`），语义直接改坏；且安全网比较前会剥掉空白，恰好放行这类破坏。 */
  '#>>', '#>', '<@', '@>', '?|', '?&', '~>', '~<~', '~>=', '~<=~', '<<|', '|>>', '&<|', '|&>', '<^', '^>'];

/* H5（第二轮审计）：上表末尾这批是 **PostgreSQL 专属**运算符。
 * 它们对所有方言生效会造成两类破坏：
 *
 *   · JDBC 的 `?||'%'`（`?` 占位符 + 字符串拼接）：`?|` 先被贪婪匹配走，
 *     剩下一个 `|` 再单独成 token，输出成 `?| | '%'`；
 *   · T-SQL / MySQL 的 `id<@maxId`（`<` + `@变量`）：`<@` 被当"包含于"，
 *     输出成 `<@ maxId`。
 *
 * 判据（两条，任一成立就不认这个 PG 运算符，退回单字符处理）：
 *   a) 运算符后面**紧贴**标识符/数字 → 更像是「单字符运算符 + @变量 / ?占位符」；
 *   b) 运算符后面紧跟 `|` / `&` → 原本是 `?||` 这种「占位符 + 拼接运算符」。
 * 真正的 PG 写法（`data #> '{a,b}'`、`a <@ b`、`tags ?| array[...]`）后面
 * 都是空白或引号/括号，不受影响。 */
var PG_ONLY_OPS = (function () {
  var o = Object.create(null);
  ['#>>', '#>', '<@', '@>', '?|', '?&', '~>', '~<~', '~>=', '~<=~', '<<|', '|>>', '&<|', '|&>', '<^', '^>']
    .forEach(function (x) { o[x] = 1; });
  return o;
})();

function pgOpAllowed(sql, i, op) {
  if (!PG_ONLY_OPS[op]) return true;
  var nc = sql.charAt(i + op.length);
  if (nc === '') return true;
  if (/[\p{L}\p{Nl}\p{Nd}_$@#]/u.test(nc)) return false;   /* <@maxId / ?|abc */
  if (nc === '|' || nc === '&') return false;              /* ?||'%' */
  return true;
}

/* ============================== 词法分析 ============================== */

/* 标识符字符集。@ 与 # 必须同时出现在 start / part 两个字符集里：
 * 旧版只把 @# 放进 start，遇到 `@x` 时 word 分支切出空 token 且 i 不前进，
 * while(i<n) 变成死循环，每轮 push 一个空 token → 堆内存耗尽（P0-1）。
 * 这里同时把 @# 加进 part，`@x`、`@@session`、`#tmp` 都会被当成一个完整标识符。 */
/* 字符集必须覆盖全部 Unicode 字母（P0-2）：旧版只写 \u4e00-\u9fa5，
 * `naïve`、`имя`、`ñ` 这类标识符会被逐字符切成 punct 并在中间插空格，
 * 而安全网对"单个字母"无能为力（切完仍然是合法 token）。 */
var WORD_START_RE = /[\p{L}\p{Nl}_@#]/u;
var WORD_PART_RE = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}_$@#]/u;

/* ASCII 快通道 + 非 ASCII 回落正则。
 *
 * 等价性：
 *   WORD_START_RE = /[\p{L}\p{Nl}_@#]/u
 *     \p{L} 在 0x00-0x7F 恰好是 A-Z a-z；\p{Nl} 全在非 ASCII；
 *     其余为字面量 _ @ #  →  ASCII 下等价于 [A-Za-z_@#]
 *   WORD_PART_RE = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}_$@#]/u
 *     \p{Nd} 在 0x00-0x7F 恰好是 0-9；\p{Mn}/\p{Mc} 全在非 ASCII
 *     →  ASCII 下等价于 [A-Za-z0-9_$@#]
 * 非 ASCII（中文标识符 / 'naïve' / 'имя' / 'ñ'）仍走原正则，行为不变。
 * 等价性由 audit/_opt_equiv.js 对 0x0000-0x10FFFF 全码位对拍。 */
var ASCII_WORDSTART = new Uint8Array(128);
var ASCII_WORDPART = new Uint8Array(128);
(function () {
  for (var c = 0; c < 128; c++) {
    var ch = String.fromCharCode(c);
    /* 直接用原正则构造表，避免手抄 A-Za-z 出错 */
    ASCII_WORDSTART[c] = WORD_START_RE.test(ch) ? 1 : 0;
    ASCII_WORDPART[c] = WORD_PART_RE.test(ch) ? 1 : 0;
  }
})();

function isWordStart(ch) {
  if (ch === undefined || ch === null || ch === '') return false;
  var c = ch.charCodeAt(0);
  if (c < 128) return ASCII_WORDSTART[c] === 1;
  return WORD_START_RE.test(ch);
}
function isWordPart(ch) {
  if (ch === undefined || ch === null || ch === '') return false;
  var c = ch.charCodeAt(0);
  if (c < 128) return ASCII_WORDPART[c] === 1;
  return WORD_PART_RE.test(ch);
}

/* 码点感知版的 isWordStart / isWordPart（A-02）。
 *
 * 旧实现直接取 `sql[i]`（一个 UTF-16 码元）喂给正则。增补平面字符
 * （U+10000 以上，如 `𐐀`、`𝕏`、emoji）在 JS 里是两个代理项，
 * 单独一个代理项既不是 \p{L} 也不是 \p{Mn}，于是：
 *   - `select 𐐀abc from t` 的 `𐐀` 不被当标识符起始 → 落到单字符 punct 分支，
 *     输出成 `\ud801 \udc00 abc`，一个合法标识符被拆成三个 token；
 *   - 安全网看不出问题（切完仍是"合法 token"），破坏被放行。
 * 这里按码点取字符（length=2 时用 slice 出完整代理对），正则加 /u 后
 * \p{L} 就能正确匹配增补平面的字母。
 * 返回值 { ok, len }：len 是该字符占的码元数（1 或 2）。 */
function wordCharAt(sql, i, part) {
  if (i >= sql.length) return { ok: false, len: 0 };
  var c0 = sql.charCodeAt(i);
  if (c0 < 128) return { ok: (part ? ASCII_WORDPART : ASCII_WORDSTART)[c0] === 1, len: 1 };
  /* 高位代理 + 合法低位代理 → 组成一个码点 */
  if (c0 >= 0xD800 && c0 <= 0xDBFF && i + 1 < sql.length) {
    var c1 = sql.charCodeAt(i + 1);
    if (c1 >= 0xDC00 && c1 <= 0xDFFF) {
      var pair = sql.slice(i, i + 2);
      return { ok: (part ? WORD_PART_RE : WORD_START_RE).test(pair), len: 2 };
    }
  }
  var one = sql.charAt(i);
  return { ok: (part ? WORD_PART_RE : WORD_START_RE).test(one), len: 1 };
}
function isWordStartAt(sql, i) { return wordCharAt(sql, i, false).ok; }
function isWordPartAt(sql, i) { return wordCharAt(sql, i, true).ok; }

/* 字符串字面量前缀：N'..' E'..' X'..' B'.. _utf8'..' U&'..'
 * 旧版把前缀当成独立 word，输出成 `N 'abc'`，语义从"字符串"变成"列 N 与字符串"。 */
/* P0-6（2026-11-02 审计）：BigQuery 的原始字符串 / 字节字符串前缀。
 * 官方词法列出了 r、b、rb、br（大小写不敏感），它们**必须**与引号紧贴，
 * 拆开就变成"列名 + 字符串"。旧正则只有 N/E/X/B 与 _charset 与 U&，
 * 于是 `r'\d+'` 被排成 `r '\d+'`。
 *
 * 注意 B 的歧义：标准 SQL 的 B'01' 是位串，BigQuery 的 b'...' 是字节串，
 * 两者都要求紧贴，所以合并成一个前缀集合没有副作用。
 * 顺序要求：长的在前（rb / br 先于 r / b），否则正则只吃到 r。 */
var STRING_PREFIX_RE = /^(?:rb|br|rb_|br_|[NnEeXxBbRr]|_[A-Za-z0-9]+|U&)$/i;
/* 需要强制按反斜杠转义扫描的前缀（P0-2）：PG 的 E'..'、BigQuery 的 r/b/rb/br。 */
var BS_PREFIX_RE = /^(?:[Ee]|rb|br|rb_|br_)$/i;

function tokenize(sql, opts) {
  var o = opts || LEX;
  var tokens = markGenericTypes(tokenizeRaw(sql, o), o);
  tokens = markPathTokens(tokens);
  return markKeywords(tokens);
}

/* 词法选项（方言开关）。Formatter 构造时写入，所有内部的 tokenize() 调用自动继承，
 * 不需要给每个工具函数加参数。 */
  var LEX = { backslash: false, hashComment: false, hashMode: 'comment', dashSpace: false, dialect: '' };

  /* joinTokens 的大小写模式：'upper'（默认） / 'lower'（uppercase=false） */
  var JOIN_CASE = 'upper';

/* ---------------------------------------------------------------- 关键字歧义
 * 这些词既是 SQL 关键字，也极常被当成列名 / 表名（Hive、MySQL 里都合法）。
 * 旧版只要命中 KEYWORDS 就无条件大小写转换，`select date, user, type from t`
 * 会被改成 `SELECT DATE, USER, TYPE`（P2-4）。这里给"软关键字"加位置判断：
 * 只有明显处在关键字位置（接左括号 / 接字符串字面量 / 跟在类型词或数字后面 /
 * 紧跟右括号之后）时才当关键字，其余当普通标识符原样保留。
 * 真正不可能当列名的语法词（SET / UPDATE / END / CASE ...）不在此表，永远大写。 */
var SOFT_IDENT_WORDS = {
  DATE: 1, USER: 1, TYPE: 1, COMMENT: 1, LOCATION: 1, SIZE: 1, FORMAT: 1, FORMATTED: 1,
  ROW: 1, ROWS: 1, HASH: 1, LONG: 1, NONE: 1, ONLY: 1, ITEMS: 1,
  READ: 1, READS: 1, INDEX: 1, INDEXES: 1, KEYS: 1, TABLES: 1, COLUMNS: 1, COLUMN: 1,
  MACRO: 1, FUNCTION: 1, FUNCTIONS: 1, OPTIONS: 1, YEAR: 1, MONTH: 1, DAY: 1,
  HOUR: 1, MINUTE: 1, SECOND: 1, FIRST: 1, LAST: 1, FOLLOWING: 1, PRECEDING: 1,
  CURRENT: 1, RANGE: 1, DIV: 1, MOD: 1, OFFSET: 1, PERCENT: 1, BOTH: 1, ESCAPED: 1,
  STATISTICS: 1, ARCHIVE: 1, UNARCHIVE: 1, EXCHANGE: 1, PURGE: 1, RENAME: 1,
  REPAIR: 1, REBUILD: 1, ROLLBACK: 1, ANALYZE: 1, MSCK: 1, SHOW: 1, DESCRIBE: 1,
  LOAD: 1, CACHE: 1, UNCACHE: 1,
  /* 窗口帧词（P1-3）：常被当列名，靠 FRAME_WORDS 上下文判定，默认不当作关键字 */
  UNBOUNDED: 1, GROUPS: 1, EXCLUDE: 1, TIES: 1, OTHERS: 1, FRAME: 1,
    /* 极常见的列名，却同时在 KEYWORDS 里（H-5 / P2-8 / R3-11）。
     * 旧版无条件大写，`select id, data, ttl, position from events` 会变成
     * `SELECT id, DATA, TTL, POSITION`，列名被改写。放进软关键字表后，
     * 只有明显处在关键字位置（后面紧跟括号）时才大写。 */
    DATA: 1, TTL: 1, POSITION: 1,
    LEFT: 1, RIGHT: 1, FULL: 1,
  /* 约束词，同时也是极常见列名（`key`、`foreign`、`check`）：
   * 放进软关键字表，只有在约束短语上下文里才大写（见 markKeywords）。 */
  KEY: 1, FOREIGN: 1, CHECK: 1,
  /* P2-6（2026-11-02 审计）：STORED AS INPUTFORMAT / OUTPUTFORMAT
   * 里的格式名不是关键字，用户写小写就该保持小写。
   * 它们同时也可能是列名，所以放软关键字表里，由上下文判定。 */
  INPUTFORMAT: 1, OUTPUTFORMAT: 1, INPUTDRIVER: 1, OUTPUTDRIVER: 1,
  /* L-3 / L-11：过程化语句与方言专属词。它们在普通查询里同样可能是列名
   * （`select return, top from t`、`where format = 1`），所以必须先归入软关键字，
   * 再由 markKeywords 的过程体/方言上下文决定是否大写。
   * 注意：如果只把它们加进 KEYWORDS 而不加进本表，markKeywords 会在
   * `if (!SOFT_IDENT_WORDS[u])` 那一步无条件大写，反而改坏用户列名。 */
  RETURN: 1, RETURNS: 1, DECLARE: 1, FUNCTION: 1, PROCEDURE: 1, TRIGGER: 1,
  LANGUAGE: 1, EACH: 1, LOOP: 1, WHILE: 1, REPEAT: 1, UNTIL: 1, EXIT: 1,
  CONTINUE: 1, HANDLER: 1, SIGNAL: 1, RESIGNAL: 1, DELIMITER: 1, CURSOR: 1,
  OPEN: 1, CLOSE: 1, INOUT: 1, DETERMINISTIC: 1, IMMUTABLE: 1, STABLE: 1,
  VOLATILE: 1, TOP: 1, PREWHERE: 1, SAMPLE: 1, FINAL: 1, SETTINGS: 1,
  DATABASES: 1, SCHEMAS: 1, PARTITIONS: 1,
  /* M10（第三轮审计）：这些词在 KEYWORDS 里，但同时也是**极常见的列名/别名**：
   *   select time, rank, level from events order by rank
   * 旧实现无条件大写，输出 `SELECT TIME ,RANK ,LEVEL … ORDER BY RANK` ——
   * 列名被改写。放进软关键字表后只有"关键字位置"才提升：
   *   · TIME / TIMESTAMP 后面紧跟类型或括号
   *   · RANK / LEVEL / START / COUNT 出现在窗口/分区/DDL 上下文
   * 其余一律保持用户原文。 */
  TIME: 1, RANK: 1, LEVEL: 1, START: 1, COUNT: 1, VALUE: 1, VALUES_: 0,
  /* 方言兼容性检测报告 §3.4/§3.5：各数据库特色语法词。
   * 全部是**软关键字** —— 它们在同一数据库里也经常是列名
   * （`select engine, charset from t`、`select stats from t`、
   *   `select identity from t`、`select prior from t` …），
   * 无条件大写就是第三轮 M10 修掉的那个 bug 的复现。
   * 是否大写由 markKeywords 的「方言位置判据」决定，见那里的 DIALECT_SOFT 分支。 */
  ENGINE: 1, CHARSET: 1, AUTO_INCREMENT: 1, SEPARATOR: 1, IDENTITY: 1,
  STATS: 1, METADATA: 1, DICTIONARIES: 1, TOTALS: 1, PRIVILEGES: 1,
  /* F-04b（2026-11-04 复核）：ESCAPE / NEXT 是标准 SQL 的固定短语词，
   * 但同时也是可能出现的列名，所以进软表，由上下文判据决定大写：
   *   LIKE '…' ESCAPE '\'   —— 前一个是字符串字面量
   *   FETCH NEXT / FETCH FIRST —— 前一个是 FETCH
   * FIRST 在表里（原本就在软表），这里补它的固定短语判据。 */
  ESCAPE: 1, NEXT: 1,
  /* N9（2026-11-04 复核）：MySQL 分区定义里的固定短语 `VALUES LESS THAN (…)`。
   * LESS / THAN 本身是普通英文词（`select less, than from t` 也合法），
   * 所以进软表，只在 `VALUES LESS THAN` 这个完整短语里大写。 */
  LESS: 1, THAN: 1,
  ROWNUM: 1, CONNECT: 1, PRIOR: 1, SIBLINGS: 1, DISTKEY: 1, SORTKEY: 1,
  NVARCHAR: 1, DATETIME2: 1, INT64: 1, FLOAT64: 1, CHARACTER: 1,
  RELOAD: 1, OUTPUT: 1,

  /* P0-11（2026-11-02 审计）：这批词在 KEYWORDS 里，但同时也是**极常见的
   * 表名/列名**，无条件大写等于改用户数据：
   *     select role, sequence, lock from t
   *     select a from t join Schema s on …
   * MySQL 在多数 Unix 上表名区分大小写，改了可能直接找不到表。
   * 登记为软关键字后，只有真正的语法位置才会大写（见 DDL / 列清单判据）。 */
  ROLE: 1, SEQUENCE: 1, SCHEMA: 1, LOCK: 1, UNLOCK: 1,

  /* F7（2026-10-29 复核）：第六轮为了修"关键字位置不大写"而加进 KEYWORDS 的词里，
   * 有一批**本身就是极常见的列名**，无条件大写等于改用户数据：
   *     select quarter, week, before, after, enable, disable, option, skip,
   *            locked, nowait, nothing, duplicate, change, modify, algorithm
   *     from events
   * 实测 508 个词里因此多出 43 个误大写（上一版是 358 个）。
   * 现在把这批词登记为软关键字：默认保持用户原文，只在 markKeywords 的
   * F7 位置判据成立时才提升。词本身仍留在 KEYWORDS 里 —— 那张表还负责
   * 折行与子句识别，删掉会连带影响排版。 */
  QUARTER: 1, WEEK: 1, DOW: 1, DOY: 1,
  BEFORE: 1, AFTER: 1, ENABLE: 1, DISABLE: 1, MODIFY: 1, CHANGE: 1,
  ALGORITHM: 1, CASCADED: 1, VALIDATE: 1, NOVALIDATE: 1,
  OPTION: 1, RECOMPILE: 1, MAXDOP: 1, MATCH_RECOGNIZE: 1, TABLESAMPLE: 1,
  NOTHING: 1, DUPLICATE: 1, NOCYCLE: 1, WITHOUT: 1, ROWID: 1,
  SKIP: 1, LOCKED: 1, NOWAIT: 1, NOLOCK: 1, HOLDLOCK: 1, UPDLOCK: 1,
  ROWLOCK: 1, READPAST: 1, TABLOCK: 1, NOCACHE: 1,
  FLASHBACK: 1, UNDROP: 1, SWAP: 1,
  LINESTRING: 1, UNLOAD: 1, IAM_ROLE: 1, TIMEFORMAT: 1,
  SYSTEM: 1, OPTIMIZE: 1, INVALIDATE: 1, FLUSH: 1, PIVOT: 1, UNPIVOT: 1,
  CONFLICT: 1
};

/* F7 位置判据用到的集合（与 SOFT_IDENT_WORDS 里那批独立，避免影响既有规则）。 */
var F7_SOFT = {
  QUARTER: 1, WEEK: 1, DOW: 1, DOY: 1,
  BEFORE: 1, AFTER: 1, ENABLE: 1, DISABLE: 1, MODIFY: 1, CHANGE: 1,
  ALGORITHM: 1, CASCADED: 1, VALIDATE: 1, NOVALIDATE: 1,
  OPTION: 1, RECOMPILE: 1, MAXDOP: 1, MATCH_RECOGNIZE: 1, TABLESAMPLE: 1,
  NOTHING: 1, DUPLICATE: 1, NOCYCLE: 1, WITHOUT: 1, ROWID: 1,
  SKIP: 1, LOCKED: 1, NOWAIT: 1, NOLOCK: 1, HOLDLOCK: 1, UPDLOCK: 1,
  ROWLOCK: 1, READPAST: 1, TABLOCK: 1, NOCACHE: 1,
  FLASHBACK: 1, UNDROP: 1, SWAP: 1,
  LINESTRING: 1, UNLOAD: 1, IAM_ROLE: 1, TIMEFORMAT: 1,
  SYSTEM: 1, OPTIMIZE: 1, INVALIDATE: 1, FLUSH: 1, PIVOT: 1, UNPIVOT: 1,
  CONFLICT: 1
};

/* "类型词"：出现在它后面的软关键字基本就是 DDL 关键字（`a string comment 'x'`） */
var TYPE_WORDS = {
  STRING: 1, INT: 1, INTEGER: 1, BIGINT: 1, SMALLINT: 1, TINYINT: 1, DOUBLE: 1,
  FLOAT: 1, DECIMAL: 1, NUMERIC: 1, BOOLEAN: 1, CHAR: 1, VARCHAR: 1, BINARY: 1,
  TIMESTAMP: 1, DATETIME: 1, ARRAY: 1, MAP: 1, STRUCT: 1, TEXT: 1,
  /* 方言兼容性检测报告 §3.5：BigQuery / Snowflake / ClickHouse 的类型名。
   * 放进本表只影响两处「已确定是类型位置」的重排（泛型叶子、
   * parseColumn 的类型头），不会把同名**列名**牵连进去。 */
  INT64: 1, FLOAT64: 1, BYTES: 1, GEOGRAPHY: 1, BIGNUMERIC: 1,
  VARIANT: 1, OBJECT: 1, NUMBER: 1, VARCHAR2: 1, NVARCHAR: 1, NVARCHAR2: 1,
  DATETIME2: 1, SMALLDATETIME: 1, MONEY: 1, UNIQUEIDENTIFIER: 1,
  UINT8: 1, UINT16: 1, UINT32: 1, UINT64: 1, INT8: 1, INT16: 1, INT32: 1,
  FLOAT32: 1, FLOAT16: 1, UUID: 1, JSON: 1, JSONB: 1, XML: 1
};

/* 窗口帧关键字（P1-3）。它们同时是极常见的列名（`select current, row from t`），
 * 所以放在 SOFT_IDENT_WORDS 里，只靠上下文判定：只有当它和相邻的帧关键字
 * 组成一个"帧短语"时才当关键字大写（ROWS BETWEEN 1 PRECEDING AND CURRENT ROW）。 */
var FRAME_WORDS = {
  ROWS: 1, RANGE: 1, GROUPS: 1, UNBOUNDED: 1, PRECEDING: 1, FOLLOWING: 1,
  CURRENT: 1, ROW: 1, EXCLUDE: 1, TIES: 1, OTHERS: 1, FRAME: 1
};

  /* 判断一个 token 是否是「关键字位置」。
   * 软关键字（SOFT_IDENT_WORDS）既可能是语法词也可能是列名，必须看上下文：
   *   · 后面紧跟 "(" 或字符串字面量  → 关键字（COMMENT 'x' / POSITION(x)）
   *   · 前面是类型词 / 数字 / ")"    → 关键字（a STRING COMMENT 'x'）
   *   · 在语句开头                    → 关键字（SET / SHOW / LOAD）
   *   · 与相邻的窗口帧词组成帧短语    → 关键字（ROWS BETWEEN ...）
   *   · 在修饰 JOIN                    → 关键字（LEFT OUTER JOIN）
   *   · 前面是 LOAD                    → 关键字（LOAD DATA）
   * 其余一律按普通标识符原样保留，绝不改用户写的列名大小写。 */
/* L3e（第三轮审计）：内置函数名的大小写必须**统一**。
 * 旧实现的判据是"这个词在不在 KEYWORDS 里"：在表里的一律大写
 * （COUNT / COALESCE / NVL / ABS / ROUND …），不在表里的保持原样
 * （now / array_agg / date_trunc / to_char …），于是同一行里
 *     SELECT COUNT(*) ,now() ,array_agg(x) ,COALESCE(a, b)
 * 一半大写一半小写，看起来像两个工具排的。
 *
 * 这里补一张「常见内置函数」表。**只在后面紧跟 `(` 时**才提升为关键字：
 *   · 现在：now() → NOW()，array_agg(x) → ARRAY_AGG(x)，与 COUNT 一致；
 *   · 列名叫 now / rank 时（`select now from t`）不受影响；
 *   · 用户自定义函数（my_udf(x)）不在此表内，保持用户原样 —— 扩展无从知道
 *     它是不是关键字，改它反而是篡改用户代码。
 * 大小写方向仍由 uppercase 配置决定（uppercase=false → 全部小写）。 */
var BUILTIN_FUNCS = {
  NOW: 1, ARRAY_AGG: 1, JSON_EXTRACT: 1, JSON_VALUE: 1, DATE_TRUNC: 1, TO_CHAR: 1,
  TO_NUMBER: 1, TO_TIMESTAMP: 1, STR_TO_DATE: 1, DATE_ADD: 1, DATE_SUB: 1,
  DATE_DIFF: 1, TIMESTAMP_DIFF: 1, TIMESTAMP_ADD: 1, TIMESTAMP_SUB: 1,
  CURRENT_DATE: 1, CURRENT_TIMESTAMP: 1, LOCALTIMESTAMP: 1, SYSDATE: 1,
  STRING_AGG: 1, GROUP_CONCAT: 1, LISTAGG: 1, ARRAY_TO_STRING: 1, SPLIT_PART: 1,
  REGEXP_REPLACE: 1, REGEXP_LIKE: 1, REGEXP_SUBSTR: 1, INITCAP: 1, LPAD: 1, RPAD: 1,
  REPEAT: 1, REVERSE: 1, SPACE: 1, FORMAT_STRING: 1, HEX: 1, UNHEX: 1, MD5: 1,
  SHA1: 1, SHA2: 1, UUID: 1, RAND: 1, RANDOM: 1, CEIL: 1, CEILING: 1, FLOOR: 1,
  POWER: 1, SQRT: 1, EXP: 1, LOG: 1, LOG2: 1, LOG10: 1, SIGN: 1, TRUNC: 1,
  DATEDIFF: 1, TIMESTAMPDIFF: 1, DATE_FORMAT: 1, FROM_UNIXTIME: 1,
  UNIX_TIMESTAMP: 1, REGEXP_EXTRACT: 1, EXPLODE: 1, COLLECT_LIST: 1, COLLECT_SET: 1,
  LATERAL_VIEW: 1, POSEXPLODE: 1, NAMED_STRUCT: 1, SIZE: 1, CARDINALITY: 1,
  SUBSTRING_INDEX: 1, LOCATE: 1, INSTR: 1, REPLACE: 1, STRCMP: 1, CONCAT_WS: 1,
  IFNULL: 1, NVL: 1, NVL2: 1, DECODE: 1, GREATEST: 1, LEAST: 1, NULLIF: 1,
  ROW_NUMBER: 1, DENSE_RANK: 1, NTILE: 1, LAG: 1, LEAD: 1, FIRST_VALUE: 1,
  LAST_VALUE: 1, PERCENT_RANK: 1, CUME_DIST: 1, STDDEV: 1, VARIANCE: 1,
  APPROX_COUNT_DISTINCT: 1, ISNULL: 1, ISNOTNULL: 1,
  /* 方言兼容性检测报告 §3.4/§3.5：各库的**表函数 / 标量函数**。
   * 它们只在后接 `(` 时才统一大小写（BUILTIN_FUNCS 的既有机制），
   * 因此 `select identifier from t`（列名）不会被改。 */
  UNNEST: 1, SAFE_CAST: 1, IFF: 1, FLATTEN: 1, IDENTIFIER: 1,
  GENERATE_ARRAY: 1, GENERATE_SERIES: 1, TO_JSON_STRING: 1,
  COLLECT_LIST: 1, COLLECT_SET: 1, NAMED_STRUCT: 1, MAP_FROM_ARRAYS: 1,
  LIST_TRANSFORM: 1, LIST_FILTER: 1, LIST_REDUCE: 1,
  TO_TIMESTAMP_NTZ: 1, TO_VARCHAR: 1, TRY_CAST: 1, TRY_CONVERT: 1,
  STRING_SPLIT: 1, DATEADD: 1, DATEPART: 1, DATENAME: 1,
  ARRAY_LENGTH: 1, ARRAY_CONTAINS: 1, MAP_KEYS: 1, MAP_VALUES: 1
};

  /* 第六轮审计（A-6）：**只在语句第一个词位置**才大写的语句头词。
   * 这些词同时也是高频列名（`select open, close, fetch from t`），
   * 所以不能进 KEYWORDS（那种表是无条件大写），只能按位置提升。
   *   KILL / RESET / PURGE / REPAIR / ASSERT / INSTALL  各库的管理语句
   *   FETCH / OPEN / CLOSE                             游标语句
   *   CHECK                                            `CHECK TABLE t`
   *   UNLOAD / FLASHBACK                               已在 KEYWORDS，这里是兜底 */
  var STMT_HEAD_WORDS = {
    KILL: 1, RESET: 1, PURGE: 1, REPAIR: 1, ASSERT: 1, INSTALL: 1,
    FETCH: 1, OPEN: 1, CLOSE: 1, CHECK: 1, UNLOAD: 1, FLASHBACK: 1,
    UNDROP: 1, SWAP: 1, SECURITY: 1
  };

  function markKeywords(tokens) {
    /* 第六轮审计：这条 token 流是不是以 ALTER 开头（供 ALTER TABLE 动词判定用）。
     * 只在进入循环前算一次。 */
    var atAlterStmt = (function () {
      for (var fw = 0; fw < tokens.length; fw++) {
        if (tokens[fw].type === 'comment') continue;
        if (tokens[fw].type === 'punct' && tokens[fw].value === ';') return false;
        return tokens[fw].type === 'word' && tokens[fw].upper === 'ALTER';
      }
      return false;
    })();
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i];
      if (tk.type !== 'word') continue;
      /* P1-3（2026-11-05 复核）：路径片段里的词**一律不是关键字**。
       * `add jar /a/where/b.jar` 里的 where、`/x/from/y` 里的 from 都是路径的一部分；
       * 诊断引擎复用这份词法结果，把它们标成子句词会让
       * 「格式化正确、诊断报子句顺序错误」这种自相矛盾的结果出现。 */
      if (tk.path) { tk.keyword = false; continue; }
      var u = tk.upper;
      var prev = tokens[i - 1], next = tokens[i + 1];
      /* L3e：内置函数名 + 紧跟 `(` → 与 COUNT/COALESCE 同等对待（统一大小写）。
       * 放在 KEYWORDS 判定之前，因为这些函数大多不在关键字表里。
       * 不跟括号的（`select now from t` 里的列名）一律不动。 */
      if (!KEYWORDS[u] && BUILTIN_FUNCS[u] &&
          next && next.type === 'punct' && next.value === '(' &&
          !(prev && prev.type === 'punct' && prev.value === '.')) {
        tk.keyword = true;
        continue;
      }

      /* P0-8（2026-11-02 审计）：ClickHouse 的关键字与函数名**大小写敏感**
       * （官方 syntax：除 SQL 标准与常见数据库兼容名外，关键字和函数名区分大小写）。
       * `array(1,2)` / `uniq(a)` / `toDate(x)` / `map(...)` 被大写成 `ARRAY(...)`
       * 之后，ClickHouse 会把它们当标识符解析 → Unknown identifier，
       * 或者退化成 `SETTINGS` 里的同名设置项。
       *
       * 必须**放在循环最前面**：ARRAY / MAP / STRUCT 这些词在 KEYWORDS 里，
       * 后面还有 `u === 'ARRAY'` 之类的分支会无条件 `keyword = true; continue`，
       * 放在末尾根本轮不到。
       *
       * 判据收紧为「后跟 `(`」+「不在 SOFT_IDENT_WORDS 里才需要单独保护」：
       *   · 后跟 `(` 说明是函数调用/类型构造，不是子句关键字；
       *   · 真正以关键字身份跟括号的场景（`SELECT(...)`、`IN (...)`）
       *     那几个词都不在 KEYWORDS 的"函数名歧义"里，且 SELECT/FROM 等
       *     语句词在 ClickHouse 里本来就大小写不敏感（属于 SQL 标准名）。
       * 只保留对 ARRAY / MAP / STRUCT 这几个既是关键字又是函数名的词生效，
       * 避免把 `FROM (SELECT …)` 这类括号也误伤。 */
      if (/clickhouse/i.test(String(LEX.dialect || ''))) {
        /* ClickHouse 的类型名大小写敏感，且与 SQL 标准关键字同形：
         *   String / Array / Map / Tuple / Nested / Nothing …
         * 这些词作**类型**出现时必须原样保留，否则 CREATE TABLE 直接报
         * Unknown type。
         *
         * 只收窄 ClickHouse 里真正会撞车的几个词，并放行两条它们仍作关键字的路径：
         *   · 语句开头（`STRING …`？ClickHouse 没有这种语句，但保留以防万一）
         *   · `ARRAY JOIN`（ClickHouse 特有的左连接语法）
         * 其它 CH 关键字（SELECT / FROM / WHERE / PREWHERE / SETTINGS …）
         * 都是 SQL 标准名或 CH 独有的非类型词，照常大写。 */
        if (/^(STRING|ARRAY|MAP|STRUCT|TUPLE|NESTED|NOTHING|BOOL|UUID)$/.test(u) &&
            !(u === 'ARRAY' && next && next.type === 'word' && next.upper === 'JOIN') &&
            !(prev && prev.type === 'word' && prev.upper === 'JOIN')) {
          tk.keyword = false;
          continue;
        }
      }
      /* 第六轮审计（A-6）：语句**第一个代码词**位置上的管理类语句头。
       * 这些词不能进 KEYWORDS（它们同时是高频列名），但作为语句第一个词时
       * 位置是确定的 —— `KILL 123` / `PURGE RECYCLEBIN` / `FETCH NEXT FROM c`
       * 里它不可能是列名。判据要求「前面只有注释」**且「后面还有词」**：
       *   · 前面只有注释 → `select open, close from t` 的列名不受影响；
       *   · 后面还有词   → 片段模式下单独一个 `open` / `check` 不被改写
       *                    （那种片段无从判断它是语句还是列名）。
       * 必须放在下面 `if (!KEYWORDS[u])` 之前，因为这些词大多不在 KEYWORDS 里。 */
      if (STMT_HEAD_WORDS[u] && next) {
        var onlyCommentsSeen = true;
        for (var cm2 = 0; cm2 < i; cm2++) {
          if (tokens[cm2].type !== 'comment') { onlyCommentsSeen = false; break; }
        }
        if (onlyCommentsSeen) { tk.keyword = true; continue; }
      }
      if (!KEYWORDS[u]) { tk.keyword = false; continue; }

      var nextIsParen = !!(next && next.type === 'punct' && next.value === '(');
      var nextIsStr = !!(next && next.type === 'string');
      var prevIsType = !!(prev && prev.type === 'word' && TYPE_WORDS[prev.upper]);
      var prevIsNum = !!(prev && prev.type === 'number');
      var prevIsClose = !!(prev && prev.type === 'punct' && prev.value === ')');
      var atStatementStart = !prev || (prev.type === 'punct' && prev.value === ';');

      /* --- 表级约束短语（H-8）：PRIMARY KEY / FOREIGN KEY / CHECK / INDEX --- */
      var constrainPrev = !!(prev && prev.type === 'word' &&
        /^(PRIMARY|UNIQUE|CONSTRAINT|PARTITION|CLUSTERED|FOREIGN|FULLTEXT|SPATIAL)$/.test(String(prev.upper)));
      /* KEY / FOREIGN / CHECK / INDEX 的大小写只在「前一个是确定无疑的约束头词」时
       * 才提升（PRIMARY / UNIQUE / CONSTRAINT / PARTITION / CLUSTERED / FULLTEXT /
       * SPATIAL）。这几个头词不可能被当列名，所以这条规则不会误伤。
       *
       * 为什么不用「后面紧跟括号」做判据：`select check(a)`、`select key (a)` 里
       * 那也是括号，于是函数调用被当成约束词大写并加空格 —— 改到了用户代码。
       * 宁可 sql() 路径里 FOREIGN / CHECK 作为**短语首词**时保持原样（大小写不统一，
       * 但语义与用户原文完全一致），也不碰任何真实列名。
       * DDL 路径（sqlddl）由 parseColumn 在已知列定义列表里逐词大写，没有这个歧义。 */
      /* KEY / FOREIGN / CHECK / INDEX：**只**由 constrainPrev 决定。
       * 不能走后面的通用判据（nextIsParen 等），因为 `select check(a)`、
       * `select key (a)`、`select index(a)` 里也有括号 —— 那是函数调用不是约束。 */
      if (u === 'KEY' || u === 'FOREIGN' || u === 'CHECK' || u === 'INDEX') {
        /* M4（第三轮审计）：`CREATE [UNIQUE] INDEX idx ON t (a)` / `DROP INDEX idx`
         * 里的 INDEX 是**语句词**，不属于表级约束短语，但同样必须大写。
         * 判据只看前一个词是不是 CREATE/DROP/UNIQUE/ALTER —— 它们不可能被当列名，
         * 不会误伤 `select index, a from t`（前一个是 SELECT/,）。
         * 旧实现直接 `keyword = constrainPrev`，于是 create index 永远小写。 */
        var idxStmtPrev = !!(prev && prev.type === 'word' &&
          /^(CREATE|DROP|UNIQUE|ALTER|REBUILD|CLUSTERED|NONCLUSTERED|BITMAP|FULLTEXT|SPATIAL|FORCE|USE|IGNORE)$/.test(String(prev.upper)));
        /* 第六轮审计（A-9）：`CREATE VIEW v AS … WITH CHECK OPTION` 里的 CHECK
         * 属于固定短语，不是约束头词。判据要求完整短语（WITH|CASCADED|LOCAL + CHECK
         * + OPTION），所以 `select check, a from t` 不受影响。 */
        var checkOptionPhrase = u === 'CHECK' &&
          prev && prev.type === 'word' &&
          /^(WITH|CASCADED|LOCAL)$/.test(String(prev.upper)) &&
          next && next.type === 'word' && next.upper === 'OPTION';
        /* 第六轮审计（A-5d）：MySQL `INSERT … ON DUPLICATE KEY UPDATE` 里的 KEY
         * 也是固定短语的一部分（前一个是 DUPLICATE，不可能是列名）。
         * 不加这条会输出 `ON DUPLICATE key UPDATE` —— 同一短语大小写混杂。 */
        var dupKeyPhrase = u === 'KEY' &&
          prev && prev.type === 'word' && prev.upper === 'DUPLICATE' &&
          next && next.type === 'word' && next.upper === 'UPDATE';
        tk.keyword = constrainPrev || idxStmtPrev || checkOptionPhrase || dupKeyPhrase;
        continue;
      }

      /* --- JOIN 修饰词（H-5 / N-16）：只有真的在修饰 JOIN 才算关键字 --- */
      if (u === 'LEFT' || u === 'RIGHT' || u === 'FULL') {
        /* 第六轮审计（A-8）：`FULL` 还可能出现在 `VACUUM FULL`（PG 的维护命令）里，
         * 那里它修饰的不是 JOIN。旧判据只看「后面是不是 OUTER/JOIN」，
         * 于是输出 `VACUUM full t` —— 同一句里 VACUUM 大写、FULL 小写。 */
        if (u === 'FULL' && prev && prev.type === 'word' && prev.upper === 'VACUUM') {
          tk.keyword = true;
          continue;
        }
        var joinMod = !!(next && next.type === 'word' &&
          /^(OUTER|SEMI|ANTI|INNER|CROSS|NATURAL|JOIN)$/.test(String(next.upper)));
        tk.keyword = joinMod;
        continue;
      }

      /* --- ORDER BY ... NULLS FIRST / NULLS LAST（M7）---
       * FIRST / LAST 既是窗口帧词又是极常见的列名（SOFT_IDENT_WORDS），
       * 通用判据不会让它们在 `nulls last` 里大写，于是输出
       * `ORDER BY a DESC NULLS last` —— 同一短语一半大写一半原样。
       * 只在前面确实是 NULLS 时才提升（`select first, last from t` 不受影响）。 */
      if ((u === 'FIRST' || u === 'LAST') &&
          prev && prev.type === 'word' && prev.upper === 'NULLS') {
        tk.keyword = true;
        continue;
      }

      /* F14-3（2026-10-29 复核）：`interval '1' day` / `interval 1 day` 的单位词。
       * DAY / MONTH / YEAR / HOUR / MINUTE / SECOND / WEEK / QUARTER 都在
       * SOFT_IDENT_WORDS 里（它们同时是列名），通用判据不会提升它们，
       * 于是同一个 INTERVAL 里数字大写、单位小写。这里往前找 INTERVAL，
       * 找到才提升，并允许跨过 `TO`（`interval '1-2' year to month`）。 */
      if (/^(DAY|HOUR|MINUTE|SECOND|MONTH|YEAR|WEEK|QUARTER|EPOCH)$/.test(u) &&
          prev && (prev.type === 'string' || prev.type === 'number')) {
        for (var iv = i - 2; iv >= 0; iv--) {
          var itk = tokens[iv];
          if (itk.type === 'comment') continue;
          if (itk.type === 'word' && itk.upper === 'INTERVAL') { tk.keyword = true; break; }
          if (itk.type === 'word' && /^(TO|AND)$/.test(String(itk.upper))) continue;
          break;
        }
        if (tk.keyword) continue;
      }

      /* F14（2026-10-29 复核）：`cast(a as decimal(10,2))` 里的 `decimal`
       * 不在 KEYWORDS（它是类型名，只在 TYPE_WORDS 里），于是原样保留，
       * 输出 `CAST(a AS decimal(10, 2))` —— 同一个 CAST 里 AS 大写、类型小写。
       * 判据：前一个词是 CAST 家族的 AS，且本词是已知类型词。 */
      /* 不要求 u 在 TYPE_WORDS 里：CAST 括号里 AS 之后**一定是**类型，
       * 而 DATE / TIME / INTERVAL 这些只在 SOFT_IDENT_WORDS 里。
       * 别名场景（`select a as date from t`）不在 CAST 括号内，下面的
       * asOwner 判据会把它排除掉。 */
      if (prev && prev.type === 'word' && prev.upper === 'AS') {
        var asOwner = null;
        for (var ab = i - 2; ab >= 0; ab--) {
          var at = tokens[ab];
          if (at.type === 'punct' && at.value === '(') { asOwner = tokens[ab - 1]; break; }
          if (at.type === 'punct' && (at.value === ')' || at.value === ';' || at.value === ',')) break;
        }
        if (asOwner && asOwner.type === 'word' &&
            /^(CAST|TRY_CAST|SAFE_CAST|CONVERT)$/.test(String(asOwner.upper))) {
          tk.keyword = true;
          /* 同时打一个标记：下面三处 `AS 之后 noCase` 的规则要放过它，
           * 否则 appendToken / renderInline / joinTokens 会把 noCase 又补回来，
           * tokenText 仍然输出小写。 */
          tk.castType = true;
          continue;
        }
      }

      /* P0-11（2026-11-02 审计）：**列清单项首**不改大小写。
       * `select role, sequence, lock from t` 里三个词都是列名，
       * 被大写成 `SELECT ROLE ,SEQUENCE ,LOCK` 后语义不变但可读性差，
       * 而且与用户原文的列名大小写不一致（下游 `as role` 就对不上）。
       *
       * 判据：前面是 SELECT 或逗号，且**还在 SELECT 列清单里**
       * （没遇到 FROM / WHERE / GROUP 等子句词）。
       * 只在词本身是软关键字时生效 —— 硬关键字（SELECT/FROM 等）不受影响，
       * 因为它们根本走不到这里（前面已经 continue）。 */
      /* 只对这张白名单生效：它们既在 KEYWORDS 里、又是极常见的列名，
       * 而且 markKeywords 后面没有任何专属位置分支可以替它们做判断。
       * TOP / FORMAT / PREWHERE / SKIP / LOCKED 这些**不能**进白名单 ——
       * 它们各自有专属分支（TOP n、FORMAT X、PREWHERE、SKIP LOCKED）。 */
      var SELECT_LIST_IDENT = {
        ROLE: 1, SEQUENCE: 1, SCHEMA: 1, LOCK: 1, UNLOCK: 1
      };
      if (SELECT_LIST_IDENT[u] && prev &&
          (prev.type === 'punct' && prev.value === ',' ||
           prev.type === 'word' && prev.upper === 'SELECT')) {
        /* 往前找最近的子句词，确认还在列清单里 */
        var inSelectList = false;
        for (var q1 = i - 1; q1 >= 0; q1--) {
          var qt = tokens[q1];
          if (qt.type === 'punct' && qt.value === ';') break;
          if (qt.type === 'word' && /^(FROM|WHERE|GROUP|ORDER|HAVING|LIMIT|UNION|WINDOW|QUALIFY)$/.test(String(qt.upper))) break;
          if (qt.type === 'word' && qt.upper === 'SELECT') { inSelectList = true; break; }
        }
        if (inSelectList) { tk.keyword = false; continue; }
      }

      /* --- 硬关键字：不可能被当列名，直接大写 --- */
      /* P0-11（2026-11-02 审计）：**表名位置**上的词不改大小写。
       * `select a from t join Schema s on 1=1` 里 `Schema` 是表名，
       * 被大写成 `SCHEMA` 后 MySQL（Unix 下区分大小写）直接找不到表。
       *
       * 判据只看**紧邻的位置词**（FROM / JOIN / INTO / UPDATE / TABLE /
       * DELETE FROM …）：当前位置前一个有效 token 是其中之一，且再前一个不是
       * `,`（逗号后的表名由后面的 JOIN 判据覆盖）。
       * 这样 `select role from t`（role 在列清单里）仍然会走到下面的软关键字
       * 分支；而 `from role` 里的 role 保持原样。 */
      /* `FOR UPDATE SKIP LOCKED` 里的 UPDATE 是锁子句，后面跟的不是表名。 */
      var prevIsLockUpdate = !!(prev && prev.type === 'word' && prev.upper === 'UPDATE' &&
        tokens[i - 2] && tokens[i - 2].type === 'word' && tokens[i - 2].upper === 'FOR');
      /* F-03（2026-11-04 复核）：`UPDATE` 后面紧跟的 `SET` **不是表名**。
       * `merge … when matched then update set a = u.a` 与
       * `on conflict (a) do update set a = 2` 里的 SET 以前被这条“位置词之后是
       * 表名”的规则判成标识符，于是保持用户原文的小写 —— 与同一脚本里独立的
       * `UPDATE t SET a = 1` 风格相矛盾（一边大写一边小写，非常显眼）。 */
      var prevIsUpdateSet = !!(prev && prev.type === 'word' && prev.upper === 'UPDATE' && u === 'SET');
      /* P2-8（2026-11-05 复核）：Hive 的 `INSERT INTO TABLE t` 里 TABLE 是
       * **关键字**，与 `INSERT OVERWRITE TABLE t` 对称。旧判据把它当表名
       * （tk.keyword = false）原样保留，于是同一族语句里一份大写一份小写。
       * 判据收紧到"**语句头**是 INSERT / LOAD，且形态为 INTO|OVERWRITE TABLE + 表名"：
       *   · `INSERT INTO TABLE t` / `INSERT OVERWRITE TABLE t`
       *   · `LOAD DATA INPATH … INTO TABLE t`
       * `select a from table`、`select … into table` 这类里的 table 是表名，不受影响。 */
      if (u === 'TABLE' && prev && prev.type === 'word' &&
          /^(INTO|OVERWRITE)$/.test(String(prev.upper)) &&
          next && (next.type === 'word' || next.type === 'quoted')) {
        var stmtHead = '';
        for (var hh = 0; hh < i; hh++) {
          var ht2 = tokens[hh];
          if (ht2.type === 'comment') continue;
          if (ht2.type === 'punct' && ht2.value === ';') { stmtHead = ''; continue; }
          if (stmtHead === '' && ht2.type === 'word') stmtHead = String(ht2.upper);
        }
        if (stmtHead === 'INSERT' || stmtHead === 'LOAD') { tk.keyword = true; continue; }
      }
      if (prev && prev.type === 'word' && !prevIsLockUpdate && !prevIsUpdateSet &&
          /^(FROM|JOIN|INTO|UPDATE|TABLE|USING|EXISTS|VIEW|DATABASE|SCHEMA|PROCEDURE|FUNCTION|TRIGGER)$/.test(String(prev.upper))) {
        /* `CREATE TABLE IF NOT EXISTS t` / `DROP TABLE IF EXISTS t`：
         * 中间还有 IF NOT EXISTS / IF EXISTS 三个词，表名不在紧邻位置。
         * 那种情况交给词表处理（那些表名本来也不在 KEYWORDS 里）。 */
        if (!/^(IF|NOT|EXISTS|ONLY|TEMPORARY|TEMP|EXTERNAL|GLOBAL|LOCAL)$/.test(u)) {
          tk.keyword = false;
          continue;
        }
      }

      /* P2-6（2026-11-02 审计）：`STORED AS INPUTFORMAT 'i' OUTPUTFORMAT 'o'`
       * 里的格式名是**名字**，不是关键字 —— 与 `STORED AS orc` 的 `orc` 同类，
       * 一律原样保留。旧实现只有紧跟 AS 的 INPUTFORMAT 因「别名 → noCase」
       * 规则侥幸保持小写，OUTPUTFORMAT 却被大写，同一子句里两种风格。 */
      if (u === 'INPUTFORMAT' || u === 'OUTPUTFORMAT' ||
          u === 'INPUTDRIVER' || u === 'OUTPUTDRIVER') {
        tk.noCase = true;
        continue;
      }

      if (!SOFT_IDENT_WORDS[u]) { tk.keyword = true; continue; }

      /* --- L-3：过程化语句的关键字（BEGIN … END / DECLARE / RETURN / SET）---
       * 这些词在普通 SQL 里分别是函数名（return(x)）或列名（return、set），
       * 所以只在"看起来像过程体"时才提升：
       *   · 语句开头（atStatementStart，由 matchClause 的同款判据给出）
       *   · 或前后邻近 BEGIN/END/IF/LOOP 等块关键词
       * 旧实现里 BEGIN 能大写（硬关键字不在 SOFT 表），但 `return` / `declare` /
       * `function` / `returns` 全部小写，于是 `CREATE function f() RETURNS INT
       * BEGIN return 1; END` 大小写混杂。 */
      if (u === 'RETURN' || u === 'RETURNS' || u === 'DECLARE' || u === 'FUNCTION' ||
          u === 'PROCEDURE' || u === 'TRIGGER' || u === 'LANGUAGE' || u === 'EACH' ||
          u === 'ROW' || u === 'LOOP' || u === 'WHILE' || u === 'REPEAT' || u === 'UNTIL' ||
          u === 'EXIT' || u === 'CONTINUE' || u === 'HANDLER' || u === 'SIGNAL' ||
          u === 'RESIGNAL' || u === 'DELIMITER' || u === 'CURSOR' || u === 'FETCH' ||
          u === 'OPEN' || u === 'CLOSE' || u === 'OUT' || u === 'INOUT' ||
          u === 'DETERMINISTIC' || u === 'IMMUTABLE' || u === 'STABLE' || u === 'VOLATILE') {
        var procCtx = !!atStatementStart ||
          (prev && prev.type === 'word' && /^(BEGIN|END|THEN|ELSE|LOOP|AS|DECLARE|RETURN|IF|WHILE|DO|REPEAT|PROCEDURE|FUNCTION|TRIGGER|CREATE|OR|REPLACE|ON|FOR|EACH|WITH|LANGUAGE)$/.test(String(prev.upper))) ||
          (next && next.type === 'word' && /^(BEGIN|RETURN|RETURNS|LANGUAGE|LOOP|DECLARE|SELECT|INT|INTEGER|BIGINT|STRING|VARCHAR|RETURNS|DETERMINISTIC|IMMUTABLE|STABLE|VOLATILE|EACH|ROW)$/.test(String(next.upper)));
        if (procCtx) { tk.keyword = true; continue; }
      }

      /* --- L-11：方言专属关键字 ---
       * 这些词只在对应方言里才有意义，但漏掉的表现很刺眼：
       *   `show tables like "x"`      → tables 小写
       *   `select * from t format JSONEachRow` → format 小写
       *   `select top 10 a from t`    → top 小写
       * 它们同时可能是列名，所以只在"语法位置"上提升。 */
      if (u === 'TABLES' || u === 'DATABASES' || u === 'SCHEMAS' || u === 'FUNCTIONS' ||
          u === 'COLUMNS' || u === 'PARTITIONS') {
        /* SHOW TABLES / DESCRIBE … / MSCK REPAIR TABLE … ：前面是 SHOW/DESCRIBE/USE */
        if (prev && prev.type === 'word' && /^(SHOW|DESCRIBE|DESC|USE|MSCK|REPAIR|ANALYZE|LIST)$/.test(String(prev.upper))) {
          tk.keyword = true; continue;
        }
      }
      /* 方言兼容性检测报告 §3.4：`MSCK REPAIR TABLE t` 里的 REPAIR 是语句词。
       * 旧实现只有"后接 TABLES 类词"的那条分支会提升 REPAIR，于是
       * `msck repair table t` 输出 `MSCK repair TABLE t` —— 半大写的怪样子。 */
      if (u === 'REPAIR') {
        if (prev && prev.type === 'word' && prev.upper === 'MSCK') { tk.keyword = true; continue; }
      }
      if (u === 'TOP') {
        /* T-SQL `SELECT TOP 10 …` / `TOP (10)`：前面是 SELECT/DISTINCT/ALL，后面是数字/括号 */
        var topCtx = !!(prev && prev.type === 'word' && /^(SELECT|DISTINCT|ALL|UPDATE|INSERT|DELETE)$/.test(String(prev.upper))) ||
          !!(next && (next.type === 'number' || (next.type === 'punct' && next.value === '(')));
        if (topCtx) { tk.keyword = true; continue; }
      }
      if (u === 'FORMAT') {
        /* ClickHouse `FORMAT JSONEachRow` / Hive `ROW FORMAT DELIMITED`。
         * 判据要排除 `select format from t`（format 是列名，next 恰是 FROM）：
         * 只有 next 是标识符**且不是子句词**时才当关键字。 */
        if (next && (next.type === 'quoted' ||
            (next.type === 'word' && !CLAUSE_START_WORDS[next.upper] &&
             next.upper !== 'FROM' && next.upper !== 'AS'))) {
          tk.keyword = true; continue;
        }
      }
      if (u === 'PREWHERE' || u === 'SAMPLE' || u === 'FINAL' || u === 'SETTINGS' ||
          u === 'LIMIT' || u === 'OFFSET' || u === 'ARRAY' || u === 'GLOBAL') {
        /* L3c（第三轮审计）：ClickHouse 方言下 PREWHERE 一定在 FROM 之后，
         * 直接当关键字处理（它在 ClickHouse 里几乎不可能作列名）；
         * 其它方言仍走"前一个词是 FROM/WHERE…"的保守判据。 */
        if (u === 'PREWHERE' && /clickhouse|(^|\W)ch(\W|$)/i.test(String(LEX.dialect || ''))) {
          tk.keyword = true; continue;
        }
        /* 列清单位置（`select offset, b from t` / `select a, offset from t`）
         * 里的 offset / limit 是**列名**，不能大写。
         * 旧表里包含 SELECT，于是 `select offset, b from t` 输出 `SELECT OFFSET`
         * —— 正好改到了用户的列名。 */
        var inSelectList = !!(prev && prev.type === 'punct' && (prev.value === ',' || prev.value === '(')) ||
          !!(prev && prev.type === 'word' && /^(SELECT|DISTINCT|ALL)$/.test(String(prev.upper)));
        if (!inSelectList && prev && prev.type === 'word' &&
            /^(FROM|WHERE|PREWHERE|SETTINGS|BY|TABLE)$/.test(String(prev.upper))) {
          tk.keyword = true; continue;
        }
      }

      if (u === 'LANGUAGE') {
        /* M4：`… AS $$ … $$ LANGUAGE sql` —— LANGUAGE 后面紧跟语言名（sql/plpgsql/js）
         * 时是子句词；`select language from t`（列名）后面是 FROM。 */
        if (next && next.type === 'word' && !CLAUSE_START_WORDS[next.upper] && next.upper !== 'FROM') {
          tk.keyword = true; continue;
        }
      }

      /* 分页子句里的软关键字（N-17）：OFFSET / FETCH / NEXT / ONLY / ROWS
       * 常被当列名，但成组出现在语句尾部时是语法词，必须大写。
       * 判定：后面跟着数字或 ROWS/ROW/NEXT/ONLY，或前面是 ROWS/FETCH/LIMIT。 */
      if (u === 'OFFSET' || u === 'FETCH' || u === 'NEXT' || u === 'ONLY' || u === 'ROWS') {
        /* L3b：占位符（`?` / template / `$1`）同样是"值"，不是列名。
         * `limit ? offset ?` 里的 offset 后面就是 `?`。 */
        var pgNext = !!(next && (next.type === 'number' ||
          (next.type === 'punct' && next.value === '?') ||
          (next.type === 'template') ||
          (next.type === 'word' && /^(ROWS|ROW|NEXT|ONLY|FIRST|PERCENT)$/.test(String(next.upper)))));
        var pgPrev = !!(prev && prev.type === 'word' &&
          /^(OFFSET|FETCH|ROWS|ROW|LIMIT|ONLY)$/.test(String(prev.upper)));
        if (pgNext || pgPrev) { tk.keyword = true; continue; }
      }

      /* F-04b（2026-11-04 复核）：固定短语里的关键字。
       *   LIKE '…' ESCAPE '\'      —— ESCAPE 以前永远小写；
       *   FETCH NEXT / FETCH FIRST —— NEXT 以前只在“后面跟数字”时才提升，
       *                               而 `fetch next 10 rows` 的 next 后面是数字，
       *                               之所以没提升是因为它根本不在 KEYWORDS 里。
       * 判据只认**完整短语**，所以 `select escape, next from t` 不受影响。 */
      if (u === 'ESCAPE' && prev && (prev.type === 'string' || prev.type === 'quoted')) {
        tk.keyword = true; continue;
      }
      if ((u === 'NEXT' || u === 'FIRST') && prev && prev.type === 'word' && prev.upper === 'FETCH') {
        tk.keyword = true; continue;
      }
      /* N9（2026-11-04 复核）：MySQL 分区定义的固定短语
       *   PARTITION p0 VALUES LESS THAN (100) / VALUES LESS THAN MAXVALUE
       * 判据是完整短语（LESS 前面必须是 VALUES、THAN 前面必须是 LESS），
       * 所以 `select less, than from t` 不受影响。 */
      if (u === 'LESS' && prev && prev.type === 'word' && prev.upper === 'VALUES') {
        tk.keyword = true; continue;
      }
      if (u === 'THAN' && prev && prev.type === 'word' && prev.upper === 'LESS') {
        tk.keyword = true; continue;
      }

      /* --- 窗口帧短语：ROWS BETWEEN 1 PRECEDING / UNBOUNDED FOLLOWING ... --- */
      var inFrame = false;
      if (FRAME_WORDS[u]) {
        var prevWord = !!(prev && prev.type === 'word' && FRAME_WORDS[prev.upper]);
        var nextWord = !!(next && next.type === 'word' && FRAME_WORDS[next.upper]);
        var nextBetween = !!(next && next.type === 'word' && next.upper === 'BETWEEN');
        var nextNum = !!(next && next.type === 'number');
        inFrame = !!(prevWord || nextWord || nextBetween ||
          (nextNum && (u === 'ROWS' || u === 'RANGE' || u === 'GROUPS')));
      }

      /* --- LOAD DATA / INSERT OVERWRITE ... DATA --- */
      var afterLoad = !!(prev && prev.type === 'word' && prev.upper === 'LOAD');

      /* --- 方言兼容性检测报告 §3.3/§3.4/§3.5：各库特色语法词的位置判据 ---
       * 这批词全都在 SOFT_IDENT_WORDS 里（它们在同一库里也常被当列名），
       * 所以不能靠上面那条通用判据（nextIsParen 等）—— 必须按**方言 + 语法位置**
       * 单独判定。核心原则：**只认"不可能是列名"的位置**。
       *
       * 每条规则的"不可能是列名"依据都写在行内注释里；任何一条拿不准就保持原文
       * （保持原文只是"没大写"，大写错了才是真改坏用户代码）。 */
      var lexD = String(LEX.dialect || '').toLowerCase();
      var isMy = /mysql|mariadb/.test(lexD);
      var isHive = /hive|spark|databricks|delta|hudi|iceberg|maxcompute|odps|impala|doris|starrocks/.test(lexD);
      var isOra = /oracle|plsql/.test(lexD);
      var isCh = /clickhouse|(^|\W)ch(\W|$)/.test(lexD);
      var isBq = /bigquery|sql-bigquery/.test(lexD);
      var isSf = /snowflake/.test(lexD);
      var isTs = /tsql|mssql|sqlserver|sql-server/.test(lexD);
      var isPg = /pgsql|postgres|postgresql|greenplum|redshift|plpgsql|duckdb/.test(lexD);
      var dialectSoft = false;

      /* MySQL 建表选项 `engine = innodb default charset = utf8mb4`：
       * 只认"前一个词是 ) / 选项词 / 分隔符"或"后面紧跟 ="。
       * `select engine, charset from t` 里前面是 SELECT / 逗号 → 不动。 */
      if (isMy && (u === 'ENGINE' || u === 'CHARSET' || u === 'AUTO_INCREMENT')) {
        var optPos = !!(prev && ((prev.type === 'punct' && prev.value === ')') ||
          (prev.type === 'word' && /^(DEFAULT|ENGINE|CHARSET|COLLATE|COMMENT|ROW_FORMAT|AUTO_INCREMENT)$/.test(String(prev.upper)))));
        var optEq = !!(next && next.type === 'punct' && next.value === '=');
        dialectSoft = optPos || optEq;
      }
      /* `GROUP_CONCAT(a ORDER BY b SEPARATOR ',')`：只在括号内的 GROUP_CONCAT 里出现。 */
      if (u === 'SEPARATOR') {
        dialectSoft = !!(prev && (prev.type === 'string' || prev.type === 'quoted' ||
          (prev.type === 'word' && !/^(SELECT|FROM|WHERE)$/.test(String(prev.upper)))));
      }
      /* `SELECT DISTINCT a FROM t` 之类不受影响 */
      /* Oracle 层次查询 `START WITH … CONNECT BY PRIOR …`：
       * CONNECT / PRIOR 只在前面已经是 START WITH 或 CONNECT BY 时提升；
       * `select prior from t`（列名）前面是 SELECT → 不动。 */
      if (isOra && (u === 'CONNECT' || u === 'PRIOR' || u === 'SIBLINGS')) {
        dialectSoft = !!(prev && (prev.type === 'word' &&
          /^(WITH|BY|CONNECT|START|PRIOR|SIBLINGS|ORDER)$/.test(String(prev.upper)))) ||
          !!(next && next.type === 'word' && /^(BY|PRIOR)$/.test(String(next.upper)));
      }
      /* Oracle 伪列 ROWNUM：只在 `where rownum <= n` / `order by rownum` 这类
       * 比较或排序上下文里。前面是 SELECT / 逗号时是列名。 */
      if (isOra && u === 'ROWNUM') {
        dialectSoft = !!(next && next.type === 'punct' &&
          /^(<=|>=|<|>|=|<>|!=)$/.test(String(next.value)));
      }
      /* `START WITH parent IS NULL` 的 START：Oracle 里 START WITH 是层次查询起点。
       * START 在 SOFT 表里（也常作列名），只在后接 WITH 时提升。 */
      if (u === 'START') {
        dialectSoft = !!(next && next.type === 'word' && next.upper === 'WITH');
      }
      /* ClickHouse `FROM t FINAL` / `SAMPLE 0.1` / `SETTINGS k = v`：
       * 这三个词紧跟在**表名**（或前一个 SETTINGS 项）之后，前面不是
       * SELECT/逗号/括号 —— 那些位置才是列名（`select final, sample from t`）。 */
      if (isCh && (u === 'FINAL' || u === 'SAMPLE' || u === 'SETTINGS')) {
        dialectSoft = !!(prev && (prev.type === 'word' ||
          (prev.type === 'punct' && prev.value === ')'))) &&
          !(prev.type === 'word' && /^(SELECT|DISTINCT|ALL|AS|BY|IS|NOT|AND|OR)$/.test(String(prev.upper)));
      }
      /* T-SQL `OUTPUT inserted.a` / Redshift `distkey (a)`：前面是建表括号的 `)`。 */
      if (u === 'OUTPUT' || u === 'DISTKEY' || u === 'SORTKEY') {
        dialectSoft = !!(prev && prev.type === 'punct' && prev.value === ')');
      }
      /* ClickHouse `WITH TOTALS`：TOTALS 只跟在 WITH 后面。 */
      if (isCh && (u === 'TOTALS' || u === 'RELOAD')) {
        dialectSoft = !!(prev && prev.type === 'word' &&
          /^(WITH|SYSTEM|GROUP|BY)$/.test(String(prev.upper)));
      }
      /* `compute stats t` / `invalidate metadata t`（Impala）、
       * `system reload dictionaries`（ClickHouse）、`optimize table t final`：
       * 都是**语句开头**的固定短语，第一个词在门槛白名单里，第二个词紧随其后。 */
      if (u === 'STATS' || u === 'METADATA' || u === 'DICTIONARIES') {
        dialectSoft = !!(prev && prev.type === 'word' &&
          /^(COMPUTE|INCREMENTAL|INVALIDATE|RELOAD|SYSTEM)$/.test(String(prev.upper)));
      }
      /* T-SQL `int identity(1,1)`：IDENTITY 只在类型词后面或紧跟 `(`。 */
      if (isTs && u === 'IDENTITY') {
        dialectSoft = !!(prevIsType || nextIsParen);
      }
      /* T-SQL / 通用类型名：NVARCHAR(MAX) / DATETIME2(7) / INT64 / FLOAT64 /
       * CHARACTER(20)。它们只作为**类型词**出现的位置：紧跟 `(`，
       * 或在变量声明/CAST 里的 AS 之后。`select int64 from t` 不动。 */
      if (/^(NVARCHAR|DATETIME2|INT64|FLOAT64|CHARACTER)$/.test(u)) {
        dialectSoft = !!(nextIsParen ||
          (prev && prev.type === 'word' && /^(AS|CAST|CONVERT|DECLARE|TYPE|OF)$/.test(String(prev.upper))));
      }
      /* Redshift `distkey (a) sortkey (a)`：只紧跟 `(`，且在 `)` 之后。 */
      if ((u === 'DISTKEY' || u === 'SORTKEY')) {
        dialectSoft = !!(nextIsParen && prev && prev.type === 'punct' && prev.value === ')');
      }
      /* `PRIVILEGES`（`flush privileges` / `grant … privileges`）：只在固定短语里。 */
      if (u === 'PRIVILEGES') {
        dialectSoft = !!(prev && prev.type === 'word' &&
          /^(FLUSH|GRANT|REVOKE|ALL|OPTION|WITH)$/.test(String(prev.upper)));
      }
      /* 维持语句首词状态：`optimize table t final` 里的 final 已在 SOFT 表，
       * 由 ClickHouse 的 FINAL 规则处理（见上面 SAMPLE/FINAL 分支）。 */

      /* 第六轮审计（A-7 / A-8 / A-9 / A-10）：**固定短语**里的后续词。
       * 这几个词本身是软关键字（TIME / FULL / ANALYZE / CHECK / YEAR … 都可能
       * 是列名），单独看无法决定，但只要它出现在下面这些**完整短语**里，
       * 位置就是确定的：
       *   AT TIME ZONE                 PG / Oracle 的时区转换
       *   TIMESTAMP WITH TIME ZONE     PG 类型名
       *   VACUUM FULL / VACUUM ANALYZE PG 维护命令的选项
       *   WITH CHECK OPTION            CREATE VIEW 的可更新约束
       *   EXTRACT(YEAR FROM x)         EXTRACT 的字段名
       * 判据都要求"前后构成完整短语"，不会误伤同名列。 */
      if (!dialectSoft) {
        var prevU = prev && prev.type === 'word' ? String(prev.upper) : '';
        var prev2U = (tokens[i - 2] && tokens[i - 2].type === 'word') ? String(tokens[i - 2].upper) : '';
        var prev3U = (tokens[i - 3] && tokens[i - 3].type === 'word') ? String(tokens[i - 3].upper) : '';
        /* AT TIME ZONE / WITH TIME ZONE */
        if (u === 'TIME' && (prevU === 'AT' || prevU === 'WITH')) {
          dialectSoft = true;
        }
        if (u === 'ZONE' && prevU === 'TIME') {
          dialectSoft = true;
        }
        /* VACUUM FULL / VACUUM ANALYZE / VACUUM FULL ANALYZE（可任意串联） */
        if (u === 'FULL' || u === 'ANALYZE') {
          if (prevU === 'VACUUM' || (u === 'ANALYZE' && prevU === 'FULL')) {
            dialectSoft = true;
          }
        }
        /* WITH [CASCADED|LOCAL] CHECK OPTION（CREATE VIEW）。CHECK 在软表里，
         * 只有前面是 WITH / CASCADED / LOCAL 时才是这个短语的一部分。 */
        if (u === 'CHECK' && (prevU === 'WITH' || prevU === 'CASCADED' || prevU === 'LOCAL')) {
          dialectSoft = true;
        }
        /* EXTRACT(YEAR FROM x) 里的字段名：位于 EXTRACT( 之后第一个词 */
        if (/^(YEAR|QUARTER|MONTH|WEEK|DAY|HOUR|MINUTE|SECOND|DOW|DOY|EPOCH)$/.test(u)) {
          if (prev2U === 'EXTRACT' && prev && prev.type === 'punct' && prev.value === '(') {
            dialectSoft = true;
          }
          /* DATE_TRUNC('month', x) 的字段名在字符串里，不受影响 */
        }
        /* ALTER TABLE … RENAME / CHANGE / MODIFY / COLUMN(S)：DDL 动词。
         * 这几个词同时也是极常见的列名（RENAME / COLUMN 都在 SOFT_IDENT_WORDS
         * 里），所以必须按位置判定：
         *   · 整条语句以 ALTER 开头（atAlterStmt）；
         *   · 当前词前面就是表名（word 或 `)`），而不是 COLUMN/COLUMNS
         *     （`alter table t alter column rename type text` 里的 rename 是列名）。
         * 只在这种"ALTER TABLE 表名 动词"的固定位置上提升。 */
        if (atAlterStmt && /^(RENAME|CHANGE|MODIFY|ADD|DROP|ALTER|SET)$/.test(u)) {
          if (prev && (prev.type === 'word' || (prev.type === 'punct' && prev.value === ')'))) {
            if (!/^(COLUMN|COLUMNS|ADD|DROP|ALTER|MODIFY|CHANGE|RENAME)$/.test(prevU)) {
              dialectSoft = true;
            }
          }
        }
        /* `ADD COLUMN a INT` / `DROP COLUMN a` / `CHANGE a b INT` 里的 COLUMN(S) */
        if (/^(COLUMN|COLUMNS)$/.test(u) &&
            /^(ADD|DROP|ALTER|MODIFY|CHANGE|RENAME|REPLACE)$/.test(prevU)) {
          dialectSoft = true;
        }
      }

        /* ---- F7（2026-10-29 复核）：上面那批软关键字的位置判据 ----
         * 通用规则（nextIsParen / prevIsType / atStatementStart …）覆盖不到它们，
         * 因为它们的语法位置是"固定短语"而不是"后跟括号"。这里逐个短语判：
         *   EXTRACT(YEAR|QUARTER|WEEK|… FROM x)          字段名
         *   FOR UPDATE SKIP LOCKED / NOWAIT              锁子句
         *   WITH (NOLOCK|HOLDLOCK|UPDLOCK|ROWLOCK|READPAST|TABLOCK)  T-SQL 表提示
         *   ON CONFLICT … DO NOTHING / ON DUPLICATE KEY UPDATE
         *   WITHOUT ROWID（SQLite）、CONNECT BY NOCYCLE（Oracle）
         *   OPTION (RECOMPILE|MAXDOP n)                  T-SQL 查询提示
         *   ALTER TABLE … ENABLE/DISABLE/VALIDATE/…       对象状态动词
         *   TABLESAMPLE (n PERCENT) / PIVOT / UNPIVOT / MATCH_RECOGNIZE
         *   FLASHBACK / UNDROP / SWAP 语句头
         * 其余一律保持用户原文。 */
        if (F7_SOFT[u]) {
          if (/^(QUARTER|WEEK|DOW|DOY|YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|EPOCH)$/.test(u) &&
              prevU === "EXTRACT") {
            dialectSoft = true;
          } else if (/^(SKIP|LOCKED|NOWAIT)$/.test(u) &&
                     /^(UPDATE|SHARE|NO|SKIP|FOR)$/.test(prevU)) {
            dialectSoft = true;
          } else if (/^(NOLOCK|HOLDLOCK|UPDLOCK|ROWLOCK|READPAST|TABLOCK)$/.test(u) &&
                     prev && prev.type === "punct" && /^[(,]$/.test(String(prev.value))) {
            dialectSoft = true;
          } else if (/^(NOTHING|DUPLICATE|NOCYCLE|ROWID)$/.test(u) &&
                     /^(DO|ON|WITHOUT|CONNECT|BY|KEY|UPDATE)$/.test(prevU)) {
            dialectSoft = true;
          } else if (u === "WITHOUT" && next && next.type === "word" && next.upper === "ROWID") {
            dialectSoft = true;
          } else if (/^(RECOMPILE|MAXDOP|OPTION)$/.test(u) &&
                     (prevU === "OPTION" ||
                      (prev && prev.type === "punct" && prev.value === "("))) {
            dialectSoft = true;
          } else if (/^(ENABLE|DISABLE|VALIDATE|NOVALIDATE|MODIFY|CHANGE|ALGORITHM|CASCADED|BEFORE|AFTER)$/.test(u) &&
                     atAlterStmt) {
            dialectSoft = true;
          } else if (/^(BEFORE|AFTER)$/.test(u) &&
                     next && next.type === "word" &&
                     /^(INSERT|UPDATE|DELETE|TRUNCATE)$/.test(String(next.upper))) {
            /* CREATE TRIGGER trg BEFORE INSERT — 时序词，不是语句头 */
            dialectSoft = true;
          } else if (u === "CONFLICT" && prevU === "ON") {
            /* ON CONFLICT (col) DO NOTHING / ON CONFLICT DO UPDATE */
            dialectSoft = true;
          } else if (u === "OPTION" && prevU === "CHECK") {
            /* WITH CHECK OPTION / WITH CASCADED CHECK OPTION */
            dialectSoft = true;
          } else if (u === "CASCADED" && prevU === "WITH") {
            /* WITH CASCADED CHECK OPTION */
            dialectSoft = true;
          } else if (u === "RECOMPILE" && prevU === "WITH") {
            /* T-SQL：CREATE PROCEDURE p WITH RECOMPILE AS … */
            dialectSoft = true;
          } else if (/^(TABLESAMPLE|PIVOT|UNPIVOT|MATCH_RECOGNIZE|CONFLICT|CASCADED)$/.test(u) &&
                     next && next.type === "punct" && next.value === "(") {
            dialectSoft = true;
          } else if (/^(FLASHBACK|UNDROP|SWAP|UNLOAD)$/.test(u) && atStatementStart) {
            dialectSoft = true;
          } else if (/^(SYSTEM|OPTIMIZE|INVALIDATE|FLUSH)$/.test(u) && atStatementStart && next) {
            dialectSoft = true;
          } else if (/^(LINESTRING|IAM_ROLE|TIMEFORMAT|NOCACHE)$/.test(u) &&
                     next && (next.type === "string" ||
                              (next.type === "punct" && next.value === "="))) {
            dialectSoft = true;
          }
        }

      if (dialectSoft) { tk.keyword = true; continue; }

      tk.keyword = !!(nextIsParen || nextIsStr || prevIsType || prevIsNum || prevIsClose ||
        atStatementStart || inFrame || afterLoad);
    }
    return tokens;
  }

/* 扫描一段引号内容。backslash=true 时把 \x 当成转义（MySQL/Hive 习惯），
 * 否则只认 SQL 标准的 '' 双写。返回 { end, closed }。 */
function scanQuoted(sql, i, quote, backslash) {
  var n = sql.length, j = i + 1;
  while (j < n) {
    if (backslash && sql[j] === '\\' && j + 1 < n) { j += 2; continue; }
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) { j += 2; continue; }   /* '' 双写 */
      return { end: j + 1, closed: true };
    }
    j++;
  }
  return { end: n, closed: false };
}

/* PostgreSQL 美元引号：$$...$$ 或 $tag$...$tag$。返回结束下标，不是则 -1。 */
/* P0-7：判断 i 处是不是一个 BigQuery 带连字符的路径。
 * 形如 my-project.dataset.table（≥2 个段，至少一段含 `-`，全部紧贴无空白）。
 * 返回结束下标；不是则 -1。 */
function scanBigQueryPath(sql, i) {
  var n = sql.length, j = i, segs = 0, sawDash = false;
  while (j < n) {
    var segStart = j;
    while (j < n && /[A-Za-z0-9_\-]/.test(sql[j])) {
      if (sql[j] === '-') sawDash = true;
      j++;
    }
    if (j === segStart) return -1;
    segs++;
    if (sql[j] === '.') { j++; continue; }
    break;
  }
  if (segs < 2 || !sawDash) return -1;
  /* 结尾不能是 . 或 - （那是运算符/分隔符） */
  if (/[.\-]$/.test(sql.slice(i, j))) return -1;
  return j;
}

function isBigQueryPath(sql, i, dialect) {
  if (!/bigquery|sql-bigquery/i.test(String(dialect || ''))) return false;
  if (!/[A-Za-z0-9_]/.test(sql[i] || '')) return false;
  /* 前面紧贴的字符不能是标识符字符（否则它是更长标识符的一部分） */
  if (i > 0 && /[A-Za-z0-9_.$]/.test(sql[i - 1])) return false;
  return scanBigQueryPath(sql, i) > i;
}

function matchDollarQuote(sql, i) {
  var n = sql.length, j = i + 1;
  while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j++;
  if (sql[j] !== '$') return -1;
  var tag = sql.slice(i, j + 1);                 /* "$$" 或 "$tag$" */
  var close = sql.indexOf(tag, j + 1);
  if (close < 0) return -1;
  return close + tag.length;
}

/* Oracle q 引号：q'[ ... ]' / q'{...}' / q'(...)' / q'<...>' / q'!...!'
 * 返回结束下标，不是则 -1。 */
var Q_QUOTE_PAIRS = { '[': ']', '{': '}', '(': ')', '<': '>' };

/* ============================== 模板占位保护（H-1） ==============================
 * Jinja / dbt / Airflow / Helm 的模板语法在 SQL 文件里极常见：
 *   {{ col }}   {% if x %}   {# 注释 #}   {%- endif -%}
 * 旧实现把它们当普通标点：`{` `{` 被切成两个单字符 token，排版时中间补空格 →
 * `{ { col } }`，渲染必然失败。更糟的是安全网按"去空白的 token 流"比较，
 * `{ {` 与 `{{` 去掉空白后相同，于是**破坏被判定为等价而放行**。
 * `{% if %}` 还会被 markKeywords 当成 SQL 的 IF 改成 `{% IF %}`。
 *
 * 现在：词法器把它们整体识别为 **opaque token**（type='template'），
 *   - 渲染时原样输出，内部不插空格、不改大小写；
 *   - significant() 里逐字节比较，任何一个字符变了都会触发安全网回退。
 * 匹配失败（没有对应的 `}}` / `%}` / `#}`）时退回普通标点处理，
 * 免得一个没写完的 `{{` 把后面整段 SQL 都吞成 opaque。
 * ---------------------------------------------------------------------------- */
var TEMPLATE_DELIMS = [
  { open: '{{', close: '}}', kind: 'expr' },
  { open: '{%', close: '%}', kind: 'stmt' },
  { open: '{#', close: '#}', kind: 'comment' }
];

/* H6（第二轮审计）：除 Jinja 三件套外，还有一批**必须整体保留**的占位符语法，
 * 旧实现会把它们拆开或改大小写，直接改坏用户代码：
 *
 *   %(name)s        psycopg2 / pymysql 命名参数 → 输出 `% (name) s`
 *   {name} / {0}    Python str.format 模板     → 输出 `{ NAME }`（带空格后 KeyError）
 *   {schema}.{table}                                          同上
 *   #{name}         MyBatis 参数占位符         → `#` 被当注释，整行不再格式化
 *   ${name}         已有分支，保持不变
 *
 * 判据（都要求"紧贴"，避免误伤正常的大括号用法）：
 *   · `%(` … `)` 后面紧跟一个字母（`%(name)s` 的 `s`）；
 *   · `{` 后面紧跟标识符/数字，且**紧贴**到下一个 `}`，内容里不含空白与引号；
 *   · `#{` 后面紧跟标识符。
 * 不满足（未闭合、内容里有空格）时退回普通标点，行为与旧版一致。 */
/* P3-5（2026-11-02 审计）：`dt =#{dt}` 里的 `=#` 被当成一个"复合词"
 * 处理了 —— `#` 在 MySQL 方言下是注释起点，但在 `#{...}` 里它是 MyBatis
 * 占位符。词法器已经把它整体切成一个 template token，所以问题在**渲染**：
 * `spaceBetween(prev, cur)` 对"运算符 + 占位符"没有专门的空格规则，
 * 而占位符 token 的类型是 word，导致既不加空格也不报错。
 * 这里在 spaceBetween 里补一条：前一个是运算符（= < > + - * / 等）时，
 * 后面的占位符必须加空格。 */
function matchPlaceholder(sql, i) {
  var ch = sql.charAt(i);
  var n = sql.length;

  /* %(name)s —— 必须紧跟一个字母后缀（S/S 之外的方言较少见，只认这一个形态） */
  if (ch === '%' && sql.charAt(i + 1) === '(') {
    var mp = /^%\(([A-Za-z_][A-Za-z0-9_]*|[0-9]+)\)([A-Za-z])/.exec(sql.slice(i, i + 80));
    if (mp) return { end: i + mp[0].length, kind: 'pyformat' };
    return null;
  }

  /* {name} / {schema} / {0} —— 内容必须是紧贴的纯标识符或数字 */
  if (ch === '{') {
    var mb = /^\{([A-Za-z_][A-Za-z0-9_]*|[0-9]+)\}/.exec(sql.slice(i, i + 80));
    if (mb) return { end: i + mb[0].length, kind: 'format' };
    return null;
  }

  /* #{name} —— MyBatis。注意 MySQL/Hive 里 `#{` 也可能是注释内容，
   * 所以只在**后面紧跟标识符再紧跟 `}`** 时才算占位符。 */
  if (ch === '#' && sql.charAt(i + 1) === '{') {
    var mh = /^#\{([A-Za-z_][A-Za-z0-9_.]*|[0-9]+)\}/.exec(sql.slice(i, i + 80));
    if (mh) return { end: i + mh[0].length, kind: 'mybatis' };
    return null;
  }

  return null;
}

/* 返回 { end, kind } 或 null。end 是**右边界**（不含）。 */
function matchTemplateTag(sql, i) {
  for (var k = 0; k < TEMPLATE_DELIMS.length; k++) {
    var d = TEMPLATE_DELIMS[k];
    if (sql.substr(i, 2) !== d.open) continue;
    var close = sql.indexOf(d.close, i + 2);
    if (close < 0) return null;              /* 未闭合：交给普通标点 */
    return { end: close + 2, kind: d.kind };
  }
  return null;
}

/* P2-7（2026-11-02 审计）：`q'[…]` 的闭合扫描是平方级的。
 *
 * 输入 `q'[q'[q'[…`（2 万个未闭合的 q 引号）时，几乎每个字符位置都会
 * 命中 `q'`，每次命中都要从当前位置线性扫到文本末尾找配对 ——
 * 报告实测 2 万个耗时 9.6 秒（本次实测 1.2~2.0 秒，取决于机器）。
 *
 * 关键观察：若从下标 s 扫到结尾**没有**找到配对，那么从任何 s' > s 扫
 * （同一个闭合字符）也一定找不到 —— 可搜索区间只会更短。
 * 于是按闭合字符各记一个「已证明扫不到」的最小起点，后续直接返回 -1。
 * 语义完全不变，只是不再重复做注定失败的扫描。 */
var qQuoteDeadFrom = Object.create(null);
/* 这份记忆只对**当前这一份** sql 文本有效 —— 换文本必须清空，
 * 否则上一次"扫不到闭合"的结论会污染另一条完全正常的 q 引号
 * （实测：先格式化未闭合的，再格式化 `q'[a]'`，后者被拆成 `q '[a]'`）。 */
var qQuoteDeadSql = null;

function matchQQuote(sql, i) {
  if ((sql[i] !== 'q' && sql[i] !== 'Q') || sql[i + 1] !== "'") return -1;
  if (qQuoteDeadSql !== sql) { qQuoteDeadSql = sql; qQuoteDeadFrom = Object.create(null); }
  var open = sql[i + 2];
  if (open === undefined) return -1;
  var close = Q_QUOTE_PAIRS[open] || open;
  var dead = qQuoteDeadFrom[close];
  if (dead !== undefined && i >= dead) return -1;
  var j = i + 3;
  while (j < sql.length) {
    if (sql[j] === close && sql[j + 1] === "'") {
      delete qQuoteDeadFrom[close];
      return j + 2;
    }
    j++;
  }
  qQuoteDeadFrom[close] = i;
  return -1;
}

/* P0-9（2026-11-02 审计）：SQL*Plus / psql 的**行级客户端命令**。
 * 它们由客户端逐行解析，不是 SQL：
 *     SET SERVEROUTPUT ON
 *     SPOOL x.log
 *     PROMPT 开始导出
 *     @script.sql
 *     /
 * 旧实现把它们当普通 SQL 词排成一行（`SET SERVEROUTPUT ON SPOOL x.log`），
 * 脚本语义直接改变 —— SQL*Plus 只认整行。
 *
 * 只有 Oracle / psql 方言才启用（opts.clientLines），否则 SHOW / COLUMN /
 * CONNECT 这些词在别的库里是正常 SQL。
 * 返回该行结束下标；不匹配返回 -1。 */
/* 只收**在 SQL 里不可能作为语句开头**的客户端指令：
 *   · SET <SQL*Plus 变量>  —— 后面必须紧跟已知变量名（`SET @x=1`、`SET x=1` 不是）
 *   · SPOOL / PROMPT / WHENEVER / TTITLE / BTITLE / ACCEPT / PAUSE / HOST / QUIT
 *   · @file / @@file  —— SQL*Plus 的脚本调用
 *   · UNDEFINE / DEFINE —— 与 SQL 的 DEFINE 无冲突（SQL 没有 DEFINE 语句）
 *
 * 刻意**不收**的几个（复核时误伤过）：
 *   CONNECT    —— Oracle 层次查询 `CONNECT BY PRIOR …` 是正常 SQL
 *   COLUMN     —— `ALTER TABLE t COLUMN a` / `ADD COLUMN` 是正常 SQL
 *   COMPUTE    —— Impala `COMPUTE STATS t` 是正常 SQL
 *   BREAK      —— 太通用，且 SQL 里也可能出现在字符串拼接描述里
 *   EXIT       —— 部分方言的过程体里有 EXIT WHEN（PL/SQL）
 *   DISCONNECT —— 同 CONNECT，留给 psql 元命令通道（\c）处理
 */
var CLIENT_CMD_RE = /^(?:SET[ \t]+(?:SERVEROUTPUT|ECHO|TIMING|LINESIZE|PAGESIZE|FEEDBACK|VERIFY|HEADING|TERMOUT|TRIMOUT|SQLBLANKLINES|AUTOCOMMIT|SHOWMODE|SERVEROUT)\b|SPOOL\b|PROMPT\b|DEFINE\b|UNDEFINE\b|WHENEVER\b|TTITLE\b|BTITLE\b|ACCEPT\b|PAUSE\b|HOST\b|QUIT\b|@|@@)/i;
var PSQL_META_RE = /^\\[a-zA-Z]/;

/* N3 / N4（2026-11-04 复核）：另外两类**行级客户端命令**，与方言无关：
 *   Hive CLI      `dfs -ls /user/hive` / `!sh ls -l /tmp` / `source x.sql`
 *   sqlcmd        `:setvar db x-y` / `:r a-b.sql` / `:connect srv`
 * 它们由客户端逐行解析，不是 SQL；旧实现把 `dfs -ls` 拆成 `dfs - ls`、
 * 把 `!sh ls -l` 拆成 `! sh ls - l`、把 `:setvar` 与下一行并成一条语句，
 * 脚本语义直接改变（那是用户直接拿去执行的脚本）。
 * 判据要求"整行"：必须从行首开始，且整行形态确定 —— 不会误伤
 * `dfs` / `:r` 这类普通标识符（它们不在行首时不受影响）。 */
var HIVE_CLI_RE = /^(?:dfs\s+[-/]|add\s+(?:file|jar|archive)\s+|list\s+(?:file|jar|archive)\b|delete\s+(?:file|jar|archive)\s+|source\s+\S|!\s*[A-Za-z])/i;
var SQLCMD_RE = /^:(?:setvar|r|connect|on\s+error|error|out|list|listvar|reset|ed|xml|serverlist|help)\s/i;
/* N8：代码区里算作**空白**的非 ASCII 字符（不含行分隔符与 BOM，见用处的注释）。 */
var HORIZONTAL_WS_RE = /^[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]$/;

/* N3 / N4 专用：只认 Hive CLI 与 sqlcmd 两类行级命令（与方言无关）。
 * 判据刻意窄：整行形态必须确定，且只在**行首**匹配，所以
 * `select dfs from t`、`where a = :r` 这类正常 SQL 不会被误伤。 */
function matchHiveSqlcmdLine(sql, i) {
  var j = sql.indexOf('\n', i);
  var e = j < 0 ? sql.length : j;
  var line = sql.slice(i, e).replace(/\s+$/, '');
  if (!line) return -1;
  if (HIVE_CLI_RE.test(line) || SQLCMD_RE.test(line)) return e;
  return -1;
}

/* 整行客户端命令：返回该行结束下标；不匹配返回 -1。 */
function matchClientLine(sql, i) {
  var j = sql.indexOf('\n', i);
  var e = j < 0 ? sql.length : j;
  var line = sql.slice(i, e).replace(/\s+$/, '');
  if (!line) return -1;
  /* 单独一行一个 / 是 SQL*Plus 的"执行缓冲区"指令 */
  if (/^\/\s*$/.test(line)) return e;
  if (CLIENT_CMD_RE.test(line) || PSQL_META_RE.test(line)) return e;
  return -1;
}

function tokenizeRaw(sql, opts) {
  opts = opts || {};
  var backslash = opts.backslash === true;
  var hashComment = opts.hashComment === true;
  var clientLines = opts.clientLines === true;
  /* P0-7：BigQuery 路径判定要用方言 */
  var lexDialect = String(opts.dialect || '');
  /* `--` 在 MySQL 里必须紧跟空白才算注释（`1--2` 是 1-(-2)，不是注释）。
   * 由 detectLex 按方言打开（H-3）。 */
  var dashSpace = opts.dashSpace === true;
  var tokens = [];
  var i = 0, n = sql.length, nl = 0;
  var unterminated = false;
  /* P1-6（2026-11-05 复核）：`unterminated` 以前是一个布尔量，把
   * "字符串未闭合""块注释未闭合""dollar-quote 未闭合""q-quote 未闭合"四种
   * 完全不同的情况混在一起，诊断引擎只能猜，于是把**闭合正常**的字符串
   * 报成"字符串未闭合"，真正出错的位置反而被掩盖。
   * 现在额外记录类型与起点，诊断按类型分别处理。 */
  var unterminatedKind = '';
  var unterminatedStart = -1;
  function markUnterminated(kind, at) {
    unterminated = true;
    if (!unterminatedKind) { unterminatedKind = kind; unterminatedStart = at; }
  }

  while (i < n) {
    var ch = sql[i];
    var before = i;

    if (ch === '\n') { nl++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') { i++; continue; }

    /* N8（2026-11-04 复核）：Unicode 空白（NBSP U+00A0、全角空格 U+3000、
     * U+2000-200A 等）在**代码区**只是空白，必须像普通空格一样跳过。
     *
     * 旧实现只认 ASCII 空白，于是这些字符被当成标点 token 送进排版，
     * 输出把它们改写成普通空格 → 重新词法时 token 数变了 → 安全网判不等价
     * → 整条语句（旧实现是整篇）回退。从网页或 Word 复制 SQL 时 NBSP 极常见，
     * 用户看到的是"按了没反应" + 一条"token 不等价"的莫名提示。
     *
     * 只收**水平**空白：U+2028 / U+2029 是行分隔符、U+FEFF 是 BOM/ZWNBSP，
     * 把它们当空格会悄悄并掉行或吞掉不可见标记，所以维持原状。 */
    if (ch.charCodeAt(0) > 0x7F && HORIZONTAL_WS_RE.test(ch)) { i++; continue; }

    /* P0-9：行首的客户端命令整行成为一个不可改写的 token。
     * 判据：本行是独立一行（i 之前那一段含换行，或 i === 0），且整行匹配。 */
    /* psql 的反斜杠元命令（\c mydb / \d table / \timing）在任何方言下
     * 都不可能是 SQL 代码 —— `\` 在 SQL 里没有作为语句起始的用法。
     * 所以这条**不依赖** clientLines 开关。 */
    /* DELIMITER 是 mysql 客户端的指令（不是 SQL），空格与分隔符都是语法的一部分。
     * 整行原样保留，否则 `delimiter ;` 会变成 `delimiter;`、后面紧跟的语句被并上来。 */
    if ((ch === 'd' || ch === 'D') && /^delimiter\b/i.test(sql.slice(i, i + 10)) &&
        (i === 0 || /\n/.test(sql.slice(Math.max(0, i - 1), i)))) {
      var dj = sql.indexOf('\n', i);
      var de = dj < 0 ? n : dj;
      tokens.push({ type: 'client', value: sql.slice(i, de).replace(/\s+$/, ''), nl: nl, start: i, end: de });
      nl = 0; i = de; continue;
    }

    if (ch === '\\' && (i === 0 || /\n/.test(sql.slice(Math.max(0, i - 1), i + 1)))) {
      var pj = sql.indexOf('\n', i);
      var pe = pj < 0 ? n : pj;
      tokens.push({ type: 'client', value: sql.slice(i, pe).replace(/\s+$/, ''), nl: nl, start: i, end: pe });
      nl = 0; i = pe; continue;
    }

    /* N1（2026-11-04 复核）：`COPY … FROM stdin;` 的内联数据块必须整段原样保留。
     *
     * pg_dump 的默认输出格式就是它：
     *     COPY t (a, b) FROM stdin;
     *     1	foo-bar
     *     \.
     * 数据行不是 SQL（Tab 分隔、可以含 `-`、`#`、`--`、引号），
     * 旧实现把它当 SQL 重新排版，`foo-bar` 变成 `foo - bar` —— 那是**数据损坏**，
     * 而且 pg_restore 会把它写进表里。
     *
     * 判据：行首的 `COPY`，且**同一行**里出现 `FROM stdin`，则该 COPY 头
     * 到 `\.` 结尾行整体成为一个不可改写的 client token。 */
    if ((ch === 'c' || ch === 'C') && (i === 0 || /\n/.test(sql.slice(Math.max(0, i - 1), i))) &&
        /^copy\b/i.test(sql.slice(i, i + 6))) {
      var copyEol = sql.indexOf('\n', i);
      if (copyEol < 0) copyEol = n;
      var copyHead = sql.slice(i, copyEol);
      if (/from\s+stdin\b/i.test(copyHead)) {
        /* 找结束行 `\.`（可带行尾空白） */
        var copyPos = copyEol;
        var copyEnd = n;
        while (copyPos < n) {
          var nlPos = sql.indexOf('\n', copyPos + 1);
          var lineEnd = nlPos < 0 ? n : nlPos;
          if (/^\s*\\\.\s*$/.test(sql.slice(copyPos, lineEnd))) { copyEnd = lineEnd; break; }
          if (nlPos < 0) { copyEnd = n; break; }
          copyPos = nlPos;
        }
        tokens.push({
          type: 'client', copyBlock: true,
          value: sql.slice(i, copyEnd).replace(/\s+$/, ''),
          nl: nl, start: i, end: copyEnd
        });
        nl = 0; i = copyEnd; continue;
      }
    }

    if (clientLines) {
      var gap0 = i === 0 ? '\n' : sql.slice(tokens.length ? (tokens[tokens.length - 1].end || 0) : 0, i);
      var atLine0 = i === 0 || /\n/.test(gap0);
      if (atLine0) {
        var ce = matchClientLine(sql, i);
        if (ce > i) {
          tokens.push({
            type: 'client', value: sql.slice(i, ce).replace(/\s+$/, ''),
            nl: nl, start: i, end: ce
          });
          nl = 0; i = ce; continue;
        }
      }
    }

    /* N3 / N4（2026-11-04 复核）：Hive CLI（`dfs -ls …` / `!sh …` / `source …`）
     * 与 sqlcmd（`:setvar …` / `:r …`）的**行级命令**，与方言无关。
     * 它们由客户端逐行解析，不是 SQL：旧实现把 `dfs -ls` 拆成 `dfs - ls`、
     * 把 `!sh ls -l` 拆成 `! sh ls - l`、把 `:setvar` 与下一行并成一条语句。
     * 判据只在**行首**生效、且整行形态确定，不会误伤正常 SQL。
     *
     * P3-2（2026-11-06 复核）：这层守卫的**首字符集合**必须覆盖
     * HIVE_CLI_RE / SQLCMD_RE 里所有分支的起始字母，否则正则写了也白写。
     * 旧守卫只有 d/!/:，于是 `list file …` 与 `source …` 根本进不来 ——
     * `list jar` 会被当 SQL 排版成 `list JAR`（JAR 在关键字表里），
     * 用户拿去执行的脚本被改坏。现在补上 l/L（list）与 s/S（source）。
     * `select` / `left` / `set` / `show` 这些以 l/s 开头的关键字也会多走一次
     * 正则，但 HIVE_CLI_RE 要求 `list\s+(file|jar|archive)\b` /
     * `source\s+\S` 的整行形态，不会命中；代价只有行首那一处一次
     * indexOf('\n') + 两次正则，可忽略。
     *
     * 为什么守卫里**没有** a/A：`add jar|file|archive` 走的是 SQL 路径
     * （ADD 是关键字，另有 markPathTokens 专门处理多路径与通配符），
     * 输出 `ADD JAR /a/x.jar /b/y.jar` 已正确。把它挪进行级保护反而会
     * 丢掉大写化（R-1 就是这么红的）。HIVE_CLI_RE 里的 add 分支因此是
     * 死分支，留着只为文档性，见 P3-2 说明。 */
    if (ch === 'd' || ch === 'D' ||
        ch === 'l' || ch === 'L' || ch === 's' || ch === 'S' ||
        ch === '!' || ch === ':') {
      var gapH = i === 0 ? '\n' : sql.slice(Math.max(0, i - 1), i);
      if (i === 0 || /\n/.test(gapH)) {
        var hc = matchHiveSqlcmdLine(sql, i);
        if (hc > i) {
          tokens.push({
            type: 'client', value: sql.slice(i, hc).replace(/\s+$/, ''),
            nl: nl, start: i, end: hc
          });
          nl = 0; i = hc; continue;
        }
      }
    }

    /* 模板定界符 {{ }} / {% %} / {# #}：整体一个 opaque token（H-1）。
     * 必须排在所有 `{` 相关分支之前，否则 `{` 会先被切成单字符标点。 */
    if (ch === '{') {
      var mt = matchTemplateTag(sql, i);
      if (mt) {
        tokens.push({
          type: 'template', kind: mt.kind, template: true, noCase: true,
          value: sql.slice(i, mt.end), upper: sql.slice(i, mt.end),
          nl: nl, start: i, end: mt.end
        });
        nl = 0; i = mt.end; continue;
      }
    }

    /* H6 / M12：其余占位符语法（%(name)s / {name} / #{name}）同样整体保护。
     * 必须排在 `#` 注释判定与 `%` 标点之前 —— 否则
     *   `a = #{a} and b` 会因为 `#` 走注释分支把整行吞掉，
     *   `%(b)s` 会被拆成 `% (b) s`。 */
    var mph = matchPlaceholder(sql, i);
    if (mph) {
      tokens.push({
        type: 'template', kind: mph.kind, template: true, noCase: true,
        value: sql.slice(i, mph.end), upper: sql.slice(i, mph.end),
        nl: nl, start: i, end: mph.end
      });
      nl = 0; i = mph.end; continue;
    }

    /* 行注释：一直保护到行尾，绝不做任何格式化 */
    /* 行注释：一直保护到行尾，绝不做任何格式化。
     * MySQL 要求 `--` 后必须紧跟空白/控制符/行尾，否则 `1--2` 就是 `1 - (-2)`。
     * 旧版无条件把 `--` 当注释，`select 1--2 as x` 的后半句被整段吞掉，
     * 列别名 `as x` 直接消失（H-3 / P0-3a）。 */
    if (ch === '-' && sql[i + 1] === '-' &&
        (!dashSpace || sql[i + 2] === undefined || /[\s]/.test(sql[i + 2]))) {
      var jl = sql.indexOf('\n', i);
      if (jl < 0) jl = n;
      var lv = sql.slice(i, jl).replace(/\s+$/, '');
      tokens.push({ type: 'comment', kind: 'line', value: lv, nl: nl, start: i, end: jl });
      nl = 0; i = jl; continue;
    }

    /* `#` 的语义完全由方言决定（H-1 / H-2 / P0-1 / P0-2）：
     *   comment 模式（MySQL/MariaDB）：`#` 之后到行尾**一律**是注释。
     *     旧版有 gluedH / afterNamePos 两个例外，于是 `select a#b, c from t` 里的
     *     `a#b` 被当成一个标识符，后面的 `, c from t` 继续当 SQL 重排 ——
     *     MySQL 里那本来是注释，格式化把它变成了可执行代码。
     *   xor / ident 模式（PG / Hive / T-SQL）：`#` 是运算符或标识符前缀，
     *     但它出现在**行首**时只可能是注释：没有 SQL 会以 `#` 开始一个表达式，
     *     而注释行以 `#` 开头极常见。旧版整行按 xor 处理，于是
     *     `# get data from order table where valid` 被拆成 `# get DATA` +
     *     `FROM ORDER TABLE` + `WHERE valid`，凭空造出第二个 FROM（P0-1）。 */
    if (ch === '#' && sql[i + 1] !== '>' && sql[i + 1] !== '<') {
      var prevH = tokens.length ? tokens[tokens.length - 1] : null;
      /* 行首判定：源文本里这个 `#` 之前一整段（到上一个 token 结束）含换行 */
      var gap = prevH && typeof prevH.end === 'number' ? sql.slice(prevH.end, i) : sql.slice(0, i);
      var atLineStart = /\n/.test(gap) || !prevH;
      if (hashComment || atLineStart) {
        var jh = sql.indexOf('\n', i);
        if (jh < 0) jh = n;
        var hv = sql.slice(i, jh).replace(/\s+$/, '');
        tokens.push({ type: 'comment', kind: 'line', value: hv, nl: nl, start: i, end: jh });
        nl = 0; i = jh; continue;
      }
    }

    /* 块注释 */
    if (ch === '/' && sql[i + 1] === '*') {
      /* P0-2（2026-11-05 复核）：`add jar /user/hive/lib/*.jar` 里的 `/*`
       * 是**路径里的斜杠 + 通配符**，不是块注释起点。旧实现无条件按注释处理，
       * 把后面整段脚本（包括真正的 SQL）吞进一个未闭合注释里 ——
       * 格式化后脚本静默变成"什么都不做"。
       *
       * 判据只看**紧贴的路径前缀**（到行首或空白为止的那一段）：
       * 以 `/` 开头、或含 `://`（hdfs://s3://file://），才是路径上下文。
       * 这样「除法紧跟一个真正的块注释」那种写法不受影响。
       * 三个字符连写的空注释也一律按注释处理，避免把 a 与 b 之间的
       * 空注释拆成路径片段。 */
      if (sql[i + 2] !== '/' && isInsidePathPrefix(sql, i)) {
        /* 落到下面的普通标点分支：`/` 与 `*` 各自成 token，
         * 随后 markPathTokens 会把整段路径（含 `*`）标出来。 */
      } else {
        var jb = sql.indexOf('*/', i + 2);
        var endb = jb < 0 ? n : jb + 2;
        if (jb < 0) {
          unterminated = true;
          if (!unterminatedKind) { unterminatedKind = 'block-comment'; unterminatedStart = i; }
        }
        tokens.push({ type: 'comment', kind: 'block', value: sql.slice(i, endb), nl: nl, start: i, end: endb });
        nl = 0; i = endb; continue;
      }
    }

    /* P0-4（2026-11-02 审计）：Hive / Spark 的 `SET key=value` 里 value 是**自由文本**，
     * 不是表达式。旧实现按表达式分词并在运算符两侧补空格：
     *     set hivevar:dt=2021-01-01;               → SET hivevar:dt = 2021 - 01 - 01;
     *     set mapred.job.name=my-job_2021;        → ... = my - job_2021;
     *     set ...java.opts=-Xmx4096m -XX:+UseG1GC; → ... = -Xmx4096m - XX:+UseG1GC;
     * 三条都改变了变量值，作业直接跑错。
     *
     * 判据用**键名形态**而不是方言：Hive 配置键一定带 `.` 或 `:`
     * （mapred.job.name / hivevar:dt / hive.exec.parallel），
     * 而 MySQL 的 `set @x = 1`、过程体的 `set x = 1` 都不带。
     * 这样不依赖调用方传对 dialect，也不会误伤普通赋值。
     * 命中后整段 `key=value` 合成一个 noCase token，直到分号或行尾。 */
    if ((ch === 'S' || ch === 's') && /^set\b/i.test(sql.slice(i, i + 4)) &&
        !(tokens.length && tokens[tokens.length - 1].type !== 'comment' &&
          tokens[tokens.length - 1].type !== 'punct')) {
      var setM = /^set[ \t]+([A-Za-z_][A-Za-z0-9_.:\-]*)[ \t]*=/i.exec(sql.slice(i, i + 200));
      if (setM && /[.:]/.test(setM[1])) {
        /* 从 set 之后到分号/行尾 */
        var sv = i + setM[0].length;
        var sEnd = sv;
        while (sEnd < n && sql[sEnd] !== ';' && sql[sEnd] !== '\n') sEnd++;
        var setVal = sql.slice(sv, sEnd).replace(/\s+$/, '');
        if (setVal) {
          tokens.push({
            type: 'word', value: 'SET', upper: 'SET', keyword: true, nl: nl, start: i, end: i + 3
          });
          /* P3-5（2026-11-02 审计）：value 直接取原文，不要重新拼。
           * 旧写法 `setM[1] + '=' + setVal` 会把 ` = ` 压缩成 `=`，
           * 输出 `SET hive.exec.dynamic.partition= true`。
           * 更糟的是 normalizeLine() 对**单行**重新分词时，
           * UPDATE 的 `SET t.a = 1` 这一行也会走进本分支（`t.a` 带点号），
           * 于是 `SET t.a = 1` 被改成 `SET t.a= 1`。
           * 取原文后，这个分支在任何位置触发都是"原样保留"。 */
          var setRaw = sql.slice(i + 3, sEnd).replace(/^[ \t]+/, "");
          tokens.push({
            type: 'word', value: setRaw,
            upper: setRaw.toUpperCase(),
            noCase: true, opaqueSet: true, nl: 0, start: i + 4, end: sEnd
          });
          nl = 0; i = sEnd; continue;
        }
      }
    }

    /* PostgreSQL 美元引号 $$...$$ / $tag$...$tag$（必须排在 $ 标点之前） */
    if (ch === '$') {
      var dq = matchDollarQuote(sql, i);
      if (dq > i) {
        tokens.push({ type: 'string', value: sql.slice(i, dq), nl: nl, start: i, end: dq });
        nl = 0; i = dq; continue;
      }
      /* P2-7（2026-11-05 复核）：形态确实是 `$tag$` / `$$`、却找不到结束标记时，
       * 旧实现让 `$tag` 当标识符、`$abc` 当变量继续往下切，后面的 SQL 照常重排：
       *     select $tag$abc from t where x=1
       *       → SELECT $tag$abc / FROM t / WHERE x = 1
       * 这类输入多半是**函数体被截断**，任何重排都是在改写内容。
       * 现在把从 `$` 到文件末尾整体作为一个不可分的 string token（逐字节保留），
       * 并标记 unterminated，诊断会指出这一处。 */
      var dqTag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (dqTag) {
        markUnterminated('dollar-quote', i);
        tokens.push({ type: 'string', value: sql.slice(i), nl: nl, start: i, end: n });
        nl = 0; i = n; continue;
      }
      /* 模板变量 ${hiveconf:dt} / ${var}：整体一个 token，内部不插空格 */
      if (sql[i + 1] === '{') {
        var jv = sql.indexOf('}', i + 2);
        if (jv > 0) {
          tokens.push({
            type: 'word', value: sql.slice(i, jv + 1), upper: sql.slice(i, jv + 1).toUpperCase(),
            noCase: true, variable: true, nl: nl, start: i, end: jv + 1
          });
          nl = 0; i = jv + 1; continue;
        }
      }
      /* P0-5（2026-11-02 审计）：数仓调度平台的日期参数 `$[yyyymmdd-1]`。
       * 它是**一个不可分的宏**，被拆成 `$ [yyyymmdd-1]` 后调度平台就不认了。
       * 判据：`$` 后紧跟 `[`，且能在同一行内找到配对的 `]`。
       * 找不到配对时退回普通标点，避免把整段吞掉。 */
      if (sql[i + 1] === '[') {
        var jbr2 = sql.indexOf(']', i + 2);
        if (jbr2 > i + 1) {
          tokens.push({
            type: 'word', value: sql.slice(i, jbr2 + 1),
            upper: sql.slice(i, jbr2 + 1).toUpperCase(),
            noCase: true, variable: true, nl: nl, start: i, end: jbr2 + 1
          });
          nl = 0; i = jbr2 + 1; continue;
        }
      }
      /* P1-3（2026-11-02 审计）：`$name` 会话变量（Snowflake `$var`、
       * T-SQL `$PARTITION`）与 `$$var`（PostgreSQL psql 变量）。
       * 旧实现只认 `$1`，`$var` 落到标点分支 → 输出 `$ var`，
       * 而且它进了 hard 指纹，格式化后指纹变了 → 安全网整篇回退。 */
      if (/[A-Za-z_]/.test(sql[i + 1] || '')) {
        var jvn = i + 1;
        while (jvn < n && /[A-Za-z0-9_]/.test(sql[jvn])) jvn++;
        tokens.push({
          type: 'word', value: sql.slice(i, jvn),
          upper: sql.slice(i, jvn).toUpperCase(),
          noCase: true, variable: true, nl: nl, start: i, end: jvn
        });
        nl = 0; i = jvn; continue;
      }
      /* PostgreSQL 位置参数 $1 / $2（P0-3）。
       * 旧版落到单字符 punct 分支，输出成 `$ 1`，所有 JDBC/psql 占位符直接失效。 */
      if (/[0-9]/.test(sql[i + 1] || '')) {
        var jp = i + 1;
        while (jp < n && /[0-9]/.test(sql[jp])) jp++;
        tokens.push({
          type: 'word', value: sql.slice(i, jp), upper: sql.slice(i, jp).toUpperCase(),
          noCase: true, variable: true, param: true, nl: nl, start: i, end: jp
        });
        nl = 0; i = jp; continue;
      }
    }

    /* 绑定变量 :name（psql / Oracle）与 T-SQL @@name。
     * `::` 是类型转换，不能进这个分支。
     *
     * H1（第二轮审计）：旧判据是"前一个 token 不是 word/quoted/number/string"才认，
     * 于是 `between :start`、`like :pat`、`in :ids`、`limit :n` **全都不认**，
     * 输出成 `: START` / `: PAT` —— SQLAlchemy text()、Spring NamedParameterJdbcTemplate
     * 的命名参数全部失效，而且 `:` 不在安全网的 DANGER_HEADS 里，安全网不报警。
     *
     * 正确判据是"这个 `:` 是否**紧贴**前一个 token"：
     *   - `struct<a:int>` / `map<string:int>` / `v:name`  → 紧贴，是类型声明/限定名，不是变量
     *   - `between :start` / `= :1`                       → 前面有空白，是绑定变量
     * 用 `end === i`（源码位置相邻）判定，与词法器其它地方保持一致。
     * 同时支持 Oracle 的位置绑定 `:1` / `:2`（旧分支只认 `[A-Za-z_]`，`:1` 永远不认）。 */
    if (ch === ':' && sql[i + 1] !== ':' && /[A-Za-z0-9_]/.test(sql[i + 1] || '')) {      var prevB = tokens.length ? tokens[tokens.length - 1] : null;
      /* 紧贴前一个 token（中间没有空白）且前一个是词/引号/数字/字符串 → 不是绑定变量 */
      var gluedToPrev = !!(prevB && typeof prevB.end === 'number' && prevB.end === i &&
        (prevB.type === 'word' || prevB.type === 'quoted' ||
         prevB.type === 'number' || prevB.type === 'string'));
      if (!gluedToPrev) {
        var jb2 = i + 1;
        while (jb2 < n && /[A-Za-z0-9_]/.test(sql[jb2])) jb2++;
        tokens.push({
          type: 'word', value: sql.slice(i, jb2), upper: sql.slice(i, jb2).toUpperCase(),
          noCase: true, variable: true, nl: nl, start: i, end: jb2
        });
        nl = 0; i = jb2; continue;
      }
    }

    /* N5b（2026-11-04 复核）：Oracle 的 `nq'[...]'` / `NQ'{...}'`
     * 是国家字符集的 q 引号，整体是一个字符串字面量。
     * 旧实现把 `nq` 当标识符、`'[x]'` 当普通字符串，输出 `nq '[x]'` ——
     * 语义从"一个字面量"变成"两个 token"。必须在标识符分支之前拦截。 */
    if ((ch === 'n' || ch === 'N') && (sql[i + 1] === 'q' || sql[i + 1] === 'Q') && sql[i + 2] === "'") {
      var nqq = matchQQuote(sql, i + 1);
      if (nqq > i + 1) {
        tokens.push({ type: 'string', value: sql.slice(i, nqq), nl: nl, start: i, end: nqq });
        nl = 0; i = nqq; continue;
      }
      /* P1-9（2026-11-06 复核）：形态确实是 `nq'…` 但找不到闭合。
       * 旧实现静默落回普通分支，输出 `nq '[abc…`（把一个字面量拆成两个 token），
       * 而 status 仍是 formatted —— 安全网用同一个词法器，也看不出来。
       * 现在标记为未闭合，sql() 原样返回并给出准确提示。 */
      markUnterminated('q-quote', i);
    }

    /* N5a（2026-11-04 复核）：Oracle SQL*Plus 的替换变量 `&b` / `&&c`。
     * 它们由客户端在发送 SQL 之前做文本替换，`&&c` 与 `& c` 是两回事。
     * 旧实现把 `&` 当按位与运算符，输出 `SELECT & b` / `, && c` ——
     * 在 SQL*Plus 里这还是能替换（`& b` 里的空格只是变量名的一部分边界的空白），
     * 但在 `define`/`accept` 与脚本拼接场景下语义已经变了，且与用户原文不一致。
     * 判据：`&` 紧贴一个标识符（中间没有空白）且不在字符串/注释里
     * （那些已由前面的分支拦掉），则整体作为一个 variable token。 */
    if (ch === '&') {
      var ampStart = i;
      var ampName = i + 1;
      if (sql[ampName] === '&') ampName++;
      if (/[A-Za-z_\u4e00-\u9fa5]/.test(sql[ampName] || '')) {
        var ampEnd = ampName;
        while (ampEnd < n && /[A-Za-z0-9_\u4e00-\u9fa5]/.test(sql[ampEnd])) ampEnd++;
        tokens.push({
          type: 'word', value: sql.slice(ampStart, ampEnd),
          upper: sql.slice(ampStart, ampEnd).toUpperCase(),
          noCase: true, variable: true, nl: nl, start: ampStart, end: ampEnd
        });
        nl = 0; i = ampEnd; continue;
      }
    }

    /* Oracle q'[...]' */
    if (ch === 'q' || ch === 'Q') {
      var qq = matchQQuote(sql, i);
      if (qq > i) {
        tokens.push({ type: 'string', value: sql.slice(i, qq), nl: nl, start: i, end: qq });
        nl = 0; i = qq; continue;
      }
      /* P0（2026-11-09 复核）：**必须再确认下一个字符是引号**才谈得上"未闭合"。
       * matchQQuote 的前置校验是 `sql[i+1] !== "'"` 就返回 -1，而旧写法在这个
       * 分支里对任何 q/Q 开头的 token 都无条件 markUnterminated —— 于是
       * `select quantity from t`、`select qty from t` 这类**完全合法**的 SQL
       * 全被判成"q-quote 未闭合"，整篇原样返回、拒绝格式化。
       * 对照 nq'' 分支：那里的条件写的是 `sql[i+2] === "'"`，本来是对的。 */
      if (sql[i + 1] === "'") markUnterminated('q-quote', i);
    }

    /* 字符串 / 引号标识符 */
    if (ch === "'" || ch === '"' || ch === '`') {
      /* N2（2026-11-04 复核）：BigQuery 的三引号字符串 `'''…'''` / `"""…"""`
       * 是**一个**字面量，内部可以含单个引号。旧实现按普通字符串扫描，
       * 在第一个引号处就闭合，于是 `'''d'e'''` 变成 `'''d'` + `e` + `'''`，
       * 排版后输出 `'''d' e'''` —— 字面量的值被插入了一个空格（数据被改）。
       * 只在 bigquery 方言下启用（其它方言里三连引号是三个相邻空串）。 */
      var tripleQuote = '';
      if (/bigquery|sql-bigquery/i.test(lexDialect) && ch !== '`' &&
          sql[i + 1] === ch && sql[i + 2] === ch) {
        tripleQuote = ch + ch + ch;
      }
      if (tripleQuote) {
        var tqClose = sql.indexOf(tripleQuote, i + 3);
        var tqEnd = tqClose < 0 ? n : tqClose + 3;
        if (tqClose < 0) markUnterminated('string', i);
        tokens.push({ type: 'string', value: sql.slice(i, tqEnd), nl: nl, start: i, end: tqEnd });
        nl = 0; i = tqEnd; continue;
      }
      var qr = scanQuoted(sql, i, ch, backslash && ch !== '`');
      if (!qr.closed) markUnterminated('string', i);
      tokens.push({
        type: ch === '`' ? 'quoted' : 'string',
        style: ch === '`' ? 'backtick' : undefined,
        value: sql.slice(i, qr.end), nl: nl, start: i, end: qr.end
      });
      nl = 0; i = qr.end; continue;
    }

    /* 方括号标识符：[select]、[from]、[my table]（T-SQL 风格）。
     * 注意要区分「下标访问」arr[0]、map_col['k']——那种 [ 紧贴前一个 token，
     * 里面是纯数字/字符串，不能当标识符整体吞掉。 */
    if (ch === '[') {
      var prevTok = tokens.length ? tokens[tokens.length - 1] : null;
      var glued = prevTok && typeof prevTok.end === 'number' && prevTok.end === i &&
        (prevTok.type === 'word' || prevTok.type === 'number' || prevTok.type === 'string' ||
         prevTok.type === 'quoted' || (prevTok.type === 'punct' && (prevTok.value === ')' || prevTok.value === ']' ||
         /* 方言兼容性检测报告 §3.5：PG **多维数组** `int[][]` 的第二个 `[]`。
          * 第一个 `[]` 已经是 punct token（见下面的 M-4 分支），它的 end 正好等于
          * 第二个 `[` 的位置，但 value 是 `'[]'` 而不是 `']'` —— 旧条件认不出来，
          * 第二个 `[]` 于是被当成**方括号标识符**（quoted），后续拼接成 `INT[] []`。
          * token 流本身没变（punct[] + quoted[] vs punct[] + punct[]），
          * 所以安全网放行，只是观感错。 */ prevTok.value === '[]')));

      if (!glued) {
        var jbr = i + 1, bval = '[', closed = false;
        while (jbr < n) {
          if (sql[jbr] === ']') {
            if (sql[jbr + 1] === ']') { bval += ']]'; jbr += 2; continue; }  /* ]] 转义 */
            bval += ']'; jbr++; closed = true; break;
          }
          bval += sql[jbr]; jbr++;
        }
        if (closed) {
          tokens.push({ type: 'quoted', style: 'bracket', value: bval, nl: nl, start: i, end: jbr });
          nl = 0; i = jbr; continue;
        }
      } else if (sql[i + 1] === ']') {
        /* M-4：**空方括号**紧贴前面的词 → 这是 PostgreSQL 的数组类型标注
         * （`int[]` / `text[]` / `varchar(10)[]` / `a::int[]`），不是 T-SQL 标识符。
         * 旧实现把它拆成 `[` `]` 两个标点，然后 spaceBetween 的 `[` 分支看到
         * 前一个词是关键字（INT）就补了一个空格 → 输出 `INT []`。
         * 重新词法时 `[]` 与 `INT` 不再紧贴，`[`+`]` 被读成一个空名方括号标识符，
         * 安全网判不等价 → 整条语句静默回退（`select '{1,2}'::int[] from t`）。
         * 现在把 `[]` 整体当成一个标点 token，并在 spaceBetween 里强制紧贴。 */
        tokens.push({ type: 'punct', value: '[]', arraySuffix: true, nl: nl, start: i, end: i + 2 });
        nl = 0; i += 2; continue;
      }
    }

    /* 数字（含 0x1F / 0b1010 / 1_000 / 1e-10 / 1.5E+3） */
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      var jn = i, seenDot = false;
      if (ch === '0' && /[xXbBoO]/.test(sql[i + 1] || '')) {
        jn = i + 2;
        while (jn < n && /[0-9A-Fa-f_]/.test(sql[jn])) jn++;
      } else {
        while (jn < n) {
          var c = sql[jn];
          if (/[0-9]/.test(c) || c === '_') { jn++; continue; }
          /* `1..2` 这类写法（Hive range / 病态数字）两个点必须一起吃进同一个 token，
           * 否则会被切成 `1.` + `.2`，输出成 `1. .2`（N-21）。
           * 这种文本本身不是合法 SQL，整段保留原样最安全。 */
          if (c === '.' && sql[jn + 1] === '.') { jn += 2; seenDot = true; continue; }
          if (c === '.' && !seenDot) { seenDot = true; jn++; continue; }
          /* 科学计数法：e / E 后面可以跟 +/- 号（1e-10、2.5E+3） */
          if (c === 'e' || c === 'E') {
            var nx = sql[jn + 1] || '';
            var ny = sql[jn + 2] || '';
            var expOk = /[0-9]/.test(nx) || ((nx === '+' || nx === '-') && /[0-9]/.test(ny));
            if (expOk) {
              jn += 1;
              if (sql[jn] === '+' || sql[jn] === '-') jn++;
              continue;
            }
            break;
          }
          break;
        }
      }
      /* Hive / Spark 的数值后缀（P0-5）：`10L`(BIGINT)、`10S`(SMALLINT)、
       * `10Y`(TINYINT)、`1.5BD`(DECIMAL)。旧版只扫数字，把后缀当独立标识符，
       * 输出成 `10 L`，Hive 直接报语法错误。
       * 只在这些后缀字符"紧贴数字且后面不再是标识符字符"时并入，
       * 所以 `10 L`（列别名 L）仍然按两个 token 处理。 */
      if (jn > i) {
        var suf = sql.slice(jn, jn + 2).toUpperCase();
        if ((suf === 'BD') && !isWordPartAt(sql, jn + 2)) {
          jn += 2;
        } else {
          var s1 = sql.charAt(jn).toUpperCase();
          if ((s1 === 'L' || s1 === 'S' || s1 === 'Y') && !isWordPartAt(sql, jn + 1)) {
            jn += 1;
          }
        }
      }
      tokens.push({ type: 'number', value: sql.slice(i, jn), nl: nl, start: i, end: jn });
      nl = 0; i = jn; continue;
    }

    /* P0-7（2026-11-02 审计）：BigQuery 允许在 FROM/JOIN 里不加引号写
     * `my-project.mydataset.mytable`（项目名含连字符是官方推荐的命名方式）。
     * 旧词法器把 `-` 当减号，输出 `FROM my - project.dataset.table` ——
     * 这是一条会报错的 SQL，而且安全网看不出来（两边 token 一致）。
     *
     * 判据（只在 bigquery 方言下）：以标识符字符开头、含有 `.` 分隔的段、
     * 且**至少一段内部含连字符**。整体成为一个 word token，标 path=true，
     * 渲染时不改大小写、不在 `-` 两侧补空格。
     * 注意必须**不跨空白**：`a - b` 是两个表达式，不是路径。 */
    if (isBigQueryPath(sql, i, lexDialect)) {
      var bpEnd = scanBigQueryPath(sql, i);
      tokens.push({
        type: 'word', value: sql.slice(i, bpEnd),
        upper: sql.slice(i, bpEnd).toUpperCase(),
        noCase: true, path: true, bqPath: true, nl: nl, start: i, end: bpEnd
      });
      nl = 0; i = bpEnd; continue;
    }

    /* 标识符 / 关键字 */
    /* MySQL/MariaDB 里 `#` 一定是注释起点，不能当标识符起始字符（H-2）。
     * 这条必须与下面的 while 守卫成对出现，否则 `#` 打头时 jw 不前进 → 死循环。 */
    if (isWordStartAt(sql, i) && !(hashComment && ch === '#')) {
      var jw = i;
      /* hashComment 方言（MySQL/MariaDB）里 `#` 一定是注释起点，
       * 不能算标识符字符：否则 `select a#b, c from t` 的 `a#b` 会连成一个词，
       * 后面的 `, c from t` 继续当 SQL 重排，等于把注释变成了可执行代码（H-2）。
       * 这里按**码点**推进（A-02）：增补平面字母（𐐀 / 𝕏）占两个码元，
       * 逐码元推进会让高位代理项掉出 WORD_PART_RE，标识符被从中间切断。 */
      while (jw < n) {
        var wp = wordCharAt(sql, jw, true);
        if (!wp.ok) break;
        if (hashComment && wp.len === 1 && sql[jw] === '#') break;
        jw += wp.len;
      }
      var w = sql.slice(i, jw);
      /* `payload#>` / `j@>` 这类"运算符紧贴标识符"的写法（PG 最常见）：
       * 因为 # 与 @ 同时在 WORD_PART_RE 里（为了 #tmp / @@session），
       * 词扫描会把 `payload#` 整个吃掉，`>` 再单独成 token，输出变成
       * `payload# >`，语义直接改坏（P0-4，安全网会剥空格比较所以放行）。
       * 这里在 word 尾部剥掉运算符首字符，让 MULTI_OPS 分支接管。 */
      if (w.length > 1) {
        var tailCh = w.charAt(w.length - 1);
        var afterCh = sql.charAt(jw);
        if ((tailCh === '#' || tailCh === '@') && (afterCh === '>' || afterCh === '<')) {
          jw -= 1;
          w = sql.slice(i, jw);
        }
        /* `col${hiveconf:suffix}`：$ 在 WORD_PART_RE 里（为了 `a$` 这类标识符），
         * 于是 `col$` 被整个吃掉、后面 `{hiveconf:suffix}` 落进 punct 分支，
         * 输出成 `col$ { hiveconf : suffix }`——模板变量被拆散（H-4）。
         * 这里在 word 尾部回退一个 `$`，让上面的 ${...} 模板分支整体接管。 */
        if (tailCh === '$' && afterCh === '{') {
          jw -= 1;
          w = sql.slice(i, jw);
        }
      }
      /* @ / # 既是标识符字符又是 PG 运算符首字符（@>、#>、#>>）。
       * 只有当 @ / # 独立成词（后面不是标识符字符）且与后续字符拼成已知
       * 运算符时才按运算符切分，避免误伤 @x、@@session、#tmp（H-2）。 */
      if ((w === '@' || w === '#') && !isWordPartAt(sql, jw)) {
        var op2 = null;
        if (ch === '#' && sql[jw] === '>' && sql[jw + 1] === '>') op2 = '#>>';
        else if ((ch === '#' || ch === '@') && (sql[jw] === '>' || sql[jw] === '<')) op2 = ch + sql[jw];
        if (op2) {
          tokens.push({ type: 'punct', value: op2, nl: nl, start: i, end: i + op2.length });
          nl = 0; i += op2.length; continue;
        }
      }
      /* 字符串前缀：N'abc' / E'a\n' / X'1F' / B'01' / _utf8'..' / U&'..'
       * 与前缀后的引号合并成"一个字符串 token"，避免被插空格改语义。 */
      /* PostgreSQL 的 U&"..." / U&'...' Unicode 转义字面量（N-19）：
       * 前缀 U& 之后紧跟引号时必须整体成一个 token，
       * 否则输出成 `U & "d\0061ta"`，语义从"一个标识符"变成"U 与某字符串"。
       * 注意 `&` 不在 WORD_PART_RE 里，所以这里 w 只会是 `U`，要单独看后面的 `&`。 */
      if ((w === 'U' || w === 'u') && sql[jw] === '&' && (sql[jw + 1] === '"' || sql[jw + 1] === "'")) {
        var uq = sql[jw + 1];
        var uqRes = scanQuoted(sql, jw + 1, uq, backslash);
        if (!uqRes.closed) unterminated = true;
        tokens.push({ type: 'string', value: sql.slice(i, uqRes.end), nl: nl, start: i, end: uqRes.end });
        nl = 0; i = uqRes.end; continue;
      }
      /* P0-6 / P0-2（2026-11-02 审计）：
       *   · 前缀后可以跟单引号**或**双引号（BigQuery 的 r"..." 是合法原始字符串）；
       *   · 前缀是 E / r / b / rb / br 时，引号内容**必须**按反斜杠转义扫描 ——
       *     PG 的 E'a\'b' 里 \' 就是单引号，BigQuery 的 r'\d+' 里 \\ 就是反斜杠。
       *     旧实现无条件用当前方言的 backslash 开关，PG（backslash=false）下
       *     E'a\'b' 在第一个 \' 处就闭合，后半段被当代码重排。 */
      if (STRING_PREFIX_RE.test(w) && (sql[jw] === "'" || sql[jw] === '"')) {
        var pq = sql[jw];
        var pqBs = backslash || BS_PREFIX_RE.test(w);
        var pr = scanQuoted(sql, jw, pq, pqBs);
        if (!pr.closed) unterminated = true;
        tokens.push({ type: 'string', value: sql.slice(i, pr.end), nl: nl, start: i, end: pr.end });
        nl = 0; i = pr.end; continue;
      }
      tokens.push({ type: 'word', value: w, upper: w.toUpperCase(), nl: nl, start: i, end: jw });
      nl = 0; i = jw; continue;
    }

    /* 多字符运算符 */
    var matched = null;
    for (var m = 0; m < MULTI_OPS.length; m++) {
      if (sql.substr(i, MULTI_OPS[m].length) === MULTI_OPS[m] &&
          pgOpAllowed(sql, i, MULTI_OPS[m])) { matched = MULTI_OPS[m]; break; }
    }
    if (matched) {
      tokens.push({ type: 'punct', value: matched, nl: nl, start: i, end: i + matched.length });
      nl = 0; i += matched.length; continue;
    }

    /* 单字符符号 */
    tokens.push({ type: 'punct', value: ch, nl: nl, start: i, end: i + 1 });
    nl = 0; i++;

    /* 兜底：任何分支都不允许原地踏步（P0-1 的根因是这里没有保证）。
     * 正常走不到（单字符符号分支一定会 i++），留作回归保护。 */
    if (i === before) {
      tokens.push({ type: 'punct', value: ch, nl: nl, start: before, end: before + 1 });
      i = before + 1;
    }
  }

  if (unterminated) {
    tokens.unterminated = true;
    /* P1-6：具体类型与起点，供诊断引擎按类型报错、按位置标注。 */
    tokens.unterminatedKind = unterminatedKind || 'string';
    tokens.unterminatedStart = unterminatedStart;
  }
  return tokens;
}

/* 泛型类型关键字：后面的 <...> 是一个整体，内部的逗号 / 冒号不是分隔符 */
var GENERIC_TYPE_WORDS = {
  MAP: 1, STRUCT: 1, ARRAY: 1, UNIONTYPE: 1, UNION_TYPE: 1
};

/* 方言兼容性检测报告 §3.5：把合并后的泛型 token（head + tail）按 uppercase
 * 重排。**只改确定是类型名的词**：
 *   · 容器词（map/struct/array/uniontype）
 *   · TYPE_WORDS 里的标量类型名（string/int/bigint/int64/…）
 * 字段名（`struct<MyCol:int>` 的 MyCol、`struct<a int64>` 的 a）不在任何类型表里，
 * 一律保持用户原文 —— 这是与"无条件大写整个泛型内容"的关键区别。
 * 同一份结果被 sql() 路径（tokenText）和 DDL 路径（joinTokens / parseColumn）共用，
 * 保证两个命令对同一句 SQL 给出同样的类型大小写。 */
function recaseGenericType(head, tail, upper) {
  /* P0-8（2026-11-02 审计）：ClickHouse 的类型名大小写敏感，
   * `LowCardinality(String)` / `Nullable(UInt32)` / `Array(String)`
   * 一旦被大写就找不到对应类型（Unknown type）。这里整体跳过重排。 */
  if (/clickhouse/i.test(String(LEX.dialect || ''))) {
    return String(head || '') + String(tail || '');
  }
  var fix = function (w) {
    var W = w.toUpperCase();
    if (!GENERIC_TYPE_WORDS[W] && !TYPE_WORDS[W]) return w;
    return upper ? W : w.toLowerCase();
  };
  var h = String(head || '');
  var t = String(tail || '');
  return fix(h) + t.replace(/[A-Za-z_][A-Za-z0-9_]*/g, fix);
}

/* 比较运算里常见的"连接词"。出现在 < > 之间就说明这不是类型声明而是比较表达式。 */
var COMPARISON_WORDS = {
  AND: 1, OR: 1, NOT: 1, IS: 1, NULL: 1, IN: 1, BETWEEN: 1, LIKE: 1, RLIKE: 1, REGEXP: 1,
  THEN: 1, ELSE: 1, WHEN: 1, SELECT: 1, FROM: 1, WHERE: 1
};

/* 泛型词后面紧跟 "<" 时，还要区分「类型声明」与「比较运算」：
 *   类型声明: MAP<STRING,INT> / ARRAY<INT> / STRUCT<a:INT>  —— "<" 紧贴类型词
 *   比较运算: array < b, c > d   /  array < b AND c > d    —— "<" 前有空白
 * 只要求"`<` 后是标识符"是不够的（P0-6）：`SELECT array < b, c > d` 里
 * `<` 后面正是标识符 b，于是被误判成泛型、整段合并成一个 token，
 * 逗号（列分隔符）被吞掉，两列并成一列；`WHERE array < b AND c > d`
 * 更会被安全网打回成"整篇静默不格式化"（P0-7）。
 *
 * 现在的判定：
 *   1) `<` 紧贴类型词（map<...>，绝对主流写法）→ 按泛型；
 *   2) `<` 前有空白时，要求闭合 ">" 后面不是标识符（只能是 , ) ; EOF 之类）
 *      且 `< >` 之间没有 AND/OR/IS 这类比较连接词 → 才按泛型。
 * 这样 `map <string,int>`（少见的带空格写法）仍然支持，
 * 而 `array < b, c > d`、`array < b AND c > d` 一定走比较运算。 */
function looksLikeGenericOpen(tokens, ltIdx, typeIdx) {
  var n = tokens[ltIdx + 1];
  if (!n) return false;
  return n.type === 'word' || n.type === 'quoted';
}

/* 闭合 ">" 之后的 token 是否允许（不可能是"比较运算的右操作数"） */
function genericCloseOk(tokens, closeIdx) {
  var after = tokens[closeIdx + 1];
  if (!after) return true;                                  /* 语句结尾 */
  if (after.type !== 'word') return true;                    /* , ) ; ] 等 */
  /* 后面是词：只有 DDL 续写关键字才允许（comment 'x' / not null ...） */
  return !!DDL_BREAK[after.upper] || after.upper === 'NOT' || after.upper === 'NULL' ||
    after.upper === 'DEFAULT' || after.upper === 'PRIMARY' || after.upper === 'KEY';
}

/* 把 MAP<STRING,INT> / STRUCT<a:INT,b:STRING> / ARRAY<INT> 整体合并成一个 token。
 * 否则里面的 "," 会被当成列分隔符切开、":" 会被加空格，DDL 结构直接崩坏。
 * 嵌套泛型（struct<a:int,b:struct<x:string>>）按 < / > 计数配对；">>" 必须被
 * 词法层切成两个独立的 ">" 才能正确配对（见 MULTI_OPS 顺序）。 */
function markGenericTypes(tokens) {
  var out = [];
  var i = 0;

  while (i < tokens.length) {
    var tk = tokens[i];

    var isTypeWord = tk.type === 'word' && GENERIC_TYPE_WORDS[tk.upper];
    if (!isTypeWord) { out.push(tk); i++; continue; }

    /* 类型名后面可能空格，也可能紧贴；再后面必须是 "<"，且 "<" 后面紧跟标识符 */
    var j = i + 1;
    while (j < tokens.length && tokens[j].type === 'comment') j++;
    if (j >= tokens.length || tokens[j].type !== 'punct' || tokens[j].value !== '<' ||
        !looksLikeGenericOpen(tokens, j, i)) {
      out.push(tk); i++; continue;
    }

    /* 找到配对的 ">"（按 < / > 嵌套计数）。
     * tokenize 会把 ">>" 切成一个 MULTI_OPS 符号，这里把它当成两个 ">" 处理。 */
    var depth = 0, close = -1, closeConsumed = 0;
    for (var k = j; k < tokens.length; k++) {
      var t2 = tokens[k];
      if (t2.type !== 'punct') continue;
      if (t2.value === '<') depth++;
      else if (t2.value === '>') {
        depth--;
        if (depth === 0) { close = k; closeConsumed = 1; break; }
      } else if (t2.value === '>>') {
        depth -= 2;
        if (depth === 0) { close = k; closeConsumed = 2; break; }
        if (depth < 0) { close = -1; break; }
      }
    }
    if (close < 0) { out.push(tk); i++; continue; }   /* 没闭合就按原样处理 */

    /* "<" 前有空白（`array < b, c > d` / `array < b AND c > d`）时额外收紧：
     * `< >` 之间不能出现比较连接词，且闭合 ">" 后面不能紧跟标识符。
     * 紧贴写法（`map<string,int>`）不受这些限制，保持原有支持。 */
    if (tokens[i].end !== tokens[j].start) {
      if (!genericCloseOk(tokens, close)) { out.push(tk); i++; continue; }
      var bad = false;
      for (var cw = j + 1; cw < close; cw++) {
        if (tokens[cw].type === 'word' && COMPARISON_WORDS[tokens[cw].upper]) { bad = true; break; }
      }
      if (bad) { out.push(tk); i++; continue; }
    }

    var raw = tk.value;
    var inner = '';
    var prevTok = null;
    for (var m = j; m <= close; m++) {
      /* 中间有换行/注释说明不是纯类型声明，放弃合并 */
      if (tokens[m].type === 'comment') { inner = null; break; }
      /* L3-方言（方言兼容性检测报告 §3.1）：**合并时必须保留 token 之间的
       * 空白**，否则 BigQuery 的 `struct<a int64, b string>` 会被粘成
       * `struct<aint64,bstring>` —— 字段名 a 与类型 int64 拼成一个新标识符，
       * 安全网判定 token 不等价，整条 CREATE TABLE 静默回退。
       *
       * Hive/Spark 用冒号分隔（`struct<a:int>`）时冒号本身是独立 token，
       * 拼接无损；BigQuery 用空格分隔，空格在 token 化时被吃掉，所以必须补回来。
       *
       * 做法：只要原文这两个 token 之间**有**间隔，就补一个空格。这样
       *   `struct<a int64, b string>` → `struct<a int64, b string>`（原样）
       *   `map<string,int>`           → `map<string,int>`（原样，没有间隔就不补）
       * 作者自己的空格习惯被完整保留，既不会粘连也不会"纠正"用户。
       * （`map<string, int>` 这类带空格的写法以前会被压成 `map<string,int>`，
       *  现在同样保留后一个空格 —— 见方言检测报告 L1 条目。） */
      if (prevTok && tokens[m].start > prevTok.end) {
        inner += ' ';
      }
      inner += tokens[m].value;
      prevTok = tokens[m];
    }
    if (inner === null) { out.push(tk); i++; continue; }
    /* ">>" 合并了内外两层闭合，这里展开成两个 ">" 保持文本原样 */
    if (closeConsumed === 2) inner = inner.replace(/>>$/, '>>');

    out.push({
      type: 'word', value: raw + inner, upper: tk.upper,
      noCase: true, generic: true, genericHead: raw, genericTail: inner,
      nl: tk.nl, start: tk.start, end: tokens[close].end
    });
    i = close + 1;
  }

  return out;
}

/* P0-2（2026-11-05 复核）：`add jar /user/hive/lib/*.jar` 里的 `/*` 是
 * 路径中的"斜杠 + 通配符"，不是块注释起点。
 * 判据只看 i 处**紧贴的路径前缀**（回溯到行首或空白为止的那一段）：
 *   · 以 `/` 开头（`/user/hive/lib/`）→ 绝对路径；
 *   · 含 `://`（`hdfs://`、`s3://`、`file://`）→ 带 scheme 的 URI。
 * 其它情况（除法后面紧跟真正的块注释、行首的注释）一律按注释处理。 */
function isInsidePathPrefix(sql, i) {
  var s = i;
  while (s > 0 && !/\s/.test(sql.charAt(s - 1))) s--;
  var prefix = sql.slice(s, i);
  if (!prefix) return false;
  if (prefix.charAt(0) === '/') return true;
  return prefix.indexOf('://') >= 0;
}

/* 标记"路径片段"里的 token：ADD JAR /user/select/t.jar 这种未加引号的路径，
 * 里面的 user / select / table 绝不能当关键字大写，也绝不能触发行拆分。
 * 判定：一段空白分隔、内部完全紧邻的 token 串，满足下面任一条件就算路径：
 *   1) 以 "/" 开头（绝对路径 /tmp/x、/user/select/t）；
 *   2) 含 "://"（hdfs://、file://）；
 *   3) 含 "/" 且整段至少出现两个点号（xxx.jar / a/b.txt 这类）。
 * 这样 `a/b`、`3/4` 这类除法不会被误判成路径。 */
function markPathTokens(tokens) {
  var i = 0;
  while (i < tokens.length) {
    var start = i;
    var j = i;
    var slashCount = 0, dotCount = 0, hasScheme = false;
    var startsWithSlash = tokens[i].type === 'punct' && tokens[i].value === '/';

    while (j < tokens.length) {
      var tk = tokens[j];
      if (tk.type === 'comment') break;
      if (j > start) {
        var prev = tokens[j - 1];
        /* 前一个 token 与当前 token 之间有空白 → 这一段结束 */
        if (typeof prev.end !== 'number' || typeof tk.start !== 'number' || prev.end !== tk.start) break;
      }
      if (tk.type === 'punct') {
        if (tk.value === '/' || tk.value === '\\') slashCount++;
        if (tk.value === ':' && tokens[j + 1] && tokens[j + 1].type === 'punct' &&
            tokens[j + 1].value === '/' && tokens[j + 1].start === tk.end) hasScheme = true;
        if (tk.value === '.' ) dotCount++;
      }
      j++;
    }

    var isPath = j - start > 1 && slashCount > 0 &&
      (startsWithSlash || hasScheme || dotCount >= 2);

    if (isPath) {
      for (var k = start; k < j; k++) tokens[k].path = true;
    }
    i = j > start ? j : start + 1;
  }
  return tokens;
}

/* ============================== 空格规则 ============================== */

function spaceBeforeParen(prev, prevPrev, prevPrevPrev, prevPrevPrevPrev) {
  if (!prev) return false;
  if (prev.type === 'punct') {
    if (prev.value === '(' || prev.value === '[') return false;
    if (prev.value === '.') return false;
    return true;
  }
  /* P2-9（2026-11-05 复核）：**带引号的表名**后面紧跟列清单括号时也要留空格。
   * `insert into `table` (a) values (1)` 以前输出成 `INSERT INTO `table`(a)`，
   * 而同一份 SQL 里未加引号的表名会得到 `t (a)` —— 两种风格并存，
   * 也与 sql-formatter / sqlfluff 的输出习惯相反。判据与 word 分支的
   * "表名 + 列清单"完全一致：前一个词是位置词（INTO / TABLE / FROM …），
   * 或点号链的链头是位置词（db.table / db."table" / "db"."table"）。
   * 注意双引号在词法器里是 `string` 类型（不是 quoted），所以两种都要覆盖。 */
  var prevIsQuotedName = prev.type === 'quoted' ||
    (prev.type === 'string' && String(prev.value).charAt(0) === '"');
  if (prevIsQuotedName) {
    if (prevPrev) {
      if (prevPrev.type === 'punct' && prevPrev.value === '.') {
        var chainHead = prevPrevPrev;
        if (chainHead && (chainHead.type === 'word' || chainHead.type === 'quoted' ||
            chainHead.type === 'string') && NAME_POSITION[String(chainHead.upper || '').toUpperCase()]) return true;
        var pq4 = arguments[3];
        if (pq4 && pq4.type === 'word' && NAME_POSITION[pq4.upper]) return true;
        /* 更长的点号链看不到链头：**不加空格**。加空格虽然语义无损，
         * 但会把 `"db"."fn"(x)` 这类调用排成 `"db"."fn" (x)`，
         * 反而制造新的风格不一致；位置词链路（上面两条）已经覆盖
         * 需要留空格的表名场景。 */
        return false;
      }
      if (prevPrev.type === 'word' && NAME_POSITION[prevPrev.upper]) return true;
    }
    return false;
  }
  if (prev.type === 'word') {
    if (FUNCTION_WORDS[prev.upper]) {
      /* 方言兼容性检测报告 §3.4：BigQuery 的 `SELECT * REPLACE (a * 2 AS a)`
       * 是**列替换子句**，不是字符串函数 `REPLACE(x, y, z)`。
       * 判据：紧跟在 `*` 后面。字符串函数调用前面不可能是 `*`（那会变成乘法）。
       * 只有这一种形态留空格，其余仍按函数名紧贴。 */
      if (prev.upper === 'REPLACE' && prevPrev &&
          prevPrev.type === 'punct' && prevPrev.value === '*') return true;
      return false;
    }
    if (BUILTIN_FUNCS[prev.upper]) return false;
    if (/^\d/.test(prev.value)) return false;
    if (SPACE_BEFORE_PAREN[prev.upper]) {
      if (prevPrev && prevPrev.type === 'punct' && prevPrev.value === '.') return false;
      return true;
    }
    /* 约束词（KEY / INDEX / FOREIGN / CHECK）只有在 markKeywords 判定它
     * 确实是约束词（tk.keyword）时才加空格：`PRIMARY KEY (a)` / `INDEX idx (a)`。
     * 作函数名时 tk.keyword 为 false，走下面的「关键字紧跟括号不留空格」。 */
    if (prev.keyword && /^(KEY|INDEX|FOREIGN|CHECK)$/.test(prev.upper)) {
      if (prevPrev && prevPrev.type === 'punct' && prevPrev.value === '.') return false;
      return true;
    }
    /* P3-1（2026-11-02 审计）：`dbms_output.put_line(i)` 被输出成
     * `put_line (i)` —— 因为 `put_line` 不是 KEYWORDS 里的函数名，
     * 落到下面"名字后跟括号"的分支时，prevPrev 是 `.`，走点号链判据
     * 要求找到 FROM/INTO 之类的表位置词，找不到就 `return false`… 
     * 但实际是先命中了 `NAME_POSITION` 的兜底 `return true`。
     * 包/模式限定的函数调用（`pkg.fn(x)`、`db.fn(x)`）一定是调用，不是
     * 「表名 (列清单)」，所以点号链 **前面还有标识符** 时一律不留空格。
     *
     * P2-9b（2026-11-06 复核）：但「点号链前面还有标识符」这个判据过宽 ——
     * `INSERT INTO db.t (a)` 里 `db.t` 的链头就是 `db`，于是被当成函数调用，
     * 排成 `INSERT INTO db.t(a)`；而同一句写法加上引号（`db`.`t`）却能得到
     * 空格，两种风格并存。现在补上与下面引号名分支**完全一致**的判据：
     * 点号链的链头前一格（last4）是位置词时，这是「库名.表名 + 列清单」。
     * `dbms_output.put_line(i)` 的 last4 是 `begin`，不是位置词，仍紧贴。 */
    if (prevPrev && prevPrev.type === 'punct' && prevPrev.value === '.' &&
        prevPrevPrev && (prevPrevPrev.type === 'word' || prevPrevPrev.type === 'quoted')) {
      var pq4w = arguments[3];
      if (pq4w && pq4w.type === 'word' && NAME_POSITION[pq4w.upper]) return true;
      return false;
    }

    /* 关键字（函数名，如 explode/collect_set）紧跟括号时不留空格 */
    if (KEYWORDS[prev.upper]) return false;
    if (prevPrev) {
      /* 表名/别名之后紧跟括号：INSERT INTO t (a, b) / CREATE TABLE t (...)。
       * 库名限定（db.t）时 prevPrev 是 "."，要沿点号链再往前找，
       * 找到 INSERT/INTO/TABLE 这类位置词才算"表名后的列清单"（M-2）。
       * 完整链：INTO(4) db(3) .(2) t(1) ((0)——位置词在点号链头的前一格。 */
      if (prevPrev.type === 'punct' && prevPrev.value === '.') {
        if (prevPrevPrev && prevPrevPrev.type === 'word') {
          if (NAME_POSITION[prevPrevPrev.upper]) return true;
          /* db 前面还有位置词（last4）：INTO db.t ( 场景 */
          var ppp = arguments[3];
          if (ppp && ppp.type === 'word' && NAME_POSITION[ppp.upper]) return true;
        }
        /* 更长点号链（db.sch.t (a,b)）：token 窗口看不到链头。
         * 加空格在 SQL 里是无损的（`db.sch.t (a,b)` 与 `db.sch.t(a,b)` 等价，
         * 函数调用 `db.f (x)` 加空格同样合法），所以这里选择加空格，
         * 保证"库名.模式.表 (列清单)"的排版一致。 */
        return true;
      }
      if (prevPrev.type === 'word' && NAME_POSITION[prevPrev.upper]) return true;
      if (prevPrev.type === 'punct' && prevPrev.value === ')') return false;
    }
    /* 沿点号链更长的限定名（a.b.t）：cur.last 只记录了最近三个 token，
     * appendToken 把整串点号链的头词找出来这里看不到。走到这一格说明
     * 前面不是位置词，维持不加空格（保守，语义无损）。 */
    return false;
  }
  return false;
}

var WILDCARD_PREV_WORDS = { SELECT: 1, DISTINCT: 1, ALL: 1, EXCEPT: 1, VALUES: 1, RETURN: 1, COUNT: 1 };

/* 判断 "*" 是通配符（a.*、COUNT(*)、SELECT *）而不是乘号 */
function isWildcard(prev) {
  if (!prev) return true;
  if (prev.type === 'punct') {
    return prev.value === '(' || prev.value === ',' || prev.value === '.' || prev.value === '*';
  }
  if (prev.type === 'word') return !!WILDCARD_PREV_WORDS[prev.upper];
  return false;
}

/* 两个 token 在源文本里是否紧挨着（中间没有空白） */
function adjacent(prev, tok) {
  return !!(prev && tok &&
    typeof prev.end === 'number' && typeof tok.start === 'number' &&
    prev.end === tok.start);
}

/* 拼接后是否会意外造出注释起始符（"--" 或 "/*"）：
 * `a - -b` 里两个减号紧挨着输出就变成注释，语义直接毁掉，必须强制加空格。 */
function wouldStartComment(prev, tok) {
  if (!prev || !tok) return false;
  if (prev.type !== 'punct' || tok.type !== 'punct') return false;
  if (prev.value === '-' && tok.value === '-') return true;
  if (prev.value === '/' && tok.value === '*') return true;
  return false;
}

function spaceBetween(prev, tok, textSoFar, prevPrev, prevPrevPrev, prevPrevPrevPrev, lineHead) {
  if (!prev) return false;

  /* 路径片段内部一律不加空格（/tmp/x.jar、hdfs://ns/a 必须保持原样）。
   * P0-1（2026-11-05 复核）：但**跨段**时不能沿用它 —— markPathTokens 按空白
   * 分段，`add jar /a/x.jar /b/y.jar` 是两个独立的路径段，两段之间那两个
   * token 都带 path 标记，旧判据于是把段间的空白也吃掉，粘成
   * `/a/x.jar/b/y.jar`（一个不存在的路径）。段内 token 天然紧贴，
   * 所以按"是否相邻"判断即可。 */
  if (prev.path && tok.path) return !adjacent(prev, tok);

  /* 模板 token（`{{ x }}` / `{% if %}` / `{# c #}`）是一个不可拆的整体（H-1）。
   * 它与邻居之间是否留空格**完全照抄原文**：
   *   - 原文紧贴就紧贴（`{{tbl}}.col`、`{%- endif -%}` 这类写法不能被打散）；
   *   - 原文有空格就留一个空格（`FROM {{ tbl }}` 保持易读）。
   * 内外都不做任何改写。 */
  if (tok.template || prev.template) {
    if (tok.template && prev.template) return !adjacent(prev, tok);
    /* P3-5（2026-11-02 审计）：占位符紧贴在**运算符**后面时补空格。
     *     dt =#{dt}      → dt = #{dt}
     *     c >=#{x}       → c >= #{x}
     * 其余情况（紧贴标识符 / 点号 / 开括号 / 下标）照抄原文，
     * 因为那里是变量替换的一部分（`col${suffix}`、`t.#{col}`）。 */
    if (tok.template && adjacent(prev, tok) &&
        prev.type === 'punct' && /^(=|<>|!=|<=|>=|<|>|\+|-|\*|\/|%)$/.test(String(prev.value))) {
      return true;
    }
    return !adjacent(prev, tok);
  }

  /* 安全性优先：绝不能把相邻的两个 - 拼成 --（会被 SQL 当成行注释） */
  if (wouldStartComment(prev, tok)) return true;

  /* 方言兼容性检测报告 §3.5：`:` 剩下能走到这里的位置只有三种，
   * 都不是"二元运算符"，不能走 default 分支无条件加空格：
   *   · Snowflake 变体访问 `v:a.b` / `v:"k y"` / `t.v:a`
   *   · PG 数组切片 `a[1:2]` / `a[1:]`
   *   · 泛型里的类型声明 `struct<a:int>`（已被 markGenericTypes 合并，
   *     正常走不到这里，留作兜底）
   * 真正的绑定变量 `:name` / `:1` 已在词法器里被识别成**一个 token**（variable），
   * 不会产生裸 `:`。所以这里只做一件事：**完全保留作者原来的紧贴/留空**。
   * 旧实现走 default → `v:a.b` 被排成 `v : a.b`（Snowflake 接受这种写法，
   * 语义不变，但与官方文档写法不一致，纯属观感倒退）。 */
  if (tok.type === 'punct' && tok.value === ':') return !adjacent(prev, tok);
  if (prev.type === 'punct' && prev.value === ':') return !adjacent(prev, tok);

  /* 原本紧贴的"数字 + 标识符"（`10abc`）和"模板变量"（`col${hiveconf:suffix}`、
   * `${a}${b}`）必须继续保持紧贴：中间插一个空格会把一个 token 拆成两个
   *（`10abc` → `10 abc` 是两条不同的语法结构；`col${x}` 里 `${x}` 是变量替换的
   * 一部分，拆开就不再参与替换）。这类写法本身罕见，但只要用户写了，
   * 格式化就不该改它的结构。 */
  if (adjacent(prev, tok)) {
    if (prev.type === 'number' && tok.type === 'word') return false;
    /* L-10：`${b}` / `${hiveconf:dt}` 这类模板变量只在**紧贴标识符**时才保持紧贴
     * （`col${suffix}` 是变量替换的一部分）。紧贴在运算符后面时应当留空格：
     *     where b =${b}      → WHERE b = ${b}
     *     where c >=${x}     → WHERE c >= ${x}
     * 旧实现不看 prev 的类型，只要 tok.variable 就 return false，
     * 于是 `=` 与 `${b}` 被粘成 `=${b}`，读起来像另一个运算符。 */
    if (tok.variable) {
      if (prev.type === 'word' || prev.type === 'number' || prev.type === 'quoted') return false;
      if (prev.type === 'punct' && (prev.value === '.' || prev.value === '(' || prev.value === '[')) return false;
      /* P3-5（2026-11-02 审计）：逗号后面交给下面的统一规则判断。
       * 旧实现无条件 return true，于是
       *       SELECT a
       *             , $2        ← 占位符多了空格
       *             ,b          ← 普通列没有
       * 同一份列清单里两种风格。现在两者都由「行首逗号后不加空格」决定。 */
      if (!(prev.type === 'punct' && prev.value === ',')) return true;
    }
  }

  if (tok.type === 'punct') {
    switch (tok.value) {
      /* M-4：PG 数组类型后缀 `[]` 永远紧贴前面的类型名（`int[]`、`text[]`）。 */
      case '[]':
        return false;
      case ')': case ']': case ',': case ';': case '.': case '::':
        return false;
      case '(':
        return spaceBeforeParen(prev, prevPrev, prevPrevPrev, prevPrevPrevPrev);
      case '[':
        /* T-SQL 方括号标识符 `[col]` 紧跟关键字时要有空格（`SELECT [abc]`），
         * 但数组下标 `a[1]` 不能拆开。未闭合的 `[`（`SELECT [abc`）也要留空格，
         * 否则会粘成 `SELECT[abc` 这种怪串（N-20）。
         *
         * 例外（M1）：ARRAY/MAP/STRUCT 这些「类型词 + 下标」的写法
         * （`array['a']`、`map['k']`）绝对不能插空格。一旦插了，输出变成
         * `ARRAY ['a']`，而 `[` 与前面不再紧贴，重新词法分析时它会被当成
         * **方括号标识符**（一个 quoted token），token 流从
         * `word:ARRAY punct:[ string:'a' punct:]` 变成 `word:ARRAY quoted:['a']`，
         * 安全网判不等价 → 整个文档静默不格式化（用户按了快捷键「没反应」）。
         * 它在 PG 里其实仍是合法写法，所以这类假阴性尤其难自查。 */
        if (prev && prev.type === 'word' &&
            (FUNCTION_WORDS[prev.upper] || GENERIC_TYPE_WORDS[prev.upper])) return false;
        return !!(prev && prev.type === 'word' && prev.keyword);
      case '+': case '-':
        /* 一元正负号：紧贴前一个开括号/逗号/运算符；其余情况（SELECT -1、
         * a * -1、WHERE -1）都要留一个空格，避免拼成 "SELECT-1"、"+ -2" 这类怪串 */
        if (tok.unary) {
          return !(prev.type === 'punct' &&
            (prev.value === '(' || prev.value === '[' || prev.value === '.' || prev.value === '::'));
        }
        return true;
      case '~':
        /* PostgreSQL 一元按位取反（M8）：`~1` / `~col` 必须紧贴，
         * 二元正则匹配 `a ~ 'x'` 必须留空格。判据见 markUnary。 */
        if (tok.unary) {
          return !(prev.type === 'punct' &&
            (prev.value === '(' || prev.value === '[' || prev.value === '.' || prev.value === '::'));
        }
        return true;
      case '/': case '%':
        /* 除号/取余：保持原作者写法（/tmp/x.jar 这类路径不能被拆开） */
        return !adjacent(prev, tok);
      case '*':
        if (isWildcard(prev)) {
          return !(prev && prev.type === 'punct' && (prev.value === '(' || prev.value === ',' || prev.value === '.'));
        }
        return true;
      /* L3b（第三轮审计）：占位符 `?` 是**操作数**，不是运算符 ——
       * `IN (?, ?)` 里它紧跟 `(`，不该被塞进空格（旧输出 `IN ( ?, ?)`）。
       * 前面是运算符/关键字时仍要留空格（`= ?`、`LIMIT ?`）。 */
      case '?':
        return !(prev.type === 'punct' &&
          (prev.value === '(' || prev.value === '[' || prev.value === '.' || prev.value === '::'));
      default:
        return true;
    }
  }

  if (prev.type === 'punct') {
    switch (prev.value) {
      case '(': case '[': case '.': case '::':
        return false;
      case ',': {
        /* 行首逗号（`,col` 风格）后不留空格。
         *
         * P-02（2026-11-04 复核）：调用方如果传入了行首状态 `lineHead`
         * （true = 这一行到目前为止只有一个逗号），直接用它判断，
         * **不再扫描 textSoFar**。
         *
         * 为什么必须这么做：下面的 `textSoFar.charAt(...)` 会把 `+=` 拼出来的
         * V8 cons string 强制扁平化（O(行长)）。一条 5 万项的 IN 列表有 5 万个逗号，
         * 每次扁平化整行 → 整行 O(n²)：实测 4 万项 2.5 s，足以卡死扩展宿主
         * 主线程（formatOnSave 750 ms 预算直接超时）。
         * 维护行首状态后复杂度回到 O(n)。 */
        if (lineHead === true || lineHead === false) {
          return lineHead === false;
        }
        /* 兜底路径（少数调用点没传行首状态）：只在一个**定长窗口**里判断
         * "这一行到目前为止是不是只有一个逗号"。语义不变：
         * 输出永不在行尾留空白，所以只要逗号后面还有代码，第一个非空白字符
         * 必然紧跟在很短的窗口内；超过 64 字符还全是空白/逗号的情况只能是
         * 病态输入，那时保守地"加空格"。 */
        var i0 = 0;
        var n0 = textSoFar.length;
        var probe = n0 < 64 ? n0 : 64;
        while (i0 < probe && (textSoFar.charAt(i0) === ' ' || textSoFar.charAt(i0) === '\t')) i0++;
        if (i0 >= probe) return true;
        if (textSoFar.charAt(i0) !== ',') return true;
        for (var k0 = i0 + 1; k0 < probe; k0++) {
          var c0 = textSoFar.charAt(k0);
          if (c0 !== ' ' && c0 !== '\t' && c0 !== '\n' && c0 !== '\r') return true;
        }
        if (probe < n0) return true;    /* 窗口之后还有内容 → 不是"只有逗号" */
        return false;           /* 整段就是 ", " → 行首逗号，后面不留空格 */
      }
      case '+': case '-':
        return !prev.unary || !!tok.path;
      case '~':
        /* 一元 `~` 之后紧贴操作数（`~1` / `~col`）；二元 `~` 之后留空格。 */
        return !prev.unary;
      case '/': case '%':
        return !adjacent(prev, tok);
      default:
        return true;
    }
  }

  if (prev.type === 'comment') return true;
  return true;
}

/* ============================== 行宽工具 ============================== */

/* 宽字符宽度表：扁平存放成 [start, end, start, end, ...]，升序不重叠。
 *
 * 判定规则（按**字体实际渲染**推出，不是照抄 Unicode 属性）：
 *   宽 = EA(W|F)  ∪  ( EA(A) ∧ Consolas 未覆盖 )
 *
 * 为什么不是「EA=A 一律 2 列」：
 *   VS Code 默认 fontFamily = "Consolas, Courier New, monospace"，
 *   Consolas 自己就带 ≥ ≤ ≠ × ÷ → ← — – … ± § ° ① Ω 以及 Latin-1 重音字母，
 *   这些字符按 Consolas 的 0.55em 渲染，恰好 = 1 个 ASCII 列。
 *   把它们当 2 列会**反向**把 AS 推歪（上一版就是这么错的）。
 *
 * 为什么汉字算 2 列而不是 1.818：
 *   Consolas 不含 CJK 字形，回落到系统字体（Windows：微软雅黑 / 宋体），
 *   汉字 = 1.0em，Consolas ASCII = 0.55em，比值 = 1.8182。
 *   等宽字体里 ASCII 一列 = 0.55em，所以一个汉字恰好占 1.818 个"列宽"，
 *   四舍五入到 2 列；连续汉字会累积 1.8 列/字的误差，但**同一行内**只要
 *   "中文个数相同"，对齐就是精确的（见 alignAsGroup 的均摊处理）。
 *
 * 表由 fontTools 读取本机 Consolas + Python unicodedata（Unicode 16.0.0）生成，
 * 脚本见 audit/_gen_wide.py，共 192 段 / 320911 个码位。
 *
 * 已知取舍：换成纯等宽中文字体（更纱黑体 / Sarasa Mono SC 等）时，
 * 汉字仍是 2 列、ASCII 仍是 1 列，本表同样正确；
 * 但换成「西文 1 : 中文 1.6」一类字体时会有偏差 —— 见 visLen 的注释。 */
var WIDE_RANGES = [
  0x1100, 0x115F, 0x2025, 0x2025, 0x2027, 0x2027, 0x2035, 0x2035, 0x203B, 0x203B, 0x2103, 0x2103, 0x2109, 0x2109, 0x2121, 0x2121,
  0x212B, 0x212B, 0x2160, 0x216B, 0x2170, 0x2179, 0x2189, 0x2189, 0x2196, 0x2199, 0x21B8, 0x21B9, 0x21D2, 0x21D2, 0x21D4, 0x21D4,
  0x21E7, 0x21E7, 0x2200, 0x2200, 0x2203, 0x2203, 0x2207, 0x2208, 0x220B, 0x220B, 0x221D, 0x221D, 0x2220, 0x2220, 0x2223, 0x2223,
  0x2225, 0x2225, 0x2227, 0x2228, 0x222A, 0x222A, 0x222C, 0x222C, 0x222E, 0x222E, 0x2234, 0x2237, 0x223C, 0x223D, 0x224C, 0x224C,
  0x2252, 0x2252, 0x2266, 0x2267, 0x226A, 0x226B, 0x226E, 0x226F, 0x2282, 0x2283, 0x2286, 0x2287, 0x2295, 0x2295, 0x2299, 0x2299,
  0x22A5, 0x22A5, 0x22BF, 0x22BF, 0x2312, 0x2312, 0x231A, 0x231B, 0x2329, 0x232A, 0x23E9, 0x23EC, 0x23F0, 0x23F0, 0x23F3, 0x23F3,
  0x2474, 0x24E9, 0x24F5, 0x24FE, 0x2581, 0x2583, 0x2585, 0x2587, 0x2589, 0x258B, 0x258D, 0x258F, 0x2594, 0x2595, 0x25A3, 0x25A9,
  0x25B3, 0x25B3, 0x25B6, 0x25B7, 0x25BD, 0x25BD, 0x25C0, 0x25C1, 0x25C6, 0x25C8, 0x25CE, 0x25CE, 0x25D0, 0x25D1, 0x25E2, 0x25E5,
  0x25EF, 0x25EF, 0x25FD, 0x25FE, 0x2605, 0x2606, 0x2609, 0x2609, 0x260E, 0x260F, 0x2614, 0x2615, 0x261C, 0x261C, 0x261E, 0x261E,
  0x2630, 0x2637, 0x2648, 0x2653, 0x2661, 0x2661, 0x2664, 0x2664, 0x2667, 0x2669, 0x266C, 0x266D, 0x267F, 0x267F, 0x268A, 0x268F,
  0x2693, 0x2693, 0x269E, 0x269F, 0x26A1, 0x26A1, 0x26AA, 0x26AB, 0x26BD, 0x26BF, 0x26C4, 0x26E1, 0x26E3, 0x26E3, 0x26E8, 0x26FF,
  0x2705, 0x2705, 0x270A, 0x270B, 0x2728, 0x2728, 0x273D, 0x273D, 0x274C, 0x274C, 0x274E, 0x274E, 0x2753, 0x2755, 0x2757, 0x2757,
  0x2795, 0x2797, 0x27B0, 0x27B0, 0x27BF, 0x27BF, 0x2B1B, 0x2B1C, 0x2B50, 0x2B50, 0x2B55, 0x2B59, 0x2E80, 0x2E99, 0x2E9B, 0x2EF3,
  0x2F00, 0x2FD5, 0x2FF0, 0x303E, 0x3041, 0x3096, 0x3099, 0x30FF, 0x3105, 0x312F, 0x3131, 0x318E, 0x3190, 0x31E5, 0x31EF, 0x321E,
  0x3220, 0xA48C, 0xA490, 0xA4C6, 0xA960, 0xA97C, 0xAC00, 0xD7A3, 0xE000, 0xFAFF, 0xFE00, 0xFE19, 0xFE30, 0xFE52, 0xFE54, 0xFE66,
  0xFE68, 0xFE6B, 0xFF01, 0xFF60, 0xFFE0, 0xFFE6, 0xFFFD, 0xFFFD, 0x16FE0, 0x16FE4, 0x16FF0, 0x16FF1, 0x17000, 0x187F7, 0x18800, 0x18CD5,
  0x18CFF, 0x18D08, 0x1AFF0, 0x1AFF3, 0x1AFF5, 0x1AFFB, 0x1AFFD, 0x1AFFE, 0x1B000, 0x1B122, 0x1B132, 0x1B132, 0x1B150, 0x1B152, 0x1B155, 0x1B155,
  0x1B164, 0x1B167, 0x1B170, 0x1B2FB, 0x1D300, 0x1D356, 0x1D360, 0x1D376, 0x1F004, 0x1F004, 0x1F0CF, 0x1F0CF, 0x1F100, 0x1F10A, 0x1F110, 0x1F12D,
  0x1F130, 0x1F169, 0x1F170, 0x1F1AC, 0x1F200, 0x1F202, 0x1F210, 0x1F23B, 0x1F240, 0x1F248, 0x1F250, 0x1F251, 0x1F260, 0x1F265, 0x1F300, 0x1F320,
  0x1F32D, 0x1F335, 0x1F337, 0x1F37C, 0x1F37E, 0x1F393, 0x1F3A0, 0x1F3CA, 0x1F3CF, 0x1F3D3, 0x1F3E0, 0x1F3F0, 0x1F3F4, 0x1F3F4, 0x1F3F8, 0x1F43E,
  0x1F440, 0x1F440, 0x1F442, 0x1F4FC, 0x1F4FF, 0x1F53D, 0x1F54B, 0x1F54E, 0x1F550, 0x1F567, 0x1F57A, 0x1F57A, 0x1F595, 0x1F596, 0x1F5A4, 0x1F5A4,
  0x1F5FB, 0x1F64F, 0x1F680, 0x1F6C5, 0x1F6CC, 0x1F6CC, 0x1F6D0, 0x1F6D2, 0x1F6D5, 0x1F6D7, 0x1F6DC, 0x1F6DF, 0x1F6EB, 0x1F6EC, 0x1F6F4, 0x1F6FC,
  0x1F7E0, 0x1F7EB, 0x1F7F0, 0x1F7F0, 0x1F90C, 0x1F93A, 0x1F93C, 0x1F945, 0x1F947, 0x1F9FF, 0x1FA70, 0x1FA7C, 0x1FA80, 0x1FA89, 0x1FA8F, 0x1FAC6,
  0x1FACE, 0x1FADC, 0x1FADF, 0x1FAE9, 0x1FAF0, 0x1FAF8, 0x20000, 0x2FFFD, 0x30000, 0x3FFFD, 0xE0100, 0xE01EF, 0xF0000, 0xFFFFD, 0x100000, 0x10FFFD
];

/* 二分查找 code 是否落在 WIDE_RANGES 的某一段里。
 * 段数 192 → 最多 8 次比较，相对每行几十个字符的 visLen 完全可忽略。 */
function inWideRange(code) {
  var lo = 0, hi = (WIDE_RANGES.length >> 1) - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    var s = WIDE_RANGES[mid * 2], e = WIDE_RANGES[mid * 2 + 1];
    if (code < s) hi = mid - 1;
    else if (code > e) lo = mid + 1;
    else return true;
  }
  return false;
}

/* 该码位渲染多少「列」。
 * 返回值是**整数列数**：ASCII 与 Consolas 覆盖区 = 1，CJK / 全角 / 未覆盖 = 2。
 * 真实的 1.818 比值由 alignAsPad / paddingFor 在**对齐时**用小数补偿，
 * 这样既保持现有所有基于 visLen 的排版逻辑不变，又能在中文行之间精确对齐。 */
function isWideChar(code) {
  if (code < 0x80) return false;          /* ASCII 快速通道：绝不可能宽 */
  return inWideRange(code);
}

/* C-06（2026-11-04 复核）：Tab 的实际列宽必须跟随 editor.tabSize。
 *
 * 旧实现把 `\t` 硬编码成 4 列。bracket_char=false 时缩进本身就是 Tab
 * （`this.unit = '\t'`），于是 tabSize=8 的项目里每层缩进只算 4 列 ——
 * 折行判断低估 50%，行会超出屏幕；tabSize=2 时反过来高估一倍、过早折行。
 * 宽度函数是纯函数且带缓存，所以换 Tab 宽度时同步清缓存。 */
var TAB_WIDTH = 4;

function setTabWidth(v) {
  var w = (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : 4;
  if (w < 1) w = 1;
  if (w > 16) w = 16;
  if (w !== TAB_WIDTH) {
    TAB_WIDTH = w;
    clearWidthCache();
  }
}

function charWidth(ch) {
  if (ch === '\t') return TAB_WIDTH;
  var code = ch.charCodeAt(0);
  /* 代理对（emoji / 扩展 B）：占 2 列 */
  if (code >= 0xD800 && code <= 0xDBFF) return 2;
  if (code >= 0xDC00 && code <= 0xDFFF) return 0;
  return isWideChar(code) ? 2 : 1;
}

/* visLen 是纯函数（只依赖 s 与 CJK_WIDTH_RATIO），缓存命中必然与重算相同。
 * 排版阶段同一行文本会被反复计算（对齐 / 折行 / 宽度判断各算一次）。
 * 达到上限后整体清空：格式化是短时突发，整体清空比 LRU 更省。 */
var VISLEN_CACHE = new Map();
var VISLEN_CACHE_MAX = 8192;

function clearWidthCache() { VISLEN_CACHE.clear(); }

function visLen(s) {
  var hit = VISLEN_CACHE.get(s);
  if (hit !== undefined) return hit;
  var n = 0;
  for (var i = 0; i < s.length; i++) n += charWidth(s.charAt(i));
  if (VISLEN_CACHE.size >= VISLEN_CACHE_MAX) VISLEN_CACHE.clear();
  VISLEN_CACHE.set(s, n);
  return n;
}

/* 汉字/全角字符相对一个 ASCII 列的真实渲染宽度。
 *
 * 取值依据（本机实测，见 audit/_measure2.py）：
 *   Consolas  ASCII 'M' = 0.550 em
 *   微软雅黑  汉字 '中' = 1.000 em
 *   → 比值 = 1.000 / 0.550 = 1.81818…
 * 换成纯等宽中文字体（更纱黑体 / Sarasa Mono SC / 等距更纱黑体）时汉字恰好
 * 占 2 个 ASCII 列，把 snugSql.cjk_width 设成 2 即可。
 *
 * 为什么不能直接用 2：每多算 0.1818 列/汉字，一行 6 个汉字就偏 1.09 列，
 * AS 会在屏幕上歪一格 —— 这正是用户反馈的现象。 */
var CJK_WIDTH_RATIO = 1.81818;
var DEFAULT_CJK_RATIO = 1.81818;

/* 合法的比值区间必须与 package.json 的说明一致：(0, 4]。 */
var CJK_RATIO_MIN = 0;
var CJK_RATIO_MAX = 4;

function setCjkRatio(r) {
  var v = Number(r);
  if (!isFinite(v)) return;
  /* B-03：边界必须含 4。旧实现是开区间 (0.5, 4)，
   * 而 package.json:150 明确写「取值 (0, 4]」——
   * 用户按文档把 cjk_width 设成 4（等宽中文字体的一种极端配置）时
   * 扩展接受、内核静默丢弃，配置看起来「没生效」。 */
  if (v > CJK_RATIO_MIN && v <= CJK_RATIO_MAX) {
    if (v !== CJK_WIDTH_RATIO) {
      CJK_WIDTH_RATIO = v;
      clearWidthCache();   /* 小数宽度变了，缓存的整数宽度仍有效，但统一清掉更稳 */
    }
  }
}

/* 小数的显示宽度：ASCII 与 Consolas 覆盖区 = 1，宽字符（CJK/全角/未覆盖）= CJK_WIDTH_RATIO。 */
function visWidthF(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch === '\t') { n += TAB_WIDTH; continue; }
    var code = ch.charCodeAt(0);
    if (code >= 0xD800 && code <= 0xDBFF) { n += CJK_WIDTH_RATIO; continue; }
    if (code >= 0xDC00 && code <= 0xDFFF) continue;
    n += isWideChar(code) ? CJK_WIDTH_RATIO : 1;
  }
  return n;
}

/* 等价于 rtrim(String.prototype)，但避免每次都进正则引擎。
 *
 * 字符集必须与 JS 的 \s 完全一致：
 *   [ \t\n\v\f\r \u00A0 \u1680 \u2000-\u200A \u2028 \u2029 \u202F \u205F \u3000 \uFEFF ]
 * 少认或多认任何一个都会造成输出差异，因此逐码位显式列出，
 * 并由 audit/_opt_equiv.js 对 0x0000-0xFFFF 全码位做等价性对拍。 */
function isSpaceCode(c) {
  if (c === 32 || (c >= 9 && c <= 13)) return true;          /* 空格 \t \n \v \f \r */
  if (c < 128) return false;
  if (c === 0xA0 || c === 0x1680) return true;
  if (c >= 0x2000 && c <= 0x200A) return true;
  if (c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F) return true;
  if (c === 0x3000 || c === 0xFEFF) return true;
  return false;
}

function rtrim(s) {
  var end = s.length;
  while (end > 0 && isSpaceCode(s.charCodeAt(end - 1))) end--;
  return end === s.length ? s : s.slice(0, end);
}

/* P2-7：线性版 `replace(/^\s+/, "")`。
 * `/^\s+/` 在长前导空白上会先吞掉整段再回溯确认，代价与空白长度成正比 ——
 * 但 `\s+$` 更糟：它从**每个**位置尝试，遇到长空白串就是 O(n²)。
 * 这两个 helper 都只做一次从头/从尾的单向扫描。 */
function ltrim(s) {
  var start = 0;
  while (start < s.length && isSpaceCode(s.charCodeAt(start))) start++;
  return start === 0 ? s : s.slice(start);
}

/* 等价于 .replace(/[ \t]+$/, '') */
function rstripSpTab(s) {
  var end = s.length;
  while (end > 0) {
    var c = s.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return end === s.length ? s : s.slice(0, end);
}

function spaces(n) {
  if (n <= 0) return '';
  return new Array(n + 1).join(' ');
}

/* 续行缩进：在当前缩进基础上再加 4 列空格 */
function continuationIndent(ind) {
  return ind + '    ';
}

/* 找到行内引号外、括号深度 0 的最后一个 " AS "（返回 AS 前空格的索引）
 * 大小写不敏感：lowercase 模式下整行都是 " as "，旧版只认 " AS " 导致对齐整组失效。 */
function findTopLevelAs(text) {
  var depth = 0, quote = null, found = -1;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (quote) {
      if (ch === '\\' && LEX.backslash !== false) { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      /* 行尾注释与块注释整体跳过：注释里的 " as " 不是别名分隔符。
       * 旧版只看空格与括号深度，于是 `…, b -- use as filter here` 里的 `as`
       * 被当成真正的 AS，对齐时按它的列号算目标列 —— 要么整篇静默回退，
       * 要么把真正的 AS 推到奇怪的位置（H-7）。 */
      if (ch === '-' && text.charAt(i + 1) === '-') return found;
      if (ch === '/' && text.charAt(i + 1) === '*') {
        var close = text.indexOf('*/', i + 2);
        if (close < 0) return found;
        i = close + 1;
        continue;
      }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { if (depth > 0) depth--; continue; }
    if (depth === 0 && ch === ' ' && /^\sas\s$/i.test(text.substr(i, 4))) found = i;
  }
  return found;
}

/* 找到行内"真正的"行尾注释起点。
 * 必须跳过：引号内的 --、块注释 /* ... *\/ 内部的 --（旧版会把块注释里的 -- 当行尾注释，
 * 折行时把块注释拦腰截断）。 */
  function findCommentPos(text, hashComment, backslash) {
  var quote = null;
    /* backslash / hashComment 未显式传入时沿用当前词法上下文（LEX）。
     * 旧版把反斜杠恒当转义，于是 PG 的 `'C:\'` 路径字符串会把结尾引号吃掉，
     * 引号状态一路错下去、后面真正的 `--` 再也找不到（H-7 / P2-12）。 */
    var bs = backslash === undefined ? LEX.backslash === true : backslash === true;
    var hc = hashComment === undefined ? LEX.hashComment === true : hashComment === true;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (quote) {
        if (bs && ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    /* M12（第二轮审计）：`#{name}` 是 MyBatis 占位符，`%(name)s` 是 psycopg2 占位符，
     * `{name}` 是 str.format 占位符 —— 都不是注释起点。
     * 旧实现只认 `--` 和 `#`，于是 `WHERE a = #{a}` 里的 `#` 被判成行尾注释，
     * alignComments 把后面几行的 `#` 当成"注释列"来对齐，凭空多出两个空格
     * （`AND b =   #{b}`）；convertCommaLocation 也会把逗号拼到它后面。 */
    if (matchPlaceholder(text, i)) continue;
    if (ch === '/' && text.charAt(i + 1) === '*') {
      var close = text.indexOf('*/', i + 2);
      if (close < 0) return -1;          /* 未闭合块注释：整行当代码 */
      i = close + 1;
      continue;
    }
    if (ch === '-' && text.charAt(i + 1) === '-') return i;
    /* M3：hashComment 方言（MySQL/MariaDB）里，词法器把 `#` 之后**一律**当注释
     * （见 tokenizeRaw 的 hashComment 分支）。这里必须与词法器保持一致，
     * 否则 `select a, b #note` 这种行会被判成"没有注释"，
     * convertCommaLocation 就把逗号拼到注释**后面**（`b #note,`）——
     * 逗号成了注释内容，安全网发现 token 不等价后整篇回退，用户看到「按了没反应」。
     * 旧版的额外条件（`#` 后必须是空白）正是这个 bug 的来源。
     * 注：T-SQL 的 `#tmp` 走 hashMode='ident'，此时 hashComment 为 false，不会进来。 */
    if (hc && ch === '#') return i;
  }
  return -1;
}

/* 标记一元运算符（+、- 与 ~），四处渲染路径共用同一判据。
 *
 * `~` 在 PostgreSQL 里是**双重身份**：一元按位取反 `~1` / `~col`，
 * 二元正则匹配 `a ~ 'x'`。旧实现完全没管它，一律按二元插空格，
 * `select ~1 from t` 输出成 `SELECT ~ 1`——一元运算符被拆开，语义改坏（M8）。
 *
 * 判据与 +/- 一致：前面没有 token、前面是运算符/开括号、或前面是
 * 值位置关键字（SELECT / WHERE / AND / CASE ...）→ 一元。 */
function markUnary(tk, last) {
  if (tk.type !== 'punct') return;
  if (tk.value !== '+' && tk.value !== '-' && tk.value !== '~') return;
  /* L3d（第三轮审计）：`case … end - 1` 里的 `-` 被当成一元负号，
   * 输出成 `END -1`。判据要补一条：`END` 是**表达式结束**（值），
   * 不是运算符 —— `END - 1` 是二元减法。
   * 同理 ELSE/NULL/TRUE/FALSE 后面的 `-` 也是二元。
   * 旧判据只看"前一个 token 是不是 ')' / ']' 或其他 punct"，END 是 word，落空。 */
  var ENDS_EXPR_WORDS = { END: 1, NULL: 1, TRUE: 1, FALSE: 1 };
  tk.unary = !last ||
    (last.type === 'punct' && last.value !== ')' && last.value !== ']') ||
    (last.type === 'word' && UNARY_WORDS[last.upper] === 1 && !ENDS_EXPR_WORDS[last.upper]);
}

/* 用统一的空格规则重排一行文本（不做大小写、不做对齐） */
function normalizeLine(text) {
  var toks = tokenize(text);
  var out = '';
  var last = null, last2 = null, last3 = null, last4 = null;
  var headFirst = '', headCount = 0;

  for (var i = 0; i < toks.length; i++) {
    var tk = toks[i];

    if (tk.type === 'comment') {
      out = rtrim(out);
      if (out !== '') out += ' ';
      out += tk.value;
      if (/\S/.test(tk.value)) {
        if (headCount === 0) headFirst = String(tk.value).charAt(0);
        headCount++;
      }
      /* 注释占位：让注释后紧跟的 token 正常加空格（M-3，同 renderInline） */
      last = { type: 'word', upper: '', value: tk.value, commentPlaceholder: true };
      last2 = null;
      last3 = null;
      last4 = null;
      continue;
    }

    markUnary(tk, last);

    var space = false;
    if (out !== '') {
      space = spaceBetween(last, tk, out, last2, last3, last4,
        headCount === 1 && headFirst === ',');
    }
    if (space) out += ' ';
    var _tt = tk.value;
    out += _tt;
    if (_tt.length > 0) {
      var _hc = _tt.charCodeAt(0);
      if (_hc !== 32 && _hc !== 9) {
        if (headCount === 0) headFirst = _tt.charAt(0);
        headCount++;
      }
    }
    last4 = last3;
    last3 = last2;
    last2 = last;
    last = tk;
  }

  return rtrim(out);
}

Formatter.prototype.normalizeLines = function (lines) {
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (ln.text === '') continue;
    if (ln.kind === 'comment' || ln.kind === 'commentTail') continue;
    ln.text = normalizeLine(ln.text);
  }
  return lines;
};

/* ============================== 子句识别 ============================== */

  /* STRAIGHT_JOIN 是 MySQL 的 JOIN 变体，必须与 JOIN 同样断行（N-6）。 */
  var JOIN_WORDS = { LEFT: 1, RIGHT: 1, FULL: 1, INNER: 1, CROSS: 1, OUTER: 1, SEMI: 1, ANTI: 1, NATURAL: 1 };

/* 子句起始词的全集：用来判断"AS 后面这个词到底是别名还是子查询起点"。
 * `select a as window, ...` 里 window 之后是逗号 → 别名；
 * `create view v as select ...` 里 select 之后是列/`*` → 子句。 */
var CLAUSE_START_WORDS = {
  SELECT: 1, WITH: 1, FROM: 1, WHERE: 1, GROUP: 1, ORDER: 1, HAVING: 1, LIMIT: 1,
  UNION: 1, EXCEPT: 1, MINUS: 1, INTERSECT: 1, WINDOW: 1, QUALIFY: 1, ON: 1,
  JOIN: 1, LEFT: 1, RIGHT: 1, FULL: 1, INNER: 1, CROSS: 1, NATURAL: 1, LATERAL: 1,
  SORT: 1, DISTRIBUTE: 1, CLUSTER: 1, INSERT: 1, UPDATE: 1, DELETE: 1, VALUES: 1
};

var STATEMENT_WORDS = {
  INSERT: 'stmt', CREATE: 'ddl', DROP: 'stmt', ALTER: 'ddl', TRUNCATE: 'stmt', USE: 'stmt',
  SET: 'stmt', ADD: 'stmt', SHOW: 'stmt', DESCRIBE: 'stmt', DESC: 'stmt', EXPLAIN: 'stmt',
  ANALYZE: 'ddl', REFRESH: 'stmt', MSCK: 'stmt', LOAD: 'stmt', CACHE: 'stmt', UNCACHE: 'stmt',
  DELETE: 'stmt', UPDATE: 'stmt', MERGE: 'ddl'
};

function matchClause(tokens, i, end, atStart) {
  var t = tokens[i];
  if (t.type !== 'word') return null;
  var u = t.upper;
  var next = tokens[i + 1];

  /* 子句关键字出现在不该出现的位置时不能断行（P1-5 / P1-6）：
   *   1) 前一个 token 是 "."：`a.from` / `t.select` 里的 from/select 是限定名的一部分；
   *   2) 前一个 token 是 AS：`select a as window` 里的 window 是别名；
   *   3) 前一个 token 是 "(" 且当前词是子句词：极少见，保守跳过会丢排版，不动；
   *   4) 当前词后面紧跟 "."：`from.x` / `select.a`，同样是限定名。
   * 旧版只看 token 是不是关键字，于是 `select a as window, b as limit from t`
   * 被拆成 `SELECT a AS` + 换行 + `WINDOW, ...`，`a.from` 被拆成 `a.` + 换行 + `FROM`。 */
  var prev = tokens[i - 1];
  if (prev) {
    if (prev.type === 'punct' && prev.value === '.') return null;
    /* GRANT / REVOKE 后面的 SELECT/INSERT/UPDATE/DELETE 是**权限名**，
     * 不是新语句：`grant select, insert on t to u` 不能拆成多行（P1-10）。 */
    if (prev.type === 'word' && (prev.upper === 'GRANT' || prev.upper === 'REVOKE') &&
        (t.upper === 'SELECT' || t.upper === 'INSERT' || t.upper === 'UPDATE' ||
         t.upper === 'DELETE' || t.upper === 'ALTER' || t.upper === 'DROP' ||
         t.upper === 'CREATE' || t.upper === 'TRUNCATE' || t.upper === 'REFERENCES')) return null;
    /* 同理：逗号后的权限名（`grant select, insert on ...`） */
    if (prev.type === 'punct' && prev.value === ',' &&
        next && next.type === 'punct' && next.value === ',') return null;
    /* AS 之后：只有"明显是别名"才跳过（后面紧跟 , ; 或另一个子句词或结尾）。
     * 不能一律跳过，否则 `CREATE VIEW v AS SELECT ...` 的 SELECT 就不再断行了。 */
    if (prev.type === 'word' && prev.upper === 'AS') {
      var after = tokens[i + 1];
      var aliasLike = !after ||
        (after.type === 'punct' && (after.value === ',' || after.value === ';' || after.value === ')')) ||
        (after.type === 'word' && !!CLAUSE_START_WORDS[after.upper]);
      if (aliasLike) return null;
    }
  }
  if (next && next.type === 'punct' && next.value === '.') return null;

  function nextIs(w) {
    return next && next.type === 'word' && next.upper === w;
  }

  /* JOIN 家族 */
  /* STRAIGHT_JOIN 是 MySQL 的 JOIN 变体，它后面不带 JOIN 词，
   * 必须单独处理；放进 JOIN_WORDS 会走「等后续 JOIN」的分支然后返回 null，
   * 第二个 STRAIGHT_JOIN 就被吞进上一个 ON 行（N-6）。 */
  if (u === 'JOIN' || u === 'STRAIGHT_JOIN') return { type: 'join', len: 1 };
  if (JOIN_WORDS[u]) {
    var j = i + 1;
    while (j < end && tokens[j].type === 'word' &&
           JOIN_WORDS[tokens[j].upper]) j++;   /* 修饰词：LEFT/RIGHT/FULL/INNER/CROSS/OUTER/SEMI/ANTI/NATURAL */
    if (j < end && tokens[j].type === 'word' && tokens[j].upper === 'JOIN') return { type: 'join', len: j - i + 1 };
    return null;
  }

  switch (u) {
    case 'SELECT': return { type: 'select', len: 1 };
    case 'WITH': {
      /* L-7：`WITH` 只有处在「带 CTE 的查询的开头」才是 WITH 子句。
       * 旧实现无条件返回 with，于是 T-SQL 的
       *     select a from t with (nolock)
       * 被拆成 `FROM t` + `WITH(nolock)` 两行，而且还丢了空格。
       * 表提示 / 选项子句（WITH (nolock)、WITH RECOMPILE、WITH (FORMAT …)）
       * 都属于同一行，不能断行。 */
      if (atStart) return { type: 'with', len: 1 };
      /* 第五轮（CTAS + CTE）：`WITH` 出现在**语句中间**时也可能是查询的开头：
       *     CREATE TABLE t AS WITH a AS (…) SELECT …      （CTAS）
       *     CREATE VIEW  v AS WITH a AS (…) SELECT …      （CREATE VIEW）
       *     INSERT INTO t    WITH a AS (…) SELECT …       （INSERT … SELECT）
       * 旧实现只看「是不是整条语句的第一个 token」，于是这几种写法里 WITH
       * 被当成普通词粘在上一行行尾（输出 `CREATE TABLE t AS WITH a AS`），
       * 后面所有 CTE 的逗号也一并排错（`), b AS` 而不是 `)\n, b AS`）。
       *
       * 判据用 **CTE 的形状** 而不是位置：`WITH [RECURSIVE] 标识符 AS`。
       * 这样三种非 CTE 的 WITH 都不会被误判：
       *   · T-SQL 表提示   `WITH (nolock)` / `WITH (FORMAT …)`  → WITH 后是 `(`
       *   · T-SQL 选项     `WITH RECOMPILE`                     → 后面没有 `AS`
       *   · MySQL 汇总     `GROUP BY a WITH ROLLUP`             → 后面没有 `AS`
       * 这比"白名单前置语句"更稳：不管前面是 AS、表名还是别的东西，
       * 只要是 `WITH x AS (` 就一定是 CTE。 */
      var wI = i + 1;
      if (tokens[wI] && tokens[wI].type === 'word' && tokens[wI].upper === 'RECURSIVE') wI++;
      if (tokens[wI] && tokens[wI].type === 'word' &&
          tokens[wI + 1] && tokens[wI + 1].type === 'word' && tokens[wI + 1].upper === 'AS') {
        /* CTE 体一定是括号：`WITH a AS (`。再跳过可选的
         * `AS [NOT] MATERIALIZED`（PG 12+ 的 CTE 物化提示）后必须紧跟 `(`。
         * 这一步不能省 —— T-SQL 的 `WITH <选项> AS` 长得完全一样：
         *     CREATE PROCEDURE p WITH RECOMPILE AS SELECT 1
         *     CREATE VIEW v WITH SCHEMABINDING AS SELECT 1
         *     CREATE FUNCTION f() RETURNS INT WITH SCHEMABINDING AS BEGIN …
         * 它们后面接的是 SELECT / BEGIN，不是 `(`，加上这个条件就能分开。 */
        var aI = wI + 2;
        if (tokens[aI] && tokens[aI].type === 'word' && tokens[aI].upper === 'NOT') aI++;
        if (tokens[aI] && tokens[aI].type === 'word' && tokens[aI].upper === 'MATERIALIZED') aI++;
        if (tokens[aI] && tokens[aI].type === 'punct' && tokens[aI].value === '(') {
          return { type: 'with', len: 1 };
        }
      }
      return null;
    }
    case 'FROM': {
      /* 方言兼容性检测报告 §3.4：`IS [NOT] DISTINCT FROM` 是一个**二元比较运算符**，
       * 不是 FROM 子句。旧实现无条件 return from，于是
       *     where a is distinct from b
       * 被断成 `WHERE a IS DISTINCT` ⏎ `FROM b`（换行等价空格，语义不变，
       * 但读起来像另一个子句，而且后面的真实 FROM 会与之混淆）。
       * 判据：前面是 DISTINCT（跳过可选的 NOT），且再往前是 IS。 */
      if (prev && prev.type === 'word' && prev.upper === 'DISTINCT') {
        var beforeDistinct = tokens[i - 2];
        if (beforeDistinct && beforeDistinct.type === 'word' && beforeDistinct.upper === 'NOT') {
          beforeDistinct = tokens[i - 3];
        }
        if (beforeDistinct && beforeDistinct.type === 'word' && beforeDistinct.upper === 'IS') return null;
      }
      /* 第六轮审计（A-15）：`DELETE FROM t` 里的 FROM 不是独立的子句起点 ——
       * 它与 DELETE 组成一个整体，拆行会得到
       *     DELETE
       *     FROM t
       * 而 DELETE 单独占一行几乎无信息量，与 `SELECT … FROM` / `UPDATE … SET`
       * 的排版也不一致。判据：紧跟在 DELETE 之后（`DELETE t FROM …` 这种
       * 多表删除的第二个 FROM 前一个是表名，不受影响，仍然断行）。 */
      if (prev && prev.type === 'word' && prev.upper === 'DELETE') return null;
      return { type: 'from', len: 1 };
    }
    case 'WHERE': return { type: 'where', len: 1 };
    /* L3c（第三轮审计）：ClickHouse 的 PREWHERE 是 WHERE 之前的过滤子句，
     * 与 WHERE 同级、同样单独成行。旧实现把它当"软关键字"只做大小写提升，
     * 从不在子句层断行，于是 `from t prewhere x = 1 where y = 2` 整段挤在
     * FROM 那一行（changelog 却写着"已补全"）。
     * 只在方言是 clickhouse、或前后确实像子句时才断，避免误伤列名 prewhere。 */
    case 'PREWHERE': {
      var ckDialect = /clickhouse|(^|\W)ch(\W|$)/i.test(String(LEX.dialect || ''));
      var ckCtx = !!(prev && prev.type === 'word' && /^(FROM|WHERE|PREWHERE|SETTINGS)$/.test(String(prev.upper)));
      if (!ckDialect && !ckCtx) return null;
      return { type: 'where', len: 1 };
    }
    case 'HAVING': return { type: 'having', len: 1 };
    case 'ON': {
      /* L-2：PostgreSQL 的 `SELECT DISTINCT ON (cols) ...` —— 这里的 ON 属于
       * SELECT 子句，不是 JOIN 条件。旧实现无条件返回 `{type:'on'}`，于是
       *     SELECT DISTINCT
       *     ON (a) a, b
       * 被拆成两行，列清单也退化成"一行挤在一起"（因为 ctx 变成 on，
       * commaBreak 关掉了）。判据：前一个 token 是 DISTINCT 时不当子句。 */
      if (prev && prev.type === 'word' && prev.upper === 'DISTINCT') return null;
      /* 第六轮审计（A-2）：**ON 不一定属于 JOIN**。T-SQL 的一批会话开关语句
       * 以 ON 结尾，断成独立一行会把一条短语句拆得莫名其妙：
       *     set nocount on            → SET nocount ⏎ ON
       *     set ansi_nulls on         → SET ansi_nulls ⏎ ON
       *     set identity_insert t on  → SET identity_insert t ⏎ ON
       * 判据取最保守的一种：**整条语句以 SET 开头时，ON 一律不当子句**。
       * 语句是按分号切好的（splitStatements），所以 `set …; select … join … on …`
       * 里真正的 JOIN ON 属于后一条语句，不会受影响。 */
      if (firstCodeWord(tokens) === 'SET') return null;
      return { type: 'on', len: 1 };
    }
    case 'LIMIT': return { type: 'limit', len: 1 };
    case 'WINDOW': return { type: 'simple', len: 1 };
    case 'LATERAL':
      if (nextIs('VIEW')) return { type: 'simple', len: 2 };
      return null;
    case 'GROUP':
      if (nextIs('BY')) return { type: 'groupby', len: 2 };
      if (nextIs('GROUPING')) return { type: 'simple', len: 2 };
      return null;
    case 'ORDER':
      if (nextIs('BY')) return { type: 'orderby', len: 2 };
      return null;
    case 'SORT':
      if (nextIs('BY')) return { type: 'sortby', len: 2 };
      return null;
    case 'DISTRIBUTE':
      if (nextIs('BY')) return { type: 'distributeby', len: 2 };
      return null;
    case 'CLUSTER':
      if (nextIs('BY')) return { type: 'clusterby', len: 2 };
      return null;
    /* EXCEPT / INTERSECT / MINUS 与 UNION 同级，必须断行（N-4）。
     * 旧版只在 UNION 处断行，于是 `… WHERE x = 1 EXCEPT SELECT …` 里的
     * EXCEPT 被留在 WHERE 行尾，第二段 SELECT 紧贴上来。 */
    case 'EXCEPT': case 'INTERSECT': case 'MINUS': {
      /* 方言兼容性检测报告 §3.4：BigQuery 的 `SELECT * EXCEPT (a, b)` 是
       * **列排除子句**（属于 SELECT 列表的一部分），不是集合运算。
       * 判据：前面紧邻 `*`（`select * except (...)`）。集合运算的
       * `select * from a except (select ...)` 里 EXCEPT 前面是表名，不是 `*`。
       * 误判成集合运算会把 `except (a), b` 拆成三行，结构面目全非。 */
      if (prev && prev.type === 'punct' && prev.value === '*' &&
          next && next.type === 'punct' && next.value === '(') return null;
      if (nextIs('ALL') || nextIs('DISTINCT')) return { type: 'union', len: 2 };
      return { type: 'union', len: 1 };
    }
    /* QUALIFY 是窗口过滤子句（Snowflake/BigQuery/Teradata），与 HAVING 同级（N-5） */
    case 'QUALIFY': return { type: 'having', len: 1 };
    /* 方言兼容性检测报告 §3.4：各库特色子句独立成行。
     * 判据统一为「前后确实是子句位置」，避免误伤同名列：
     *   · ClickHouse `ARRAY JOIN arr` —— ARRAY 后必须紧跟 JOIN；
     *   · ClickHouse `FINAL` / `SAMPLE n` / `SETTINGS k = v` —— 只在 FROM 表名之后；
     *   · Oracle `START WITH … [CONNECT BY PRIOR …]` —— START 后必须紧跟 WITH，
     *     CONNECT 后必须紧跟 BY；
     *   · T-SQL `OUTPUT inserted.a` —— OUTPUT 后不能是 `,` / `)`（那是列名）。 */
    case 'ARRAY': {
      if (nextIs('JOIN')) return { type: 'join', len: 2 };
      return null;
    }
    /* FINAL / SAMPLE / SETTINGS 不在这里断行：它们在 ClickHouse 里紧跟在表名
     * 后面（`FROM t FINAL SAMPLE 0.1 SETTINGS k = v`），断成多行反而更难读。
     * 只做大小写提升（见 markKeywords 的 isCh 分支）。 */
    case 'CONNECT': {
      if (nextIs('BY')) return { type: 'simple', len: 2 };
      return null;
    }
    case 'START': {
      if (nextIs('WITH')) return { type: 'simple', len: 2 };
      return null;
    }
    case 'OUTPUT': {
      /* `insert into t (a) output inserted.a values (1)`：
       * OUTPUT 后面紧跟 inserted/deleted 或标识符，且前面是 `)`；
       * `select output, a from t` 前面是 SELECT → 不动。 */
      if (!prev || !(prev.type === 'punct' && prev.value === ')')) return null;
      return { type: 'simple', len: 1 };
    }
    case 'DISTKEY': case 'SORTKEY': {
      /* Redshift 建表尾部 `) distkey (a) sortkey (a)`：前面是 `)`。 */
      if (!prev || !(prev.type === 'punct' && prev.value === ')')) return null;
      return { type: 'simple', len: 1 };
    }
    /* M-3：Hive 多路插入的**后续** INSERT 也要断行。
     *     FROM s
     *     INSERT OVERWRITE TABLE t1 SELECT a
     *     INSERT OVERWRITE TABLE t2 SELECT b
     * 旧实现只在"语句开头"认 INSERT（STATEMENT_WORDS + atStart），
     * 于是第二个 INSERT 被当成普通词粘在 `SELECT a` 行尾：
     *     SELECT a INSERT OVERWRITE TABLE t2
     * 判据：INSERT 后面紧跟 INTO / OVERWRITE / TABLE / DIRECTORY 才算语句级；
     * `MERGE … THEN INSERT (id, a)` 的 INSERT 后面是 `(`，不受影响。 */
    case 'INSERT': {
      if (prev && prev.type === 'word' && /^(THEN|DO)$/.test(prev.upper)) return null;
      if (nextIs('INTO') || nextIs('OVERWRITE') || nextIs('TABLE') || nextIs('DIRECTORY')) {
        return { type: 'stmtStart', len: 1 };
      }
      return null;
    }
    /* L-1：MERGE 的 WHEN 分支各占一行。
     * `MERGE INTO t USING s ON … WHEN MATCHED THEN UPDATE … WHEN NOT MATCHED THEN INSERT …`
     * 旧实现把整段挤在一行（WHEN 没有被当成子句起点），可读性极差。
     * WHEN 同时是 CASE 的关键字，所以只在**语句里有 MERGE** 时才当子句起点 ——
     * 这里用"前一个词是 ON 的条件尾部 / 已经是 WHEN 分支"这类上下文判断：
     *   · 前一个 token 是 ')' / 标识符 / 数字（即上一个 WHEN 分支结束），或
     *   · 前一个 token 是 MATCHED / NOT 之后（WHEN NOT MATCHED）
     * 最稳妥的判据是：**后面紧跟 MATCHED 或 NOT**（`WHEN MATCHED` / `WHEN NOT MATCHED`），
     * 这两种组合在 CASE 里不会出现。 */
    case 'WHEN': {
      var n1 = tokens[i + 1], n2 = tokens[i + 2];
      var mergeWhen = !!(n1 && n1.type === 'word' &&
        (n1.upper === 'MATCHED' || n1.upper === 'NOT')) ||
        !!(n1 && n1.type === 'word' && n1.upper === 'NOT' &&
           n2 && n2.type === 'word' && n2.upper === 'MATCHED');
      if (mergeWhen) return { type: 'simple', len: 1 };
      return null;
    }
    /* L-1：THEN UPDATE SET / THEN INSERT / THEN DELETE 也各占一行，
     * 但它们跟在 WHEN 分支里已经断行，这里只要保证 `INSERT (` 有空格即可
     * （由 SPACE_BEFORE_PAREN 的默认规则处理）。 */
    /* P3-5（2026-11-02 审计）：`UPDATE ... JOIN ... ON ... SET ...` 的 SET 不断行，
     * 输出 `ON t.id = s.id SET t.a = s.a, t.b = s.b` —— 赋值清单粘在连接条件后面。
     *
     * 只在**语句以 UPDATE 开头**时才认（SET 出现在语句中部）：
     *   · `set hive.exec.dynamic.partition = true` —— 语句头就是 SET，由
     *     STATEMENT_WORDS 处理，这里不能重复断行；
     *   · MERGE 的 `WHEN MATCHED THEN UPDATE SET a = s.a` —— 语句以 MERGE 开头；
     *   · PG 的 `ON CONFLICT (a) DO UPDATE SET b = excluded.b` —— 以 INSERT 开头。
     * 这几种都不受影响。 */
    case 'SET': {
      if (firstCodeWord(tokens) === 'UPDATE') return { type: 'simple', len: 1 };
      return null;
    }
    /* OFFSET / FETCH 是分页子句（N-17），与 LIMIT 同级 */
    /* OFFSET / FETCH 是分页子句，但它们也极常是列名（N-17）。
     * 只有当它处在「分页子句位置」时才断行：
     *   · 后面紧跟数字 / ROWS / ROW / NEXT，且
     *   · 前面不是 SELECT / 逗号 / "("（那是列清单位置）。
     * 否则当普通标识符，避免把 `select offset, b from t` 拆成两行。 */
    case 'OFFSET': case 'FETCH': {
      /* L3b（第三轮审计）：JDBC/PG 的 `LIMIT ? OFFSET ?` 里 offset 后面是
       * **占位符**（`?` / `$1` / `:n`），不是数字 —— 旧判据只认 number 和
       * ROWS/NEXT 这类词，于是 `offset ?` 被当成列名，永远保持小写。 */
      var pgOk = !!(next && (next.type === 'number' ||
        (next.type === 'punct' && next.value === '?') ||
        (next.type === 'word' && /^(ROWS|ROW|NEXT|ONLY|FIRST|PERCENT)$/.test(String(next.upper))) ||
        (next.type === 'template')));
      var colPos = !prev ||
        (prev.type === 'punct' && (prev.value === ',' || prev.value === '(' )) ||
        (prev.type === 'word' && /^(SELECT|DISTINCT|ALL)$/.test(String(prev.upper)));
      if (pgOk && !colPos) return { type: 'limit', len: 1 };
      return null;
    }
    /* L4（第三轮审计）：这里原本还有一个 `case 'FETCH': return { type: 'limit', len: 1 };`，
     * 它永远不可达（同一个 switch 里上面已经有 `case 'FETCH'`），而且它无条件返回
     * limit 的做法与上面的保守判据矛盾。已删除。 */
    case 'UNION': {
      if (nextIs('ALL') || nextIs('DISTINCT')) return { type: 'union', len: 2 };
      return { type: 'union', len: 1 };
    }
    default:
      break;
  }

  if (atStart && STATEMENT_WORDS[u]) {
    return { type: u === 'CREATE' || u === 'ALTER' ? 'ddl' : 'stmtStart', len: 1 };
  }
  return null;
}

/* ============================== 格式化器 ============================== */

function Formatter(opts) {
  opts = opts || {};
  this.opts = {
    uppercase: opts.uppercase !== false,
    commaLocation: opts.commaLocation === true,
    bracketChar: opts.bracketChar === true,
    /* as_loc_cnt：0 = 跟随 maxWidth，负数 = 不限制（Infinity），
     * 正数 = 显式列号。旧实现把负数静默换成 150，与 package.json 里
     * "negative = no limit" 的承诺不符（M-1）。 */
    asLocCnt: typeof opts.asLocCnt === 'number'
      ? (opts.asLocCnt > 0 ? opts.asLocCnt : (opts.asLocCnt < 0 ? Infinity : 0))
      : 150,
    maxWidth: typeof opts.maxWidth === 'number' && opts.maxWidth > 0 ? opts.maxWidth : DEFAULT_MAX_LINE,
    /* 「目标 / 上限」双阈值（2026-11-04 修正语义，缺陷 W-1）：
     *   maxWidth  = 目标宽度（屏幕 × 80%）：**超过它就折行**，
     *               折行点也尽量落在这一列附近（允许向前/向后舍入到逻辑块边界）；
     *   hardWidth = 硬上限（屏幕 × 100%）：任何一行都不得主动超过它。
     * 旧实现把 maxWidth 只当"对齐用的软目标"，折行触发看 hardWidth ——
     * 于是 80%~100% 之间的行永远不折，"超过 80% 就换行"的约定形同虚设。
     * 现在：超过 80% 就折；只有在"不劈开一段逻辑"（连接运算符、单个超长
     * token）时才允许借用 80%~100% 这段余量。 */
    hardWidth: (typeof opts.hardWidth === 'number' && opts.hardWidth > 0)
      ? opts.hardWidth
      : ((typeof opts.maxWidth === 'number' && opts.maxWidth > 0) ? Math.round(opts.maxWidth / 0.8) : Math.round(DEFAULT_MAX_LINE / 0.8)),
    /* 行内紧凑化开关。默认开启（"换行太短"的解法）；
     * DDL 提取（extractddl）和 DDL 排版需要的是**逐列一行**的中间结构，必须关掉。 */
    compactExpressions: opts.compactExpressions !== false,
    /* 超长时才打破的"软"优先级：数值越小越晚断。留作扩展点。 */
    breakPenalty: typeof opts.breakPenalty === 'number' ? opts.breakPenalty : 0
  };
  /* 汉字相对 ASCII 列的真实渲染宽度（默认 1.81818 = Consolas + 微软雅黑）。
   * 只影响 AS 对齐 / 注释对齐补几个空格；折行仍用整数 visLen。
   *
   * B-03：**每次构造都必须把比值解析成一个确定值**（缺省/非法 → 默认 1.81818）。
   * 旧实现是「只在显式传入 number 时才设置」，而扩展层把缺省/非法值归一成 0，
   * 0 又过不了 setCjkRatio 的范围检查 —— 于是「先在有 cjk_width=2 的文档里格式化，
   * 再在默认文档里格式化」时，后者继承了前者的 2，同一份 SQL 在两处对齐宽度不同。
   * CJK_WIDTH_RATIO 是进程级全局量，不复位就等于跨文档串味。
   * 注意：0 / 负数 / NaN / >4 一律视为「没配」，回落到默认值，而不是「保持上一次」。 */
  setCjkRatio((typeof opts.cjkWidth === 'number' && isFinite(opts.cjkWidth) &&
    opts.cjkWidth > CJK_RATIO_MIN && opts.cjkWidth <= CJK_RATIO_MAX)
    ? opts.cjkWidth
    : DEFAULT_CJK_RATIO);
  /* 方言开关：反斜杠转义 / `#` 的语义（注释 / 异或 / 标识符）。
   * 写进全局 LEX，内部 tokenize() 自动继承。
   * 注意：`#` 的语义必须带上 hashMode 一起记录，仅靠 hashComment 布尔量
   * 无法区分"这是 PG 的异或"还是"这是 MySQL 的注释"，后面 renderInline /
   * joinTokens 等重放路径判断"`#` 后面要不要加空格"时需要用。 */
    /* 把大小写模式同步给 joinTokens（DDL 路径走 joinTokens） */
    JOIN_CASE = this.opts.uppercase ? 'upper' : 'lower';

  /* asLocCnt=0 的契约是「跟随 maxWidth」（R3-6）。
   * 旧实现直接留 0，而 alignAsGroup 的判据是「列号 ≤ asLocCnt」，
   * 于是 0 意味着**任何行都不参与对齐**，AS 完全不对齐 —— 
   * 与 package.json 里 "0 = follow max line length" 的说明矛盾。 */
  if (this.opts.asLocCnt === 0) this.opts.asLocCnt = this.opts.maxWidth;
  this.lex = {
    backslash: opts.backslash === true,
    hashComment: opts.hashComment === true,
      hashMode: opts.hashMode === 'xor' || opts.hashMode === 'ident' ? opts.hashMode : 'comment',
      dashSpace: opts.dashSpace === true,
      /* L3c：方言要留在 LEX 上，matchClause 等后处理才能按方言决定
       * PREWHERE 这类专属子句要不要断行。 */
      dialect: opts.dialect === undefined ? '' : String(opts.dialect)
    };
  LEX.backslash = this.lex.backslash;
  LEX.hashComment = this.lex.hashComment;
  LEX.hashMode = this.lex.hashMode;
    LEX.dashSpace = this.lex.dashSpace;
    LEX.dialect = this.lex.dialect;
    /* 缩进单位（R3-9）：bracketChar 只决定用制表符还是空格，
     * 用几个空格由 tabWidth 决定（扩展层从 editor.tabSize 传进来）。
     * 旧版写死 4 空格，tabSize=2 的项目里格式化后缩进直接翻倍。 */
    var tw = (typeof opts.tabWidth === 'number' && opts.tabWidth > 0) ? Math.floor(opts.tabWidth) : 4;
    this.unit = this.opts.bracketChar ? new Array(tw + 1).join(' ') : '\t';
    /* C-06：Tab 的列宽跟着 tabSize 走（宽度函数是全局纯函数，带缓存）。 */
    setTabWidth(tw);
  this.lines = [];
  this.cur = null;
  this.indent = '';
}

Formatter.prototype.tokenText = function (tk) {
  /* 路径里的 token 一律保持原样（/user/select/t.jar 不能变成 /USER/SELECT） */
  if (tk.path) return tk.value;
  /* 方言兼容性检测报告 §3.5：泛型类型 token（`map<string,int>` 整体合并成一个
   * token）也要跟随 uppercase —— 否则 sql() 路径输出 `struct<a int64>`，
   * 而 DDL 路径输出 `STRUCT<a INT64>`，同一句 SQL 走两个命令结果不同。
   * 只重排**确定是类型名**的词（TYPE_WORDS / GENERIC_TYPE_WORDS），
   * 字段名（`struct<MyCol:int>` 的 MyCol）保持原样。 */
  if (tk.generic) return recaseGenericType(tk.genericHead, tk.genericTail, this.opts.uppercase);
  /* noCase：AS 之后的别名、点号之后的限定名、泛型类型、变量/字面量前缀等，
   * 一律按原样输出；裸标识符是否算关键字由 token 自己的 keyword 标记决定。 */
  if (tk.type === 'word' && !tk.noCase && tk.keyword) {
    return this.opts.uppercase ? tk.value.toUpperCase() : tk.value.toLowerCase();
  }
  return tk.value;
};

Formatter.prototype.newLine = function (ind, kind, exprBase) {
  if (this.cur && this.cur.text === '') {
    this.cur.ind = ind;
    if (kind) this.cur.kind = kind;
    if (exprBase !== undefined) this.cur.exprBase = exprBase;
    return this.cur;
  }
  if (this.cur) this.lines.push(this.cur);
  this.cur = {
    ind: ind,
    text: '',
    kind: kind || 'code',
    exprBase: exprBase === undefined ? ind.length : exprBase,
    last: null,
    last2: null,
    last3: null,
    last4: null,
    /* P-02（2026-11-04 复核）：行首状态，供 spaceBetween 的逗号分支 O(1) 判断
     * "这一行到目前为止只有一个逗号"，避免对 cons string 做 charAt（会强制扁平化
     * 整行，长 IN 列表因此 O(n²)）。 */
    headFirst: '',
    headCount: 0
  };
  return this.cur;
};

Formatter.prototype.appendToken = function (tk, noSpace) {
  var cur = this.cur || this.newLine(this.indent, 'code');

  if (cur.last && cur.last.type === 'word' && cur.last.upper === 'AS' && !tk.castType) tk.noCase = true;
  if (cur.last && cur.last.type === 'punct' && cur.last.value === '.') tk.noCase = true;

  markUnary(tk, cur.last);

  var space = false;
  if (cur.text !== '' && !noSpace) {
    space = spaceBetween(cur.last, tk, cur.text, cur.last2, cur.last3, cur.last4,
      cur.headCount === undefined ? null : (cur.headCount === 1 && cur.headFirst === ','));
  }
  if (space) cur.text += ' ';
  var tt = this.tokenText(tk);
  cur.text += tt;
  /* P-02：维护行首状态（只看 token 文本首字符，均摊 O(1)） */
  if (cur.headCount === undefined) { cur.headFirst = ''; cur.headCount = 0; }
  if (tt.length > 0) {
    var _c0 = tt.charCodeAt(0);
    if (_c0 !== 32 && _c0 !== 9) {
      if (cur.headCount === 0) cur.headFirst = tt.charAt(0);
      cur.headCount++;
    }
  }
  cur.last4 = cur.last3;
  cur.last3 = cur.last2;
  cur.last2 = cur.last;
  cur.last = tk;
};

Formatter.prototype.hasText = function () {
  return this.cur && this.cur.text !== '';
};

/* ---------------------------- 注释 ---------------------------- */

/* 行尾注释打断之后，下一行应该从"续行位置"开始，而不是回到子句起始列。
 * SELECT 列表里这一列正好是行首逗号所在列（`      ,b`），并且 kind / exprBase
 * 也要和逗号续行一致，否则 AS 对齐会因为 kind 不同而整组失效（P2-1 / P2-11）。 */
Formatter.prototype.commentResume = function (ctx) {
  if (!ctx) return { ind: this.indent, kind: 'code', exprBase: undefined };
  if (ctx.commaBreak) {
    return {
      ind: ctx.commaInd !== undefined ? ctx.commaInd : ctx.ind,
      kind: ctx.type === 'paren' ? 'paren' : ctx.type,
      exprBase: ctx.exprBase
    };
  }
  if (ctx.type === 'where' || ctx.type === 'on' || ctx.type === 'having') {
    return { ind: ctx.contInd !== undefined ? ctx.contInd : ctx.ind, kind: ctx.type, exprBase: ctx.exprBase };
  }
  return { ind: ctx.ind, kind: 'code', exprBase: undefined };
};

/* ---------------------------- 注释 ---------------------------- */

/* 多行块注释在输出里必须"原样保留内容"：
 *   - 旧版把每一行 trim 后重新缩进，注释内部缩进被抹平，
 *     安全网发现注释变了就整段回退 → 用户按快捷键没反应（P1-1）；
 *   - 这里把整个 token 作为一个带内嵌换行的行实体原样输出，
 *     相对缩进（`/* l1\n   l2 *\/` 里的 3 个空格）完全不动。 */
Formatter.prototype.emitComment = function (tk, ctx) {
  var cur = this.cur;
  var resume = this.commentResume(ctx);
  var isMultiBlock = tk.kind === 'block' && tk.value.indexOf('\n') >= 0;
  var sameLine = cur && cur.text !== '' && tk.nl === 0;

  /* 多行块注释：整块逐字保留（含内部换行与相对缩进）。
   * 若它本来就跟在前面的代码后面（`a, /* l1\n  l2 *\/ b`），就接在同一行，
   * 避免把一行拆成"代码 / 注释 / 代码"三段。 */
  if (isMultiBlock) {
    if (sameLine) {
      cur.text = rtrim(cur.text) + ' ' + tk.value;
      cur.kind = 'commentTail';
      cur.multiline = true;
      this.newLine(resume.ind, resume.kind, resume.exprBase);
      return;
    }
    if (cur && cur.text !== '') this.newLine(ctx.ind, 'comment');
    this.newLine(ctx.ind, 'comment');
    this.cur.text = tk.value;
    this.cur.multiline = true;
    this.newLine(resume.ind, resume.kind, resume.exprBase);
    return;
  }

  if (sameLine) {
    cur.text = rtrim(cur.text) + ' ' + tk.value;
    cur.kind = 'commentTail';
    /* 行注释必须换行（-- 之后整行都是注释）；单行块注释可以继续接代码，
     * 不要把 a /* c *\/ + 1 这种表达式劈成两半（P2-2）。 */
    if (tk.kind === 'line') this.newLine(resume.ind, resume.kind, resume.exprBase);
    return;
  }

  this.newLine(ctx.ind, 'comment');
  this.cur.text = tk.value;
  this.newLine(resume.ind, resume.kind, resume.exprBase);
};

/* ---------------------------- 括号 ---------------------------- */

function findMatchingParen(tokens, openIdx, end) {
  var depth = 0;
  for (var i = openIdx; i < end; i++) {
    var t = tokens[i];
    if (t.type !== 'punct') continue;
    if (t.value === '(') depth++;
    else if (t.value === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

Formatter.prototype.parenInfo = function (tokens, openIdx, closeIdx) {
  var inner = tokens.slice(openIdx + 1, closeIdx);
  var isSubquery = false;
  var hasLineComment = false;

  for (var i = 0; i < inner.length; i++) {
    var t = inner[i];
    if (t.type === 'word' && (t.upper === 'SELECT' || t.upper === 'WITH')) { isSubquery = true; break; }
    if (t.type === 'comment' && t.kind === 'line') { hasLineComment = true; break; }
    if (t.type === 'punct' && t.value === '(') {
      var close = findMatchingParen(inner, i, inner.length);
      if (close < 0) break;
      i = close;
    }
  }

  /* 往前回溯判断括号是否是 DDL 的列定义列表：
   * 先跳过 [库名.]表名 这串点号名字，再跳过 IF NOT EXISTS / TEMPORARY 等修饰词，
   * 最后看前一个词是不是 TABLE / PARTITIONED / COLUMNS 之类。 */
  var isDdlList = false;
  var k = openIdx - 1;
  if (k >= 0 && tokens[k].type === 'comment') k--;

  /* 点号名字：db . t → 退到 db */
  while (k - 1 >= 0 && tokens[k].type === 'word' &&
         tokens[k - 1].type === 'punct' && tokens[k - 1].value === '.') {
    k -= 2;
  }

  /* 名字前面的修饰词 */
  while (k - 1 >= 0 && tokens[k - 1].type === 'word' &&
         (tokens[k - 1].upper === 'IF' || tokens[k - 1].upper === 'NOT' ||
          tokens[k - 1].upper === 'EXISTS' || tokens[k - 1].upper === 'TEMPORARY' ||
          tokens[k - 1].upper === 'EXTERNAL' || tokens[k - 1].upper === 'TRANSACTIONAL' ||
          tokens[k - 1].upper === 'GLOBAL')) {
    k--;
  }

  if (k - 1 >= 0 && tokens[k - 1].type === 'word' && DDL_PAREN_BEFORE[tokens[k - 1].upper]) {
    isDdlList = true;
  }

  return {
    isSubquery: isSubquery,
    hasLineComment: hasLineComment,
    isDdlList: isDdlList,
    isBlock: inner.length > 0 && (isSubquery || isDdlList || hasLineComment)
  };
};

Formatter.prototype.handleParen = function (tokens, openIdx, end, ind, ctx) {
  var closeIdx = findMatchingParen(tokens, openIdx, end);
  var unbalanced = closeIdx < 0;

  /* 括号不平衡（用户少写了一个 ")"）时，绝不能把 end-1 当成右括号——
   * 那样后面还没渲染的 token 会被整段吞掉。这里把剩余内容当作括号体渲染，
   * 只是不补那个并不存在的 ")"。 */
  if (unbalanced) closeIdx = end;

  var info = this.parenInfo(tokens, openIdx, closeIdx);

  /* 行内括号：当作一个原子拼接 */
  if (!info.isBlock && !unbalanced) {
    var txt = this.renderInline(tokens, openIdx + 1, closeIdx);
    var cur = this.cur || this.newLine(ind, 'code');
    var needSpace = cur.text !== '' &&
      spaceBeforeParen(cur.last, cur.last2, cur.last3, cur.last4);
    if (needSpace) cur.text += ' ';
    cur.text += '(' + txt + ')';
    cur.last4 = cur.last3;
    cur.last3 = cur.last2;
    cur.last2 = cur.last;
    cur.last = { type: 'punct', value: ')' };
    return closeIdx + 1;
  }

  /* 块括号 */
  var prev = this.cur ? this.cur.last : null;

  /* P3-5（2026-11-02 审计）：缩进基准不能只看传进来的 ind。
   * 行首逗号那一行的缩进记在 `this.cur.ind` 上（commaInd），
   * 传进来的 `ind` 仍是空串 —— 于是 `, (` 里的 `(` 在第 6 列，
   * 配对的 `)` 却掉到第 0 列。取两者中较长者作为括号的基准列。 */
  var baseInd = ind;
  if (this.cur && this.cur.ind && this.cur.ind.length > baseInd.length) {
    baseInd = this.cur.ind;
  }

  if (this.cur && this.cur.text !== '') {
    if (info.isDdlList) {
      this.newLine(ind, 'code');
    } else if (prev && prev.type === 'word' && BLOCK_OPEN_BREAK[prev.upper]) {
      this.newLine(ind, 'code');
    }
  } else if (!this.cur) {
    this.newLine(ind, 'code');
  }

  this.appendToken({ type: 'punct', value: '(' }, true);

  var innerInd = baseInd + this.unit;
  this.newLine(innerInd, 'code');
  this.indent = innerInd;
  this.formatTokens(tokens, openIdx + 1, closeIdx, innerInd, info.isDdlList ? 'paren' : 'stmt');
  this.indent = ind;

  /* 原始文本里就没有配对的 ")"，不要凭空补一个 */
  if (!unbalanced) {
    this.newLine(baseInd, 'code');
    this.appendToken({ type: 'punct', value: ')' }, true);
  }

  return closeIdx + (unbalanced ? 0 : 1);
};

/* ---------------------------- 行内渲染 ---------------------------- */

Formatter.prototype.renderInline = function (tokens, start, end) {
  var text = '';
  var last = null, last2 = null, last3 = null, last4 = null;
  /* P-02（2026-11-04 复核）：行首状态。这里才是行首逗号判定的**真正热点** ——
   * 2 万项 IN 列表实测 39 998 次 spaceBetween 调用全部走这里。
   * 维护"这一行到目前为止的非空白 token 个数 + 首个非空白字符"后，
   * 逗号分支再也不碰 text（cons string），彻底消掉扁平化。 */
  var headFirst = '', headCount = 0;

  for (var i = start; i < end; i++) {
    var tk = tokens[i];

    if (tk.type === 'comment') {
      text = rtrim(text);
      if (text !== '') text += ' ';
      text += tk.value;
      /* 注释也算“行内已有内容”（否则 `, -- c` 之后会被误判成行首逗号） */
      if (/\S/.test(tk.value)) {
        if (headCount === 0) headFirst = String(tk.value).charAt(0);
        headCount++;
      }
      /* 单行块注释后还可能接代码（a, /* c *\/ b）：合成一个"注释占位"词，
       * 让下一个 token 走正常的加空格路径，避免输出 `c *\/b` 贴死（M-3）。 */
      last = { type: 'word', upper: '', value: tk.value, commentPlaceholder: true };
      last2 = null; last3 = null; last4 = null;
      continue;
    }

    if (last && last.type === 'word' && last.upper === 'AS' && !tk.castType) tk.noCase = true;
    if (last && last.type === 'punct' && last.value === '.') tk.noCase = true;

    markUnary(tk, last);

    var space = false;
    if (text !== '') {
      space = spaceBetween(last, tk, text, last2, last3, last4,
        headCount === 1 && headFirst === ',');
    }
    if (space) text += ' ';
    var tt = this.tokenText(tk);
    text += tt;
    /* 维护行首状态（只看 token 文本的首字符，均摊 O(1)） */
    if (tt.length > 0) {
      var c0 = tt.charCodeAt(0);
      if (c0 !== 32 && c0 !== 9) {
        if (headCount === 0) headFirst = tt.charAt(0);
        headCount++;
      }
    }

    if (tk.type === 'punct' && (tk.value === '(' || tk.value === '[')) {
      /* 内层括号：prevPrev 语义不变，简单保留 */
    }
    last4 = last3;
    last3 = last2;
    last2 = last;
    last = tk;
  }

  return text;
};

/* ---------------------------- 子句 ---------------------------- */

Formatter.prototype.startClause = function (cl, tokens, i, end, ind) {
  var words = tokens.slice(i, i + cl.len);
  var next = tokens[i + cl.len];
  var ctx = null;
  var k;

  var types = {
    orderby: 'ORDER BY ', sortby: 'SORT BY ', clusterby: 'CLUSTER BY ', distributeby: 'DISTRIBUTE BY '
  };

  switch (cl.type) {
    case 'select': {
      var prefixLen = 7; /* "SELECT " */
      /* DISTINCT 前缀 16 列（"SELECT DISTINCT "），ALL 只有 11 列（"SELECT ALL "）。
       * 旧版把两者都当 16，于是 `select all a, b` 的续行列多缩进 5 列（P2-3）。 */
      if (next && next.type === 'word' && next.upper === 'DISTINCT') prefixLen = 16;
      else if (next && next.type === 'word' && next.upper === 'ALL') prefixLen = 11;
      var exprBase = ind.length + prefixLen;
      this.newLine(ind, 'select', exprBase);
      this.appendToken(words[0], true);
      ctx = {
        type: 'select', ind: ind, contInd: ind + '        ',
        /* M3b（第三轮审计）：commaInd 是"逗号在行首时"的缩进 —— 比 SELECT 短 1 格，
         * 这样 `SELECT a` / `      ,b` 的字段名能竖向对齐。
         * 但 comma_location=true 时逗号被移到**上一行行尾**，续行不再有行首逗号，
         * 若沿用 `prefixLen - 1` 就对不齐（少 1 格）。此时用 prefixLen。 */
        commaInd: ind + spaces(this.opts.commaLocation ? prefixLen : prefixLen - 1),
        commaBreak: true,
        exprBase: exprBase, ddl: false
      };
      break;
    }

    case 'with':
      this.newLine(ind, 'with');
      this.appendToken(words[0], true);
      ctx = {
        type: 'with', ind: ind, contInd: ind + '     ',
        commaInd: ind, commaBreak: false, exprBase: ind.length, ddl: false
      };
      break;

    case 'from':
      this.newLine(ind, 'from');
      this.appendToken(words[0], true);
      ctx = { type: 'from', ind: ind, contInd: ind + '   ', commaInd: ind, commaBreak: false, exprBase: ind.length, ddl: false };
      break;

    case 'join':
      this.newLine(ind, 'join');
      this.appendToken(words[0], true);
      for (k = 1; k < words.length; k++) this.appendToken(words[k]);
      ctx = { type: 'join', ind: ind, contInd: ind + '     ', commaInd: ind, commaBreak: false, exprBase: ind.length, ddl: false };
      break;

    case 'on':
      this.newLine(ind, 'on');
      this.appendToken(words[0], true);
      /* 条件与 ON 对齐（不再额外缩进） */
      ctx = { type: 'on', ind: ind, contInd: ind, commaInd: ind, commaBreak: false, exprBase: ind.length, ddl: false };
      break;

    case 'where':
    case 'having': {
      var kw = cl.type === 'where' ? 'WHERE' : 'HAVING';
      this.newLine(ind, cl.type);
      this.appendToken(words[0], true);
      /* 条件与 WHERE / HAVING 对齐（不再额外缩进） */
      ctx = {
        type: cl.type, ind: ind, contInd: ind,
        commaInd: ind, commaBreak: false, exprBase: ind.length, ddl: false
      };
      break;
    }

    case 'groupby':
    case 'orderby':
    case 'sortby':
    case 'clusterby':
    case 'distributeby': {
      var prefix = types[cl.type] || 'GROUP BY ';
      if (cl.type === 'groupby') prefix = 'GROUP BY ';
      var eb = ind.length + prefix.length;
      this.newLine(ind, cl.type, eb);
      this.appendToken(words[0], true);
      this.appendToken(words[1]);
      ctx = {
        type: cl.type, ind: ind, contInd: ind + spaces(prefix.length - 2),
        /* M3b：理由同上面的 SELECT 分支 —— 逗号后置时续行没有行首逗号，缩进要用 prefixLen。 */
        commaInd: ind + spaces(this.opts.commaLocation ? prefix.length : prefix.length - 1),
        commaBreak: true,
        exprBase: eb, ddl: false
      };
      break;
    }

    case 'union':
      this.newLine(ind, 'union');
      this.appendToken(words[0], true);
      for (k = 1; k < words.length; k++) this.appendToken(words[k]);
      ctx = { type: 'stmt', ind: ind, contInd: ind, commaInd: ind, commaBreak: false, exprBase: ind.length, ddl: false };
      break;

    case 'limit':
    case 'simple':
      this.newLine(ind, cl.type);
      this.appendToken(words[0], true);
      for (k = 1; k < words.length; k++) this.appendToken(words[k]);
      ctx = { type: 'stmt', ind: ind, contInd: ind, commaInd: ind, commaBreak: false, exprBase: ind.length, ddl: false };
      break;

    case 'stmtStart':
      this.newLine(ind, 'stmt');
      this.appendToken(words[0], true);
      ctx = { type: 'stmt', ind: ind, contInd: ind, commaInd: ind, commaBreak: false, exprBase: ind.length, ddl: false };
      break;

    case 'ddl':
      this.newLine(ind, 'ddl');
      this.appendToken(words[0], true);
      ctx = { type: 'ddl', ind: ind, contInd: ind, commaInd: ind, commaBreak: false, exprBase: ind.length, ddl: true };
      break;

    default:
      return null;
  }
  return ctx;
};

/* ---------------------------- 主循环 ---------------------------- */

Formatter.prototype.formatTokens = function (tokens, start, end, ind, mode) {
  var ctx = {
    type: mode === 'paren' ? 'paren' : 'stmt',
    ind: ind,
    contInd: ind,
    commaInd: ind,
    commaBreak: mode === 'paren',
    exprBase: ind.length,
    ddl: false
  };

  var firstCode = start;
  while (firstCode < end && tokens[firstCode].type === 'comment') firstCode++;

  /* betweenPending 要记录"BETWEEN 出现的嵌套层级"：
   * 旧版只用一个布尔值，`a BETWEEN CASE WHEN x=1 AND z=2 THEN ... END AND 5`
   * 里 CASE 内层的 AND 会先把标记吃掉，导致真正的配对 AND 被当成条件分隔符换行（P2-9）。
   * 括号不需要单独计数——handleParen 会把整个括号组一次性消费掉，
   * 括号内部的 AND 根本不会走到这里；只有 CASE...END 留在同一层需要跟踪。 */
  var betweenDepth = -1;
  var caseDepth = 0;

  /* P1-13（2026-11-02 审计）：片段以 AND / OR 开头时，整段其实是 WHERE
   * 或 ON 的一部分。旧实现把初始 ctx.type 固定成 "stmt"，而 AND 的换行
   * 只认 "where" / "on" / "having"，于是
   *       and a = 1
   *       and b = 2
   * 被压成一行 `AND a = 1 AND b = 2` —— 用户选中的 2 行变 1 行。
   * 这里把这种片段的初始上下文当成条件上下文，AND/OR 正常换行。
   * 只在**首个代码词**是 AND/OR 时生效，不影响正常语句。 */
  if (firstCode < end) {
    var firstUp = String(tokens[firstCode].upper || '');
    if (firstUp === 'AND' || firstUp === 'OR') {
      ctx.type = 'where';
      ctx.contInd = ind;
    }
  }

  var i = start;

  while (i < end) {
    var tk = tokens[i];

    if (tk.type === 'comment') { this.emitComment(tk, ctx); i++; continue; }

    var depthNow = caseDepth;

    /* WITH 子查询之间：收尾的 ")" 独立成行，逗号放到下一行行首（, cte_name AS） */
    if (tk.type === 'punct' && tk.value === ',' && ctx.type === 'with') {
      if (this.opts.commaLocation) {
        if (this.cur) this.cur.text = rtrim(this.cur.text) + ',';
      } else {
        this.newLine(ind, 'with');
        this.appendToken({ type: 'punct', value: ',' }, true);
      }
      i++;
      continue;
    }

    /* 路径片段（/user/select/t.jar）：段内直接相连，段首按正常空格规则。
     * 整段一次性拼接，避免逐 token 触发空格规则（例：hdfs:// 的 ":" 与 "//"）。 */
    if (tk.path) {
      var segEnd = i;
      /* P0-1（2026-11-05 复核）：**按段**收集，不能把所有相邻的 path token
       * 一律吞进一段。markPathTokens 以空白为界分段，
       * `add jar /a/x.jar /b/y.jar` 里两段的 token 都带 path 标记，
       * 旧循环会把它们拼成一个字符串 `/a/x.jar/b/y.jar` ——
       * 一个不存在的路径，Hive 作业启动即 ClassNotFoundException。
       * 遇到"上一 token 与当前 token 之间有空白"就断开。 */
      while (segEnd < end && tokens[segEnd].path) {
        if (segEnd > i) {
          var segPrev = tokens[segEnd - 1];
          if (typeof segPrev.end !== 'number' || typeof tokens[segEnd].start !== 'number' ||
              segPrev.end !== tokens[segEnd].start) break;
        }
        segEnd++;
      }
      var segText = '';
      for (var s2 = i; s2 < segEnd; s2++) segText += tokens[s2].value;
      var prevTok = i > 0 ? tokens[i - 1] : null;
      /* P0-1（2026-11-05 复核）：**只有与上一段末尾紧贴**才是同一段。
       * 旧判据只看 `prevTok.path`，而 markPathTokens 是**按空白分段**标记的，
       * 于是 `add jar /a/x.jar /b/y.jar` 的两个独立路径被直接拼接成
       * `/a/x.jar/b/y.jar` —— 一个不存在的路径，作业启动即失败。
       * 两段之间原本有空白（prevTok.end !== tk.start）时必须按普通 token 输出，
       * 让 spaceBetween 补回那个空格。 */
      var glued = !!(prevTok && prevTok.path &&
        typeof prevTok.end === 'number' && typeof tk.start === 'number' &&
        prevTok.end === tk.start);
      if (glued) {
        this.appendToken({ type: 'punct', value: segText }, true);
      } else {
        /* 不紧贴：这是**另一段**独立路径，按普通词输出，让空格规则补回原文的空白。
         * 这里必须清掉 `path` 标志 —— spaceBetween 对 `prev.path && tok.path`
         * 一律不加空格（段内拼接的约定），留着它同样会粘成一条路径。 */
        this.appendToken({ type: 'word', value: segText, upper: segText, noCase: true }, false);
      }
      i = segEnd;
      continue;
    }

    if (tk.type === 'punct' && tk.value === '(') {
      i = this.handleParen(tokens, i, end, ind, ctx);
      continue;
    }
    /* 孤立的 ")"（没有对应左括号）：原样输出，不能静默丢弃 */
    if (tk.type === 'punct' && tk.value === ')') {
      this.appendToken(tk, false);
      i++;
      continue;
    }

    /* M-5：**方括号内的逗号不是列分隔符**。
     * `array[1,2,3]` / `map['a','b']` / T-SQL `[a,b]` 里的逗号属于那个字面量，
     * 旧实现让它们走 `ctx.commaBreak` 分支，于是
     *     SELECT ARRAY[1
     *           ,2
     *           ,3]
     * 把一个数组字面量拆成"三个字段"，语义没变但可读性被毁，
     * 而且和 extractddl 的"一列一行"逻辑互相干扰。
     * 这里用一个方括号深度计数：深度 > 0 时跳过所有换行/逗号处理，
     * 只按普通 token 逐个拼接（内部的空格仍由 spaceBetween 决定）。 */
    if (tk.type === 'punct' && tk.value === '[') {
      var bd = 0, bj = i;
      for (; bj < end; bj++) {
        var bt2 = tokens[bj];
        if (bt2.type === 'punct' && bt2.value === '[') bd++;
        else if (bt2.type === 'punct' && bt2.value === ']') { bd--; if (bd === 0) break; }
      }
      if (bd === 0 && bj < end) {
        /* 完整的方括号组：整体按行内方式渲染，内部不换行 */
        for (var bq = i; bq <= bj; bq++) {
          this.appendToken(tokens[bq], bq === i ? false : undefined);
        }
        i = bj + 1;
        continue;
      }
      /* 未闭合：退回普通处理 */
    }

    if (tk.type === 'word') {
      var upper = tk.upper;

      /* CASE ... END 嵌套计数：END 先减，这样 END 本身算"外层"；
       * CASE 先进再算，让 CASE 内部的 BETWEEN/AND 记在内层。 */
      if (upper === 'END') caseDepth = Math.max(0, caseDepth - 1);
      depthNow = caseDepth;
      if (upper === 'CASE') { caseDepth++; }

      /* 「语句开头」不只是整条语句的第一个 token：
       *   WITH cte AS ( ... ) INSERT OVERWRITE TABLE t ...
       * 里 INSERT 前面是 CTE 体的配对 ")"，它同样是一条语句的主语位置。
       * 旧判定只看 i === firstCode，于是 INSERT / DELETE / UPDATE / MERGE
       * 全部被当成普通词粘在 ")" 行尾（SELECT 不受影响，因为它在 switch 里
       * 走的是子句分支）。
       *
       * 条件刻意收窄：只认「WITH 上下文 + 前一个 token 是 ")"」，
       * 不会误伤子查询别名 FROM (...) a、 (SELECT ...) UNION ... 这类写法。 */
      var atStmtStart = (i === firstCode) ||
        (ctx.type === 'with' && i > start &&
         tokens[i - 1].type === 'punct' && tokens[i - 1].value === ')');
      var cl = matchClause(tokens, i, end, atStmtStart);
      if (cl) {
        var newCtx = this.startClause(cl, tokens, i, end, ind);
        if (newCtx) { i += cl.len; ctx = newCtx; continue; }
      }

      if (upper === 'BETWEEN') betweenDepth = depthNow;

      if (upper === 'AND' || upper === 'OR') {
        /* 只有"同一层"的 AND 才是 BETWEEN 的配对 AND；
         * 内层（CASE / 括号 / 子查询）里的 AND 不动标记。 */
        if (upper === 'AND' && betweenDepth === depthNow) {
          betweenDepth = -1;
        } else if (ctx.type === 'where' || ctx.type === 'on' || ctx.type === 'having') {
          /* CASE 表达式内部的 AND 不应该被当成 WHERE 的条件分隔符（P2-6） */
          if (caseDepth === 0) {
            this.newLine(ctx.contInd, 'cond');
            this.appendToken(tk, true);
            i++;
            continue;
          }
        }
      }

      if (ctx.ddl && DDL_BREAK[upper] && this.hasText()) {
        this.newLine(ind, 'ddl');
        this.appendToken(tk, true);
        i++;
        continue;
      }
    }

    /* L-9：comma_location=true 的语义是"逗号跟在字段后面"，**不是**"所有字段挤一行"。
     * 旧实现在这里直接跳过换行，于是 convertCommaLocation（它只会处理
     * "以逗号开头的行"）永远没有输入，最终输出 `SELECT a, b, c` 一整行 ——
     * 与配置说明「把逗号放在字段后面」完全不符，而且列一多就没法读。
     * 现在：无论逗号在源文本里是前置还是后置，都**先换行**，再把逗号补回上一行行尾。
     * 这样两种源写法会收敛到同一个中间态，二轮格式化依然稳定（H-1）。 */
    if (tk.type === 'punct' && tk.value === ',' && ctx.commaBreak) {
      /* 第六轮审计（A-12）：**DDL 列定义列表**里的「列, -- 注释」必须让逗号
       * 留在这一列的末尾。旧行为是新起一行只放一个 `,`，再把注释接上去：
       *     a INT
       *     ,     -- 第一列
       *     b STRING
       * 逗号与它分隔的列被拆到两行，注释还挂在一个孤零零的逗号后面，
       * 后续 alignComments 再补一串空格对齐，可读性很差。
       * 正确形态（与 sqlddl 一致）：
       *     a INT, -- 第一列
       *     b STRING
       *
       * 只对 `paren`（DDL 列定义列表）生效：select 列表的 `, -- 注释` 形态
       * 有幂等性约束（见 convertCommaLocation 里 M2 那段注释），改它会引入抖动。 */
      var afterComma = tokens[i + 1];
      /* P2-4（2026-11-05 复核）：注释**独占一行**时不要让它把逗号孤立出来。
       * 输入
       *     select a,
       *     -- c
       *     b from t
       * 以前输出
       *     SELECT a
       *           ,
       *     -- c
       *           b
       * 逗号自己占一行、注释又独占一行，读起来比原文更差，也与
       * 「不再出现只有逗号的一行」的意图矛盾。
       * 现在把这条**单行**注释接到当前列的行尾（与 `, -- c` 同一归属），
       * 逗号随后照常换行/前置 —— 两种逗号风格下都不会再出现孤立逗号行。
       * 多行块注释不动（它本身就是要整块保留的）。 */
      if (afterComma && afterComma.type === 'comment' && afterComma.kind === 'line' &&
          afterComma.nl > 0 && !this.opts.commaLocation &&
          this.cur && this.cur.text !== '' &&
          findCommentPos(this.cur.text, this.lex.hashComment) === -1) {
        var hoistVal = String(afterComma.value).replace(/\s+$/, '');
        if (hoistVal && hoistVal.indexOf('\n') < 0) {
          this.cur.text = rtrim(this.cur.text) + ' ' + hoistVal;
          this.cur.kind = 'commentTail';
          i++;                          /* 注释已消费，逗号继续按常规处理 */
          afterComma = tokens[i + 1];
        }
      }
      if (ctx.type === 'paren' && afterComma && afterComma.type === 'comment' &&
          afterComma.nl === 0 && this.cur && this.cur.text !== '' &&
          findCommentPos(this.cur.text, this.lex.hashComment) !== 0) {
        this.cur.text = rtrim(this.cur.text) + ',';
        this.cur.kind = 'paren';
        i++;
        continue;                       /* 注释留给下一轮循环，仍接在这一行 */
      }
      if (this.opts.commaLocation) {
        /* 逗号要补到**上一行代码**的行尾。当前行可能已经是空白行 ——
         * 例如 `select a -- first` + `, b`：注释触发 emitComment 换行后，
         * this.cur 是一个刚建好的空行。此时若往空行写逗号，会得到
         *     SELECT a, -- first
         *     ,            ← 空行上只有一个逗号
         *     b
         * 所以当前行是空的时候要往前找最后一行非空行补逗号，
         * 并且**不要再换行**（当前行已经是新的空行，直接用它接下一个字段）。
         *
         * 但**行尾是 `--` 行注释时绝对不能补逗号**：补上去会变成注释的一部分
         * （`SELECT a -- first,` → 逗号被注释吃掉，语句少一个分隔符），
         * 安全网虽然会回退原文（语义没坏），但这一行就永远格式化不了。
         * 这种情况退回"行首逗号"写法，语义与可读性都正确。 */
        var target = (this.cur && this.cur.text !== '') ? this.cur : null;
        if (!target) {
          for (var li = this.lines.length - 1; li >= 0; li--) {
            if (this.lines[li].text !== '') { target = this.lines[li]; break; }
          }
        }
        /* 上一行若以**行注释**结尾（`-- …` 或 MySQL 的 `# …`），
         * 逗号绝不能补在行尾 —— 那会被注释吃掉（`b #note,` 里逗号成了注释内容），
         * 安全网发现 token 不等价后整篇回退，用户看到「按了没反应」。
         * 正确做法与 convertCommaLocation 一致：把逗号**插到注释之前**。 */
        var tailCp = target ? findCommentPos(target.text, this.lex.hashComment) : -1;

        /* 但如果上一行**整行就是注释**（cp === 0），把逗号插进去会得到
         * `, -- note`，下一轮这条注释又会被吸到前一行，来回抖（非幂等）。
         * 这种情况与 convertCommaLocation 的处理保持一致：原地不动，
         * 逗号留在当前行的行首。 */
        if (tailCp === 0) {
          if (!this.cur || this.cur.text !== '') {
            this.newLine(ctx.commaInd, ctx.type === 'paren' ? 'paren' : ctx.type, ctx.exprBase);
          }
          this.appendToken(tk, true);
          i++;
          continue;
        }

        if (tailCp > 0) {
          var head = target.text.slice(0, tailCp).replace(/\s+$/, '');
          var tail = target.text.slice(tailCp).replace(/^\s+/, '');
          target.text = head + ', ' + tail;
        } else if (target) {
          target.text = rtrim(target.text) + ',';
        }

        /* 逗号后面紧跟**同一行的注释**时不要换行：让它通过 emitComment
         * 接在当前行（`b, #note`）。否则注释会被甩到下一行独自成行，
         * 第二遍格式化就把它当成"上一行代码的注释"，产生非幂等。 */
        var after = tokens[i + 1];
        var sameLineComment = !!(after && after.type === 'comment' && after.nl === 0);
        if (!sameLineComment && this.cur && this.cur.text !== '') {
          this.newLine(ctx.commaInd, ctx.type === 'paren' ? 'paren' : ctx.type, ctx.exprBase);
        }
        i++;
        continue;
      }
      /* F14（2026-10-29 复核）：逗号前置风格下，`select a, -- first` 的注释
       * 原本在 a 所在行的行尾；旧行为先换行再写逗号，注释就挂到了
       * 孤零零的逗号后面：
       *     SELECT a
       *           , -- first
       *           b
       * 现在把同行注释先接到**这一列**的行尾，再换行写逗号：
       *     SELECT a  -- first
       *           ,b
       * 注释归属与原文一致，第二轮也稳定（注释已在前一行行尾，
       * 逗号是下一条逻辑行的开头，convertCommaLocation 不会再去动它）。 */
      var cmAfter = tokens[i + 1];
      if (!this.opts.commaLocation && cmAfter && cmAfter.type === 'comment' &&
          cmAfter.nl === 0 && this.cur && this.cur.text !== '' &&
          findCommentPos(this.cur.text, this.lex.hashComment) === -1) {
        var cmVal = String(cmAfter.value).replace(/\s+$/, '');
        if (cmVal && cmVal.indexOf('\n') < 0) {
          /* 必须与常规注释通道（pushComment / emitComment）用**同一个**分隔符，
           * 否则一轮两个空格、二轮一个空格 → 非幂等。 */
          this.cur.text = rtrim(this.cur.text) + ' ' + cmVal;
          this.cur.kind = 'commentTail';
          i += 2;                       /* 逗号 + 注释都已消费 */
          this.newLine(ctx.commaInd, ctx.type === 'paren' ? 'paren' : ctx.type, ctx.exprBase);
          this.appendToken(tk, true);
          continue;
        }
      }

      this.newLine(ctx.commaInd, ctx.type === 'paren' ? 'paren' : ctx.type, ctx.exprBase);
      this.appendToken(tk, true);
      i++;
      continue;
    }

    this.appendToken(tk);
    i++;
  }

  return ctx;
};

/* ---------------------------- 语句 ---------------------------- */

function splitStatements(tokens) {
  var stmts = [];
  var cur = [];
  var depth = 0;

  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];

    /* P0-9：客户端命令行各自独立，不与前后 SQL 合并 */
    if (t.type === 'client') {
      if (cur.length) stmts.push({ tokens: cur, terminated: false });
      cur = [];
      stmts.push({ tokens: [t], terminated: true, client: true });
      depth = 0;
      continue;
    }

    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth = Math.max(0, depth - 1);

    cur.push(t);

    /* H3：T-SQL 的 `GO` 是**批分隔符**，等价于分号，但它前面没有分号。
     * 旧实现只按 `;` 切语句，`GO` 落在上一条语句的末尾被当成隐式别名，
     * 输出成 `FROM t go`（小写、粘在 FROM 行尾）。SSMS 里 `FROM t go` 是
     * 语法错误 —— 那是用户直接拿去执行的脚本。
     * 判据（必须同时成立，避免误伤叫 go 的列/别名）：
     *   · 单独成行（前面有换行，或它是语句的第一个 token）；
     *   · 它本身是这一行的最后一个 token（后面没有同行的其它代码）。
     * 真正的列名 `select go from t`、别名 `select a as go` 都不满足"单独成行 + 行尾"。 */
    if (t.type === 'word' && t.upper === 'GO' && depth === 0) {
      var prevG = tokens[i - 1];
      var nextG = tokens[i + 1];
      var aloneOnLine = (t.nl > 0 || !prevG);
      var endsHere = !nextG || nextG.nl > 0 || nextG.type === 'comment';
      if (aloneOnLine && endsHere) {
        /* GO 自己**不进入**上一条语句：它必须独立成行，且要大写。
         * 注意 `cur.push(t)` 已经在上面执行过，这里先把它弹出去，
         * 否则 GO 会同时出现在上一条语句末尾和独立批行里
         * （token 序列多一个 GO → 安全网判不等价 → 整篇回退）。 */
        if (cur.length && cur[cur.length - 1] === t) cur.pop();
        if (cur.length) stmts.push({ tokens: cur, terminated: false });
        cur = [];
        stmts.push({
          tokens: [{
            type: 'word', value: 'GO', upper: 'GO', keyword: true,
            nl: 0, start: t.start, end: t.end
          }], terminated: true, batchGo: true
        });
        continue;
      }
    }

    if (t.type === 'punct' && t.value === ';' && depth === 0) {
      var j = i + 1;
      while (j < tokens.length && tokens[j].type === 'comment' && tokens[j].nl === 0) {
        cur.push(tokens[j]);
        j++;
      }
      stmts.push({ tokens: cur, terminated: true });
      cur = [];
      i = j - 1;
    }
  }

  if (cur.length) stmts.push({ tokens: cur, terminated: false });
  return stmts;
}

Formatter.prototype.formatStatement = function (stmt) {
  this.lines = [];
  this.cur = null;

  /* P0-9：客户端命令行整行原样输出，不参与任何排版 */
  if (stmt.client) {
    for (var ci = 0; ci < stmt.tokens.length; ci++) {
      var cv = String(stmt.tokens[ci].value).replace(/\s+$/, '');
      if (cv) this.lines.push({ ind: '', text: cv, kind: 'client', exprBase: 0 });
    }
    return this.lines;
  }

  var toks = stmt.tokens;
  var semiIdx = -1;
  /* F4（2026-10-29 复核）：分号后面如果还有**代码**（begin … ; end 的 end、
   * declare x int; set x = 1; 的第二句），那这个分号是过程体内部的语句分隔符，
   * 不是本条语句的终止符。旧实现取"最后一个分号"，于是 end 落进 tail，
   * 被 pushComment() 原样输出 —— 大小写不处理、还挤在同一行。
   * 现在只认"后面全是注释"的那个分号。 */
  for (var i = toks.length - 1; i >= 0; i--) {
    if (toks[i].type === 'punct' && toks[i].value === ';') {
      var onlyCommentsAfter = true;
      for (var sa = i + 1; sa < toks.length; sa++) {
        if (toks[sa].type !== 'comment') { onlyCommentsAfter = false; break; }
      }
      if (onlyCommentsAfter) { semiIdx = i; break; }
    }
  }

  var body = semiIdx >= 0 ? toks.slice(0, semiIdx) : toks;
  var tail = semiIdx >= 0 ? toks.slice(semiIdx + 1) : [];

  /* F4（2026-10-29 复核）：分号后面可能还有**代码**（过程体收尾的 END、
   * 或者 `; end if` 里的 END IF）。它们不能进 tail —— tail 是"注释专用通道"，
   * pushComment() 原样输出 value，不做大小写处理。
   * 这里把 tail 拆成"代码段"与"注释段"：代码段单独再跑一次 formatTokens，
   * 自然另起一行且走完整的大小写/缩进逻辑。 */
  var tailCode = [];
  while (tail.length && tail[0].type !== 'comment') tailCode.push(tail.shift());

  /* 语句末尾如果只剩注释（`select a from t -- note` + 换行 + `;`），
   * 分号必须挂到"最后一行代码"上，而不是挂到注释行尾——
   * 旧版会输出 `FROM t -- note;`，分号被并进注释，语句失去终止符（P1-3）。 */
  var trailingComments = [];
  for (var k = body.length - 1; k >= 0; k--) {
    if (body[k].type === 'comment') trailingComments.unshift(body[k]);
    else break;
  }
  var codeBody = body.slice(0, body.length - trailingComments.length);

  if (codeBody.length) {
    this.indent = '';
    this.formatTokens(codeBody, 0, codeBody.length, '', 'stmt');
  }

  /* F4：分号后的代码段（END / END IF …）另起一行格式化，不并进上一行。 */
  if (tailCode.length) {
    if (this.cur) { this.lines.push(this.cur); this.cur = null; }
    this.indent = '';
    this.formatTokens(tailCode, 0, tailCode.length, '', 'stmt');
  }

  if (this.cur) { this.lines.push(this.cur); this.cur = null; }

  var lines = this.lines.filter(function (l) { return l.text !== ''; });

  /* 分号的落点决定「安全性」和「幂等性」两件事，必须按注释的原始位置分情况：
   *
   * a) 末尾注释跟代码同处一行（`select a from t -- note` + 下一行 `;`）
   *      → `FROM t; -- note`   分号在注释之前，语句有终止符（P1-3）
   *      下一轮这条注释在 `;` 之后就满足 nl === 0，会被再次并回行尾 → 稳定。
   * b) 末尾注释自己独占一行（`select a from t` + `-- note` + `;`）
   *      → 保持注释在前、分号单独成行：
   *            FROM t
   *            -- note
   *            ;
   *      若把它挪到分号之后，第二轮这条注释就变成"下一条语句的前导注释"，
   *      空行位置随之漂移（实测会来回抖）。保持原顺序则完全稳定。 */
  var ownLineTail = trailingComments.length > 0 &&
    trailingComments[trailingComments.length - 1].nl > 0;

  if (semiIdx >= 0 && !ownLineTail) {
    if (lines.length) {
      var last = lines[lines.length - 1];
      last.text = rtrim(last.text) + ';';
      last.kind = 'stmt';
    } else if (trailingComments.length) {
      /* P0-10（2026-11-04 复核）：整条语句**只有注释**，例如 MySQL 的可执行注释
       *     /*!40101 SET a=1 *\/;
       * 旧实现先塞一个 `;` 行、再把注释当"行尾注释"接上去，输出
       *     ; /*!40101 SET a=1 *\/
       * 分号跑到注释前面去了 —— 对 MySQL 来说那个注释是**会执行**的语句，
       * 顺序一变语义就变。这里保持注释在前、分号挂在注释行尾（与原顺序一致，
       * 且再跑一遍仍得到同样的输出，幂等）。 */
      for (var tcx = 0; tcx < trailingComments.length; tcx++) pushComment(trailingComments[tcx], false);
      trailingComments.length = 0;
      var lastc = lines[lines.length - 1];
      lastc.text = rtrim(lastc.text) + ';';
    } else {
      lines.push({ ind: '', text: ';', kind: 'stmt', exprBase: 0 });
    }
  }

  function pushComment(tk2, allowInline) {
    var v = String(tk2.value).replace(/\s+$/, '');
    if (!v) return;

    var anchor = lines.length ? lines[lines.length - 1] : null;
    if (allowInline && anchor && anchor.kind !== 'comment' && tk2.nl === 0 && v.indexOf('\n') < 0) {
      anchor.text = rtrim(anchor.text) + ' ' + v;
      anchor.kind = 'commentTail';
      return;
    }
    lines.push({ ind: '', text: v, kind: 'comment', exprBase: 0, multiline: v.indexOf('\n') >= 0 });
  }

  for (var c = 0; c < trailingComments.length; c++) pushComment(trailingComments[c], true);
  if (semiIdx >= 0 && ownLineTail) {
    lines.push({ ind: '', text: ';', kind: 'stmt', exprBase: 0 });
  }
  /* `;` 之后同一行的注释（`... ; -- x`）保持行尾形式 */
  for (var t = 0; t < tail.length; t++) pushComment(tail[t], true);

  return lines;
};

/* 语句组之间**不加空行**的续接词（L-3）。
 * 过程化代码 `BEGIN … ; END` 会被 splitStatements 切成两条语句
 * （第一条以 `;` 结束、第二条只剩 `END`），formatLines 于是在中间插了一个空行：
 *     BEGIN
 *     SELECT 1;
 *
 *     END
 * 这不是用户写的空行，是分号切分带来的假象。下面这些词开头的"语句"
 * 其实是上一段代码的延续/收尾，不该被空行隔开。 */
var NO_BLANK_BEFORE = {
  END: 1, ELSE: 1, ELSIF: 1, ELSEIF: 1, EXCEPTION: 1, WHEN: 1, UNTIL: 1,
  CLOSE: 1, EXIT: 1, CONTINUE: 1, LOOP: 1, LEAVE: 1, ITERATE: 1,
  COMMIT: 0, ROLLBACK: 0     /* 这两条是独立语句，保留空行 */
};

/* 取一组 token 里第一个"代码词"的大写形式（跳过注释）。 */
function firstCodeWord(tokens) {
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (t.type === 'comment') continue;
    if (t.type === 'word') return String(t.upper);
    return '';
  }
  return '';
}

Formatter.prototype.formatLines = function (sql) {
  var tokens = tokenize(sql);
  var stmts = splitStatements(tokens);
  var out = [];

  for (var s = 0; s < stmts.length; s++) {
    var lines = this.formatStatement(stmts[s]);
    if (!lines.length) continue;
    /* L-3：续接语句（END / ELSE / WHEN / EXCEPTION …）前面不插空行。 */
    if (out.length && !NO_BLANK_BEFORE[firstCodeWord(stmts[s].tokens)]) {
      out.push({ ind: '', text: '', kind: 'blank', exprBase: 0 });
    }
    /* P4-1：concat 每次都复制整个数组 → O(n²)。用逐项 push 常数摊还。
     * M7（第三轮审计）：这里原本是 `out.push.apply(out, lines)`，参数个数等于
     * lines 长度，单条语句 20 万列时直接 `Maximum call stack size exceeded`
     * （超出引擎的实参上限，约 12 万）。改回循环后不再有上限。 */
    for (var li2 = 0; li2 < lines.length; li2++) out.push(lines[li2]);
  }

  /* 长代码行按子句拆行，但结构行（注释/空行等）不重新拼装 */
  out = this.normalizeLines(out);
  /* 先合并能被 maxWidth 容下的续行（"换行太短"的解法），再对仍然超长的行折行 */
  out = this.compactLines(out);
  out = this.wrapLines(out);
  out = this.alignCaseBlocks(out);
  if (this.opts.commaLocation) out = this.convertCommaLocation(out);
  out = this.alignAs(out);
  out = this.alignComments(out);

  /* 去掉空行末尾多余空格 */
  out.forEach(function (l) {
    if (!l.multiline) l.text = rstripSpTab(l.text);
  });

  return out;
};

Formatter.prototype.format = function (sql) {
  var lines = this.formatLines(sql);
  var arr = [];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].text === '') arr.push('');
    else arr.push(lines[i].ind + lines[i].text);
  }
  /* 去掉首尾空行 */
  while (arr.length && arr[0] === '') arr.shift();
  while (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr.join('\n');
};

/* ---------------------------- CASE 块缩进 / WHEN-THEN 对齐 ---------------------------- */

/* 找到行内指定关键字在"最浅括号层"出现的位置（引号内不算） */
function findKeywordShallow(text, keyword, from) {
  var target = keyword.toUpperCase();
  var minDepth = 99, bestPos = -1;
  var depth = 0, quote = null;
  var start = from || 0;

  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (quote) { if (ch === '\\' && LEX.backslash !== false) { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (i < start) continue;
    if (!/[A-Za-z_]/.test(ch) || (i > 0 && /[A-Za-z0-9_$@#.]/.test(text.charAt(i - 1)))) continue;

    var w = /^[A-Za-z_]+/.exec(text.slice(i))[0].toUpperCase();
    if (w === target) {
      if (depth < minDepth) { minDepth = depth; bestPos = i; }
    }
    i += w.length - 1;
  }

  return bestPos;
}

/* 从 from 开始累计显示宽度，返回"宽度不超过 avail 列"的最远字符下标。
 * 用于把"可用列数"换算成字符串下标（中文占 2 列，两者不能直接相加）。 */
function indexAtVisWidth(text, from, avail) {
  var w = 0, i = from;
  for (; i < text.length; i++) {
    var cw = charWidth(text.charAt(i));
    if (w + cw > avail) break;
    w += cw;
  }
  return i;
}

/* 在 (from, limit] 内找一个"安全断点"：断点只能落在 token 边界上，
 * 绝不允许把标识符 / 数字 / 字符串切成两半。
 * 优先返回 <= limit 的最大安全位置；若该区间内没有任何安全位置
 * （例如单个超长标识符），返回该 token 的结束位置——宁可超宽也不拆字段。 */
function safeCutPos(text, from, limit) {
  var toks = tokenize(text);
  var lastSafe = -1;
  var i;

  for (i = 0; i < toks.length; i++) {
    var s = toks[i].start;
    if (s <= from) continue;              /* 断点必须严格大于 from */
    if (s > limit) break;                 /* 已经超出允许宽度 */
    /* 断点前必须是空白，否则说明落在了复合词（a.b、x::y）内部 */
    if (s > 0 && !/\s/.test(text.charAt(s - 1))) continue;
    lastSafe = s;
  }
  if (lastSafe > from) return lastSafe;

  /* 没有安全断点：退到 from 之后第一个 token 的末尾，绝不切开 token */
  for (i = 0; i < toks.length; i++) {
    if (toks[i].end > from) return toks[i].end;
  }

  return text.length;
}

/* 在 (from, limit] 内找最后一个"运算符断点"：
 * 只认 + - * / || >= <= > < = <> != 和逗号等，断开后下一行以运算符开头，
 * 既不会拆字段，读起来也像正常的表达式换行。 */
var CUT_OPS = {
  '+': 1, '-': 1, '*': 1, '/': 1, '||': 1, ',': 1,
  '>=': 1, '<=': 1, '>': 1, '<': 1, '=': 1, '<>': 1, '!=': 1, '&': 1, '|': 1, '%': 1
};

/* 就近的"关键字级"断点：真正超宽时优先退回这些位置，而不是从算式中间劈开。 */
var KEYWORD_CUT = {
  AND: 1, OR: 1, WHEN: 1, THEN: 1, ELSE: 1, ON: 1, WHERE: 1, HAVING: 1,
  SELECT: 1, FROM: 1, JOIN: 1, GROUP: 1, ORDER: 1, LIMIT: 1, UNION: 1,
  PARTITION: 1, ROWS: 1, RANGE: 1, GROUPS: 1, BETWEEN: 1
};

/* 在 (from, limit] 区间里找最靠右的关键字断点（词边界，跳过引号内容） */
function keywordCut(text, from, limit) {
  var best = -1;
  var quote = null;
  for (var i = Math.max(0, from); i < text.length && i <= limit; i++) {
    var ch = text.charAt(i);
    if (quote) { if (ch === '\\' && LEX.backslash !== false) { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (!/[A-Za-z_]/.test(ch)) continue;
    if (i > 0 && /[A-Za-z0-9_$@#.]/.test(text.charAt(i - 1))) continue;
    var w = /^[A-Za-z_]+/.exec(text.slice(i))[0];
    if (i > from && KEYWORD_CUT[w.toUpperCase()]) best = i;
    i += w.length - 1;
  }
  return best;
}

function operatorCut(text, from, limit) {
  var toks = tokenize(text);
  var best = -1;

  for (var i = 0; i < toks.length; i++) {
    var tk = toks[i];
    if (tk.start <= from) continue;
    if (tk.start > limit) break;
    if (tk.type !== 'punct' || !CUT_OPS[tk.value]) continue;
    /* 断点前必须是空白，避免把 a-b 这类原本无空格的表达式拆开 */
    if (tk.start > 0 && !/\s/.test(text.charAt(tk.start - 1))) continue;
    /* 后面紧跟的也不能是另一个运算符的中间状态 */
    best = tk.start;
  }

  return best;
}

/* ============================ 断点“整块逻辑”对齐 ============================
 * 用户预设（2026-11-04）：折行位置取「屏幕宽度 W 的 80%」，并且**不得把一段
 * 逻辑从中间劈开**，允许向前或向后舍入到逻辑块的边界。
 *
 * 反例（旧实现）：
 *     SELECT price
 *     * cnt AS amt          ← `* cnt` 孤零零落到下一行行首
 * 期望（两种都接受）：
 *     SELECT price * cnt    ← 向后舍入到 cnt 结束
 *         AS amt
 *     SELECT
 *         price * cnt AS amt ← 向前舍入到 price 开始
 *
 * 判据：断点正好落在**二元运算符**上、且它左右各是一个简单操作数
 * （标识符 / 数字 / 字符串）时，把断点挪到「左侧操作数起点」或「右侧操作数
 * 终点」，取离 80% 列更近的那个。复杂操作数（子查询 / 函数调用 / 括号表达式）
 * 不挪动 —— 那种情况下从运算符处断开才是正常写法。
 * ========================================================================== */

var BINARY_OPERATOR_TOKENS = {
  '+': 1, '-': 1, '*': 1, '/': 1, '%': 1, '||': 1,
  '&': 1, '|': 1, '^': 1, '=': 1, '<>': 1, '!=': 1, '>': 1, '<': 1, '>=': 1, '<=': 1
};

function isSimpleOperandToken(tk) {
  if (!tk) return false;
  return tk.type === 'word' || tk.type === 'number' ||
    tk.type === 'string' || tk.type === 'quoted';
}

/* 把断点从二元运算符挪到逻辑块边界。
 *   text      —— 当前行的代码文本（不含缩进）
 *   pos       —— 候选断点（字符下标）
 *   indVis    —— 该行的缩进列数
 *   targetAbs —— 目标列（80% 处，绝对列号）
 *   hardAbs   —— 允许的最大列（100% 处，绝对列号）
 * 返回新的字符下标；无法安全挪动时原样返回 pos。 */
function snapBreakOutsideOperator(text, pos, indVis, targetAbs, hardAbs, toks) {
  if (!toks) {
    try { toks = tokenize(text); } catch (e) { return pos; }
  }

  /* P-01（2026-11-04 复核）：token 表按 start 升序，用二分定位。
   * 旧实现每片都全表线性扫一遍 —— 长 IN 列表实测 2 973 万次 token 比较。 */
  var i = -1;
  var _lb = lowerBoundTokStart(toks, pos);
  if (_lb < toks.length && toks[_lb].start === pos) i = _lb;
  if (i <= 0) return pos;

  var op = toks[i];
  if (op.type !== 'punct' || !BINARY_OPERATOR_TOKENS[op.value]) return pos;

  var prev = toks[i - 1];
  var next = toks[i + 1];

  /* 通配符 / 一元符号 / 非算式位置：不是二元运算符，不能挪 */
  if (prev && prev.type === 'punct' &&
      (prev.value === '(' || prev.value === '.' || prev.value === ',' ||
       prev.value === '[' || prev.value === ':')) return pos;
  if (!prev || !next) return pos;

  /* 向前舍入到 prev 起点时，必须保证上一行**不以运算符结尾**。
   * `a * b * c` 的第二个 `*` 处断开若无脑退到 b 的起点，会输出
   *     a * b *
   *     c
   * —— 行尾挂着一个运算符，正是要消灭的形态。
   *
   * 链式算式（`a * b * c * …`）没有"整对操作数"可言：无论怎么挪，都会有一侧
   * 以运算符开头或结尾。此时保持原有断点（运算符落在续行行首）即可 ——
   * 这也是 SQL 手写的通行写法，与插件自己 `,b` / `AND x` 的续行风格一致。 */
  var beforePrev = toks[i - 2];
  if (beforePrev && beforePrev.type === 'punct' && BINARY_OPERATOR_TOKENS[beforePrev.value]) {
    return pos;
  }

  var backCol = -1, fwdCol = -1;
  if (isSimpleOperandToken(prev)) {
    backCol = indVis + visLen(text.slice(0, prev.start));
  }
  if (isSimpleOperandToken(next)) {
    fwdCol = indVis + visLen(text.slice(0, next.end));
  }
  if (backCol < 0 && fwdCol < 0) return pos;

  /* 向前舍入不能太离谱（否则整行只剩一小截）；向后舍入不能越过 100% 列 */
  var minBack = Math.max(indVis + 20, targetAbs * 0.45);
  if (backCol >= 0 && backCol < minBack) backCol = -1;
  if (fwdCol >= 0 && fwdCol > hardAbs) fwdCol = -1;

  /* 向后舍入不能把整行"吃掉"：`WHERE aaa… = 1` 的 `=` 处断开时 next.end 就是行尾，
   * 舍过去等于**取消折行**（实测那一行仍然 138 列，远超 120 列屏幕）。
   * 尾巴不足 10 列就认为没有下一个逻辑块，look 回原断点。
   * 注意这一步必须放在下面的早退之前，否则 backCol 已被 minBack 否决时
   * 会直接走 `return next.end` 分支，绕开本检查。 */
  if (fwdCol >= 0 && visLen(text.slice(next.end)) < 10) fwdCol = -1;

  if (backCol < 0 && fwdCol < 0) return pos;
  if (backCol < 0) return next.end;
  if (fwdCol < 0) return prev.start;

  /* 取离目标列更近的一侧；并列时取靠前（行更短、可读性更好） */
  return (fwdCol - targetAbs) < (targetAbs - backCol) ? next.end : prev.start;
}

/* 文本里是否存在 AND / OR 断点（不存在说明是 GREATEST(...) 这类参数列表） */
function hasTopLevelAndOr(text) {
  var depth = 0, quote = null, found = false;

  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (quote) { if (ch === '\\' && LEX.backslash !== false) { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (!/[A-Za-z_]/.test(ch) || (i > 0 && /[A-Za-z0-9_$@#.]/.test(text.charAt(i - 1)))) continue;
    var w = /^[A-Za-z_]+/.exec(text.slice(i))[0].toUpperCase();
    if (w === 'AND' || w === 'OR') { found = true; break; }
    i += w.length - 1;
  }

  return found;
}

/* 把 "WHEN cond THEN result" 之类的片段按 AND / OR（最浅层）折行，
 * 首行可带前缀（如 "CASE " / ",NVL(CASE "），续行统一缩进到 condInd。 */
Formatter.prototype.wrapCondSegments = function (seg, firstInd, prefix, condInd, reserve) {
  var max = this.opts.maxWidth;
  /* 触发折行的硬阈值：一行放进 80%~100% 之间时保持完整，不从中间劈开
   *（用户反馈的 `(a - b) / b >= 0.5` 被截断就是这个阈值取错了）。 */
  var hard = this.opts.hardWidth || max;
  var text = seg;
  reserve = reserve || 0;

  /* 收集最浅层的 AND / OR 断点 */
  var depth = 0, quote = null;
  var breaks = [];
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (quote) { if (ch === '\\' && LEX.backslash !== false) { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (!/[A-Za-z_]/.test(ch) || (i > 0 && /[A-Za-z0-9_$@#.]/.test(text.charAt(i - 1)))) continue;
    var w = /^[A-Za-z_]+/.exec(text.slice(i))[0].toUpperCase();
    if (w === 'AND' || w === 'OR') breaks.push({ pos: i, depth: depth });
    i += w.length - 1;
  }

  var minDepth = 99;
  for (i = 0; i < breaks.length; i++) if (breaks[i].depth < minDepth) minDepth = breaks[i].depth;
  var cand = breaks.filter(function (b) { return b.depth === minDepth; });

  var pieces = [];
  var cursor = 0;
  var first = true;

  while (cursor < text.length) {
    var curInd = first ? firstInd : condInd;
    var pre = first ? (prefix || '') : '';
    var full = max - visLen(curInd) - visLen(pre);
    if (full < 20) full = 20;
    /* 放得下（撑到 100% 也算放得下）就不折 */
    var hardFull = hard - visLen(curInd) - visLen(pre);
    if (hardFull < 20) hardFull = 20;

    /* 宽度一律按"显示列"算：中文 / emoji 占 2 列（P2-10）。
     * 下标仍然用 cursor（字符偏移），只有比较时才换算。 */
    var restLen = visLen(text.slice(cursor));

    /* 剩余内容 + 需要接在末尾的 THEN 结果都放得下 → 收尾 */
    if (restLen + reserve <= full) {
      pieces.push({ ind: curInd, text: pre + text.slice(cursor).replace(/\s+$/, ''), kind: 'case', exprBase: 0 });
      break;
    }
    /* 放不进 80% 但整段仍撑得进 100%：宁可这一行超到 100%，也不从中间劈开 */
    if (restLen + reserve <= hardFull) {
      pieces.push({ ind: curInd, text: pre + text.slice(cursor).replace(/\s+$/, ''), kind: 'case', exprBase: 0 });
      break;
    }
    if (restLen <= full) {
      pieces.push({ ind: curInd, text: pre + text.slice(cursor).replace(/\s+$/, ''), kind: 'case', exprBase: 0 });
      break;
    }
    if (restLen <= hardFull) {
      pieces.push({ ind: curInd, text: pre + text.slice(cursor).replace(/\s+$/, ''), kind: 'case', exprBase: 0 });
      break;
    }

    /* 断行一律按整行可用宽度算，不要因为"给 THEN 留位置"就把条件切得太碎；
     * THEN 结果是否并排由调用方决定。
     * limit 是字符串下标，要用显示宽度换算（full 是列数）。
     * 用硬阈值（100%）来量断点位置：先尽量填满再断。 */
    var limit = indexAtVisWidth(text, cursor, hardFull);
    var best = -1;
    for (i = 0; i < cand.length; i++) {
      if (cand[i].pos > cursor && cand[i].pos <= limit) best = cand[i].pos;
    }
    if (best >= 0) {
      /* 有 AND/OR 可断：但先看能不能整段塞进 100%，能塞就不必在 AND 处断 */
      if (restLen > hardFull) {
        /* 确实塞不下，用 AND/OR 断点 */
      } else {
        pieces.push({ ind: curInd, text: pre + text.slice(cursor).replace(/\s+$/, ''), kind: 'case', exprBase: 0 });
        break;
      }
    }
    if (best < 0) {
      /* 本段没有 AND / OR 可断：
       *   1) 先试关键字断点（就近的 THEN / WHEN / END / ROWS …）；
       *   2) 再退到运算符断点（下一行以运算符开头）；
       * 绝不把字段名或数字劈成两半。 */
      best = keywordCut(text, cursor, limit);
      if (best < 0) best = operatorCut(text, cursor, limit);
    }
    if (best < 0) {
      /* 关键字/运算符都找不到：把剩余的整段放一行（宁宽勿断） */
      best = text.length;
    }
    if (best <= cursor) best = text.length;

    var piece = text.slice(cursor, best).replace(/\s+$/, '');
    pieces.push({ ind: curInd, text: pre + piece, kind: 'case', exprBase: 0 });

    cursor = best;
    while (cursor < text.length && text.charAt(cursor) === ' ') cursor++;
    if (cursor >= text.length) break;
    first = false;
  }

  return pieces.length ? pieces : [{ ind: firstInd, text: (prefix || '') + text, kind: 'case', exprBase: 0 }];
};

/* `CASE WHEN … THEN … ELSE … END` 这种**只有一两个分支**的 CASE 是否应该展开。
 * 判据：最外层 CASE 的同层 WHEN 数量 <= 1。这种 CASE 展开成
 * "WHEN 一行 / THEN 一行 / ELSE 一行 / END 一行" 往往比整行放下多出 2~3 行，
 * 属于用户反馈的"两行便能展示，却换行成三行"。
 * 多分支（WHEN >= 2）的 CASE 展开后竖向对齐，反而更好读，仍然走 splitCase。 */
function singleWhenCase(text) {
  var casePos = -1, depth = 0, quote = null, i;

  for (i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (quote) { if (ch === '\\' && LEX.backslash !== false) { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (!/[A-Za-z_]/.test(ch) || (i > 0 && /[A-Za-z0-9_$@#.]/.test(text.charAt(i - 1)))) continue;
    var w = /^[A-Za-z_]+/.exec(text.slice(i))[0].toUpperCase();
    if (w === 'CASE') { casePos = i; break; }
    i += w.length - 1;
  }
  if (casePos < 0) return false;

  var baseDepth = 0;
  for (i = 0; i < casePos; i++) {
    var c2 = text.charAt(i);
    if (c2 === '(') baseDepth++;
    else if (c2 === ')') baseDepth = Math.max(0, baseDepth - 1);
  }

  var whens = 0, nest = 0;
  depth = baseDepth;
  quote = null;
  for (i = casePos; i < text.length; i++) {
    var ch3 = text.charAt(i);
    if (quote) { if (ch3 === '\\' && LEX.backslash !== false) { i++; continue; } if (ch3 === quote) quote = null; continue; }
    if (ch3 === "'" || ch3 === '"' || ch3 === '`') { quote = ch3; continue; }
    if (ch3 === '(') { depth++; continue; }
    if (ch3 === ')') { depth = Math.max(baseDepth, depth - 1); continue; }
    if (depth !== baseDepth) continue;
    if (!/[A-Za-z_]/.test(ch3) || (i > 0 && /[A-Za-z0-9_$@#.]/.test(text.charAt(i - 1)))) continue;
    var w3 = /^[A-Za-z_]+/.exec(text.slice(i))[0].toUpperCase();
    if (w3 === 'CASE') nest++;
    else if (w3 === 'END') { nest--; if (nest === 0) break; }
    else if (w3 === 'WHEN' && nest === 1) whens++;
    i += w3.length - 1;
  }

  return whens <= 1;
}

/* CASE WHEN 展开：
 *   - CASE 与第一个 WHEN 同一行；
 *   - 其余 WHEN / ELSE 各占一行，和第一个 WHEN 对齐；
 *   - 每段 "WHEN 条件 THEN 结果" 尽量不换行，过长时只在 AND / OR 处折行；
 *   - END 与尾部（", 0)" / " AS x"）尽量贴在同一行末尾。 */
Formatter.prototype.splitCase = function (ln) {
  var max = this.opts.maxWidth;
  /* 判断"这一段能不能整行放下"时用 100% 阈值：落在 80%~100% 之间也算放得下，
   * 不把 CASE 分支从中间劈开。对齐仍然按 maxWidth。 */
  var hard = this.opts.hardWidth || max;
  var text = ln.text;
  var casePos = -1;
  var depth = 0, quote = null;
  var i;

  for (i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (quote) { if (ch === '\\' && LEX.backslash !== false) { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[A-Za-z0-9_$@#.]/.test(text.charAt(i - 1)))) {
      var word = /^[A-Za-z_]+/.exec(text.slice(i))[0].toUpperCase();
      if (word === 'CASE') { casePos = i; break; }
    }
  }
  if (casePos < 0) return null;

  /* 找配对的 END（按 CASE/END 嵌套计数，引号内不算） */
  var nest = 0, endStart = -1;
  for (i = casePos; i < text.length; i++) {
    var ch2 = text.charAt(i);
    if (quote) { if (ch2 === '\\' && LEX.backslash !== false) { i++; continue; } if (ch2 === quote) quote = null; continue; }
    if (ch2 === "'" || ch2 === '"' || ch2 === '`') { quote = ch2; continue; }
    if (!/[A-Za-z_]/.test(ch2) || (i > 0 && /[A-Za-z0-9_$@#.]/.test(text.charAt(i - 1)))) continue;
    var w2 = /^[A-Za-z_]+/.exec(text.slice(i))[0].toUpperCase();
    if (w2 === 'CASE') nest++;
    else if (w2 === 'END') { nest--; if (nest === 0) { endStart = i; break; } }
    i += w2.length - 1;
  }
  if (endStart < 0) return null;

  var head = text.slice(0, casePos);
  var body = text.slice(casePos, endStart);
  var tailPart = text.slice(endStart);

  /* 只有**一个** WHEN 且没有 ELSE 的 CASE（`CASE WHEN c THEN a ELSE 0 END` 也算
   * 一个 WHEN + 一个 ELSE）：展开成 "WHEN 一行 / THEN 一行 / ELSE 一行 / END 一行"
   * 反而比整行放下多用 2~3 行。这种情况交给 genericWrap 在 AND/OR/运算符处折。
   * 统计同层 WHEN 数量需要先扫一遍，见下面 segs 计算后回头判断。 */

  /* 同层切分 WHEN / ELSE */
  var segs = [];
  var segStart = 0;
  var caseDepth = depth === 0 ? countDepthAt(text, casePos) : depth;

  depth = caseDepth;
  quote = null;
  var innerCase = 0;

  for (i = 4; i < body.length; i++) {
    var ch3 = body.charAt(i);
    if (quote) { if (ch3 === '\\' && LEX.backslash !== false) { i++; continue; } if (ch3 === quote) quote = null; continue; }
    if (ch3 === "'" || ch3 === '"' || ch3 === '`') { quote = ch3; continue; }
    if (ch3 === '(') { depth++; continue; }
    if (ch3 === ')') { depth = Math.max(caseDepth, depth - 1); continue; }
    if (depth !== caseDepth) continue;
    if (!/[A-Za-z_]/.test(ch3) || (i > 0 && /[A-Za-z0-9_$@#.]/.test(body.charAt(i - 1)))) continue;

    var w3 = /^[A-Za-z_]+/.exec(body.slice(i))[0].toUpperCase();
    if (w3 === 'CASE') innerCase++;
    else if (w3 === 'END') innerCase--;
    else if ((w3 === 'WHEN' || w3 === 'ELSE') && innerCase === 0) {
      segs.push(body.slice(segStart, i));
      segStart = i;
    }
    i += w3.length - 1;
  }
  segs.push(body.slice(segStart));

  if (segs.length < 2) return null;

  var prefix0 = (head + segs[0]).replace(/\s+$/, '');  /* 例如 "      ,NVL(CASE" */
  var firstSeg = segs[1].replace(/^\s+/, '').replace(/\s+$/, '');
  var firstThenAt = findKeywordShallow(firstSeg, 'THEN', 0);
  var firstCond = firstThenAt >= 0 ? firstSeg.slice(0, firstThenAt).replace(/\s+$/, '') : firstSeg;

  /* 第一个 WHEN 一律紧跟 CASE 同一行（用户要求）；其它 WHEN 与它竖向对齐。
   * CASE 前若还有 NVL(... / GREATEST(...) 长前缀，对齐过去会把续行推出屏幕，
   * 此时退回相对 CASE 的缩进。 */
  var whenInd = caseWhenIndent(ln.ind, visLen(prefix0), casePos, max);
  var condInd = whenInd + '     ';                     /* 条件续行：对齐到 WHEN 之后 */
  var out = [];

  var firstReserve = (segs.length === 2) ? (visLen(rtrim(tailPart)) + 1) : 0;
  var firstFull = prefix0 + ' ' + firstSeg;

  if (visLen(ln.ind) + visLen(firstFull) + firstReserve <= hard) {
    out.push({ ind: ln.ind, text: firstFull, kind: 'case', exprBase: 0 });
  } else if (!hasTopLevelAndOr(firstCond)) {
    /* CASE 后面是 GREATEST(...) 这类长参数表达式，没有 AND/OR 可断：
     * 先按普通折行拆表达式，再把第一个 WHEN 另起一行（仍与其它 WHEN 对齐），
     * 避免在参数中间硬切出半截。 */
    whenInd = ln.ind + spaces(casePos + 5);
    condInd = whenInd + '     ';
    var exprPieces = this.genericWrap({ ind: ln.ind, text: prefix0, kind: 'case', exprBase: 0 });
    for (var e = 0; e < exprPieces.length; e++) out.push(exprPieces[e]);
    out.push({ ind: whenInd, text: firstSeg, kind: 'case', exprBase: 0 });
  } else {
    /* 放不下：按 AND / OR 续行，首行仍以 CASE + 第一个 WHEN 开头 */
    var fThenAt = findKeywordShallow(firstSeg, 'THEN', 0);
    var fCond = fThenAt >= 0 ? firstSeg.slice(0, fThenAt).replace(/\s+$/, '') : firstSeg;
    var fRest = fThenAt >= 0 ? firstSeg.slice(fThenAt).replace(/^\s+/, '') : '';
    var fReserve = (fRest ? visLen(fRest) + 1 : 0) + firstReserve;

    var fPieces = this.wrapCondSegments(fCond, ln.ind, prefix0 + ' ', condInd, fReserve);
    var fLast = fPieces[fPieces.length - 1];

    if (fRest && fRest !== fCond) {
      var fMerged = (fLast.text + ' ' + fRest).replace(/\s+$/, '');
      if (visLen(fLast.ind) + visLen(fMerged) + firstReserve <= hard) {
        fLast.text = fMerged;
      } else {
        fPieces.push({ ind: condInd, text: fRest, kind: 'case', exprBase: 0 });
      }
    }
    for (var f = 0; f < fPieces.length; f++) out.push(fPieces[f]);
  }

  for (i = 2; i < segs.length; i++) {
    var seg = segs[i].replace(/^\s+/, '').replace(/\s+$/, '');
    if (!seg) continue;

    var lineInd = whenInd;
    var prefix = '';

    /* 最后一段要为末尾的 " END, 0) AS x" 预留空间 */
    var isLastSeg = (i === segs.length - 1);
    var reserve = isLastSeg ? (visLen(rtrim(tailPart)) + 1) : 0;
    if (reserve > 40) reserve = 0; /* 尾部过长时不预留，避免条件被过度拆碎 */

    if (visLen(lineInd) + visLen(prefix) + visLen(seg) + reserve <= hard) {
      out.push({ ind: lineInd, text: prefix + seg, kind: 'case', exprBase: 0 });
      continue;
    }

    /* 过长：条件与结果分开处理 */
    var thenAt = findKeywordShallow(seg, 'THEN', 0);
    var condText = thenAt >= 0 ? seg.slice(0, thenAt).replace(/\s+$/, '') : seg;
    var restText = thenAt >= 0 ? seg.slice(thenAt).replace(/^\s+/, '') : '';

    /* 折条件时为 "THEN 结果"（以及最后一段的 "END, 0) AS x"）预留空间，
     * 让 THEN 结果尽量跟在同一行，减少无谓换行 */
    var condReserve = (restText ? visLen(restText) + 1 : 0) + (isLastSeg ? reserve : 0);
    var pieces = this.wrapCondSegments(condText, lineInd, prefix, condInd, condReserve);
    var lastLine = pieces[pieces.length - 1];

    if (restText && restText !== condText) {
      var merged = (lastLine.text + ' ' + restText).replace(/\s+$/, '');
      if (visLen(lastLine.ind) + visLen(merged) + (isLastSeg ? reserve : 0) <= hard) {
        lastLine.text = merged;
      } else {
        /* 预留失败：退回不预留的折法，再把 THEN 结果单独放一行 */
        pieces = this.wrapCondSegments(condText, lineInd, prefix, condInd, isLastSeg ? reserve : 0);
        lastLine = pieces[pieces.length - 1];
        var merged2 = (lastLine.text + ' ' + restText).replace(/\s+$/, '');
        if (visLen(lastLine.ind) + visLen(merged2) + (isLastSeg ? reserve : 0) <= hard) {
          lastLine.text = merged2;
        } else {
          pieces.push({ ind: condInd, text: restText, kind: 'case', exprBase: 0 });
        }
      }
    }

    for (var k = 0; k < pieces.length; k++) out.push(pieces[k]);
  }

  /* END + 尾部：放得下就贴最后一行，放不下才另起一行（对齐 CASE） */
  var tail = rtrim(tailPart);
  var last = out[out.length - 1];
  var mergedTail = (last.text + ' ' + tail).replace(/\s+$/, '');

  if (visLen(last.ind) + visLen(mergedTail) <= hard) {
    last.text = mergedTail;
  } else if (/^END\b/i.test(tail)) {
    out.push({ ind: ln.ind + spaces(casePos), text: tail, kind: 'case', exprBase: 0 });
  } else {
    last.text = mergedTail;
  }

  return out;
};

/* WHEN 的缩进列：默认对齐到 CASE 之后（prefix0 末尾 + 1），
 * 但若 CASE 前还有 NVL(...) / GREATEST(...) 这类长前缀，对齐过去会把续行推出屏幕，
 * 此时退回相对 CASE 的缩进，保证每个 WHEN 行都有足够的可用宽度。 */
function caseWhenIndent(lnInd, prefixLen, caseCol, max) {
  var cap = Math.max(40, max * 0.4);
  if (prefixLen + 1 <= cap) return lnInd + spaces(prefixLen + 1);
  return lnInd + spaces(caseCol + 5);
}

/* 指定位置处的括号深度 */
function countDepthAt(text, pos) {
  var depth = 0, quote = null;
  for (var i = 0; i < pos; i++) {
    var ch = text.charAt(i);
    if (quote) { if (ch === '\\' && LEX.backslash !== false) { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
  }
  return depth;
}

/* 统一多行 CASE 的缩进：WHEN/ELSE 对齐到第一个 WHEN，END 对齐到 CASE；
 * 同一 CASE 内多个 THEN 关键字竖向对齐（放得下才对齐）。 */
Formatter.prototype.alignCaseBlocks = function (lines) {
  var stack = [];

  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (ln.text === '') continue;

    var cp = findCommentPos(ln.text, this.lex.hashComment, this.lex.backslash);
    var code = cp >= 0 ? ln.text.slice(0, cp) : ln.text;
    var toks = tokenize(code);

    /* 本行第一个关键字（跳过行首逗号），用于判断 WHEN / ELSE / END 续行 */
    var firstWord = '';
    for (var t = 0; t < toks.length; t++) {
      if (toks[t].type === 'word') { firstWord = toks[t].upper; break; }
        /* 词法器产出的 token 类型是 'punct'（不是 'punctuation'）。
         * 旧写法 `t !== 'punctuation'` 永远为真，于是行首逗号也被当成"非 word"直接 break，
         * 后续的 WHEN/ELSE/END 续行判断拿不到任何 token（H-12 / N-30）。 */
        if (toks[t].type !== 'punct' && toks[t].value !== ',') break;
    }

    if (stack.length) {
      var top = stack[stack.length - 1];
      if (firstWord === 'WHEN' || firstWord === 'ELSE') {
        var wantCol = top.whenCol >= 0 ? top.whenCol : top.caseCol + 5;
        /* 对齐列太深会把内容推出屏幕：退回相对 CASE 的缩进 */
        var cap = Math.max(40, this.opts.maxWidth * 0.4);
        if (wantCol > cap) wantCol = top.caseCol + 5;
        ln.ind = top.indStr + spaces(wantCol);
      } else if (firstWord === 'END') {
        ln.ind = top.indStr + spaces(top.caseCol);
      }
    }

    for (t = 0; t < toks.length; t++) {
      var tk = toks[t];
      if (tk.type !== 'word') continue;

      if (tk.upper === 'CASE') {
        var blk = {
          indStr: ln.ind,
          caseCol: tk.start,          /* 相对行首缩进 */
          whenCol: -1,
          whenLines: []
        };
        stack.push(blk);
      } else if (tk.upper === 'END') {
        var done = stack.pop();
        if (done && done.whenLines.length >= 2) this.alignThen(done.whenLines);
      } else if (tk.upper === 'WHEN' && stack.length) {
        var cur = stack[stack.length - 1];
        /* 换算成相对该 CASE 所在行缩进的列号 */
        var relCol = visLen(ln.ind) - visLen(cur.indStr) + tk.start;
        if (cur.whenCol < 0) cur.whenCol = relCol;
        /* CASE 头部的那个 WHEN 不参与 THEN 对齐：它前面可能跟着 GREATEST(...)，
         * 列号远离其它分支，对齐会撑出一大段空白 */
        if (cur.whenLines.indexOf(ln) < 0 && !/\bCASE\b/i.test(code.slice(0, tk.start))) {
          cur.whenLines.push(ln);
        }
      }
    }
  }

  return lines;
};

/* 把同一个 CASE 内各 WHEN 行的 THEN 关键字对齐到同一列 */
Formatter.prototype.alignThen = function (whenLines) {
  var maxCol = -1, minCol = 1e9;
  var pos = [];

  for (var i = 0; i < whenLines.length; i++) {
    var ln = whenLines[i];
    var thenAt = findKeywordShallow(ln.text, 'THEN', 0);
    pos.push(thenAt);
    if (thenAt < 0) continue;
    var col = visLen(ln.ind) + visLen(ln.text.slice(0, thenAt));
    if (col > maxCol) maxCol = col;
    if (col < minCol) minCol = col;
  }

  if (maxCol <= 0 || maxCol <= minCol) return;

  /* 对齐后不能溢出屏幕 */
  for (i = 0; i < whenLines.length; i++) {
    if (pos[i] < 0) continue;
    var c0 = visLen(whenLines[i].ind) + visLen(whenLines[i].text.slice(0, pos[i]));
    if (c0 > maxCol) continue;
    if (visLen(whenLines[i].ind) + visLen(whenLines[i].text) + (maxCol - c0) > this.opts.maxWidth) return;
  }

  for (i = 0; i < whenLines.length; i++) {
    if (pos[i] < 0) continue;
    var c = visLen(whenLines[i].ind) + visLen(whenLines[i].text.slice(0, pos[i]));
    if (c >= maxCol) continue;
    whenLines[i].text = whenLines[i].text.slice(0, pos[i]) +
      spaces(maxCol - c) + whenLines[i].text.slice(pos[i]);
  }
};

/* ---------------------------- 逗号位置 ---------------------------- */

Formatter.prototype.convertCommaLocation = function (lines) {
  for (var i = 0; i + 1 < lines.length; i++) {
    var nxt = lines[i + 1];
    var cur = lines[i];
    if (cur.text === '' || nxt.text === '') continue;
    if (nxt.text.charAt(0) !== ',') continue;
    if (!(nxt.kind === 'select' || nxt.kind === 'groupby' || nxt.kind === 'orderby' ||
          nxt.kind === 'paren' || nxt.kind === 'cte' || nxt.kind === 'sortby' ||
          nxt.kind === 'clusterby' || nxt.kind === 'distributeby' || nxt.kind === 'code')) continue;

    /* M2：`cur` 整行都是注释时**不要**把逗号并进去，也不要动 `nxt`。
     * 形如
     *     select a
     *     -- note
     *     , b from t
     * 里注释独占一行、逗号在下一行行首。若把逗号并进注释行，
     * 第一次输出 `SELECT a` / `, -- note` / `b`，第二次再格式化就变成
     * `SELECT a, -- note` / `b` —— 同一份文件两次结果不同（非幂等），
     * 而幂等性是编辑器保存钩子必须成立的前提（每次保存都会再跑一遍）。
     * 正确做法：注释行与逗号行都原地不动。 */
    var cp = findCommentPos(cur.text, this.lex.hashComment);
    if (cp === 0) continue;

    nxt.text = nxt.text.slice(1).replace(/^\s+/, '');

    if (cp > 0) {
      var head = cur.text.slice(0, cp).replace(/\s+$/, '');
      var tail = cur.text.slice(cp).replace(/^\s+/, '');
      cur.text = head + ', ' + tail;
    } else {
      cur.text = rtrim(cur.text) + ',';
    }
  }
  return lines;
};

/* ---------------------------- AS 对齐 ---------------------------- */

/* 判断两行是否属于同一个「可对齐」组：kind 相同，或者其中一方是带行尾注释的
 * commentTail（它原本的 kind 已被注释覆盖，但它仍然属于这条 select/groupby 列表）。 */
function compatAlignKind(a, b) {
  if (a === b) return true;
  if (a === 'commentTail' || b === 'commentTail') return true;
  return false;
}

/* 一行是否是「一个 select 项的开头」。
 * 只有项开头才参与 AS 对齐；CASE 展开后的 `ELSE 0 END, 0) AS x`、
 * 折行后的续行 `+ 1 AS y` 都属于同一个项，跟着对齐会让整段看起来歪掉。
 *
 * M3a（第三轮审计）：`comma_location=true` 时逗号被移到**上一行行尾**，
 * 续行不再以 `,` 开头 —— 旧判据于是把每一行都当成"非项开头"，
 * 整个 select 列表的对齐组永远是空的，AS 完全不对齐。
 * 这里的 `commaAtEnd` 参数用来告诉它"当前是逗号后置风格"：
 * 此时同 kind / 同 exprBase 的连续行就是各个项（换行已由格式化器保证）。 */
function isItemStart(text, commaAtEnd) {
  var t = String(text).replace(/^\s+/, '');
  if (t === '') return false;
  if (t.charAt(0) === ',') return true;
  if (/^(SELECT|DISTINCT)\b/i.test(t)) return true;
  /* 逗号后置风格：行首没有逗号，但行尾有逗号（最后一项没有）。
   * 也接受"行尾没有逗号但属于同一组的续行"——这正是最后一项。 */
  if (commaAtEnd) {
    /* 以 CASE 的 WHEN/ELSE/END 或运算符开头的仍是续行，不是新项 */
    if (/^(WHEN|ELSE|END|\+|-|\*|\/|%|\|\||&&)\b/i.test(t)) return false;
    return true;
  }
  return false;
}

Formatter.prototype.alignAs = function (lines) {
  var asLocCnt = this.opts.asLocCnt;
  var commaAtEnd = this.opts.commaLocation === true;
  var i = 0;

  while (i < lines.length) {
    var ln = lines[i];
    /* commentTail 也必须参与对齐：`… AS is_normal  -- 注释` 这类行带行尾注释，
     * 曾经被排除在外，于是同一段 select 里带注释的行各自为政、AS 列参差不齐。
     * 对齐只看 AS 之前的代码列，注释在 AS 之后，不影响计算。 */
    var alignable = ln.text !== '' &&
      (ln.kind === 'select' || ln.kind === 'groupby' || ln.kind === 'paren' ||
       ln.kind === 'code' || ln.kind === 'commentTail');

    if (!alignable) { i++; continue; }
    /* 组必须从「一个 select 项的开头」开始，否则会把 CASE 的续行
     * （`ELSE 0 END, 0) AS x`）当成独立项拉去对齐 */
    if (!isItemStart(ln.text, commaAtEnd)) { i++; continue; }

    var group = [ln];
    var j = i + 1;
    while (j < lines.length && lines[j].text !== '' && compatAlignKind(lines[j].kind, ln.kind) &&
           lines[j].exprBase === ln.exprBase) {
      /* 续行（ELSE / END / 运算符开头）不加入对齐组，否则同一个 CASE 的
       * 多行会被拉到不同的 AS 列上 */
      if (!isItemStart(lines[j].text, commaAtEnd)) break;
      group.push(lines[j]);
      j++;
    }

    if (group.length >= 2) {
      this.alignAsGroup(group);
    }

    i = j;
  }

  return lines;
};

Formatter.prototype.alignAsGroup = function (group) {
  var asLocCnt = this.opts.asLocCnt;
  var pos = [];
  var q, idx;

  for (q = 0; q < group.length; q++) {
    pos.push(findTopLevelAs(group[q].text));
  }

  /* 逐轮剔除"实在没法参与对齐"的行，剩下的才一起对齐。
   *
   * 旧实现只要**有一条**行按 maxCol 补齐后会超宽，就整组放弃对齐 ——
   * 用户看到的正是「有的一行对齐、有的各自为政」。
   * 更合理的做法：把那条特别长的行留在原位（它本来就放不下），
   * 其余行照常对齐，视觉上仍然成列。 */
  var active = [];
  for (q = 0; q < group.length; q++) {
    if (pos[q] < 0) continue;
    var c = visLen(group[q].ind) + visLen(group[q].text.slice(0, pos[q]));
    if (c <= asLocCnt) active.push(q);
  }
  if (active.length < 2) return;

  var limit = this.opts.hardWidth || this.opts.maxWidth;

  /* 循环界不是魔法数字（豆包 BUG-5）：每次迭代**恰好剔除一条**行，
   * 所以最多 active.length 次就必然收敛；再多只是空转。
   * 旧写法 `guard < 64` 在理论上会给 >64 列的宽表留一个截断口，
   * 虽然实测（含 200/300 列闭合式扫描）从未触发，但界应当可证明。 */
  for (var guard = 0; guard <= active.length + 1; guard++) {
    var maxCol = -1, minCol = 1e9;
    for (var a = 0; a < active.length; a++) {
      var cc = visLen(group[active[a]].ind) + visLen(group[active[a]].text.slice(0, pos[active[a]]));
      if (cc > maxCol) maxCol = cc;
      if (cc < minCol) minCol = cc;
    }
    if (maxCol <= 0 || maxCol <= minCol) return;

    /* 找第一条「补到 maxCol 就超宽」的行 */
    var drop = -1;
    for (a = 0; a < active.length; a++) {
      var ln2 = group[active[a]];
      var c0 = visLen(ln2.ind) + visLen(ln2.text.slice(0, pos[active[a]]));
      if (c0 > maxCol) continue;
      if (visLen(ln2.ind) + visLen(ln2.text) + (maxCol - c0) > limit) { drop = active[a]; break; }
    }
    if (drop < 0) break;             /* 全部放得下，可以对齐 */
    if (active.length <= 2) return;  /* 只剩两条还放不下就别硬来 */

    active = active.filter(function (k) { return k !== drop; });
  }

  /* 对齐的"目标列"用**小数宽度**算，而不是整数 visLen。
   *
   * 原因：汉字在 Consolas + 微软雅黑下是 1.8182 列，不是 2 列。
   * 用整数 2 计算时，一行有 6 个汉字就与纯 ASCII 行差 1.09 列，
   * 但两者 visLen 相等 → 内核认为"已经对齐"、不补空格 → 屏幕上看是歪的。
   *
   * 补空格的单位只能是整格（空格宽 1.0），所以取 round(目标 - 当前)：
   * 取整误差 ≤ 0.5 列（14px 字号下约 2.75px），且会把所有行的 AS 收敛到
   * 同一列附近，剩余偏差远小于肉眼可辨的一格。 */
  var finalMax = -1e9;
  var fw = [];
  for (var b = 0; b < active.length; b++) {
    var wb = visWidthF(group[active[b]].ind) + visWidthF(group[active[b]].text.slice(0, pos[active[b]]));
    fw[b] = wb;
    if (wb > finalMax) finalMax = wb;
  }
  if (finalMax <= 0) return;

  /* F-10（2026-11-04 复核）：对齐只补**合理**的空白。
   *
   * 上面那轮剔除只保护"补完会超过硬上限"，没有保护"空白本身荒谬"。
   * 一条 70 列的长列名会把同组其它行推到 70 列之外：
   *     SELECT a                                                                      AS x
   *           ,bbbb…（70 列）… AS 长列
   * 首行 82 列里 70 列是空白。对齐的价值是"看起来成列"，一旦某行比别人长出
   * 一大截，对齐反而毁掉可读性。
   *
   * 判据：把"最短行"作为基准，任何一行如果为了对齐要补的空格超过
   * 基准列 + ALIGN_MAX_PAD，就把它从对齐组里剔除（它自己保持原样），
   * 再重新计算 —— 反复直到稳定。ALIGN_MAX_PAD 取 24：
   * 常见别名长度差（`a` vs `settlement_date`）都不会超过这个量级。 */
  var ALIGN_MAX_PAD = 24;
  for (var ag = 0; ag <= active.length + 1; ag++) {
    var loCol = 1e9, hiCol = -1e9;
    for (var agi = 0; agi < active.length; agi++) {
      var cagi = visLen(group[active[agi]].ind) + visLen(group[active[agi]].text.slice(0, pos[active[agi]]));
      if (cagi < loCol) loCol = cagi;
      if (cagi > hiCol) hiCol = cagi;
    }
    if (hiCol - loCol <= ALIGN_MAX_PAD) break;      /* 跨度合理，可以对齐 */
    if (active.length <= 2) return;                  /* 只剩两条：别硬来 */
    /* 剔掉最长的那一条（它是造成巨幅空白的源头） */
    var dropIdx = -1, dropCol = -1;
    for (var agj = 0; agj < active.length; agj++) {
      var cagj = visLen(group[active[agj]].ind) + visLen(group[active[agj]].text.slice(0, pos[active[agj]]));
      if (cagj > dropCol) { dropCol = cagj; dropIdx = active[agj]; }
    }
    if (dropIdx < 0) break;
    active = active.filter(function (k) { return k !== dropIdx; });
    if (active.length < 2) return;
    /* 重新计算 finalMax / fw */
    finalMax = -1e9;
    fw = [];
    for (b = 0; b < active.length; b++) {
      var wb2 = visWidthF(group[active[b]].ind) + visWidthF(group[active[b]].text.slice(0, pos[active[b]]));
      fw[b] = wb2;
      if (wb2 > finalMax) finalMax = wb2;
    }
    if (finalMax <= 0) return;
  }

  for (b = 0; b < active.length; b++) {
    var ln3 = group[active[b]];
    var pad = Math.round(finalMax - fw[b]);
    if (pad > 0) {
      ln3.text = ln3.text.slice(0, pos[active[b]]) + spaces(pad) + ln3.text.slice(pos[active[b]]);
    }
  }
};

/* ---------------------------- 注释对齐 ---------------------------- */

/* 注释对齐的"档位"：相邻两行代码结束列相差 <= GAP 且档内跨度 <= SPAN 时算同一档 */
var COMMENT_BUCKET_SPAN = 36;
var COMMENT_BUCKET_GAP = 12;
/* 注释列超过这个位置就不再对齐（否则整行会被推得太远） */
var COMMENT_ALIGN_MAX = 120;

/* 折行为行尾注释预留的最大宽度（P6-1）。
 * 只影响"最后一行能不能再塞点代码"，不应该让整段被压窄；
 * 取一个较小值，正好够末行容纳注释开头即可。 */
var COMMENT_TAIL_RESERVE = 24;

/* 对一组行（每行都有行尾注释）按"代码结束列"分档，档内把注释对齐到同一列 */
Formatter.prototype.alignCommentRun = function (group) {
  if (group.length < 2) return;

  var items = [];
  for (var q = 0; q < group.length; q++) {
    var ln = group[q];
    var p = findCommentPos(ln.text, this.lex.hashComment, this.lex.backslash);
    if (p <= 0) continue;
    var code = ln.text.slice(0, p).replace(/\s+$/, '');
    if (code === '') continue;
    var comment = ln.text.slice(p).replace(/^\s+/, '');
    items.push({
      ln: ln,
      code: code,
      comment: comment,
      codeCol: visLen(ln.ind) + visLen(code),
      /* 小数宽度版本：分档仍用整数（保持原有分级行为），补空格用小数 */
      codeColF: visWidthF(ln.ind) + visWidthF(code)
    });
  }
  if (items.length < 2) return;

  /* 按代码结束列排序后贪心分档：档内跨度 <= COMMENT_BUCKET_SPAN */
  var sorted = items.slice().sort(function (a, b) { return a.codeCol - b.codeCol; });
  var buckets = [];
  var cur = null;

  for (var i = 0; i < sorted.length; i++) {
    var it = sorted[i];
    var prevCol = cur ? cur.items[cur.items.length - 1].codeCol : 0;

    if (!cur || it.codeCol - cur.startCol > COMMENT_BUCKET_SPAN || it.codeCol - prevCol > COMMENT_BUCKET_GAP) {
      cur = { startCol: it.codeCol, items: [] };
      buckets.push(cur);
    }
    cur.items.push(it);
  }

  for (var b = 0; b < buckets.length; b++) {
    var bucket = buckets[b];
    if (bucket.items.length < 2) continue;

    var targetCode = 0;
    for (var k = 0; k < bucket.items.length; k++) {
      if (bucket.items[k].codeColF > targetCode) targetCode = bucket.items[k].codeColF;
    }
    if (targetCode + 1 > COMMENT_ALIGN_MAX) continue;

    /* 对齐后任何一行都不能超出屏幕宽度 */
    var fits = true;
    for (k = 0; k < bucket.items.length; k++) {
      var item = bucket.items[k];
      var width = targetCode + 1 + visLen(item.comment);
      if (width > this.opts.maxWidth) { fits = false; break; }
    }
    if (!fits) continue;

    for (k = 0; k < bucket.items.length; k++) {
      var it2 = bucket.items[k];
      /* 同样是"补整格 + 小数宽度"，让中文注释与英文注释的 -- 落在同一列 */
      var padC = Math.round(targetCode + 1 - it2.codeColF);
      if (padC < 1) padC = 1;
      it2.ln.text = it2.code + spaces(padC) + it2.comment;
    }
  }
};

Formatter.prototype.alignComments = function (lines) {
  /* 按空行切块：同一语句块内统一分档对齐，跨语句互不影响 */
  var i = 0;
  while (i < lines.length) {
    if (lines[i].text === '') { i++; continue; }

    var run = [];
    var j = i;
    while (j < lines.length && lines[j].text !== '') {
      if (findCommentPos(lines[j].text, this.lex.hashComment, this.lex.backslash) > 0) run.push(lines[j]);
      j++;
    }
    this.alignCommentRun(run);
    i = j;
  }

  return lines;
};

/* ---------------------------- 超长行折行 ---------------------------- */

Formatter.prototype.breakCandidates = function (text) {
  var toks = tokenize(text);
  var depth = 0;
  var out = [];
  var prev = null;

  /* 断点优先级按「深度分层」：越靠外层的断点越优先。
   * 这是用户反复反馈的那条规则的可执行版本——
   *   `SUM(CASE …END) / SUM(CASE …END) AS x`
   * 必须断在**外层的 `/`**，而不是 SUM 括号里 CASE 的 AND/WHEN 上。
   * 分层后：外层算术(5) > 括号内关键字(4) > 括号内逗号/AND(3) > 括号内算术(2)。 */
  function prioOf(tk, depth, prev) {
    var outer = (depth === 0);
    var u = tk.upper;

    if (tk.type === 'punct' && tk.value === ',') return outer ? 6 : 3;
    if (tk.type === 'word' && (u === 'AND' || u === 'OR')) return outer ? 6 : 3;
    if (tk.type === 'word' && (u === 'WHEN' || u === 'ELSE' || u === 'END')) {
      /* 紧跟在 CASE 后面的第一个 WHEN 不能当断点：在它前面断等于把 CASE 单独扔
       * 到上一行、WHEN 另起一行，白白多出一行（用户案例 3 的
       * `,NVL(CASE` / `WHEN …` / `THEN …` 就是这条造成的）。
       * 真正的断点应该在后面更靠外的 OR / AND / 运算符上。 */
      if (u === 'WHEN' && prev && prev.type === 'word' && prev.upper === 'CASE') return 0;
      return outer ? 6 : 4;
    }
    if (tk.type === 'word' && u === 'THEN') return outer ? 5 : 4;

    /* 窗口函数 / 聚合的内部子句：优先在 PARTITION BY / ORDER BY / ROWS 之前断，
     * 而不是把 `BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` 从 AND 处劈开。 */
    if (tk.type === 'word' && (u === 'ROWS' || u === 'RANGE' || u === 'GROUPS')) return outer ? 0 : 4;
    if (tk.type === 'word' && (u === 'PARTITION' || u === 'ORDER') && !outer &&
        prev && prev.type === 'word' &&
        (prev.upper === '(' || prev.upper === 'OVER' || prev.upper === 'BY')) return 4;

    /* 算术运算符：外层 `a / b` 断成 `a` 与 `/ b`，下一行以运算符开头。
     * 用户明确要求"在字符 / 处换行"，所以外层乘除给到 5，压过括号内的关键字。 */
    if (tk.type === 'punct' && (tk.value === '+' || tk.value === '-' || tk.value === '||' ||
                                tk.value === '*' || tk.value === '/' || tk.value === '%')) {
      /* 排除非算式的 `*`：COUNT(*)、SELECT *、a.* */
      if (tk.value === '*' && prev && prev.type === 'punct' && (prev.value === '(' || prev.value === '.')) return 0;
      /* 排除一元正负号：`(- 1)`、`, -1` */
      if ((tk.value === '+' || tk.value === '-') && prev && prev.type === 'punct' &&
          (prev.value === '(' || prev.value === ',')) return 0;
      /* 排除点号前的 *：t.* */
      if (tk.value === '*' && prev && prev.type === 'punct' && prev.value === '.') return 0;
      return outer ? 5 : 2;
    }

    if (tk.type === 'word' && /^(AS|IN|BETWEEN|LIKE|IS|NOT|DESC|ASC)$/.test(u)) return outer ? 4 : 1;

    /* 2026-11-04（缺陷 W-3）：比较运算符过去**完全没有断点候选**。
     * 于是 `WHERE <84 列的条件> = 1 -- 注释` 这类行虽然超宽，却因为
     * candidates 为空而直接放弃折行（实测输出 138 列，远超 120 列屏幕）。
     * 现在补上 =、<>、!=、>、<、>=、<=：优先级低于逗号/AND，但足以作为
     * 最后的断点，让超宽行至少能折在赋值/比较处。 */
    if (tk.type === 'punct' && (tk.value === '=' || tk.value === '<>' ||
        tk.value === '!=' || tk.value === '>' || tk.value === '<' ||
        tk.value === '>=' || tk.value === '<=')) {
      return outer ? 4 : 1;
    }

    return 0;
  }

  for (var i = 0; i < toks.length; i++) {
    var tk = toks[i];

    if (tk.type === 'punct' && tk.value === '(') { depth++; prev = tk; continue; }
    if (tk.type === 'punct' && tk.value === ')') { depth = Math.max(0, depth - 1); prev = tk; continue; }

    if (i > 0) {
      var prio = prioOf(tk, depth, prev);
      if (prio > 0) {
        var isSep = (tk.type === 'word' && /^(AND|OR|WHEN|THEN|ELSE|END|ROWS|RANGE|GROUPS|PARTITION|ORDER)$/.test(tk.upper)) ||
                    (tk.type === 'punct' && tk.value === ',');
        out.push({ pos: tk.start, prio: prio, depth: depth, sep: isSep });
      }
    }

    prev = tk;
  }

  /* 复用这次分词结果：折行时判断"断点是不是二元运算符"要用到它。
   * 旧实现每折一段就重新 tokenize 一次整行，长 IN 列表下是 O(n²)。 */
  out.tokens = toks;
  return out;
};

/* 从候选断点里挑一个。
 *
 * 2026-11-04 审计（缺陷 W-2）修正：旧实现在 (from, to] 里**只看优先级**，
 * 优先级高的断点哪怕在行首附近也照选。实测：
 *     AND y IN (100001, …, 100024)      ← 一行远超 80%
 *   →
 *     AND y                             ← 断点在 IN 上（prio 4），离行首只有 6 列
 *         IN (100001, …)
 * 第一行只用了 5 列，等于把一条逻辑从中间拆开。
 *
 * 现在加一个「有效窗口」floorChar：只在目标宽度的一半之后挑断点，
 * 保证断点靠近 80% 的目标列；窗口内再按优先级（外层优先）、同优先级取最靠右。
 * floorChar 由调用方用字符下标给出（宽度换算在那边做，避免这里 O(n²)）。
 */
/* P-01（2026-11-04 复核）：cands 是按 pos 升序的（tokenize 顺序即文档顺序），
 * 但 pickBreak / pickBreakOverflow / pickBreakRightmost 每次都从 cands[0] 开始
 * 线性扫。genericWrap 对**每一片**都调用一次 → 2 万项 IN 列表实测
 * pickBreak 调用 1 423 次、迭代 2 846 万次，单次格式化数百毫秒。
 * 这里加一个下标二分，把每次调用的起点定位到 from 之后。 */
function lowerBoundCand(cands, pos) {
  var lo = 0, hi = cands.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (cands[mid].pos <= pos) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* 同上的 token 版（按 start 升序），供 snapBreakOutsideOperator 用。 */
function lowerBoundTokStart(toks, pos) {
  var lo = 0, hi = toks.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (toks[mid].start < pos) lo = mid + 1; else hi = mid;
  }
  return lo;
}

Formatter.prototype.pickBreak = function (cands, from, to, floorChar) {
  var best = -1, bestPrio = -1;
  var floor = (typeof floorChar === 'number' && floorChar > from) ? floorChar : from;
  for (var i = lowerBoundCand(cands, from); i < cands.length; i++) {
    var c = cands[i];
    if (c.pos <= from || c.pos > to) continue;
    if (c.pos < floor) continue;
    if (c.prio > bestPrio || (c.prio === bestPrio && c.pos > best)) {
      best = c.pos;
      bestPrio = c.prio;
    }
  }
  return best;
};

/* 窗口内没有任何断点时，退到 (from, to] 里最靠右的断点（不看优先级）。
 * 再没有就返回 -1，由调用方按 token 边界安全切开。 */
Formatter.prototype.pickBreakRightmost = function (cands, from, to) {
  var best = -1;
  for (var i = lowerBoundCand(cands, from); i < cands.length; i++) {
    var c = cands[i];
    if (c.pos <= from) continue;
    if (c.pos > to) break;
    if (c.prio > 0 && c.pos > best) best = c.pos;
  }
  return best;
};

/* 80% 内找不到断点时的「溢出」候选：允许一直找到 100% 列，
 * 但只挑最外层（depth 最小）的断点，避免把括号里的参数列表切碎。 */
Formatter.prototype.pickBreakOverflow = function (cands, from, to) {
  var best = -1, bestDepth = 99;
  for (var i = lowerBoundCand(cands, from); i < cands.length; i++) {
    var c = cands[i];
    if (c.pos <= from) continue;
    if (c.pos > to) break;
    if (c.depth < bestDepth) { bestDepth = c.depth; best = c.pos; }
  }
  return best;
};

Formatter.prototype.wrapLine = function (ln) {
  /* 2026-11-04（用户预设复核，缺陷 W-1）：**触发阈值必须是 80%（maxWidth）**。
   * 旧实现用 hardWidth（屏幕 100%）判断"是否要折"，于是
   *     WHERE a IN (1, 2, …, 24)      ← 98 列，占 120 列屏幕的 82%
   * 被原样保留，用户看到的排版和"宽度大于 80% 就换行"的约定不符。
   * 现在：超过 80% 就进入折行；折行点取 80% 附近，必要时允许越到 100%，
   * 保证一段逻辑不被从中间劈开（见 snapBreakOutsideOperator）。 */
  var trigger = this.opts.maxWidth;
  var hardLimit = this.opts.hardWidth || trigger;
  if (ln.text === '' || ln.kind === 'comment') return [ln];
  if (visLen(ln.ind) + visLen(ln.text) <= trigger) return [ln];

  /* 带行尾注释：先拆代码部分，注释挂到最后一行 */
  var cp = findCommentPos(ln.text, this.lex.hashComment, this.lex.backslash);
  var code = ln.text;
  var comment = '';
  if (cp > 0) {
    code = ln.text.slice(0, cp).replace(/\s+$/, '');
    comment = ln.text.slice(cp).replace(/^\s+/, '');
  }

  /* 注释会追加到最后一行，折行时要为它预留宽度，避免折完仍然溢出。
   * 宽度一律用 visLen（中文/emoji 占 2 列）。
   *
   * P6-1/P6-3：**先不预留，按满宽排一遍**。只有末行 + 注释真的放不下时才收窄重排。
   * 旧实现无条件把整条注释宽度从每一行扣掉，一条 30 列的注释就让可用宽度
   * 凭空少 30 列 —— "两行就能放下"的 NVL(CASE ...) 因此被切成三行
   * （用户明确反馈的错误）。注释只挂在最后一行，前面各行根本用不到这部分宽度。 */
  var tailReserve = comment ? visLen(comment) + 1 : 0;
  if (tailReserve > COMMENT_TAIL_RESERVE) tailReserve = COMMENT_TAIL_RESERVE;
  if (tailReserve && tailReserve > hardLimit / 2) tailReserve = 0;

  var work = { ind: ln.ind, text: code, kind: ln.kind, exprBase: ln.exprBase, contInd: ln.contInd };
  var savedMax = this.opts.maxWidth;
  var savedHard = this.opts.hardWidth;

  var pieces = this.wrapLinePieces(work);

  if (comment && tailReserve && pieces.length) {
    var tailLn = pieces[pieces.length - 1];
    var tailW = visLen(tailLn.ind) + visLen(tailLn.text);
    if (tailW + 1 + visLen(comment) > hardLimit) {
      /* 末行塞不下注释：收窄一点重排，让注释有落脚处 */
      this.opts.maxWidth = Math.max(40, trigger - tailReserve);
      if (savedHard) this.opts.hardWidth = Math.max(40, savedHard - tailReserve);
      try {
        pieces = this.wrapLinePieces(work);
      } finally {
        this.opts.maxWidth = savedMax;
        this.opts.hardWidth = savedHard;
      }
    }
  }

  if (comment) {
    var last = pieces[pieces.length - 1];
    last.text = rtrim(last.text) + ' ' + comment;
    last.kind = 'commentTail';
  }

  return pieces;
};

/* 折行的实际算法（供 wrapLine 调用一次或两次）。
 * 窄/宽两条路线各算一遍，取行数更少且不溢出屏幕的那条。 */
Formatter.prototype.wrapLinePieces = function (work) {
  var ln = work;
  var code = ln.text;
  var pieces = null;
  var savedMax = this.opts.maxWidth;
  var savedHard = this.opts.hardWidth;

  try {
    /* 两条路线都算一遍，**谁的行数少就用谁**（用户核心诉求：
     * "两行便能展示，却换行成三行"是错的）。
     *
     *   A) 浅层折行（genericWrap）：优先在外层运算符 / 逗号 / AND / OR 处断；
     *   B) CASE 展开（splitCase）：CASE 与第一个 WHEN 同行，其余 WHEN/ELSE 对齐。
     *
     * 分支多的 CASE 用 B 更清楚；只有一个 WHEN 的 CASE 用 B 反而会为了
     * WHEN/ELSE/END 各占一行而多出一行，这时候 A 才是对的。
     * 只要 A 的每一行都不超过 hardWidth，就按行数择优。 */
    var shallow = this.genericWrap(work);
    var shallowOk = true;
    for (var s = 0; s < shallow.length; s++) {
      if (visLen(shallow[s].ind) + visLen(shallow[s].text) > (this.opts.hardWidth || this.opts.maxWidth)) {
        shallowOk = false;
        break;
      }
    }

    /* CASE ... END 展开为多行 */
    var caseParts = (ln.text.indexOf('CASE') >= 0 || /case/i.test(code)) ? this.splitCase(work) : null;
    var expanded = null;

    if (caseParts && caseParts.length > 1) {
      expanded = [];
      for (var i = 0; i < caseParts.length; i++) {
        var part = caseParts[i];
        if (visLen(part.ind) + visLen(part.text) > (this.opts.hardWidth || this.opts.maxWidth)) {
          /* 第一个 WHEN 与 CASE 同处一行且仍然超长：只在 AND / OR 处拆条件，
           * 保证"第一个 WHEN 不换行"这条规则不被后续折行破坏 */
          var sub = (i === 0 && findKeywordShallow(part.text, 'THEN', 0) >= 0)
            ? this.wrapCondSegments(part.text, part.ind, '', part.ind + '    ', 0)
            : this.genericWrap(part);
          for (var k = 0; k < sub.length; k++) expanded.push(sub[k]);
        } else {
          expanded.push(part);
        }
      }
    }

    if (expanded && shallowOk && shallow.length <= expanded.length && singleWhenCase(code)) {
      /* 单分支 CASE（`CASE WHEN c THEN a ELSE 0 END`）：整行放下只在运算符处折
       * 比展开成 WHEN/THEN/ELSE/END 各占一行更省行，也更接近用户手写的样子。
       * 多分支 CASE 仍然走 splitCase，竖向对齐更好读。 */
      pieces = shallow;
    } else if (expanded) {
      pieces = expanded;
    } else {
      pieces = shallow;
    }
  } finally {
    this.opts.maxWidth = savedMax;
    this.opts.hardWidth = savedHard;
  }

  return pieces;
};

Formatter.prototype.genericWrap = function (ln) {
  var max = this.opts.maxWidth;                     /* 80%：理想宽度 / 目标列 */
  var fill = this.opts.hardWidth || max;            /* 100%：绝不允许超过 */
  var ind = ln.ind;
  var contInd = ln.contInd || continuationIndent(ln.ind);
  var text = ln.text;
  var cands = this.breakCandidates(text);

  if (!cands.length) return [ln];

  var pieces = [];
  var cursor = 0;
  var first = true;

  /* M7（第三轮审计）：旧实现在每轮循环里做 `visLen(text.slice(cursor))` ——
   * 每次都把**剩余全文**重新扫一遍并新建子串，于是单个超长行（IN 列表、
   * VALUES 批量插入）是 O(n²)：1.2 万项约 1.2 秒，4 万项 19 秒，
   * 同步执行会冻结整个扩展宿主（format-on-save 默认只等 750 ms）。
   * 现在维护一个"剩余可视宽度"增量：每消耗一段就减去那一段的宽度，
   * 整条循环变成 O(n)。 */
  var remainingVis = visLen(text);

  while (cursor < text.length) {
    var segStart = cursor;
    var curInd = first ? ind : contInd;
    var indVis = visLen(curInd);
    var availHard = fill - indVis;
    if (availHard < 20) availHard = 20;
    var availTarget = max - indVis;
    if (availTarget < 20) availTarget = 20;
    if (availTarget > availHard) availTarget = availHard;

    /* avail 是"列"，text 下标是"字符"，中文占 2 列时必须换算（P2-10） */
    if (remainingVis <= availTarget) {
      pieces.push({ ind: curInd, text: text.slice(cursor).replace(/\s+$/, ''), kind: ln.kind, exprBase: ln.exprBase, contInd: contInd });
      break;
    }

    var hardChar = indexAtVisWidth(text, cursor, availHard);
    var targetChar = indexAtVisWidth(text, cursor, availTarget);
    /* 只在一个"有效窗口"里挑断点：从目标列（80%）的 45% 处开始，
     * 这样断点不会跑到行首附近，导致第一行只用了几个列。 */
    var floorChar = indexAtVisWidth(text, cursor, Math.max(12, Math.floor(availTarget * 0.45)));
    var targetAbs = indVis + availTarget;

    var best = this.pickBreak(cands, cursor, targetChar, floorChar);
    if (best < 0) {
      /* 80% 内没有断点：放宽到 100%，但只认最外层断点（避免切碎括号参数）。 */
      best = this.pickBreakOverflow(cands, cursor, hardChar);
    }
    if (best < 0) {
      /* 100% 内仍然没有：取最靠右的一个，宁可这一行超一点。 */
      best = this.pickBreakRightmost(cands, cursor, hardChar);
    }
    if (best < 0) {
      /* 完全没有候选断点：只在 token 边界处切，绝不把字段名劈成两半 */
      best = safeCutPos(text, cursor, hardChar);
    }

    /* 断点若正好落在二元运算符上，向前/向后舍入到"逻辑块"的边界，
     * 避免出现 `price` / `* cnt` 这种把算式劈开的输出。 */
    if (best > cursor && best < text.length) {
      var snapped = snapBreakOutsideOperator(text, best, indVis, targetAbs, indVis + availHard, cands.tokens);
      if (snapped > cursor && snapped <= hardChar) best = snapped;
    }

    /* safeCutPos 可能返回超过 hardChar 的位置（单个超长 token），
     * 这种情况宁可超宽也不能切开 token。 */
    if (best <= cursor) best = text.length;

    var piece = text.slice(cursor, best).replace(/\s+$/, '');
    if (piece !== '') {
      pieces.push({ ind: curInd, text: piece, kind: ln.kind, exprBase: ln.exprBase, contInd: contInd });
    }

    /* 增量维护剩余宽度：把 [segStart, cursor) 这段（含跳过的空格）扣掉。 */
    cursor = best;
    while (cursor < text.length && text.charAt(cursor) === ' ') cursor++;
    remainingVis -= visLen(text.slice(segStart, cursor));
    if (remainingVis < 0) remainingVis = 0;
    if (cursor >= text.length) break;
    first = false;
  }

  if (!pieces.length) return [ln];

  /* 收尾：如果某一片只剩逗号 / 分号 / 右括号这类纯分隔符，把它并回上一片。
   *
   * 为什么必须做：`comma_location=true`（逗号后置）时结构层已经输出
   *     SELECT aaa… ,          ← 以逗号结尾
   *             b
   * 折行时这一行的最后一个断点就是那个逗号，于是切出
   *     SELECT aaa…
   *     ,                      ← 只有逗号的一片
   * 随后 convertCommaLocation 把逗号移回上一行行尾，这一片就变成**空行**：
   *     SELECT aaa…,
   *                            ← 凭空多出一个空行（实测复现）
   *             b
   * 纯分隔符本身没有内容可断，并回上一片最多让那一行多 1~2 列，
   * 远好过在输出里插入空行。 */
  for (var pi = pieces.length - 1; pi > 0; pi--) {
    if (/^[,;)\]}]+$/.test(pieces[pi].text.replace(/\s+$/, ''))) {
      pieces[pi - 1].text = pieces[pi - 1].text.replace(/\s+$/, '') +
        pieces[pi].text.replace(/^\s+/, '');
      pieces.splice(pi, 1);
    }
  }

  /* 别名黏合（W-5，2026-11-04 复核）：绝不让 `AS 别名` 单独占一行。
   *
   * 用户预设是「在 80% 处折行，但**保留完整逻辑代码**，可以向前/向后舍入」。
   * `expr AS alias` 正是一个不可分的逻辑单元：在 AS 前断开等于把别名从它修饰的
   * 表达式上摘下来，实测输出
   *     ,COUNT(DISTINCT CASE WHEN order_status = 2 THEN flow_id ELSE NULL END)
   *         AS `取消的合并订单数`          ← 别名悬空，正是用户报的那一屏
   * 而整项其实只有 98 列，屏幕 120 列**放得下** —— 按预设应当整体保留到 100%。
   *
   * 因此：最后一片如果以 AS 开头，且并回上一片后不超过 100%（屏幕宽度），
   * 就并回去（= 向后舍入到逻辑块结束）。并回去会超 100% 时才退回原样，
   * 由调用方在「<100%」的前提下另想办法（那种情况本来就塞不进屏幕）。 */
  for (var ai = pieces.length - 1; ai > 0; ai--) {
    var asTxt = pieces[ai].text.replace(/^\s+/, '');
    if (!/^AS\s/i.test(asTxt)) continue;
    var prevTxt = pieces[ai - 1].text.replace(/\s+$/, '');
    if (prevTxt === '') continue;
    var mergedVis = visLen(pieces[ai - 1].ind) + visLen(prevTxt) + 1 + visLen(asTxt);
    if (mergedVis > fill) continue;          /* 并回去会超出屏幕：放弃，保留原断点 */
    pieces[ai - 1].text = prevTxt + ' ' + asTxt;
    pieces.splice(ai, 1);
  }

  return pieces;
};

Formatter.prototype.wrapLines = function (lines) {
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (ln.text === '') { out.push(ln); continue; }
    /* 纯注释行保持原样；带行尾注释的代码行仍需要判断是否超长。
     * 多行块注释整体不能再被拆开，否则会破坏注释内容（P1-1）。 */
    var res = (ln.kind === 'comment' || ln.multiline) ? [ln] : this.wrapLine(ln);
    for (var k = 0; k < res.length; k++) out.push(res[k]);
  }
  return out;
};

/* ============================== 行内紧凑化 ==============================
 * 结构层（formatTokens）在**每个逗号、每个 AND/OR** 处无条件分行，这是插件
 * 招牌的"一列一行"风格：
 *
 *   select sum(a), avg(b), max(c) from t
 *   → SELECT SUM(a)
 *           ,AVG(b)
 *           ,MAX(c)
 *     FROM t
 *
 * 但表达式**内部**（CASE 分支、函数参数、括号里的算式）被结构层拆开时，
 * 往往拆得毫无必要——`IF(a > 0, 'p', 'n')` 被拆成三行只是噪音。
 *
 * 这里做两件事，边界划得很清楚：
 *   1) **列表类行不合并**：select 字段、group by 字段、order by 字段、
 *      WHERE/ON/HAVING 的 AND/OR 条件项——这些是"项"，一项一行才是可读的；
 *      2026-10-27 追加：DDL 列定义（`create table t (a int, b int, c int)`）
 *      同样属于"项"，也必须一列一行（见下面 A-1 的说明）；
 *   2) **表达式类行合并**：case / code（CASE 分支、括号算式），
 *      只要合并后不超过 maxWidth 就粘回一行。
 *
 * 合并结果只取决于 (结构行, maxWidth)，与原文排版无关 → 多次格式化一致。
 *
 * 第六轮审计（A-1）：这里原本还有一条 `paren: { paren: 1 }`，把 DDL 列定义
 * 列表的续行也合并了 —— 而 `paren` 这个 kind **只**由 DDL 列定义列表产生
 * （`handleParen` 里 `info.isDdlList ? 'paren' : 'stmt'`）。结果是
 *
 *     create table t (a int, b string, c int)
 *       → CREATE TABLE t ( ⏎ a INT ⏎ ,b STRING, c INT ⏎ )
 *                                          ↑ 第 2、3 列挤在同一行
 *
 * 两列时看不出来（只有 `,b STRING` 一行），三列以上就明显错乱：同一张表的列
 * 有的独占一行、有的两个挤一行。而 `Beautify SQL DDL` 走的 sqlddl() 一直是
 * 「一列一行」，两个命令对同一句 CREATE TABLE 给出不同布局，本身也不一致。
 *
 * 因此**移除 paren 的合并**：DDL 列定义必须一列一行。
 * 其它括号场景（函数参数、表达式括号）走 `renderInline`，不产生行 kind，不受影响。 */
var COMPACT_PAIRS = {
  code: { code: 1 },
  case: { case: 1 }
};

/* 这些词开头的行永远是子句起点，绝不能被粘到上一行 */
var COMPACT_BLOCK_HEAD = {
  SELECT: 1, FROM: 1, WHERE: 1, GROUP: 1, ORDER: 1, HAVING: 1, LIMIT: 1, OFFSET: 1,
  UNION: 1, INTERSECT: 1, EXCEPT: 1, MINUS: 1, JOIN: 1, LEFT: 1, RIGHT: 1, FULL: 1,
  INNER: 1, CROSS: 1, NATURAL: 1, ON: 1, WITH: 1, WINDOW: 1, QUALIFY: 1,
  DISTRIBUTE: 1, SORT: 1, CLUSTER: 1, LATERAL: 1, INSERT: 1, UPDATE: 1, DELETE: 1,
  VALUES: 1, SET: 1, CREATE: 1, DROP: 1, ALTER: 1, TRUNCATE: 1, MERGE: 1,
  PARTITIONED: 1, CLUSTERED: 1, STORED: 1, LOCATION: 1, TBLPROPERTIES: 1, ROW: 1,
  SERDE: 1, SKEWED: 1, LIFECYCLE: 1, COMMENT: 1, USING: 1
};

function startsClauseWord(text) {
  var m = /^([A-Za-z_]+)/.exec(String(text).replace(/^\s+/, ''));
  return !!(m && COMPACT_BLOCK_HEAD[m[1].toUpperCase()]);
}

/* 把 b 粘到 a 后面（逗号/右括号/点号不加空格），并重排空格 */
function compactJoin(a, b) {
  var head = String(a).replace(/\s+$/, '');
  var tail = String(b).replace(/^\s+/, '');
  if (tail === '') return head;
  var c0 = tail.charAt(0);
  if (c0 === ',' || c0 === ')' || c0 === ']' || c0 === '.' || c0 === ';') {
    return normalizeLine(head + tail);
  }
  return normalizeLine(head + ' ' + tail);
}

Formatter.prototype.tryCompact = function (prev, cur, max) {
  if (prev.text === '' || cur.text === '') return false;
  if (prev.kind === 'comment' || prev.kind === 'commentTail' || prev.multiline) return false;
  if (cur.kind === 'comment' || cur.kind === 'commentTail' || cur.multiline) return false;
  /* DDL 的列定义块必须保持"每列一行 + 缩进"，不能被压平 */
  if (prev.kind === 'ddl' || cur.kind === 'ddl') return false;
  /* 孤立的括号行（块的开始 / 结束）永远独立成行，否则会压成 `(a INT` */
  var pt = String(prev.text).replace(/\s+$/, '');
  if (pt === '(' || pt === ')' || pt === '),' || pt === ']') return false;
  var ct = String(cur.text).replace(/^\s+/, '');
  if (ct === ')' || ct === '],' || ct === ']') return false;
  /* 上一行以 `(` 结尾 = 块括号的开始，下一行是括号体的第一行，必须保持缩进 */
  if (/\($/.test(pt)) return false;

  var allow = COMPACT_PAIRS[prev.kind];
  if (!allow || !allow[cur.kind]) return false;

  /* 续行必须确实是"接着上一行写的"：缩进更深、或以逗号开头、或本身就是条件续行 */
  var deeper = visLen(cur.ind) > visLen(prev.ind);
  var commaHead = ct.charAt(0) === ',';
  if (!deeper && !commaHead && cur.kind !== 'cond') return false;

  /* 绝不把新子句粘到上一行末尾 */
  if (startsClauseWord(cur.text)) return false;
  /* 绝不把"独立成行的条件项"（AND/OR 开头）粘回去——那是用户明确要保留的列表风格 */
  if (/^(AND|OR)\b/i.test(ct)) return false;

  var merged = compactJoin(prev.text, cur.text);
  /* 合并后不能超过理想宽度（屏幕 80%）—— 与 wrapLine 的折行阈值保持一致。
   * 旧实现放到 100%，于是 compactLines 先粘出一行 95 列的文本，wrapLines 又按
   * 80% 把它拆开：同一份输入在两趟之间来回改写，多出无意义的中间态。 */
  var limit = max;
  if (visLen(prev.ind) + visLen(merged) > limit) return false;

  prev.text = merged;
  return true;
};

Formatter.prototype.compactLines = function (lines) {
  if (this.opts.compactExpressions === false) return lines;
  var max = this.opts.maxWidth;
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var cur = lines[i];
    var prev = out.length ? out[out.length - 1] : null;
    if (prev && this.tryCompact(prev, cur, max)) continue;
    out.push(cur);
  }
  return out;
};

/* ============================== DDL 美化（基于新内核重写） ============================== */

/* 重复 str n 次。原实现用 String.prototype.times 扩展内建原型（可枚举），
 * 会污染 VS Code 宿主进程里的所有字符串，这里改成普通函数。 */
function repeatStr(str, n) {
  if (n <= 0) return '';
  var out = '';
  for (var i = 0; i < n; i++) out += str;
  return out;
}

/* 旧实现是一串正则替换（`replace(/^\(/ig,'(\\n')` 只对行首生效），
 * 单行 DDL `create table db.t (a string comment 'aa', ...)` 会把 `create` 当成列名，
 * 表名和首列整段丢失，末尾还凭空多一个 "COMMENT "。
 * 这里改成基于 token 的结构化排版：
 *   1) 找到第一个 `(` 的列定义列表（跳过库名.表名、IF NOT EXISTS 等修饰词）；
 *   2) 只在括号最外层按逗号切列，泛型里的 `,`（map<string,int>）不会误切；
 *   3) 每列对齐"列名 / 类型 / COMMENT"，类型不做大小写转换；
 *   4) 括号后的 PARTITIONED BY / STORED AS / LOCATION / TBLPROPERTIES 各自成行。 */
/* M4：DDL 列表缩进跟随 bracket_char / tabWidth。
 *   bracketChar=true  → w 个空格（w = tabWidth，默认 4）
 *   bracketChar=false → 一个制表符
 * 由 ddl() 的第二个参数传入（不再读模块级变量 —— 那会让结果依赖调用顺序，
 * 正是 M5 那类问题）。 */
function ddlColIndent(opts) {
  var w = (opts && typeof opts.tabWidth === 'number' && opts.tabWidth > 0) ? opts.tabWidth : 4;
  if (opts && opts.bracketChar === true) return repeatStr(' ', w);
  if (opts && opts.bracketChar === false && opts.columnIndentKnown === true) return '\t';
  return '  ';
}

function ddl(str, ddlOpts) {
  var toks = tokenize(str);
  if (!toks.length) return str;

  /* F3-2（2026-10-29 复核）：renderDdlGroup 现在会把 maxWidth / hardWidth 传进来，
   * 但旧实现内部完全没用它们 —— CREATE TABLE 的列清单恒为"一列一行"。
   * 这里取一次，列行超限时把 rest（COMMENT / DEFAULT / 约束）折到下一行。 */
  var ddlMaxW = (ddlOpts && typeof ddlOpts.maxWidth === 'number' && ddlOpts.maxWidth > 0)
    ? ddlOpts.maxWidth : 0;
  var ddlHardW = (ddlOpts && typeof ddlOpts.hardWidth === 'number' && ddlOpts.hardWidth > 0)
    ? ddlOpts.hardWidth : 0;

  /* --- CTAS / CREATE VIEW AS SELECT（P0-9）---
   * `create table t as select max(a) as m from s` 里的第一个 "(" 是 max( 的括号，
   * 旧版把它当成列定义列表起点，输出成
   *   CREATE TABLE t AS select MAX
   *   (
   *     a
   *   )
   *   AS m FROM s
   * 这是语法错误的 SQL，而安全网认为 token 等价所以放行。
   * 判定：在第一个 "(" 之前出现顶层 AS 且其后紧跟 SELECT/WITH → 不是列定义 DDL，
   * 交给上层的 SQL 路径处理（sqlddl 里会调 sql() 格式化整条 CTAS）。 */
  var depthCtas = 0, sawAs = false;
  for (var ci = 0; ci < toks.length; ci++) {
    var ct0 = toks[ci];
    if (ct0.type === 'punct') {
      if (ct0.value === '(') { depthCtas++; }
      else if (ct0.value === ')') { depthCtas = Math.max(0, depthCtas - 1); }
      else if (ct0.value === ';' && depthCtas === 0) break;
      else if (ct0.value === '(' && depthCtas === 1 && !sawAs) break;
      continue;
    }
    if (ct0.type === 'word' && ct0.upper === 'AS') {
      /* P2-1（2026-11-05 复核）：`create table t as (select a, b from s)` 的
       * AS 后面先是一个括号。旧判据要求"下一个 token 就是 SELECT/WITH"，
       * 带括号的 CTAS 判据不成立，于是那个 `(` 被当成列定义列表起点，
       * 把整个查询体拆成"列定义"并逐项缩进 —— 输出结构完全错误。
       * 现在跳过任意个 `(` 再判断。 */
      var nx0 = toks[ci + 1];
      var skip0 = 0;
      while (nx0 && nx0.type === 'punct' && nx0.value === '(') {
        skip0++;
        nx0 = toks[ci + 1 + skip0];
      }
      if (nx0 && nx0.type === 'word' && (nx0.upper === 'SELECT' || nx0.upper === 'WITH' ||
          nx0.upper === 'VALUES' || nx0.upper === 'TABLE')) {
        sawAs = true;
        break;
      }
    }
  }
  if (sawAs) return str;                            /* 由 sqlddl 走 SQL 路径 */

  /* --- 找到列定义列表的左括号 --- */
  var open = -1;
  for (var i = 0; i < toks.length; i++) {
    if (toks[i].type === 'punct' && toks[i].value === '(') { open = i; break; }
    if (toks[i].type === 'punct' && (toks[i].value === ';' || toks[i].value === '=')) break;
  }
  if (open < 0) return str;

  var close = -1, depth = 0;
  for (i = open; i < toks.length; i++) {
    if (toks[i].type !== 'punct') continue;
    if (toks[i].value === '(') depth++;
    else if (toks[i].value === ')') { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return str;                     /* 括号不配对：交给原样输出 */

  /* --- 前缀：CREATE TABLE ... --- */
  var prefix = joinTokens(toks.slice(0, open), true);
  if (!/^\s*CREATE\b/i.test(prefix)) return str;  /* 不是建表语句，不动 */

  /* M4（第三轮审计）：只有 **CREATE TABLE** 的括号才是列定义列表。
   * 旧实现只要求"以 CREATE 开头"，于是
   *     create index idx on t (a);                    → 把 (a) 当成列定义展开成多行
   *     create or replace function f() returns int …  → 把 () 当成空列清单
   * 都是语法上完全不同的 DDL，却走了建表排版路径。
   * 这里要求前缀里出现 TABLE（且不在别的词里），其余 CREATE 交给调用方走 SQL 路径。 */
  if (!/(^|\s)TABLE(\s|$)/i.test(prefix)) return str;

  /* --- 按最外层逗号切列 --- */
  var cols = [];
  var seg = [];
  depth = 0;
  for (i = open + 1; i < close; i++) {
    var t = toks[i];
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && t.type === 'punct' && t.value === ',') {
      cols.push(seg);
      seg = [];
      continue;
    }
    seg.push(t);
  }
  if (seg.length) cols.push(seg);

  /* P1-11（2026-11-02 审计）：把"与上一列逗号同一行的注释"归回上一列。
   *
   * 切列只看逗号，于是
   *     a int, -- first
   *     b int
   * 里的 `-- first` 变成了 b 的段首注释，输出时排在 b 上方 ——
   * 读起来像在说明 b，而作者的本意是说明 a。
   *
   * 判据用注释 token 的 nl（与**上一个 token** 之间隔了几个换行）：
   *   nl === 0 → 同一行，属于上一列  → 追加到上一列的 trail
   *   nl > 0   → 独占一行，属于下一列 → 保持段首
   * 这也是原作者 parseColumn 里 nl 字段的语义。 */
  for (i = 1; i < cols.length; i++) {
    var segHead = cols[i];
    var moveTo = cols[i - 1];
    while (segHead.length && segHead[0].type === 'comment' && segHead[0].nl === 0) {
      moveTo.push(segHead.shift());
    }
  }

  /* --- 解析每列：name / type / 其余（COMMENT 等） --- */
  var rows = [];
  for (i = 0; i < cols.length; i++) {
    var row = parseColumn(cols[i]);
    if (row) rows.push(row);
  }

  var out = [];
  out.push(rtrim(prefix));

  if (rows.length) {
    /* 列宽按**小数显示宽度**算（中文 1.818 列，见 CJK_WIDTH_RATIO），
     * 否则 CJK 列名与 ASCII 列名的类型起点对不齐。 */
    var nameW = 0, typeW = 0;
    for (i = 0; i < rows.length; i++) {
      nameW = Math.max(nameW, visWidthF(rows[i].name));
      typeW = Math.max(typeW, visWidthF(rows[i].type));
    }
    var colInd = ddlColIndent(ddlOpts);
    out.push('(');
    /* P2-2（2026-11-05 复核）：`comma_location` 也要对 DDL 列清单生效。
     * package.json 声称 DDL 跟随该配置，sqlddl 也把它传进了 Formatter 与缓存键，
     * 但 ddl() 渲染列清单时写死的是**前置逗号**（列尾），于是
     * comma_location=false/true 的输出完全相同。
     * 现在先渲染所有列（不含逗号），最后按风格统一落逗号：
     *   · false（默认）：挂在**上一列最后一行**的行尾；
     *   · true：挂在**下一列第一行**的行首（缩进缩短 1 格，保持类型列对齐）。
     * 逗号与行尾注释的先后顺序保持不变（先逗号、后注释）。 */
    var colRecs = [];
    function pushColLines(lines, trailArr) {
      var firstAt = out.length;
      for (var ql = 0; ql < lines.length; ql++) out.push(lines[ql]);
      colRecs.push({ first: firstAt, last: out.length - 1, trail: trailArr || null });
    }
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      /* 段首注释（上一列逗号之后、本列之前）原样成行，保证 DDL 里的注释不丢（P0-8） */
      if (r.lead && r.lead.length) {
        for (var li = 0; li < r.lead.length; li++) out.push(colInd + r.lead[li]);
      }
      if (r.onlyComment) continue;                 /* 整段只有注释，已输出 */
        /* 表级约束：整体单行输出（不参与列名/类型对齐） */
        if (r.tableConstraint) {
          pushColLines([colInd + r.constraintText], r.trail);
          continue;
        }
      /* 行尾不留空格（P2-5）：最后一列若没有 rest，不要补 type 的 pad */
      /* 补空格取整：空格的宽度恒为 1，小数差只能 round */
      var padName = Math.round(nameW - visWidthF(r.name));
      if (padName < 0) padName = 0;
      var line = colInd + rows[i].name + repeatStr(' ', padName) + ' ' + rows[i].type;
      var restTail = '';
      if (r.rest) {
        var padType = Math.round(typeW - visWidthF(r.type));
        if (padType < 0) padType = 0;
        var restStr = repeatStr(' ', padType) + ' ' + r.rest;
        /* F3-2：超限时把 rest 折到下一行（用列缩进 + 两个空格续写），
         * 而不是让整行无限延长。上限优先用 maxWidth（80% 理想宽度），
         * 没有就退到 hardWidth（100% 屏幕）。 */
        var limit = ddlMaxW > 0 ? ddlMaxW : ddlHardW;
        if (limit > 0 && visWidthF(colInd + rows[i].name + repeatStr(' ', padName) +
            ' ' + rows[i].type + restStr) > limit) {
          restTail = restStr.replace(/^\s+/, '');
        } else {
          line += restStr;
        }
      }
      line = rtrim(line);
      /* F3-2：折行时，逗号必须落在**该列最后一行**的末尾 ——
       * 留在第一行会变成 `col TYPE,\n  COMMENT 'x'`，逗号把列和它的注释拆开，
       * token 流与原文不等价（安全网会回退整段）。 */
      var colLines = [];
      if (restTail) {
        colLines.push(line);
        colLines.push(colInd + '  ' + restTail);
      } else {
        colLines.push(line);
      }
      pushColLines(colLines, r.trail);
    }

    /* 统一落逗号（见上面 P2-2 的说明）。
     * P1-11（2026-11-02 审计）：**先补逗号，再挂注释** ——
     * 反过来的话输出 `a INT -- first,`，逗号成了行注释的内容。
     *
     * 2026-11-07 复核：这里的判定与 SQL 路径**相反**了。
     * SQL 路径（Formatter，见 convertCommaLocation）里 `commaLocation: true`
     * 表示"逗号补到上一行行尾"，false 表示"逗号留在下一行行首"；
     * 原插件 package.json 的描述也是 "Fix the comma location to the end of the
     * line"，即 true = 行尾。而这里写成了 `commaLocation === true` → 行首，
     * 于是同一个开关在 SELECT 列表和 DDL 列清单上得到相反结果。
     * 现在统一：true = 列尾，false（默认）= 列首。 */
    var commaAtLineStart = !(ddlOpts && ddlOpts.commaLocation === true);
    for (var cr = 0; cr < colRecs.length; cr++) {
      var rec = colRecs[cr];
      if (cr !== colRecs.length - 1) {
        if (commaAtLineStart) {
          var nxRec = colRecs[cr + 1];
          var headLine = out[nxRec.first];
          var indM = /^([ \t]*)([\s\S]*)$/.exec(headLine);
          var headInd = indM[1];
          /* 逗号占一格，缩进相应减 1，类型列仍然对齐 */
          if (headInd.length > 0) headInd = headInd.slice(0, -1);
          out[nxRec.first] = headInd + ',' + indM[2];
        } else {
          out[rec.last] = rtrim(out[rec.last]) + ',';
        }
      }
      /* 段尾注释（与逗号同一行）挂在最后一行尾，避免被当成下一列的段首 */
      if (rec.trail && rec.trail.length) out[rec.last] += ' ' + rec.trail.join(' ');
    }
    out.push(')');
  } else {
    out.push('(' + joinTokens(toks.slice(open + 1, close), true).replace(/\s+$/, '') + ')');
  }

  /* --- 括号之后的 DDL 结构子句，各自成行 --- */
  var restToks = toks.slice(close + 1);
  var clauseStart = {};
  clauseStart.PARTITIONED = 1; clauseStart.CLUSTERED = 1; clauseStart.STORED = 1;
  clauseStart.LOCATION = 1; clauseStart.TBLPROPERTIES = 1; clauseStart.ROW = 1;
  /* P2-6（2026-11-02 审计）：ROW FORMAT SERDE 以前被拆成两行 ——
   * SERDE 是 ROW FORMAT 的续写部分，不是新的 DDL 子句。 */
  clauseStart.SKEWED = 1; clauseStart.COMMENT = 1;
  clauseStart.LIFECYCLE = 1;
  clauseStart.COLLECTION = 1;

  /* 多语句 DDL：在分号处强制换行，避免 `; CREATE TABLE b ...` 拼在上一行尾 */
  var curLine = [];
  depth = 0;
  for (i = 0; i < restToks.length; i++) {
    var rt = restToks[i];
    if (rt.type === 'punct' && rt.value === ';' && depth === 0) {
      if (curLine.length) out.push(joinTokens(curLine, true).replace(/\s+$/, ''));
      out.push(';');
      curLine = [];
      continue;
    }
    if (rt.type === 'punct' && rt.value === '(') depth++;
    else if (rt.type === 'punct' && rt.value === ')') depth = Math.max(0, depth - 1);

    if (depth === 0 && rt.type === 'word' && clauseStart[rt.upper] &&
        (curLine.length || rt.upper === 'PARTITIONED' || rt.upper === 'CLUSTERED')) {
      /* PARTITIONED BY (...) / CLUSTERED BY (...) 里的列定义仍展开成多行。
       * 旧实现把 restToks.slice(i) 之后"所有"内容都交给 renderTrailingClause，
       * 其后的 STORED AS / LOCATION / TBLPROPERTIES 被兜底 joinTokens 并成一行（M-4）。
       * 现在只把当前子句（到下一个 clauseStart 词或分号为止）交给它渲染。 */
      if (rt.upper === 'PARTITIONED' || rt.upper === 'CLUSTERED') {
        /* 先把当前子句（如 `COMMENT 'x'` / `LOCATION '/x'`）落行，
         * 否则它会被 renderTrailingClause 的 slice(i,...) 整段吞掉（安全网拦下 → 原样返回）。 */
        if (curLine.length) out.push(joinTokens(curLine, true).replace(/\s+$/, ''));
        curLine = [];
        var clauseEnd = restToks.length;
        /* P2-6（2026-11-02 审计）：**必须跟踪括号深度**。
         * `PARTITIONED BY (ds STRING COMMENT 'p', hr STRING COMMENT 'q')`
         * 里 `COMMENT` 是列注释，不是新的表级子句；旧实现只看词表，
         * 于是子句在第一个 COMMENT 处被截断，交给 renderTrailingClause 的片段
         * 连右括号都没有 → 输出被拆成三行。 */
        var ceDepth = 0;
        for (var ce = i + 1; ce < restToks.length; ce++) {
          var ct = restToks[ce];
          if (ct.type === 'punct' && ct.value === '(') { ceDepth++; continue; }
          if (ct.type === 'punct' && ct.value === ')') { ceDepth = Math.max(0, ceDepth - 1); continue; }
          if (ct.type === 'punct' && ct.value === ';' && ceDepth === 0) { clauseEnd = ce; break; }
          if (ceDepth !== 0) continue;
          if (ct.type === 'word' && clauseStart[ct.upper] && ce > i + 1) {
            /* 子句内的词（如 SORTED BY 里的 BY）不算新子句：只认「上一 token 是括号外」的情况 */
            var prevCt = restToks[ce - 1];
            if (!(prevCt && prevCt.type === 'punct' && (prevCt.value === ')' || prevCt.value === '('))) {
              if (!(ct.upper === 'BY')) { clauseEnd = ce; break; }
            }
          }
        }
        var tailToks = restToks.slice(i, clauseEnd);
        var rendered = renderTrailingClause(tailToks, ddlOpts);
        for (var ri = 0; ri < rendered.length; ri++) out.push(rendered[ri]);
        curLine = [];
        i = clauseEnd - 1;
        continue;
      }
      out.push(joinTokens(curLine, true).replace(/\s+$/, ''));
      curLine = [];
    }
    curLine.push(rt);
  }
  if (curLine.length) out.push(joinTokens(curLine, true).replace(/\s+$/, ''));

  return out.filter(function (l) { return l !== ''; }).join('\n');
}

/* ---------------------------------------------------------------- 方言表
 * `#` 在不同方言里身份完全不同，这是本项目里唯一**无法靠文本自身**判定的歧义：
 *   MySQL / MariaDB : `#` 开始一行注释             → select a # 注释
 *   PostgreSQL      : `#` 是位异或 / 几何运算符     → select a # b
 *   Hive / Spark    : 不支持 `#` 注释（只有 -- 与 / * * /）→ `#` 只能是运算符
 *   T-SQL           : `#tmp` 是临时表名前缀         → 标识符
 * 完全相同的两段文本 `select a # b from t`，在 MySQL 里是"a 加注释"，
 * 在 PG 里是"a 异或 b"。所以必须由**调用方**把 document.languageId 传进来，
 * 由这里映射成 hash 的语义；未知方言才退回启发式（见 classifyHash）。 */
/* 反斜杠是不是字符串转义符 —— **由方言决定**（H2，第二轮审计）。
 *
 * 旧实现不看方言，先按标准 SQL（无转义）切一遍，只有"切出未闭合字符串"才改用
 * 反斜杠模式。于是含**偶数个** `\'` 的语句（`select 'it\'s' as a, 'don\'t' as b`）
 * 引号总数也是偶数，标准切法"恰好闭合"，整段按错误词法切开：
 *     SELECT 'it\' s ' as a, ' don \ 't' AS b
 * 字符串内容被插入空格 —— **数据被改写**，而重新词法后 token 序列一致，安全网放行。
 *
 * 现在：已知方言直接固定；只有方言未知 / 'auto' 才退回启发式（并要求两种切法
 * 的"未闭合"结论一致才算数）。 */
var BACKSLASH_DIALECT = {
  /* 反斜杠是转义符 */
  mysql: true, mariadb: true, my: true,
  hive: true, 'hive-sql': true, hivesql: true,
  spark: true, 'spark-sql': true, sparksql: true,
  impala: true, clickhouse: true, bigquery: true, 'sql-bigquery': true,
  doris: true, starrocks: true,
  /* 方言兼容性检测（§3.2）：这几个 languageId 已经注册在 SQL_SELECTOR 里，
   * 但以前两张方言表都没有它们，于是 `#` 退化成"按文本内容猜" ——
   * 同一个文件里既有 `#` 运算符又有 `#` 注释时必然有一处被误判。
   * 现在按各自的语义家族补齐（扩展自 Spark / PostgreSQL / Hive / 标准 SQL）。 */
  databricks: true, delta: true, hudi: true, iceberg: true,   /* Spark 家族 */
  maxcompute: true, odps: true,                                /* 阿里 MaxCompute，Hive 语法 */
  /* 反斜杠是普通字符（标准 SQL / PG standard_conforming_strings 默认 on） */
  pgsql: false, postgres: false, postgresql: false, pg: false, greenplum: false,
  plpgsql: false, duckdb: false, db2: false,
  oracle: false, plsql: false, tsql: false, 'sql-server': false, sqlserver: false, mssql: false,
  sqlite: false, vertica: false,
  presto: false, trino: false, athena: false, teradata: false,
  /* P0-3（2026-11-02 审计）：Snowflake 的单引号字符串**支持反斜杠转义**
   * （官方文档 data-types-text：\' 表示单引号），旧表把它配成 false，
   * 于是 `'it\'s'` 被切成 `'it\'` + `s'`，内容被改写。
   * Redshift 走 PG 兼容模式，standard_conforming_strings 默认 on，
   * 反斜杠是普通字符 —— 保持 false 是正确的。 */
  snowflake: true, 'snowflake-sql': true, redshift: false
};

function backslashModeOf(dialect) {
  if (!dialect) return null;
  var k = String(dialect).toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(BACKSLASH_DIALECT, k)) return BACKSLASH_DIALECT[k];
  if (/mysql|mariadb/.test(k)) return true;
  if (/hive|spark|impala|clickhouse|bigquery|doris|starrocks/.test(k)) return true;
  if (/postgres|greenplum|oracle|plsql|sqlserver|tsql|mssql|sqlite|snowflake|redshift|vertica|presto|trino|athena|teradata/.test(k)) return false;
  return null;                              /* 未知 → 调用方走启发式 */
}

var HASH_DIALECT = {
  mysql: 'comment', mariadb: 'comment', my: 'comment',
  pgsql: 'xor', postgres: 'xor', postgresql: 'xor', pg: 'xor',
  hive: 'xor', 'hive-sql': 'xor',
  spark: 'xor', 'spark-sql': 'xor',
  impala: 'xor', clickhouse: 'xor', bigquery: 'xor', 'sql-bigquery': 'xor',
  snowflake: 'xor', 'snowflake-sql': 'xor', redshift: 'xor', vertica: 'xor',
  tsql: 'ident', 'sql-server': 'ident', sqlserver: 'ident',
  plsql: 'xor', oracle: 'xor', sqlite: 'xor',
  /* 方言兼容性检测（§3.2）：补齐已注册 languageId 的映射。
   *   · databricks / delta / hudi / iceberg —— Spark 家族，与 spark 一致（xor）
   *   · maxcompute / odps                     —— Hive 语法（xor）
   *   · plpgsql / duckdb                      —— PostgreSQL 家族（xor）
   *   · db2                                   —— 标准 SQL，`#` 不是注释（xor） */
  databricks: 'xor', delta: 'xor', hudi: 'xor', iceberg: 'xor',
  maxcompute: 'xor', odps: 'xor',
  plpgsql: 'xor', duckdb: 'xor', db2: 'xor'
};

/* 把 languageId / 方言名归一成 'comment' | 'xor' | 'ident' | null（未知） */
function hashModeOf(dialect) {
  if (!dialect) return null;
  var k = String(dialect).toLowerCase().trim();
  if (HASH_DIALECT[k]) return HASH_DIALECT[k];
  /* 兼容 "PostgreSQL" / "MySQL" 这类带大小写的全名 */
  if (/mysql|mariadb/.test(k)) return 'comment';
  if (/postgres|greenplum|redshift/.test(k)) return 'xor';
  if (/hive|spark|impala|clickhouse|bigquery|snowflake|presto|trino|athena/.test(k)) return 'xor';
  if (/sqlserver|tsql|mssql/.test(k)) return 'ident';
  return null;
}

/* 把 PARTITIONED BY (...) 之类的尾段渲染成"子句 ( + 展开的列定义 + )"。
 * 左括号跟子句同一行（`PARTITIONED BY (`），与 `GROUP BY (` 的排版一致；
 * 旧版把 `PARTITIONED BY` 和 `(` 拆成两行，只有 `PARTITIONED` 走这条路径，
 * `COMMENT` / `STORED AS` 却是单行，风格不统一（残留 1）。 */
function renderTrailingClause(toks, trailingOpts) {
  var out = [];
  var head = [];
  var i = 0;
  while (i < toks.length && !(toks[i].type === 'punct' && toks[i].value === '(')) {
    head.push(toks[i]); i++;
  }
  var headText = joinTokens(head, true).replace(/\s+$/, '');
  if (i >= toks.length) {
    out.push(headText);
    return out;
  }

  var depth = 0, close = -1;
  for (var k = i; k < toks.length; k++) {
    if (toks[k].type !== 'punct') continue;
    if (toks[k].value === '(') depth++;
    else if (toks[k].value === ')') { depth--; if (depth === 0) { close = k; break; } }
  }
  if (close < 0) { out.push(headText + ' ' + joinTokens(toks.slice(i), true)); return out; }

  /* 展开分区列 */
  var cols = [];
  var seg = [];
  depth = 0;
  for (var j = i + 1; j < close; j++) {
    var t = toks[j];
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && t.type === 'punct' && t.value === ',') { cols.push(seg); seg = []; continue; }
    seg.push(t);
  }
  if (seg.length) cols.push(seg);

  var rows = [];
  for (var c = 0; c < cols.length; c++) {
    var row = parseColumn(cols[c]);
    if (row) rows.push(row);
  }
  if (rows.length) {
    /* 同 ddl()：小数显示宽度（中文 1.818 列） */
    var nw = 0, tw = 0;
    for (c = 0; c < rows.length; c++) {
      nw = Math.max(nw, visWidthF(rows[c].name));
      tw = Math.max(tw, visWidthF(rows[c].type));
    }
    out.push(headText + ' (');
    var partLines = [];
    for (c = 0; c < rows.length; c++) {
      /* 行尾不留空格（P2-5）：只有后面还有内容时才补 pad */
      var padN = Math.round(nw - visWidthF(rows[c].name));
      if (padN < 0) padN = 0;
      var pl = ddlColIndent(trailingOpts) + rows[c].name + repeatStr(' ', padN) + ' ' + rows[c].type;
      var restPad = Math.round(tw - visWidthF(rows[c].type));
      if (restPad < 0) restPad = 0;
      if (rows[c].rest) {
        /* P2-6（2026-11-02 审计）：rest 里可能带原文换行（`a INT\n-- c`），
         * 直接拼进一行会把整行劈成多行 —— 正是 PARTITIONED BY 被 COMMENT
         * 拆碎的成因。这里压缩成单个空格。 */
        var restFlat = String(rows[c].rest).replace(/\s+/g, ' ').replace(/\s+$/, '');
        pl += repeatStr(' ', restPad) + ' ' + restFlat;
      }
      partLines.push(rtrim(pl));
    }
    /* 2026-11-07 复核：分区列以前写死**行尾**逗号，与 ddl() 列清单、SQL 的
     * SELECT 列表都不一致 —— comma_location 在同一个文件里出现两种风格。
     * 现在与 ddl() 同规则：true = 列尾，false（默认）= 下一行列首。 */
    var partLeadComma = !(trailingOpts && trailingOpts.commaLocation === true);
    for (c = 0; c < partLines.length; c++) {
      if (c === partLines.length - 1) { out.push(partLines[c]); break; }
      if (partLeadComma) {
        var nx = /^([ \t]*)([\s\S]*)$/.exec(partLines[c + 1]);
        var nxInd = nx[1].length > 0 ? nx[1].slice(0, -1) : nx[1];
        partLines[c + 1] = nxInd + ',' + nx[2];
      } else {
        partLines[c] = partLines[c] + ',';
      }
      out.push(partLines[c]);
    }
    out.push(')');
  } else {
    out.push(headText + ' (' + joinTokens(toks.slice(i + 1, close), true).replace(/\s+$/, '') + ')');
  }

  var tail = toks.slice(close + 1);
  if (tail.length) out.push(joinTokens(tail, true).replace(/\s+$/, ''));
  return out;
}

/* 解析一列：`a string comment 'x'` → { name:'a', type:'STRING', rest:"COMMENT 'x'" }
 *
 * 注释必须保留（P0-8）：旧版 `toks.filter(t => t.type !== 'comment')` 把列注释
 * 直接扔掉，于是 `create table t (a string, -- keep\n b int)` 的 DDL 美化
 * 永远会删注释；现在被安全网整篇打回 → 该 DDL 永远无法美化。
 * 这里把"段首注释"（含上一列逗号之后的注释）单独收集，由 ddl() 渲染成独立行。 */
function parseColumn(toks) {
  /* 段首注释 */
  var i0 = 0;
  var lead = [];
  while (i0 < toks.length && toks[i0].type === 'comment') { lead.push(toks[i0].value); i0++; }

  /* 段尾注释 */
  var i1 = toks.length - 1;
  var trail = [];
  while (i1 >= i0 && toks[i1].type === 'comment') { trail.unshift(toks[i1].value); i1--; }

  var list = toks.slice(i0, i1 + 1);
  if (!list.length) {
    /* 整段只有注释：交给 ddl() 原样输出 */
    return { name: '', type: '', rest: '', lead: lead, trail: trail, onlyComment: true };
  }

    /* 表级约束（PRIMARY KEY / UNIQUE KEY / INDEX / FOREIGN KEY / CONSTRAINT ...）：
     * 它们不是"列名 + 类型"，而是独立的定义项。旧版把 `primary key (a)` 拆成
     * 名字 = primary、类型 = KEY、其余 = (a)，输出成 `primary KEY(a)`——
     * 关键字大小写与空格全乱；更糟的是这些写法原本会让安全网判不等价、
     * 整条 CREATE TABLE 静默不格式化（H-8 / N-11 / P1-8 / R3-1）。
     * 现在整体按原样（只规整大小写）单行输出，不再当成列解析。 */
    var CONSTRAINT_HEAD = {
      PRIMARY: 1, UNIQUE: 1, KEY: 1, INDEX: 1, FULLTEXT: 1, SPATIAL: 1,
      FOREIGN: 1, CONSTRAINT: 1, CHECK: 1, EXCLUDE: 1, PERIOD: 1
    };
    var firstWord = list[0] && list[0].type === 'word' ? String(list[0].upper) : '';
    /* 约束头词里有一部分**同时是极常见的列名**（KEY / INDEX / CHECK /
     * FULLTEXT / SPATIAL / EXCLUDE / PERIOD）。`key int` 是列定义，
     * `primary key (a)` 才是表级约束，必须区分，否则 `key int` 会被
     * 当成约束输出成 `KEY INT`（改用户列名）。
     * 判定：这类歧义词只有在「后面紧跟 ( 」或「后面跟一个非类型词再跟 ( 」
     * 时才算约束。`key decimal(10,2)` 的 decimal 是类型词 → 仍是列定义。 */
    var AMBIGUOUS_HEAD = { KEY: 1, INDEX: 1, FULLTEXT: 1, SPATIAL: 1, CHECK: 1, EXCLUDE: 1, PERIOD: 1 };
    var looksLikeConstraint = true;
    if (AMBIGUOUS_HEAD[firstWord]) {
      var t1 = list[1], t2 = list[2];
      var nxParen = !!(t1 && t1.type === 'punct' && t1.value === '(');
      /* L-5：`key \`idx_n\` (\`n\`)` —— 约束名常常是**带引号**的标识符
       * （反引号 / 双引号 / 方括号），它们被词法器切成 quoted token，
       * 旧判据只认 type==='word'，于是这种表级索引被当成「列名 + 类型」解析，
       * 输出成 `key     \`idx_n\`(\`n\`)`（名字列被对齐、括号前还少了空格）。 */
      /* L-5：`key "idx_n" ("n")` —— 双引号标识符在 Hive/MySQL 里被词法器
       * 当成 string token（那里 `"` 是字符串引号），同样要认成约束名。 */
      var nameThenParen = !!(t1 && (t1.type === 'word' || t1.type === 'quoted' ||
        (t1.type === 'string' && t1.value.charAt(0) === '"')) &&
        (t1.type !== 'word' || !TYPE_WORDS[String(t1.upper)]) &&
        t2 && t2.type === 'punct' && t2.value === '(');
      looksLikeConstraint = nxParen || nameThenParen;
    }
    if (CONSTRAINT_HEAD[firstWord] && looksLikeConstraint) {
      /* `check` / `constraint` 之后可能还有约束名，整段按原样保留 */
      /* 约束词的大小写必须在这里处理，不能在 markKeywords 里做：
       * 那些词（KEY/FOREIGN/CHECK/INDEX）同时也是极常见的列名和函数名，
       * token 层无法区分，猜错就会把用户的列名改大写。
       * 走到这个分支说明**已经确定**这是列定义列表里的一个表级约束项，
       * 此时把约束头词逐词大写是安全的。 */
      var CONSTRAINT_WORDS = /^(PRIMARY|UNIQUE|KEY|INDEX|FULLTEXT|SPATIAL|FOREIGN|CONSTRAINT|CHECK|REFERENCES|EXCLUDE|PERIOD|ON|NOT|NULL|DEFERRABLE|INITIALLY|DEFERRED|IMMEDIATE)$/i;
      var cText = joinTokens(list, true).replace(/\s+/g, ' ').replace(/\s*\(\s*/g, ' (').trim();
      /* C-01：约束词的大小写必须跟随 uppercase 开关。
       * 旧实现恒 toUpperCase，于是 uppercase=false 时输出
       * `create table t (a int, PRIMARY KEY (a), b string …)` ——
       * 同一句里只有约束是大写，用户以为配置没生效。 */
      cText = cText.split(/(\s+|\()/).map(function (w) {
        if (!CONSTRAINT_WORDS.test(w)) return w;
        return JOIN_CASE === 'lower' ? w.toLowerCase() : w.toUpperCase();
      }).join("");
      return {
        name: '', type: '', rest: '', lead: lead, trail: trail,
        tableConstraint: true, constraintText: cText
      };
    }
  var first = list[0];
  var name = first.value;
  var rest = list.slice(1);

  /* 分区列可能写成 `dt string` 或 `dt string comment 'x'` */
  var typeEnd = 0;
  var type = '';
  if (rest.length) {
    var t0 = rest[0];
    if (t0.type === 'word' || (t0.type === 'punct' && t0.value === '(')) {
      type = t0.value;
      typeEnd = 1;

      /* 多词类型（N-28）：DOUBLE PRECISION / CHARACTER VARYING(20) /
       * TIMESTAMP WITH TIME ZONE / NATIONAL CHARACTER VARYING。
       * 先收修饰词，再收类型的参数括号。旧版只取首词，
       * 输出成 `DOUBLE    precision` 这种半大写的怪样子。 */
      var MULTI_TYPE_TAIL = /^(PRECISION|VARYING|ZONE|CHARACTER|NATIONAL|UNSIGNED|SIGNED|LOCAL|TIME|WITH|WITHOUT)$/i;
      while (rest[typeEnd] && rest[typeEnd].type === 'word' &&
             MULTI_TYPE_TAIL.test(String(rest[typeEnd].value))) {
        type += ' ' + rest[typeEnd].value;
        typeEnd++;
      }

      /* 带参数的类型：decimal(18,2) / varchar(20) / character varying(20) */
      if (rest[typeEnd] && rest[typeEnd].type === 'punct' && rest[typeEnd].value === '(') {
        var d = 0, k = typeEnd;
        for (; k < rest.length; k++) {
          if (rest[k].type === 'punct' && rest[k].value === '(') d++;
          else if (rest[k].type === 'punct' && rest[k].value === ')') { d--; if (d === 0) break; }
        }
        type += joinTokens(rest.slice(typeEnd, k + 1), false);
        typeEnd = k + 1;
      }
      /* `map<string,int>` 这类泛型类型已被 markGenericTypes 合成**一个** token，
       * 所以 typeEnd 停在它后面就已经正确，这里不需要额外分支。 */

      /* M4（第三轮审计）：PG 的数组后缀 `text[]` / `varchar(10)[]` / `int[][]`。
       * 旧实现把 `[` `]` 丢进 rest，输出成 `TEXT []` —— 重新词法后 `[]` 变成
       * 方括号标识符，安全网判 token 不等价，**整条 CREATE TABLE 静默回退**
       * （用户看到"按了没反应"）。M-4 上一轮只修了 sql() 路径，DDL 路径漏了。
       * 词法器把 `[]` 合成**一个** punct token（arraySuffix），所以两种形态都要认：
       *   · 单个 `'[]'` token（正常情况）
       *   · `'['` + `']'` 两个 token（词法器降级时的兜底）
       * 输出时紧贴类型名，不加空格。 */
      for (;;) {
        var nt = rest[typeEnd];
        if (!nt || nt.type !== 'punct') break;
        if (nt.value === '[]') { type += '[]'; typeEnd++; continue; }
        if (nt.value === '[' && rest[typeEnd + 1] &&
            rest[typeEnd + 1].type === 'punct' && rest[typeEnd + 1].value === ']') {
          type += '[]';
          typeEnd += 2;
          continue;
        }
        break;
      }
    }
  }

  var tailToks = rest.slice(typeEnd);
  var restText = joinTokens(tailToks, true).replace(/\s+$/, '');

  /* 类型名的大小写：把类型名里的每个**类型词**按当前模式处理（N-28 / BUG-1）：
   *   JOIN_CASE = upper → DOUBLE PRECISION / CHARACTER VARYING(20)
   *   JOIN_CASE = lower → double precision / character varying(20)
   * 泛型参数里的字段名保持原样（P2-8：`struct<MyCol:int>` 的 MyCol 是列标识符）。
   *
   * 旧版这里恒 toUpperCase，于是 uppercase=false 时出现「关键字小写、类型大写」
   * 的大小写混杂输出 —— 删掉 lowerDdlKeywords 之后这个副作用才暴露出来。 */
  var TYPE_HEAD_WORDS = /^(PRECISION|VARYING|ZONE|CHARACTER|NATIONAL|UNSIGNED|SIGNED|LOCAL|TIME|WITH|WITHOUT|OF|SET|INTERVAL|DAY|HOUR|MINUTE|SECOND|YEAR|MONTH)$/i;
  var recaseTypeWord = function (w) {
    return JOIN_CASE === 'lower' ? w.toLowerCase() : w.toUpperCase();
  };
  var typeText = type;
  var gm = /^([^\s(<]+)([\s\S]*)$/.exec(type);
  if (gm) {
    var head = gm[1];
    var restType = gm[2];
    /* 括号/尖括号之前的部分可能是多个词，逐词判断是否类型词 */
    var parenPos = restType.search(/[(<]/);
    var wordsPart = parenPos >= 0 ? restType.slice(0, parenPos) : restType;
    var tailPart = parenPos >= 0 ? restType.slice(parenPos) : "";
    var recased = wordsPart.split(/(\s+)/).map(function (w) {
      if (!w || /^\s+$/.test(w)) return w;
      return TYPE_HEAD_WORDS.test(w) ? recaseTypeWord(w) : w;
    }).join("");
    /* 泛型/参数括号里的**容器词**也要跟随大小写（豆包 BUG-8）：
     * typeText 只重排了 head 和括号之前的词，`map<string,map<int,string>>`
     * 的 tailPart 因此一直是原样 → 出现 `MAP<string,map<int,string>>`
     * 外层大写、内层小写的混杂。
     * 只动容器词（map/struct/array/uniontype），叶子类型名与字段名
     * （`struct<MyCol:int>` 的 MyCol / int）保持原样。 */
    var recasedTail = tailPart.replace(/[A-Za-z_][A-Za-z0-9_]*/g, function (w) {
      var W = w.toUpperCase();
      /* 方言兼容性检测报告 §3.5：泛型里的**叶子类型名**也跟随 uppercase
       * （`map<string,int>` → `MAP<STRING, INT>`）。
       * 只改确定是类型名的词：字段名（`struct<MyCol:int>` 的 MyCol、
       * `struct<a int64>` 的 a）不在 TYPE_WORDS / GENERIC_TYPE_WORDS 里，保持原样。 */
      if (!GENERIC_TYPE_WORDS[W] && !TYPE_WORDS[W]) return w;
      return recaseTypeWord(w);
    });
    typeText = recaseTypeWord(head) + recased + recasedTail;
  }

  /* P0-8：ClickHouse 方言下类型名一律保持用户原文（大小写敏感）。 */
  if (/clickhouse/i.test(String(LEX.dialect || ''))) {
    return {
      name: name,
      type: type,
      rest: restText,
      lead: lead,
      trail: trail
    };
  }

  return {
    name: name,
    type: typeText,
    rest: restText,
    lead: lead,
    trail: trail
  };
}

/* 把 token 列表拼回文本。doCase=true 时按关键字表做大小写（默认大写）。 */
function joinTokens(toks, doCase) {
  var out = '';
  var last = null, last2 = null, last3 = null, last4 = null;
  /* P-02（2026-11-04 复核）：行首状态，理由同 renderInline。 */
  var headFirst = '', headCount = 0;
  for (var i = 0; i < toks.length; i++) {
    var tk = toks[i];
    if (tk.type === 'comment') {
      out = rtrim(out);
      if (out !== '') out += ' ';
      out += tk.value;
      if (/\S/.test(tk.value)) {
        if (headCount === 0) headFirst = String(tk.value).charAt(0);
        headCount++;
      }
      /* 注释占位：让注释后紧跟的 token 正常加空格（M-3，同 renderInline） */
      last = { type: 'word', upper: '', value: tk.value, commentPlaceholder: true };
      last2 = null; last3 = null; last4 = null;
      continue;
    }
    if (last && last.type === 'word' && last.upper === 'AS' && !tk.castType) tk.noCase = true;
    if (last && last.type === 'punct' && last.value === '.') tk.noCase = true;
    markUnary(tk, last);
    var space = false;
    if (out !== '') {
      space = spaceBetween(last, tk, out, last2, last3, last4,
        headCount === 1 && headFirst === ',');
    }
    if (space) out += ' ';
    /* 大小写模式由 Formatter 决定（JOIN_CASE）：
     *   upper → 大写关键字；lower → 小写关键字。
     * 旧版 joinTokens 恒大写，DDL 路径只能事后用正则把整个输出里
     * 「看起来像关键字的词」全小写 —— 正则分不清关键字与标识符，
     * 于是 `create table t (DATA string)` 的列名 DATA 也被改成 data（H-5）。 */
    /* 泛型类型（map<…> / struct<…> / array<…>）整体被 markGenericTypes 合成
     * 一个 noCase token，所以内层的容器词从来没被重排过大小写，
     * 出现 `MAP<string,map<int,string>>` 这种外层大写、内层小写的混杂（豆包 BUG-8）。
     * 这里只重排**容器词**（map/struct/array/uniontype）；参数里的叶子类型名
     * 与字段名（`struct<MyCol:int>` 的 MyCol）一律保持原样。 */
    /* P0-8（2026-11-02 审计）：ClickHouse 的类型名大小写敏感，
     * `LowCardinality(String)` 里的 `String` 被改成 `STRING` 之后类型不存在。
     * 泛型容器本身（LowCardinality / Nullable / Array）也一并保持原样。 */
    if (doCase && tk.type === 'word' && tk.generic && !tk.path &&
        !/clickhouse/i.test(String(LEX.dialect || ''))) {
      var gTail = String(tk.genericTail || '');
      /* 容器词（map/struct/array/uniontype）一律跟随 uppercase。 */
      gTail = gTail.replace(/[A-Za-z_][A-Za-z0-9_]*/g, function (w) {
        var W = w.toUpperCase();
        if (GENERIC_TYPE_WORDS[W]) return JOIN_CASE === 'lower' ? w.toLowerCase() : W;
        /* 方言兼容性检测报告 §3.5：泛型里的**叶子类型名**也要跟随 uppercase。
         *   create table t (m map<string,int>, s struct<a:int,b:string>)
         * 旧实现只改容器词，输出 `MAP<string,int>` / `STRUCT<a:int,b:string>` ——
         * 外层列类型全大写、内层类型全小写，同一行两种风格。
         *
         * 关键判据：只改**确定是类型名**的词，绝不动字段名。
         * 判据是「该词在已知类型表里」—— `a` / `b` / `MyCol` 这些字段名
         * 不在 TYPE_WORDS 里，因此 `struct<MyCol:int>` 的 MyCol 保持原样。
         * 这样既修正了观感，又不会像"无条件大写整个泛型内容"那样篡改字段名。 */
        if (TYPE_WORDS[W] || GENERIC_TYPE_WORDS[W]) return JOIN_CASE === 'lower' ? w.toLowerCase() : W;
        return w;
      });
      var gHead = JOIN_CASE === 'lower' ? String(tk.genericHead || '').toLowerCase() : String(tk.genericHead || '').toUpperCase();
      out += gHead + gTail;
      if (gHead.length > 0) {
        if (headCount === 0) headFirst = gHead.charAt(0);
        headCount++;
      }
      last4 = last3; last3 = last2; last2 = last; last = tk;
      continue;
    }
    var _tokText = (doCase && tk.type === 'word' && !tk.noCase && tk.keyword && !tk.path)
      ? ((JOIN_CASE === 'lower') ? tk.value.toLowerCase() : tk.value.toUpperCase())
      : tk.value;
    out += _tokText;
    if (_tokText.length > 0) {
      var _hc = _tokText.charCodeAt(0);
      if (_hc !== 32 && _hc !== 9) {
        if (headCount === 0) headFirst = _tokText.charAt(0);
        headCount++;
      }
    }
    last4 = last3;
    last3 = last2;
    last2 = last;
    last = tk;
  }
  return out;
}

/* ============================== 从 SELECT/INSERT 提取 DDL ============================== */

/* 比旧实现多做的事：
 *   - 支持 `insert overwrite table t select ...`（旧版只能从 SELECT 起始行取）；
 *   - 别名支持反引号 / 双引号 / 方括号（旧版遇到 `as \`别名\`` 整列丢弃）；
 *   - 保留 `t.*`（旧版丢弃）；
 *   - 没有别名的表达式用表达式本身做列名（旧版整列丢弃）；
 *   - 类型默认 STRING 而不是 BIGINT（BIGINT 对字符串列是错类型），
 *     聚合/字面量尽量推断常见类型。 */
/* P2-5（2026-11-02 审计）：第二个参数从「方言字符串」扩展成「方言或选项对象」。
 * 旧的字符串形式继续支持（大量内部调用点仍传字符串）。
 * 选项：{ dialect, uppercase, bracketChar, tabWidth, cjkWidth, maxWidth, hardWidth } */
function extractddl(str, dialect, renderOpts) {
  var ro = renderOpts || {};
  if (dialect && typeof dialect === 'object') { ro = dialect; dialect = ro.dialect; }
  /* 与对外 API 一致：先做方言检测，否则含 MySQL 反斜杠转义（'it\\'s'）的
   * SELECT 会被切错，导致提取出的列名/别名缺失。 */
  var lex = detectLex(str, dialect);
  lastExtractReason = '';
  lastTypeGuess = "";
  /* P2-5（2026-11-05 复核）：同一张表被多条 INSERT 写入时合并成一份 DDL。
   *   mergedTargets —— 被合并过的目标表（用于在输出末尾提示"已合并"）；
   *   dupCols       —— 合并/去重时加了 _2 后缀的列名。 */
  var mergedTargets = [];
  var dupCols = [];
  /* M6：记住原始 EOL。旧实现全程按 \n 拼接，CRLF 文件里提取一次就把整段改成 LF。
   * P2-6（2026-11-05 复核）：判定必须只看**代码区**。旧实现用裸文本正则
   * /\r\n/.test(str)，LF 文档里只要有一个跨行字符串含 CRLF，整份产出就被
   * 拼成 CRLF（实测 0 个 CRLF → 5 个）。sql() / sqlddl() 早就改用
   * detectDocEol，提取路径漏改。 */
  var eolIn = detectDocEol(str, lex);
  var src = str.replace(/\r\n?/g, '\n');

  var f = new Formatter({
    uppercase: true, commaLocation: false, bracketChar: false, asLocCnt: 150, maxWidth: 150,
    /* 提取器需要"一列一行"的中间结构，关掉紧凑化，否则列会被合并到同一行 */
    compactExpressions: false,
    backslash: lex.backslash, hashComment: lex.hashComment, hashMode: lex.hashMode,
    dashSpace: lex.dashSpace, dialect: lex.dialect
  });

  /* ------------------------------------------------------------------
   * 目标表与列清单的定位改成**基于 token**（A-03 / A-04）。
   *
   * 旧实现用一条正则从原文里「猜」目标表名：
   *   /\binsert\s+(?:into|overwrite)\s+(?:table\s+)?([A-Za-z0-9_$`".\u4e00-\u9fa5]+)/i
   * 两个致命点：
   *   ① 字符类里没有空格，`"my schema"."order"` 只吃到 `"my`，去掉引号后
   *      变成 `CREATE TABLE my` —— 生成一份表名完全错误的 DDL，而它看上去能执行；
   *   ② 它永远取**第一个** INSERT 的目标，列清单却取「第一个 SELECT」，
   *      于是 Hive 多路插入 `from s insert into t1 select aa insert into t2 select bb`
   *      会把 t2 的列写进 t1（A-04）。
   *
   * 现在：按 token 解析 `[db.]tbl`（允许每个部分带引号/方括号），
   * 并把「某个 INSERT 的列清单」限定为它**后面第一个顶层 SELECT**，
   * 到下一个顶层 INSERT / 分号为止。两者一一对应，不会再串。
   * ------------------------------------------------------------------ */
  var toks = tokenizeRaw(src, lex);

  /* 解析 `a.b."c d"` / `[my table]` / `` `x y` `` 这种限定名，保留原引号。 */
  function readTableName(i) {
    var parts = [], j = i, wantName = true;
    while (j < toks.length) {
      var t = toks[j];
      if (wantName) {
        if (t.type === 'word' || t.type === 'quoted' ||
            (t.type === 'string' && t.value.charAt(0) === '"')) {
          parts.push(t.value); j++; wantName = false; continue;
        }
        break;
      }
      if (t.type === 'punct' && t.value === '.') { wantName = true; j++; continue; }
      break;
    }
    if (!parts.length || wantName) return null;
    return { name: parts.join('.'), end: j };
  }

  var depth = 0;
  var inserts = [];                    /* { target, selIdx } */
  var topSelects = [];
  for (var ti = 0; ti < toks.length; ti++) {
    var tt = toks[ti];
    if (tt.type === 'punct' && tt.value === '(') { depth++; continue; }
    if (tt.type === 'punct' && tt.value === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0 || tt.type !== 'word') continue;
    if (tt.upper === 'SELECT') { topSelects.push(ti); continue; }
    if (tt.upper !== 'INSERT') continue;

    /* INSERT [OVERWRITE] [INTO] [TABLE] name —— INTO / OVERWRITE 至少一个 */
    var k = ti + 1;
    var sawDir = false;
    while (k < toks.length && toks[k].type === 'word' &&
           /^(INTO|OVERWRITE|TABLE|LOCAL|DIRECTORY)$/i.test(String(toks[k].upper))) {
      if (toks[k].upper === 'DIRECTORY') { sawDir = true; break; }
      if (toks[k].upper === 'INTO' || toks[k].upper === 'OVERWRITE') sawDir = true;
      k++;
    }
    if (sawDir === false) continue;
    /* `INSERT OVERWRITE [LOCAL] DIRECTORY '/path'`：目标是一段路径，没有表名 */
    if (k < toks.length && toks[k].type === 'word' && toks[k].upper === 'DIRECTORY') continue;
    var nm = readTableName(k);
    if (!nm) continue;

    /* M-6：`insert into t (a, b) select x, y` 的**显式列清单**才决定目标列名，
     * 旧实现完全忽略它，直接拿 SELECT 的表达式/别名当列名（x, y）——
     * 生成的建表语句列名全错，而它看上去完全合法。
     * 这里把括号里的标识符按顺序记下来（允许带引号/反引号/方括号），
     * 后面按位置覆盖列名。括号里出现非标识符（表达式）时放弃，退回旧行为。 */
    var collist = null;
    if (nm.end < toks.length && toks[nm.end].type === 'punct' && toks[nm.end].value === '(') {
      var cl = [], cj = nm.end + 1, okCl = true;
      while (cj < toks.length && !(toks[cj].type === 'punct' && toks[cj].value === ')')) {
        var ct2 = toks[cj];
        if (ct2.type === 'word' || ct2.type === 'quoted') { cl.push(ct2.value); cj++; continue; }
        if (ct2.type === 'punct' && ct2.value === ',') { cj++; continue; }
        okCl = false; break;                       /* PARTITION (dt='x') 之类，不是列清单 */
      }
      if (okCl && cj < toks.length && cl.length) collist = cl;
    }

    /* 这个 INSERT 的列清单 = 它后面第一个**顶层** SELECT。
     *
     * P1-8（2026-11-02 审计）：旧实现不跟踪括号深度，于是
     *     insert into t with x as (select a from s) select a, b from x
     * 取到的是 CTE **内部**的 `select a from s` —— 只识别出列 a，b 丢了。
     * （`WITH x AS (…)` 里的括号深度是 1，真正的取数 SELECT 在深度 0。） */
    var selIdx = -1;
    var selDepth = 0;
    for (var sj = nm.end; sj < toks.length; sj++) {
      var stj = toks[sj];
      if (stj.type === 'punct' && stj.value === '(') { selDepth++; continue; }
      if (stj.type === 'punct' && stj.value === ')') { selDepth = Math.max(0, selDepth - 1); continue; }
      if (stj.type === 'punct' && stj.value === ';' && selDepth === 0) break;
      if (stj.type !== 'word') continue;
      if (stj.upper === 'INSERT' && selDepth === 0) break;
      if (stj.upper === 'SELECT' && selDepth === 0) { selIdx = sj; break; }
    }
    /* P1-9（2026-11-02 审计）：`INSERT OVERWRITE TABLE t PARTITION (dt='2020') SELECT …`
     * 的分区键必须写进生成的 DDL（`PARTITIONED BY (dt STRING)`），
     * 否则用户照这份 DDL 建出来的表没有分区，后续写入直接失败。 */
    var partCols = null;
    if (nm.end < toks.length && toks[nm.end].type === 'word' &&
        String(toks[nm.end].upper) === 'PARTITION' &&
        toks[nm.end + 1] && toks[nm.end + 1].type === 'punct' && toks[nm.end + 1].value === '(') {
      var pc = [], pj = nm.end + 2, okPc = true, pdepth = 0;
      while (pj < toks.length) {
        var pt2 = toks[pj];
        if (pt2.type === 'punct' && pt2.value === '(') { pdepth++; pj++; continue; }
        if (pt2.type === 'punct' && pt2.value === ')') {
          if (pdepth === 0) break;
          pdepth--; pj++; continue;
        }
        if (pdepth === 0 && pt2.type === 'word') { pc.push(pt2.value); pj++; continue; }
        if (pdepth === 0 && pt2.type === 'punct' && (pt2.value === '=' || pt2.value === ',')) { pj++; continue; }
        if (pt2.type === 'string' || pt2.type === 'number') { pj++; continue; }
        okPc = false; break;
      }
      if (okPc && pc.length) partCols = pc;
    }

    inserts.push({ target: nm.name, selIdx: selIdx, collist: collist, partCols: partCols });
  }

  /* P1-9（2026-11-02 审计）：原来的实现只处理 `inserts[0]`，于是
   * "insert into t1 …; insert into t2 …;" 只产出 t1 的 DDL，t2 静默消失。
   * 现在为**每个** INSERT 目标各生成一条 CREATE TABLE。 */
  function buildColumns(uItems, uCollist, uWildcards) {
    var out = [];
    var used = Object.create(null);
    var colPos = 0;
    var guessed = [];
    /* M-6：INSERT 的目标列清单（若声明了），按位置覆盖列名。 */
      var collist = uCollist;
    var wildcards = uWildcards || [];

    for (var q = 0; q < uItems.length; q++) {
      var item = uItems[q];

      /* H4（第三轮审计）：SELECT 列表里的 **hint / 前导块注释** 不是列表达式。
       *   `select /*+ mapjoin(b) *\/ a.x, b.y …`
       * 旧实现把 hint 原样留在 item 里，列名生成把它当成表达式，
       * 输出 `div_mul_add_mapjoin_b_mul_div_a_x` 这种乱码列名，
       * 用户复制 DDL 去建表会得到一个完全不相干的列名。 */
      item = stripLeadingComments(item);

      var cp = findCommentPos(item, lex.hashComment, lex.backslash);
      var comment = '';
      if (cp >= 0) {
        comment = item.slice(cp).replace(/^[-\s]+/, '').replace(/\s+$/, '');
        item = item.slice(0, cp);
      }

      item = rtrim(item);
      if (!item) continue;

      /* A-05：通配符（`*` / `t.*` / `db.t.*`）无法静态展开，但**绝不能静默丢弃**。
       * 旧实现走到 splitAlias 返回 null 就 continue，于是 `select t.*, a from t`
       * 提取出的 DDL 只有 a —— 用户拿这份 DDL 建表会少掉一整批列，
       * 而且看不出任何提示；更糟的是文件头部注释还写着"保留 t.*"，行为与文档矛盾。
       * 现在记录下来，在输出末尾追加一条明确的待办注释。 */
      if (/^(?:[A-Za-z0-9_$`"\[\]\u4e00-\u9fa5]+\.)*\*$/.test(item)) {
        wildcards.push(item);
        continue;
      }

      /* P1-7：先剥掉表达式中间的块注释，再解析别名 —— 否则注释里的 `*` `/`
       * 会被 generatedColName 当成运算符展开成 `div_mul_x_mul_div`。 */
      var parsed = splitAlias(stripInlineBlockComments(item));
      if (!parsed || !parsed.name) continue;

      /* F-09（2026-11-04 复核）：**带引号的别名原样保留**。
       * `select a as "x y", b as `my col` from t` 里的 `"x y"` / `` `my col` ``
       * 是合法的带引号标识符，空格是名字的一部分。旧实现一律走 sanitizeAlias，
       * 把空格换成下划线 → 生成 `x_y` / `my_col`：DDL 悄悄改名，
       * 下游按原名查不到列。这里直接沿用引号风格输出。 */
      var quotedAlias = parsed.quoted === true && parsed.name !== '';
      var quoteStyle = '';
      if (quotedAlias) {
        /* 引号风格按方言：MySQL/Hive/Spark 用反引号，其余用双引号。
         * 用户自己写了一对方括号（T-SQL）时保持方括号。 */
        var rawAliasText = String(item).slice(findTopLevelAs(String(item)) + 4).trim();
        if (/^\[[\s\S]*\]$/.test(rawAliasText)) quoteStyle = 'bracket';
        else if (/^`[\s\S]*`$/.test(rawAliasText)) quoteStyle = 'backtick';
        else if (/^"[\s\S]*"$/.test(rawAliasText)) quoteStyle = 'double';
        else quoteStyle = /mysql|mariadb|hive|spark|impala|clickhouse/i.test(String(dialect || '')) ? 'backtick' : 'double';
      }

      var colName = quotedAlias ? String(parsed.name) : sanitizeAlias(parsed.name);
      if (!colName || colName === '*') continue;

      /* M-6：INSERT 有显式列清单时，**按位置**用清单里的名字覆盖。
       * `insert into t (a, b) select x, y from s` → 列名必须是 a, b。
       * 显式列清单与通配符的组合在调用方直接拒绝，不猜测列映射。 */
      if (collist && colPos < collist.length) {
        colName = sanitizeAlias(unquoteIdent(String(collist[colPos])));
        if (!colName) colName = sanitizeAlias(parsed.name);
      }

      /* 重名列（P1-9）：旧版直接 `continue`，于是 `select a as x, b as x` 静默丢一列。
       * 现在加 _2 / _3 后缀保留每一列，行为可预测且不丢数据。 */
      var colKey = colName.toLowerCase();
      if (used[colKey]) {
        var seq = 2;
        while (used[(colName + '_' + seq).toLowerCase()]) seq++;
        colName = colName + '_' + seq;
        colKey = colName.toLowerCase();
        dupCols.push(colName);     /* P2-5：交给上层提示"同名列已加后缀" */
      }
      used[colKey] = 1;
      colPos++;

      var type = inferType(parsed.expr, dialect);
      /* P2-5：inferType 把"只能猜"的情况写进 lastTypeGuess，这里把它归到本列。 */
      if (lastTypeGuess !== "") {
        /* 表达式就是列名本身（`select a as x` 里的 a）时不必重复列出来， */
        /* `x (a)` 这种写法对用户没有信息量。 */
        var guessExpr = String(lastTypeGuess).replace(/\s+/g, " ").trim();
        if (guessExpr && guessExpr.toLowerCase() !== String(colName).toLowerCase()) {
          guessed.push(colName + " (" + guessExpr + ")");
        } else {
          guessed.push(colName);
        }
        lastTypeGuess = "";
      }
      /* COMMENT 里的单引号转义方式**必须按方言**（豆包 BUG-3）：
       *   MySQL / Hive / Spark / ClickHouse : 反斜杠转义  'it\'s'
       *   PG / Oracle / SQLite / TSQL / 其它 : 单引号双写  'it''s'
       * 旧版恒用 \'，在 PG（standard_conforming_strings 默认 on）和 Oracle 里
       * 生成的 DDL 直接语法错误 —— 那是一份用户要复制出去执行的语句。
       * 反斜杠同理：只有 MySQL 系需要加倍，其它方言里反斜杠是普通字符。 */
      var BS_ESCAPE = /mysql|mariadb|hive|spark|impala|clickhouse|bigquery|presto|trino/i;
      var useBackslash = BS_ESCAPE.test(String(dialect || ''));
      var safeComment = String(comment || ' ');
      if (useBackslash) {
        safeComment = safeComment.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      } else {
        safeComment = safeComment.replace(/'/g, "''");
      }
      safeComment = safeComment.replace(/\r?\n/g, ' ');
        /* 只有原文**确实有注释**时才输出 COMMENT。
         * 旧版恒发 `COMMENT " "`（一个空格），等于给每一列凭空加一个空注释，
         * 用户复制这份 DDL 去建表，列注释里会多出一堆空格（N-26 / P2-10）。 */
      /* 保留字列名必须加引号（豆包 BUG-9）：
       * `select a as order` 生成的 `CREATE TABLE t (order STRING)` 在 Hive/MySQL
       * 里是语法错误 —— 用户复制出去执行会直接失败。
       * 只对「**硬保留字**」加引号（order/select/from/where/group/table…），
       * 像 date/user/type 这类在主流方言里可以直接当列名的词不加，
       * 免得平白给用户的 DDL 添一堆引号。
       * 引号风格按方言：MySQL/Hive/Spark 用反引号，其余用双引号。
       * 列名里本来就带引号时（splitAlias 已剥掉外层引号）不再重复包裹。 */
      var outColName = colName;
      if (quotedAlias) {
        /* F-09：带引号的别名按用户原来的引号风格输出（方括号 / 反引号 / 双引号）。 */
        if (quoteStyle === 'bracket') outColName = '[' + colName + ']';
        else if (quoteStyle === 'backtick') outColName = '`' + colName + '`';
        else outColName = '"' + colName + '"';
      } else if (HARD_RESERVED[colName.toUpperCase()]) {
        var quoteChar = /mysql|mariadb|hive|spark|impala|clickhouse/i.test(String(dialect || '')) ? '`' : '"';
        outColName = quoteChar + colName + quoteChar;
      }
      var line = outColName + " " + type;
        if (comment) line += " COMMENT '" + safeComment + "'";
        out.push(line);
    }
    return { cols: out, guessed: guessed };
  }

  /* 每个 INSERT 一份：{ target, items, wildcards, collist, partCols } */
  var units = [];
  function unitFor(u) {
    var iu = inserts[u];
    if (!iu || iu.selIdx < 0) return null;
    var uItems = [], uWild = [];
    var boundEnd = src.length;
    for (var bk = iu.selIdx + 1; bk < toks.length; bk++) {
      var bt = toks[bk];
      if (bt.type === 'word' && bt.upper === 'INSERT') { boundEnd = bt.start; break; }
      if (bt.type === 'punct' && bt.value === ';') { boundEnd = bt.start; break; }
    }
    var segLines = f.formatLines(src.slice(toks[iu.selIdx].start, boundEnd));
    collectSelectItems(segLines, 0, uItems, uWild);
    var filteredItems = [];
    for (var ui = 0; ui < uItems.length; ui++) {
      if (/^(?:[A-Za-z0-9_$`"\[\]\u4e00-\u9fa5]+\.)*\*$/.test(uItems[ui])) uWild.push(uItems[ui]);
      else filteredItems.push(uItems[ui]);
    }
    return { target: iu.target, items: filteredItems, wildcards: uWild,
             collist: iu.collist, partCols: iu.partCols };
  }

  var targetTable = 't';
  var items = [];
  var wildcards = [];

  if (inserts.length) {
    for (var uI = 0; uI < inserts.length; uI++) {
      var one = unitFor(uI);
      if (!one || (!one.items.length && !one.wildcards.length)) continue;
      /* P2-5（2026-11-05 复核）：**同一个目标表的多条 INSERT 必须合并成一份 DDL**。
       * 旧实现每条 INSERT 各生成一份 `CREATE TABLE t`，两条各只含一半列，
       * 而且复制执行第二条会报 table already exists。README 承诺的是
       * "每条目标表各生成一条 CREATE TABLE"—— 同一张表出现两次时，
       * 正确做法是把列清单并集起来，只输出一份。
       * 重复列交给 buildColumns 去重（加 _2 后缀），并在末尾给出提示。 */
      var same = null;
      for (var uj = 0; uj < units.length; uj++) {
        if (units[uj].target === one.target) { same = units[uj]; break; }
      }
      if (same) {
        for (var mi = 0; mi < one.items.length; mi++) same.items.push(one.items[mi]);
        for (var mw = 0; mw < one.wildcards.length; mw++) same.wildcards.push(one.wildcards[mw]);
        if (!same.collist && one.collist) same.collist = one.collist;
        if (!same.partCols && one.partCols) same.partCols = one.partCols;
        mergedTargets.push(one.target);
        continue;
      }
      units.push(one);
    }
    if (!units.length) {
      lastExtractReason = 'INSERT 语句后面没有跟着 SELECT，无法推断列清单。';
      return '';
    }
  } else {
    /* 纯 SELECT 输入：沿用"第一个顶层 SELECT 分支"的语义。 */
    var lines = f.formatLines(src);
    var branchStarts = [];
    var depthAll = 0;
    for (var bs = 0; bs < lines.length; bs++) {
      var bl = lines[bs].text;
      if (depthAll === 0 && /^\s*SELECT\b/i.test(bl)) branchStarts.push(bs);
      depthAll += countParenDelta(bl);
      if (depthAll < 0) depthAll = 0;
    }
    if (!branchStarts.length) {
      lastExtractReason = '没有找到顶层 SELECT 语句，无法推断列清单。';
      return '';
    }
    /* UNION / EXCEPT / INTERSECT 的元数据由**第一个分支**决定（SQL 标准），
     * 且各分支的列数必须相同。旧版把每个分支的列都收进来再补 _2 后缀，
     * 于是 `insert into t select a, b from t1 union all select a, b from t2`
     * 给只有 2 列的目标表 t 生成了 4 列（a, b, a_2, b_2）—— 结构性错误（R3-3）。 */
    collectSelectItems(lines, branchStarts[0], items, wildcards);
    units.push({ target: 't', items: items, wildcards: wildcards,
                 collist: null, partCols: null });
  }

  /* 目标表名兜底：不能为空、不能是 SELECT/WITH 这类词。
   *
   * M11b（第三轮审计）：旧判据是 `/[A-Za-z_\u4e00-\u9fa5`"\[]/`，只认 ASCII 字母 +
   * 中文。于是 `insert into заказы …`、`insert into café …`、
   * `insert into Ürünler …` 里的表名一个字符都不匹配 → 静默变成 `t`，
   * 用户拿到的 DDL 建出来是一张叫 t 的空壳表。
   * 词法器的标识符字符集早就用 \p{L} 覆盖全部 Unicode，这里跟着用即可。 */
  function safeTableName(name) {
    if (!/[\p{L}\p{Nl}_`"[]/u.test(name) || /^(select|with|values)$/i.test(name)) return 't';
    return name;
  }

  /* P2-5：提取阶段用 uppercase=true（判定 TYPE_WORDS 需要稳定大小写），
   * 但**渲染阶段**必须听调用方的。ddl() → joinTokens 读的是全局 JOIN_CASE，
   * 所以这里用目标选项重新构造一个 Formatter 把全局量刷过去。
   * 同时透传缩进/括号风格/列宽，否则 Extract 的结果永远是 2 空格 + 150 列。 */
  var renderUpper = ro.uppercase !== false;
  /* eslint-disable no-new */
  new Formatter({
    uppercase: renderUpper,
    commaLocation: false,
    bracketChar: ro.bracketChar === true,
    asLocCnt: (typeof ro.maxWidth === 'number' && ro.maxWidth > 0) ? ro.maxWidth : 150,
    maxWidth: (typeof ro.maxWidth === 'number' && ro.maxWidth > 0) ? ro.maxWidth : 150,
    hardWidth: (typeof ro.hardWidth === 'number' && ro.hardWidth > 0) ? ro.hardWidth : undefined,
    tabWidth: (typeof ro.tabWidth === 'number' && ro.tabWidth > 0) ? ro.tabWidth : 4,
    backslash: lex.backslash, hashComment: lex.hashComment, hashMode: lex.hashMode,
    dashSpace: lex.dashSpace, dialect: lex.dialect,
    cjkWidth: (typeof ro.cjkWidth === 'number' && ro.cjkWidth > 0) ? ro.cjkWidth : undefined
  });

  var ddlMax = (typeof ro.maxWidth === 'number' && ro.maxWidth > 0) ? ro.maxWidth : undefined;
  var ddlHard = (typeof ro.hardWidth === 'number' && ro.hardWidth > 0) ? ro.hardWidth : undefined;
  var allWildcards = [];
  /* P2-5：类型是靠猜的列，最后统一说明。 */
  var allGuessed = [];
  var pieces = [];

  for (var uR = 0; uR < units.length; uR++) {
    var un = units[uR];
    if (un.collist && un.wildcards.length) {
      lastExtractReason = '目标表 ' + un.target + ' 的 SELECT 列表含通配符（' +
        un.wildcards.join(', ') + '），无法确定与显式目标列清单的列映射；请先展开通配符。';
      return '';
    }
    var built = buildColumns(un.items, un.collist, un.wildcards);
    var cols = built.cols;
    for (var gq = 0; gq < built.guessed.length; gq++) allGuessed.push(built.guessed[gq]);
    if (un.wildcards.length) {
      for (var wq = 0; wq < un.wildcards.length; wq++) {
        allWildcards.push(un.target + ': ' + un.wildcards[wq]);
      }
    }
    if (!cols.length) continue;
    /* P1-9：分区键 → PARTITIONED BY (col STRING, …) */
    var partClause = '';
    if (un.partCols && un.partCols.length) {
      var pcs = [];
      for (var pq = 0; pq < un.partCols.length; pq++) {
        pcs.push(un.partCols[pq] + ' STRING');
      }
      partClause = ' partitioned by (' + pcs.join(', ') + ')';
    }
    var piece = ddl('create table ' + safeTableName(un.target) + ' (' + cols.join(', ') + ')' + partClause,
      { maxWidth: ddlMax, hardWidth: ddlHard,
        tabWidth: ro.tabWidth, bracketChar: ro.bracketChar,
        /* 2026-11-07 复核：以前漏了 commaLocation —— 文档说 Extract 跟随配置，
         * 但提取出来的 DDL 永远用行首逗号（默认风格）。 */
        commaLocation: ro.commaLocation === true,
        columnIndentKnown: typeof ro.tabWidth === 'number' || ro.bracketChar === true });
    pieces.push(piece);
  }

  if (!pieces.length) {
    /* A-05：整列清单都是通配符（`select *` / `select t.*`）时**返回空串**，
     * 让扩展层的"不写回"保护生效 —— 绝不能把一条提示注释覆盖到用户的 SQL 上。
     * 具体原因通过 lastDiagnostics() 传给扩展，由它弹出准确提示。 */
    if (allWildcards.length) {
      lastExtractReason = '列清单全部是通配符（' + allWildcards.join(', ') +
        '），无法静态展开列名；请先手动展开为具体列后再提取。';
    } else {
      lastExtractReason = '没有从 SELECT 列表里识别出任何列。';
    }
    return '';
  }
  var ddlText = pieces.join('\n\n');
  if (units.length > 1 && allWildcards.length) {
    lastExtractReason = '部分目标表含未展开的通配符：' + allWildcards.join(', ') +
      '；请先补全列清单，本次未生成不完整的 DDL。';
    return '';
  }
  lastExtractReason = '';

  /* A-05：单目标、部分通配符时保留已知列并明确列出待补内容。 */
  if (allWildcards.length) {
    ddlText += '\n' + wrapNoteLines('-- Snug SQL Formatter: 以下通配符未展开，请按实际表结构补列：' +
      allWildcards.join(', '), ddlMax || ddlHard || 120);
  }

  /* P2-5（2026-11-02 审计）：把"类型是猜出来的"这件事写清楚。
   * 旧实现静默给 STRING —— 用户照这份 DDL 建表，金额/时间/布尔列全变字符串，
   * 而且完全看不出来。现在显式列出，用户知道该手工核对哪几列。
   *
   * 2026-11-04（缺陷 X-1）：这段提示是**单行**拼出来的，列一多就几百列宽
   *（实测 12 列 → 585 列，远超屏幕）。它是给人看的注释，必须跟着折行宽度走。 */
  if (allGuessed.length) {
    ddlText += '\n' + wrapNoteLines('-- Snug SQL Formatter: 以下列的类型无法静态推断，已按 STRING 处理，请按实际语义核对：' +
      allGuessed.join(', '), ddlMax || ddlHard || 120);
  }

  /* P2-5（2026-11-05 复核）：多条 INSERT 写同一张表时合并成了一份 DDL，
   * 以及重名列被加了 _2 后缀 —— 这两件事都改了"一条 INSERT 一份列清单"
   * 的直觉，必须显式说明，否则用户不知道 DDL 里为什么会多出列或改名。 */
  if (mergedTargets.length) {
    var uniqMerged = [];
    for (var mt = 0; mt < mergedTargets.length; mt++) {
      if (uniqMerged.indexOf(mergedTargets[mt]) < 0) uniqMerged.push(mergedTargets[mt]);
    }
    ddlText += '\n' + wrapNoteLines('-- Snug SQL Formatter: 表 ' + uniqMerged.join(', ') +
      ' 被多条 INSERT 写入，已把列清单合并为一份 CREATE TABLE', ddlMax || ddlHard || 120);
  }
  if (dupCols.length) {
    ddlText += '\n' + wrapNoteLines('-- Snug SQL Formatter: 以下列名重复，已加序号后缀区分：' +
      dupCols.join(', '), ddlMax || ddlHard || 120);
  }

  return eolIn === '\n' ? ddlText : ddlText.replace(/\n/g, eolIn);
}

/* 把一条 `-- …` 提示按可用列数折成多行，续行沿用同样的 `-- ` 前缀。
 *
 * 只在原注释里**本来就有的 `, `** 处断行 —— 绝不切开单个标识符或括号里的表达式；
 * 单段超过可用宽度时（超长列名）整段独占一行（宁可超宽，也不把列名劈成两半）。 */
function wrapNoteLines(text, maxCols) {
  var limit = (typeof maxCols === 'number' && maxCols > 20) ? maxCols : 120;
  var m = /^(--\s*)([\s\S]*)$/.exec(String(text).replace(/\s+/g, ' ').trim());
  var prefix = m ? m[1] : '';
  var body = m ? m[2] : String(text);
  var items = body.split(', ');
  var lines = [], cur = prefix + items[0];
  for (var i = 1; i < items.length; i++) {
    var cand = cur + ', ' + items[i];
    if (visLen(cand) > limit && cur !== prefix) {
      lines.push(rtrim(cur) + ',');
      cur = prefix + items[i];
    } else {
      cur = cand;
    }
  }
  if (cur !== prefix) lines.push(rtrim(cur));
  return lines.length ? lines.join('\n') : prefix + body;
}

/* 从 lines[start]（一个顶层 SELECT 行）开始收集列表达式，追加到 items。
 * 标量子查询列 `(...)` 会跨多行，用括号深度跟踪（M-5）。 */
function collectSelectItems(lines, start, items, wildcards) {
    /* 剥掉 SELECT 前缀。`DISTINCT ON (cols)` 必须整段剥掉，
     * 否则 DISTINCT 会被当成第一列、ON (...) 被当成第二列（N-10）。 */
    /* 剥掉 SELECT 前缀，以及 `DISTINCT ON (cols)` 整段（N-10）。
     * DISTINCT ON 会被格式化器拆成两行（`SELECT DISTINCT` / `ON (a) a, b`），
     * 所以先看下一行是不是以 `ON (` 开头，是就合并回来再剥。 */
    var raws = lines[start].text;
    var nextIdx = start + 1;
    if (/^\s*SELECT\s+(DISTINCT|ALL)\s*$/i.test(raws) &&
        nextIdx < lines.length && /^\s*ON\s*\(/i.test(lines[nextIdx].text)) {
      raws = raws + " " + lines[nextIdx].text;
      nextIdx++;
    }
    var curItem = raws
      .replace(/^\s*SELECT\s+/i, "")
      .replace(/^DISTINCT\s+ON\s*\([^)]*\)\s+/i, "")
      .replace(/^(DISTINCT|ALL)\s+/i, "");
  var subDepth = countParenDelta(curItem);

  /* DISTINCT ON (...) 与列清单被格式化到同一行（`ON (a) a, b`）时，
   * 剩下的部分还要按顶层逗号拆成多项，否则多列会被当成一个表达式（N-10）。 */
  if (nextIdx > start + 1 && curItem !== null) {
    var mergedParts = splitTopLevelCommas(curItem);
    if (mergedParts.length > 1) {
      for (var mp = 0; mp < mergedParts.length; mp++) items.push(mergedParts[mp]);
      curItem = null;
    }
  }
  var i = nextIdx;

  while (i < lines.length) {
    var t = lines[i].text;
    if (t === '') break;
    if (subDepth > 0) {
      /* 子查询内部：无条件拼进当前 item，只跟踪括号深度 */
      curItem += ' ' + t.replace(/^\s+/, '');
      subDepth += countParenDelta(t);
      if (subDepth <= 0) {          /* 子查询闭合：当前列表达式完整，收尾 */
        subDepth = 0;
        items.push(curItem);
        curItem = null;
      }
    } else if (/^\s*,/.test(t)) {
      if (curItem !== null) items.push(curItem);
      /* H4（第三轮审计）：**行尾逗号 + 行注释**的写法会被格式化器排成
       *     SELECT a
       *           ,   -- user id
       *           b
       * 这里的 `,` 是「上一项结束」的分隔符，后面的注释属于**上一项**。
       * 旧实现把整段 `-- user id` 当成新项的开头，随后那一项被
       * findCommentPos 判成纯注释 → continue → **整列静默消失**
       * （3 列只剩 1 列）。现在把注释回填给上一项，新项留空等下一行的内容。 */
      var afterComma = t.replace(/^\s*,\s*/, '');
      /* `,` 后面只有**行注释**（-- / #）时，注释属于上一项；
       * 块注释 `/* … *\/` 只有在行尾（后面没内容）时才属于上一项，
       * 否则它是**下一项的前缀注释**（`/* c1 *\/ b` 里的 b 才是列）。 */
      var commaTailComment = '';
      if (/^(--|#)/.test(afterComma)) {
        commaTailComment = afterComma;
      } else if (/^\/\*/.test(afterComma)) {
        var bcEnd = afterComma.indexOf('*/');
        var afterBlock = bcEnd < 0 ? '' : afterComma.slice(bcEnd + 2).trim();
        if (!afterBlock) commaTailComment = afterComma;
      }
      if (commaTailComment || afterComma === '') {
        if (commaTailComment && items.length) {
          items[items.length - 1] = items[items.length - 1] + ' ' + commaTailComment;
        }
        curItem = '';
        subDepth = 0;
        i++;
        continue;
      }
      curItem = afterComma;
      subDepth = countParenDelta(curItem);
      if (subDepth > 0) {
        curItem = rtrim(curItem);
        i++;
        continue;
      }
    } else if (curItem === null) {
      /* 收尾行之后、下一个逗号行之前不应该再有内容；遇到子句关键字就停 */
      if (/^\s*(FROM|WHERE|GROUP|ORDER|HAVING|LIMIT|UNION|INTERSECT|EXCEPT|MINUS|JOIN|ON|WINDOW|DISTRIBUTE|SORT|CLUSTER|LATERAL)\b/i.test(t) || /^;/.test(t)) break;
      curItem = t.replace(/^\s+/, '');
    } else if (curItem === '') {
      /* 上一行是 `,` + 注释（逗号独占行）：这一行的内容接着上一项已经收尾的
       * 位置开一个新项。若它本身只是注释，就继续空着。 */
      var nextTxt = t.replace(/^\s+/, '');
      if (/^(--|#|\/\*)/.test(nextTxt)) { i++; continue; }
      curItem = nextTxt;
      subDepth = countParenDelta(curItem);
    } else if (/^\s*(FROM|WHERE|GROUP|ORDER|HAVING|LIMIT|UNION|INTERSECT|EXCEPT|MINUS|JOIN|ON|WINDOW|DISTRIBUTE|SORT|CLUSTER|LATERAL)\b/i.test(t) ||
               t.charAt(0) === ')' || /^;/.test(t)) {
      break;
    } else {
      curItem += ' ' + t.replace(/^\s+/, '');
    }
    i++;
  }
  if (curItem !== null && curItem !== '') items.push(curItem);
  return items;
}

/* 统计一行里 ( 与 ) 的净增量，忽略引号内的括号 */
function countParenDelta(line) {
  var d = 0, quote = null;
  for (var i = 0; i < line.length; i++) {
    var ch = line.charAt(i);
    if (quote) {
      if (ch === '\\' && LEX.backslash !== false) { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') d++;
    else if (ch === ')') d--;
  }
  return d;
}

  /* 按**顶层**逗号切分一段 SQL 文本（忽略括号内与引号内的逗号）。
   * 只在提取器需要「一行里塞了多列」时使用（N-10 的 DISTINCT ON 合并）。 */
  function splitTopLevelCommas(text) {
    var out = [], depth = 0, quote = null, start = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (quote) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
      if (ch === "(" || ch === "[") { depth++; continue; }
      if (ch === ")" || ch === "]") { if (depth > 0) depth--; continue; }
      if (depth === 0 && ch === ",") {
        out.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    var tail = text.slice(start).trim();
    if (tail) out.push(tail);
    return out;
  }

/* 把 `expr AS alias` / `expr alias` / `alias` 拆成 { expr, name }。
 * 通配符（`*` / `t.*`）没有确定列名，返回 null —— 调用方据此跳过该列，
 * 而不是硬造一个假列名。 */
  /* 把 select 项拆成 { expr, name }。
   * 关键约束（P1-7 / R3-4 / R3-5）：
   *   1) 只有**顶层**的 AS 才是别名分隔符 —— `cast(a as int)` 里的 as 在括号内；
   *   2) 隐式别名不能是运算符后面的操作数 —— `a + b` 里的 b 是加数不是别名；
   *   3) 隐式别名不能是纯数字 / 保留字 —— `a - 1`、`col is null`；
   *   4) 别名可以是任意 Unicode 标识符 —— `coût`、`売上の合計`、`中文别名`。 */
  /* P1-7（2026-11-02 审计）：剥掉表达式**中间**的块注释。
   *   `select a [块注释 x] from s`
   * 旧实现只在 item **开头**剥注释（stripLeadingComments），中间的
   * 块注释被当成表达式的一部分喂给 generatedColName，
   * 生成 `a_div_mul_x_mul_div` 这种乱码列名 —— 用户复制 DDL 建表会得到
   * 一个完全不相干的列名。
   *
   * 只在**括号外**、且不在字符串里的块注释才剥；行注释 `--` 不在这里处理
   * （它由 findCommentPos 单独负责，语义是"列注释"）。 */
  function stripInlineBlockComments(text) {
    var s = String(text || "");
    var out = "", i = 0, quote = null, depth = 0;
    var bs = LEX.backslash === true;
    while (i < s.length) {
      var ch = s.charAt(i);
      if (quote) {
        out += ch;
        if (bs && ch === "\\") { out += s.charAt(i + 1); i += 2; continue; }
        if (ch === quote) quote = null;
        i++; continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") { quote = ch; out += ch; i++; continue; }
      if (ch === "(" || ch === "[") { depth++; out += ch; i++; continue; }
      if (ch === ")" || ch === "]") { if (depth > 0) depth--; out += ch; i++; continue; }
      if (ch === "/" && s.charAt(i + 1) === "*") {
        var close = s.indexOf("*/", i + 2);
        if (close < 0) { out += s.slice(i); break; }   /* 未闭合：原样保留到结尾 */
        /* 用一个空格替代，避免粘连 */
        if (out && !/\s$/.test(out)) out += " ";
        i = close + 2;
        if (i < s.length && !/\s/.test(s.charAt(i))) out += " ";
        continue;
      }
      out += ch; i++;
    }
    return out.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
  }

  function splitAlias(item) {
    var s = String(item || "").trim();
    if (!s) return null;

    /* 通配符：`*`、`t.*`、`db.t.*` */
    if (/^(?:[A-Za-z0-9_$`"\[\]\.]+\.)?\*$/.test(s)) return null;

    /* 数字字面量（含小数 / 负数）不是限定名（P2-9） */
    if (/^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(s)) {
      return { expr: s, name: sanitizeColName(s) };
    }

    /* 顶层 AS 的位置（跳过括号与引号内的 as） */
    var asPos = findTopLevelAs(s);
    if (asPos >= 0) {
      var aliasRaw = s.slice(asPos + 4).trim();
      var exprPart = s.slice(0, asPos).replace(/\s+$/, "");
      if (aliasRaw && exprPart) {
        return { expr: exprPart, name: unquoteIdent(aliasRaw), quoted: isQuotedIdent(aliasRaw) };
      }
    }

    /* 单列：`t.col` / `col`（允许全 Unicode 标识符） */
    var IDENT = "[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}_$]*";
    var bareRe = new RegExp("^(?:" + IDENT + "\\.)*" + IDENT + "$", "u");
    if (bareRe.test(s)) return { expr: s, name: unquoteIdent(s.split(".").pop()) };

    /* 带引号的单列：`"col"` / `[col]` / `t.`col`` */
    var qBare = s.match(/^(?:[^\s]+\s*\.\s*)?(`[^`]*`|"[^"]*"|\[[^\]]*\])$/);
    if (qBare) return { expr: s, name: unquoteIdent(qBare[1]), quoted: true };

    /* 隐式别名：`sum(c) sc` / `a + 1 total` / `amount coût`。
     * 先剥掉外层括号内 && 运算符，尾部那个"词"才算别名。 */
    var impRe = new RegExp("^(.*[^\\s])\\s+(" + IDENT + "|`[^`]*`|\"[^\"]*\"|\\[[^\\]]*\\])$", "u");
    var imp = s.match(impRe);
    if (imp) {
      var tail = imp[2];
      var head = imp[1];
      var headTail = head.replace(/\s+$/, "");
      /* 运算符结尾 → 尾部词是操作数，不是别名（`a + b` / `a - 1`） */
      var afterOp = /[+\-*/%<>=!|&^~,:]$/.test(headTail);
      /* 保留字做隐式别名 → 其实是语法的一部分（`col is null` / `a between 1 and 2`） */
      var RESERVED_TAIL = /^(END|THEN|ELSE|WHEN|NULL|NOT|AND|OR|IS|IN|LIKE|BETWEEN|EXISTS|TRUE|FALSE|ASC|DESC|OVER|ROWS|RANGE|PRECEDING|FOLLOWING|CURRENT|ROW|UNBOUNDED|SELECT|FROM|WHERE|GROUP|ORDER|BY|HAVING|LIMIT|UNION|ALL|DISTINCT|CASE|BEGIN|INTERVAL|AS|ON|USING|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|WITH|COUNT|SUM|AVG|MIN|MAX)$/i;
      /* 纯数字做别名 → 是字面量，不是别名（`a - 1`） */
      var numericTail = new RegExp("^-?\\d+(?:\\.\\d+)?$").test(tail);
      if (!afterOp && !RESERVED_TAIL.test(tail) && !numericTail && /[^\d]/.test(tail.charAt(0)) ) {
        return { expr: head, name: unquoteIdent(tail), quoted: isQuotedIdent(tail) };
      }
    }

    /* 没有任何别名：用表达式本身当列名，保证不丢列。
     *
     * M-7：旧实现直接 `sanitizeColName(整条表达式)`，于是
     *   `row_number() over (order by e)` → `ROW_NUMBER_OVER_ORDER_BY_e`
     *   `if(j>1,1,0)`                    → `IF_j_1_1_0`
     *   `concat_ws(a,b)`                 → `CONCAT_WS_a_b`
     *   `length(g)`                      → `LENGTH_g`
     * 又长又大小写混杂，几乎不可用。现在只取"函数名"或"末段标识符"：
     *   row_number() over (…) → row_number
     *   if(j>1,1,0)           → if
     *   concat_ws(a,b)        → concat_ws
     *   length(g)             → length
     *   t.col                 → col
     *   a + b                 → a_add_b（保持无歧义）
     * 这样列名短、可预测，重名由 _2/_3 后缀兜底。 */
    var generated = generatedColName(s);
    if (!generated) return null;
    return { expr: s, name: generated };
  }


function unquoteIdent(s) {
  var t = s.trim();
  if (/^`.*`$/.test(t) || /^".*"$/.test(t)) return t.slice(1, -1);
  if (/^\[.*\]$/.test(t)) return t.slice(1, -1);
  return t;
}

/* F-09（2026-11-04 复核）：判断别名是不是**用户加了引号的标识符**。
 * `as "x y"` / `as `my col`` / `as [a b]` 是合法的带引号标识符，
 * 里面可以有空格。Extract 以前一律走 sanitizeAlias，把空格换成下划线，
 * 于是生成的 DDL 悄悄把列改名（`"x y"` → `x_y`），下游按原名查不到列。 */
function isQuotedIdent(s) {
  var t = String(s || "").trim();
  return /^`[\s\S]*`$/.test(t) || /^"[\s\S]*"$/.test(t) || /^\[[\s\S]*\]$/.test(t);
}

  /* 别名落到 DDL 列名时的最后规整。
   * 只把**真正非法**的字符（空白、点号、标点）换成下划线，不做 ASCII 白名单过滤。
   * 旧版写 `[^A-Za-z0-9_$一-龥]`，于是 `coût` → `co_t`、`betrag_für` → `betrag_f_r`、
   * `売上の合計` → `売上_合計`，用户的别名被逐字改写（R3-4）。
   * 现在按 Unicode 字母 / 数字判断，非 ASCII 标识符原样保留。 */
  /* 剥掉表达式**开头**的注释（hint / 块注释 / 行注释）。
   * 返回 `{ expr, hints }`；hints 目前只用于判定"要不要丢弃这条 item"，
   * 不参与列名生成 —— 这正是 H4 的修复要点。 */
  function stripLeadingComments(text) {
    var s = String(text || '').replace(/^\s+/, '');
    for (var guard = 0; guard < 50; guard++) {
      if (/^\/\*/.test(s)) {
        var e = s.indexOf('*/');
        if (e < 0) return '';
        s = s.slice(e + 2).replace(/^\s+/, '');
        continue;
      }
      if (/^(--|#)/.test(s)) {
        /* 行注释在拼接后可能后面还有内容（`, -- x` 已经把 x 归给上一项了），
         * 这里只剥到行尾；没有换行说明整段都是注释 → 返回空。 */
        var nlPos = s.search(/[\r\n]/);
        if (nlPos < 0) return '';
        s = s.slice(nlPos).replace(/^\s+/, '');
        continue;
      }
      break;
    }
    return s;
  }

  function sanitizeAlias(name) {
    var s = String(name || "");
    /* P1-6（2026-11-02 审计）：用户写的别名是**他自己定的列名**，不能改写。
     * 旧实现做了三步破坏性变换：
     *   · `.replace(/_+/g, "_")`  → `bar__baz` 变 `bar_baz`
     *   · `.replace(/^_+|_+$/g, "")` → `_x` 变 `x`、`foo_` 变 `foo`
     *   · `.replace(/[\s\.]+/g, "_")` → 空格/点号变下划线（这个只对**没加引号
     *     的别名**有意义，加了引号的别名本来就允许空格）
     * 前两步会让**完全合法**的列名（`foo_`、`__id`、`bar__baz` 在 MySQL/Hive/
     * PG 里都合法）被悄悄改名，用户照着这份 DDL 建表后，下游按原名查就找不到列。
     * 现在只做"非法字符替换"这一件事，其余一律原样保留。
     *
     * 仍然保留的处理（都是**必需**的）：
     *   · 空白/点号 → `_`（无引号别名里的这两类字符无法直接做列名）；
     *   · 真正的非法字符（标点、运算符）→ `_`；
     *   · 首字符不是字母/下划线/`$` 时补 `c_` 前缀；
     *   · 长度截断到 64（Hive/PG 的标识符上限）。 */
    s = s.replace(/[\s\.]+/g, "_");
    s = s.replace(/[^\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}_$]/gu, "_");
    if (!s) return "";
    if (!/^[\p{L}\p{Nl}_$]/u.test(s)) s = "c_" + s;
    return s.slice(0, 64);
  }

  /* 把任意表达式转成合法的列名（不含别名时兜底，保证"不丢列"）。
   * 表达式里一个可用字符都提取不出来时返回空串，由调用方跳过（R3-4）。 */
  function sanitizeColName(expr) {
    var s = String(expr || "").replace(/`/g, "").replace(/\s+/g, "_");
    s = s.replace(/[^\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}_$]/gu, "_");
    s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    if (!s) return "";
    if (!/^[\p{L}\p{Nl}_$]/u.test(s)) s = "c_" + s;
    return s.slice(0, 64);
  }

  /* 无别名表达式 → 列名（M-7）。
   * 只在"表达式没有别名"时使用。优先取函数名，其次取末段标识符，
   * 最后才退回整条表达式的规整形式。 */
  function generatedColName(expr) {
    var s = String(expr || "").trim();
    if (!s) return "";

    /* 1) 函数调用：取函数名（去掉库名前缀）。`db.fn(x)` → fn */
    var fn = /^(?:\w+\.)*([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5$]*)\s*\(/.exec(s);
    if (fn) return sanitizeColName(String(fn[1]).toLowerCase());

    /* 2) 限定名 / 裸标识符：取最后一段。`t.col` → col，`col` → col */
    var ident = /^(?:[\w\u4e00-\u9fa5$"`\[\]]+\.)*(["`\[]?)([\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}_$]*)(["`\]]?)$/u.exec(s);
    if (ident) {
      var nm = sanitizeColName(ident[2]);
      if (nm) return nm.toLowerCase() === String(ident[2]).toLowerCase() ? nm : sanitizeColName(ident[2]);
    }

    /* 3) 兜底：整条表达式规整。`a + b` → a_add_b（避免 a_b 这种歧义） */
    var withOps = s.replace(/\s*([-+*/%])\s*/g, function (m, op) {
      var map = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod' };
      return '_' + (map[op] || 'op') + '_';
    });
    return sanitizeColName(withOps);
  }

  /* 粗粒度类型推断（R3-10）。
   * 旧版 `if (/^date_/i.test(s)) return "DATE"` 会命中 `date_str`、`date_key`
   * 这类明明是字符串的列名；而 `cast(x as int) as id` 又因为只看别名而推成 STRING。
   * 现在：先看显式 CAST，再看字面量/函数，最后才靠列名后缀兜底。
   * 不确定时一律 STRING（保守，STRING 在 Hive/MySQL 里几乎总能隐式转换）。 */
  var CAST_TYPE_MAP = {
    INT: "INT", INTEGER: "INT", BIGINT: "BIGINT", SMALLINT: "SMALLINT", TINYINT: "TINYINT",
    DECIMAL: "DECIMAL", NUMERIC: "DECIMAL", DOUBLE: "DOUBLE", PRECISION: "DOUBLE",
    REAL: "FLOAT", FLOAT: "FLOAT", BOOLEAN: "BOOLEAN", BOOL: "BOOLEAN",
    DATE: "DATE", TIMESTAMP: "TIMESTAMP", DATETIME: "TIMESTAMP",
    /* 带长度参数的类型必须映射到**自己**而不是 STRING：
     * `cast(a as varchar(20))` 若映射成 STRING 再拼 (20) 会得到 `STRING(20)`，
     * 而 Hive 的 STRING 不接受长度参数 —— 那是一条语法错误的 DDL。 */
    VARCHAR: "VARCHAR", CHAR: "CHAR", TEXT: "STRING"
  };
  /* CAST 的完整类型表达式 → DDL 类型。**必须保留精度**（B-04）：
   *   decimal(10,2) → DECIMAL(10,2)   而不是 DECIMAL(38,18) 或 STRING
   *   varchar(20)   → VARCHAR(20)     而不是 STRING
   *   timestamp(3)  → TIMESTAMP(3)
   * 旧正则只允许「类型名后直接接 )」，遇到带参数的 CAST 整条降级成 STRING ——
   * 一份 `cast(amt as decimal(10,2)) as amount` 提取出的 DDL 变成 `amount STRING`，
   * 用户照着建表，金额列会变成字符串列。 */
  var CAST_FULL_RE = /^cast\s*\(([\s\S]*)\bas\s+([A-Za-z0-9_]+(?:\s+[A-Za-z]+)*)\s*(\([^()]*\))?\s*\)$/i;
  function isPgFamilyType(dialect) {
    return /postgres|pgsql|pg|greenplum|redshift|duckdb/i.test(String(dialect || ''));
  }

  /* 递归深度：只有最外层调用才允许写 lastTypeGuess。
   * `map('k',1)` 内层推断 `'k'` 时推不出类型，但那不该算作
   * "这一列的类型是猜的" —— 外层的 MAP 类型已经确定了。 */
  var typeDepth = 0;

  function inferType(expr, dialect) {
    typeDepth++;
    try {
      return inferType0(expr, dialect);
    } finally {
      typeDepth--;
    }
  }

  function inferType0(expr, dialect) {
    var d = String(dialect || "");
    var s = String(expr || "").trim();
    if (!s) return "STRING";

    /* 1) 显式 CAST(... AS <type>[ (p,s) ]) —— 类型是确定的，优先采用且保留精度 */
    var cm = CAST_FULL_RE.exec(s);
    if (cm) {
      var base = String(cm[2]).toUpperCase().replace(/\s+/g, " ").trim();
      var args = cm[3] ? String(cm[3]).replace(/\s+/g, "") : "";
      var mapped = CAST_TYPE_MAP[base.split(" ")[0]];
      if (mapped) {
        /* DOUBLE PRECISION / CHARACTER VARYING 这类多词类型，只取归一后的主类型名 */
        if (base === "DOUBLE PRECISION") mapped = "DOUBLE";
        if (base === "CHARACTER VARYING") mapped = "VARCHAR";
        return mapped + args;
      }
    }
    /* 1b) `x::decimal(10,2)` 这种 PostgreSQL 简写 */
    var pgCast = /::\s*([A-Za-z0-9_]+)\s*(\([^()]*\))?\s*$/.exec(s);
    if (pgCast) {
      var pbase = CAST_TYPE_MAP[String(pgCast[1]).toUpperCase()];
      if (pbase) return pbase + (pgCast[2] ? String(pgCast[2]).replace(/\s+/g, "") : "");
    }

    /* 2) 字面量 */
    if (/^-?\d+$/.test(s)) return "BIGINT";
    if (/^-?\d*\.\d+$/.test(s)) return "DECIMAL(38,18)";
    /* 科学计数法（B-04）：`1e3` / `1.5E-2` 是**数值**，旧实现落到最后的 STRING。
     * 整数形式 → DOUBLE（它的量级本来就是浮点用途）；带小数点 → DECIMAL。 */
    if (/^-?(?:\d+\.?\d*|\.\d+)[eE][-+]?\d+$/.test(s)) {
      return /^-?\d+[eE]/.test(s) ? "DOUBLE" : "DECIMAL(38,18)";
    }
    if (/^(true|false)$/i.test(s)) return "BOOLEAN";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s.replace(/['"]/g, ""))) return "DATE";
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s.replace(/['"]/g, ""))) return "TIMESTAMP";

    /* 3) 无参时间函数 / 当前时间。
     * B-04：CURRENT_DATE 是 DATE、CURRENT_TIMESTAMP 才是 TIMESTAMP ——
     * 旧实现把两者合并成 TIMESTAMP，`current_date as dt` 生成 `dt TIMESTAMP`，
     * 在 Hive 里 DATE→TIMESTAMP 会带上时分秒，下游分区字段直接对不上。 */
    if (/^(current_date|curdate\s*\(\s*\))$/i.test(s)) return "DATE";
    if (/^(current_timestamp|now\s*\(\s*\)|localtimestamp|sysdate)$/i.test(s)) return "TIMESTAMP";

    /* 4) 聚合 / 窗口 / 常见内置函数。
     * M-7：旧实现只认 count/sum/avg/max/min，于是 `length(g)`、`unix_timestamp()`、
     * `row_number() over (...)`、`if(j>1,1,0)` 全都落到 STRING ——
     * 提取出来的建表语句把整数长度、时间戳、自增序号都写成字符串列。
     * 这里按"返回值形态可确定"的原则补齐：
     *   整数类（计数/长度/序号/时间戳）→ BIGINT 或 INT
     *   浮点类（sum/avg/方差 …）        → DECIMAL(38,18)
     *   布尔类（isnull/布尔判定）        → BOOLEAN
     *   字符串类（concat/substr/trim）   → STRING
     * 认不出来的一律 STRING —— 保守，且与旧行为一致。 */
    var ARGS = /\(([\s\S]*)\)\s*$/;
    if (/^count\s*\(/i.test(s)) return "BIGINT";
    if (/^(length|char_length|character_length|size|cardinality|datediff|date_diff|unix_timestamp|to_unix_timestamp|timestampdiff|row_number|rank|dense_rank|ntile|count_if)\s*\(/i.test(s)) {
      /* 这些都返回整数；`unix_timestamp()` 的秒数是 long，row_number 是 int */
      return /^(row_number|rank|dense_rank|ntile)\s*\(/i.test(s) ? "INT" : "BIGINT";
    }
    if (/^(sum|avg|stddev|stddev_samp|stddev_pop|variance|var_samp|var_pop)\s*\(/i.test(s)) {
      /* M-7：Hive/PG 里 sum(int) 返回 BIGINT，sum(double)/avg 返回 DOUBLE。
       * 旧实现一律 DECIMAL(38,18)，`sum(x)*1.0` 这种常见的"整数转浮点"也照样
       * 变成 DECIMAL(38,18)，与实际类型不符。这里按有无 `*1.0` / 浮点字面量判断。
       *
       * M11a（第三轮审计）：类型推断必须**保守**。`sum(amount)` 的 amount 是
       * decimal 时，Hive 返回 decimal、PG 返回 numeric —— 都不是 BIGINT。
       * 旧实现猜 BIGINT，用户拿这份 DDL 建表，金额列会把小数**直接截断**。
       * 现在默认 DECIMAL(38,18)（能容纳小数，也不会像 STRING 那样丢精度）；
       * 只有明确是浮点（`*1.0`）才给 DOUBLE，avg/stddev 系列按定义就是 DOUBLE。 */
      if (/\*\s*\d+\.\d+|\/\s*\d+\.\d+|\b1\.0\b/.test(s)) return "DOUBLE";
      if (/^(avg|stddev|stddev_samp|stddev_pop|variance|var_samp|var_pop)\s*\(/i.test(s)) return "DOUBLE";
      return "DECIMAL(38,18)";
    }
    /* M11a：`max/min` 返回的是**参数的类型**，不是 STRING。
     * `max(created)` 生成 `last_dt STRING` 会让用户拿到一份全部是字符串的表。
     * 递归推断参数类型（`max(created)` → 列名启发式 → TIMESTAMP）。 */
    if (/^(max|min|any_value|first_value|last_value)\s*\(/i.test(s)) {
      var aggArgs = ARGS.exec(s);
      if (aggArgs && aggArgs[1]) {
        var innerType = inferType(aggArgs[1].split(',')[0], d);
        if (innerType && innerType !== "STRING") return innerType;
        /* P1-6（2026-11-06 复核）：参数本身推不出具体类型时退回 STRING，
         * 但必须**登记为猜测** —— 旧实现这里直接 return，lastTypeGuess 仍为空，
         * 于是 `max(b)` 生成 `m STRING` 却完全没有"类型无法静态推断"的提示，
         * 与 README 的承诺（猜出来的列会列在 DDL 末尾供核对）相矛盾。 */
        if (typeDepth === 1) lastTypeGuess = String(expr || s);
        return "STRING";
      }
      if (typeDepth === 1) lastTypeGuess = String(expr || s);
      return "STRING";
    }
    if (/^(isnull|isnotnull|is_null|boolean|bool_and|bool_or|every)\s*\(/i.test(s)) return "BOOLEAN";
    if (/^(row_number|rank|dense_rank|ntile)\s*\(/i.test(s)) return "INT";
    if (/^(current_date|curdate\s*\(\s*\))$/i.test(s)) return "DATE";
    if (/^(current_timestamp|now\s*\(\s*\)|localtimestamp|sysdate)$/i.test(s)) return "TIMESTAMP";
    /* `if(...)` / `case ... end` / `coalesce` / `nvl`：类型取决于分支，无法静态确定，
     * 但从 DDL 可用性角度给出常见的 BIGINT（布尔分支时也能被隐式转换）——
     * 更好的做法是看分支字面量：全是数字 → BIGINT，全是字符串 → STRING。 */
    if (/^(if|iif|case|coalesce|nvl|nvl2|ifnull|greatest|least)\b/i.test(s)) {
      var body = (ARGS.exec(s) || [, s])[1] || s;
      var hasStr = /'[^']*'|"[^"]*"/.test(body);
      var hasNum = /(?:^|[\s,(])\d+(?:\.\d+)?(?:$|[\s,)])/.test(body);
      if (hasStr) return "STRING";
      if (hasNum) return /\d+\.\d+/.test(body) ? "DECIMAL(38,18)" : "BIGINT";
      return "STRING";
    }
    if (/^to_date\s*\(/i.test(s)) return "DATE";
    if (/^split\s*\(/i.test(s)) return isPgFamilyType(d) ? "TEXT[]" : "ARRAY<STRING>";
    if (/^(concat|concat_ws|substr|substring|trim|ltrim|rtrim|upper|lower|regexp_extract|regexp_replace|reverse|repeat|space|lpad|rpad|format_string|date_format|from_unixtime|string_agg|group_concat)\s*\(/i.test(s)) {
      return "STRING";
    }
    /* P2-5（2026-11-02 审计）：集合构造器。
     *   array(1, 2)              → ARRAY<INT>（Hive 系）/ INT[]（PG 系）
     *   array('a', 'b')         → ARRAY<STRING>
     *   map('k', 1)             → MAP<STRING, INT>
     *   named_struct('x', 1)    → STRUCT<x: INT>
     *   struct(1, 'a')          → STRUCT<col1: INT, col2: STRING>
     * 旧实现一律落到最后的 STRING —— `select array(1,2) as a` 生成的
     * `a STRING` 在 Hive/PG 里都是错类型，而且看上去完全合法。 */
    var collM = /^(array|map|named_struct|struct|collect_list|collect_set|array_agg)\s*\(([\s\S]*)\)\s*$/i.exec(s);
    if (collM) {
      var fnName = String(collM[1]).toUpperCase();
      var rawArgs = splitTopLevelCommas(collM[2]);
      var argTypes = [];
      for (var ai = 0; ai < rawArgs.length; ai++) argTypes.push(inferType(rawArgs[ai], d));
      var isPgFamily = /postgres|pgsql|pg|greenplum|redshift|duckdb/i.test(d);
      if (fnName === "ARRAY" || fnName === "COLLECT_LIST" || fnName === "COLLECT_SET" || fnName === "ARRAY_AGG") {
        if (!argTypes.length) argTypes.push("STRING");
        /* 所有元素同类型时只写一个 */
        var elemT = argTypes[0];
        var same = true;
        for (var at2 = 1; at2 < argTypes.length; at2++) {
          if (argTypes[at2] !== elemT) { same = false; break; }
        }
        if (isPgFamily) return (same ? elemT : "TEXT") + "[]";
        return "ARRAY<" + (same ? elemT : "STRING") + ">";
      }
      if (fnName === "MAP") {
        var kT = argTypes.length > 0 ? argTypes[0] : "STRING";
        var vT = argTypes.length > 1 ? argTypes[1] : "STRING";
        if (isPgFamily) return "JSONB";            /* PG 没有 MAP 类型 */
        return "MAP<" + kT + "," + vT + ">";
      }
      /* STRUCT / NAMED_STRUCT */
      var fields = [], fIdx = 0;
      if (fnName === "NAMED_STRUCT") {
        for (var ni = 0; ni + 1 < rawArgs.length; ni += 2) {
          var fName = String(rawArgs[ni]).replace(/^['"]|['"]$/g, "");
          fields.push(fName + ":" + argTypes[ni + 1]);
        }
      } else {
        for (var si2 = 0; si2 < argTypes.length; si2++) {
          fields.push("col" + (++fIdx) + ":" + argTypes[si2]);
        }
      }
      if (!fields.length) fields.push("col1:STRING");
      if (isPgFamily) return "JSONB";
      return "STRUCT<" + fields.join(",") + ">";
    }

    /* 算术表达式：`a + b` / `a * 100` 之类 —— 含浮点字面量 → DOUBLE，否则视为数值。
     * 仅在整条表达式确实是算术且不含函数调用时生效。 */
    if (/^-?(?:\d+(?:\.\d+)?|\w+(?:\.\w+)?)(?:\s*[-+*/%]\s*-?(?:\d+(?:\.\d+)?|\w+(?:\.\w+)?))+$/.test(s) && !/\(/.test(s)) {
      if (/\d+\.\d+/.test(s)) return "DECIMAL(38,18)";
      return "BIGINT";
    }

    /* 5) 列名前缀/后缀提示 —— 只在**整词匹配**时采用，避免 date_str 被当日期 */
    var bare = s.replace(/^[A-Za-z0-9_$]+\./, "");
    if (/^(dt|stat_date|biz_date|pt|partition_date)$/i.test(bare) ||
        /_(date|dt|day)$/i.test(bare) === false && /^(date)$/i.test(bare)) return "DATE";
    if (/_(ts|timestamp|time)$/i.test(bare) || /^ts$/i.test(bare)) return "TIMESTAMP";
    /* M11a：审计列（created / updated / _at）几乎都是时间戳。
     * `max(created)` 旧实现走 max→STRING，提取出的 DDL 把它建成字符串列，
     * 下游按时间比较会全部错乱。 */
    if (/^(created|updated|inserted|deleted|modified|last_seen|first_seen)(_at|_time|_ts|_dt)?$/i.test(bare) ||
        /_(at|time|ts|timestamp)$/i.test(bare)) return "TIMESTAMP";
    if (/_(id|count|cnt|num|qty)$/i.test(bare) && !/^\d/.test(bare)) {
      /* 后缀是 _id 之类通常是整数，但也可能是字符串主键；保持 STRING 更安全 */
      return "STRING";
    }
    if (/_(amt|amount|price|fee|rate|ratio|pct|percent)$/i.test(bare)) return "DECIMAL(38,18)";
    if (/^(is_|has_|flag)/i.test(bare) || /_(flag|is_.*)$/i.test(bare)) return "BOOLEAN";

    /* P2-5（2026-11-02 审计）：走到这里说明类型完全靠猜。
     * 旧实现静默返回 STRING，用户拿到的 DDL 看上去完全正常，
     * 但金额、时间、布尔列全变成字符串 —— 建表后才发现。
     * 现在打一个标记，调用方在 DDL 末尾列出这些列。 */
    if (typeDepth === 1) lastTypeGuess = String(expr || "");
    return "STRING";
  }



/* ============================== 对外接口 ============================== */

/* 内核门面：只暴露 sql / sqlddl / extractddl 三个入口与诊断接口。
 *
 * 刻意保持**无状态**：所有排版参数都由调用方按次传入（maxLine / hardWidth /
 * Tab 宽度 / 方言 / 逗号位置…），实例上不留任何可变字段。
 * 这样同一进程里并发格式化多份文档时不会互相串配置，也不必在每次调用前
 * reset 任何东西。缩进字符串由 spaces() 按需生成，不做预计算表。 */
function SQLBeautifyKernel() {}

/* ---------------------------------------------------------------- 安全网
 * 旧实现用"同一个词法器切出来的 token 序列是否相同"来证明等价，
 * 这是自证的：词法器认不出的语法（$$...$$、0xFF、N'abc'、:dt、2 ** 3）
 * 改写前后切出的 token 必然相同，于是把语义改坏的结果判成"等价"写回用户文件。
 *
 * 新实现换成**字符级不变量**：
 *   1) 词法器仍然把每个 token 切成 {type, value}；
 *   2) 字符串 / 注释 / 引号标识符要求 value 逐字节相同（注释除外：允许行尾空白差异）；
 *   3) 其余 token 要求 value 去掉内部空白后相同——`$$` vs `$ $`、`0xFF` vs `0 x FF`、
 *      `N'abc'` vs `N 'abc'` 都会被立刻判为不等价；
 *   4) 词法器的 token 个数也必须相同（防止"吞掉一段"）。
 * 这样即使词法器还没学会某个方言，安全网也不会放行错误改写——它不再依赖
 * 被检查对象的正确性。 */
/* P1-3（2026-11-02 审计）：按语句隔离的兜底格式化。
 *
 * 返回拼好的文本；任何一步出问题返回 null，调用方继续走"整篇原样返回"。
 * 每条语句都必须单独通过 sameTokenStream 才会采用它的格式化结果 ——
 * 通不过的那一条保持原文，**其余语句照常排版**。
 *
 * 语句之间的空白照抄原文，避免这条兜底路径改变用户原有的空行习惯。 */
/* 给格式化结果的**续行**补统一缩进前缀。
 *
 * 首行不补：它前面的空白已由调用方从原文 `body.slice(cursor, s0)` 原样带出。
 * 数据区（跨行字符串 / 块注释 / dollar quote）内部的行也不补 —— 那是用户数据。
 *
 * P0-1（2026-11-06 复核）：按语句隔离时，被重排的语句必须与"原样保留"的
 * 兄弟语句保持同一缩进层级，否则从子查询中间选一段格式化后，重排的行会
 * 掉回第 0 列。补缩进只发生在这里（内核侧），接入层不再重复补偿。 */
function indentContinuationLines(text, indent, lex) {
  if (!indent || text.indexOf('\n') < 0) return text;
  var ranges = null;
  try { ranges = protectedRanges(text, lex || LEX); } catch (e) { ranges = null; }
  function insideData(off) {
    if (!ranges) return false;
    for (var r = 0; r < ranges.length; r++) {
      if (off <= ranges[r][0]) return false;
      if (off < ranges[r][1]) return true;
    }
    return false;
  }
  var out = '', start = 0;
  for (;;) {
    var nl = text.indexOf('\n', start);
    if (nl < 0) { out += text.slice(start); break; }
    out += text.slice(start, nl) + '\n';
    start = nl + 1;
    if (start >= text.length) break;
    if (!insideData(start)) out += indent;
  }
  return out;
}

function formatByStatement(body, lex, makeFormatter) {
  var toks;
  try { toks = tokenizeRaw(body, lex); } catch (e) { return null; }
  var stmts;
  try { stmts = splitStatements(toks); } catch (e) { return null; }
  if (!stmts || !stmts.length) return null;

  var out = '', cursor = 0, formatted = 0;
  for (var si = 0; si < stmts.length; si++) {
    var ts = stmts[si].tokens;
    if (!ts || !ts.length) continue;
    var s0 = ts[0].start, e0 = ts[ts.length - 1].end;
    if (typeof s0 !== 'number' || typeof e0 !== 'number' || e0 <= s0) continue;
    /* 上一条语句的 span 已经吃掉这段（例如被未闭合括号吞并），跳过 */
    if (s0 < cursor) continue;
    out += body.slice(cursor, s0);
    var src = body.slice(s0, e0);
    /* P0-1（2026-11-06 复核）：这条语句在原文里的**行首缩进**。
     * 语句间的空白已经由上一行 `body.slice(cursor, s0)` 原样带出，
     * 所以这里只需要给格式化结果的**续行**补同样的前缀 —— 否则被重排的
     * 语句会从第 0 列开始，而旁边"原样保留"的语句还带着缩进，视觉上错位；
     * 接入层若再统一补一层，就会每执行一次命令缩进翻倍。 */
    var lineStart = s0;
    while (lineStart > 0 && body.charAt(lineStart - 1) !== '\n') lineStart--;
    var stmtIndent = '';
    for (var ii = lineStart; ii < s0; ii++) {
      var cc = body.charAt(ii);
      if (cc === ' ' || cc === '\t') stmtIndent += cc;
      else { stmtIndent = ''; break; }      /* 语句前还有代码（`a; select`）→ 不补 */
    }
    var piece = null;
    var balance = 0, invalid = false;
    for (var ti = 0; ti < ts.length; ti++) {
      if (ts[ti].type !== 'punct') continue;
      if (ts[ti].value === '(') balance++;
      else if (ts[ti].value === ')') {
        balance--;
        if (balance < 0) { invalid = true; break; }
      }
    }
    if (balance !== 0) invalid = true;
    if (!invalid) {
      try {
        piece = makeFormatter().format(src);
      } catch (e) { piece = null; }
    }
    if (piece && piece !== '' && sameTokenStream(src, piece, lex)) {
      out += indentContinuationLines(piece, stmtIndent);
      formatted++;
    } else {
      /* 这条通不过安全网（或格式化抛异常）→ 原样保留它，不牵连别的语句 */
      out += src;
    }
    cursor = e0;
  }
  out += body.slice(cursor);
  /* 至少一条正常语句成功格式化且确有文本变化即可采用隔离结果。 */
  if (formatted < 1 || out === body) return null;
  return out;
}

function significant(text, lex) {
  var toks = tokenizeRaw(text, lex || LEX);
  var parts = [];
  var comments = [];

  for (var i = 0; i < toks.length; i++) {
    var t = toks[i];
    if (t.type === 'comment') {
      /* 注释：内容必须逐字相同（只允许整体行尾空白差异） */
      comments.push(rtrim(t.value));
      continue;
    }
    if (t.type === 'client') {
      /* P0-9：客户端命令逐字节比较（SPOOL 的文件名、PROMPT 的文字都不能动） */
      parts.push('C:' + t.value);
    } else if (t.type === 'string' || t.type === 'quoted') {
      parts.push('S:' + t.value);            /* 字符串/引号标识符逐字节比较 */
    } else if (t.type === 'template') {
      /* H-1：模板标签**逐字节**比较。旧版把它当普通标点，`{{ col }}` → `{ { col } }`
       * 去掉空白后完全相同，破坏被放行。现在只要有一个字符被改动就判不等价。 */
      parts.push('T:' + t.value);
    } else {
      /* 其余 token：去掉内部空白再比；大小写不敏感（大写化是允许的改写） */
      parts.push((t.type === 'word' ? 'W:' : t.type + ':') + t.value.replace(/\s+/g, '').toUpperCase());
    }
  }
  return { tokens: parts.join('\u0001'), comments: comments.join('\u0001'), raw: toks };
}

/* 兼容旧调用点 */
function sqlDigest(sql) { return significant(sql); }

/* ---------------------------------------------------------------- 危险粘连
 * `significant()` 只能发现"token 数量/内容变了"，发现不了"两个 token 之间
 * 被插入/删除了空白"——而这类改动恰好能改变 SQL 语义：
 *
 *   $1      →  $ 1        （PG 位置参数失效）
 *   @>      →  @ >        （PG 运算符失效）
 *   10L     →  10 L       （Hive BIGINT 字面量变语法错误）
 *   a.b     →  a . b      （限定名）
 *
 * 这里额外维护一份"危险粘连指纹"：把源文本里所有**紧贴**且拼起来属于危险形态的
 * token 对记为 `i=<前值><后值>`；格式化结果必须包含完全相同的集合。
 * 只覆盖下列可枚举的危险形态，避免误伤正常的排版（`a,b` → `a, b` 是允许的）。 */
var DANGER_HEADS = { '$': 1, '@': 1, '#': 1, '?': 1 };
/* 能和其他字符拼成"多字符运算符"的符号。只有这些符号之间的紧贴才敏感：
 * `a = -1` 拆不拆都合法，`a :: b` 拆开就变语法错误。 */
var OP_CHARS = { '-': 1, '+': 1, '*': 1, '/': 1, '%': 1, '<': 1, '>': 1, '=': 1, '!': 1, '~': 1, '|': 1, '&': 1, '^': 1, ':': 1, '?': 1, '@': 1, '#': 1, '$': 1 };

function isOpTok(t) {
  return t.type === 'punct' && t.value.length === 1 && !!OP_CHARS[t.value];
}

function normTok(t) {
  return t.type === 'word' ? String(t.value).toUpperCase() : String(t.value);
}

/* 真正算"一个运算符"的拼接结果。只有拼起来**真的是**运算符，中间加空格才可能改语义。
 * `*-` `/-` `%-` `=+` `<-` `+-` `:|` 这些拼起来不是任何运算符，格式化时在中间补一个
 * 空格（`a*-2` → `a * -2`）语义完全不变，不能算危险形态——旧版把"任意两个符号字符
 * 紧贴"一律当危险，于是这类写法被判成"改坏语义"，整篇文件静默回退（H-10）。 */
var MULTI_OP_SET = (function () {
  var o = Object.create(null);
  for (var mi = 0; mi < MULTI_OPS.length; mi++) o[MULTI_OPS[mi]] = true;
  return o;
})();

/* 危险粘连指纹分三级比较：
 *
 *   hard —— 必须**完全相同**（多一个少一个都算破坏）：
 *     · `$1` / `@x` / `#tmp` / `?1` 这类前缀紧贴（前缀必须是被单独切出来的那个字符）
 *     · `10L` / `1.5BD` 这类数字类型后缀
 *     · 真实多字符运算符的紧贴（`>>`、`::`、`#>` ...）
 *     这些一旦被拆开或粘上，语义直接变。
 *
 *   guarded —— 输入里有的，输出里也必须**有**（输出多出几个无所谓）：
 *     · `10abc` 数字贴标识符。它在词法器里是 `number` + `word` **两个** token，
 *       所以拆成 `10 abc` 不会改变 token 序列、`significant()` 发现不了，
 *       必须单独守住。
 *
 *   neutral —— 只登记、不参与判定：
 *     · `f(x)` 函数调用紧贴
 *     · `a.b` 限定名
 *     这两类在 SQL 语法里加不加空格完全等价（`count (1)` 与 `count(1)`、
 *     `a.b` 与 `a . b` 都是同一条语句），格式化把它们规整成统一形态不该被判成
 *     破坏。旧版对它们也要求完全相同，于是
 *       `count (1)` → `count(1)`（**新增**一个指纹）
 *     和
 *       `REFERENCES o(a)` → `REFERENCES o (a)`（**丢掉**一个指纹）
 *     两个方向都会被拦下，整篇文件静默不格式化（H-6 / H-8）。
 *     真正危险的粘连形态全在 hard 里，neutral 不承担安全职责。 */
function dangerGlue(tokens) {
  var hard = [], guarded = [], neutral = [];
  for (var i = 0; i + 1 < tokens.length; i++) {
    var a = tokens[i], b = tokens[i + 1];
    if (a.type === 'comment' || b.type === 'comment') continue;
    if (typeof a.end !== 'number' || typeof b.start !== 'number') continue;
    if (a.end !== b.start) continue;                       /* 本来就有空白，不敏感 */

    var av = normTok(a), bv = normTok(b);

    /* 1) 数字 + 类型后缀（10L / 1.5BD / 10S / 10Y）：拆开就变语法错误 → hard */
    if (a.type === 'number' && b.type === 'word' && /^(BD|L|S|Y)$/i.test(bv)) {
      hard.push(i + '=num-suffix:' + av + bv); continue;
    }
    /* 2) 数字 + 标识符（10abc 这种非法写法，但格式化不该拆分它）→ guarded */
    if (a.type === 'number' && b.type === 'word') { guarded.push(i + '=num-word:' + av + bv); continue; }
    /* 3) $ / @ / # / ? 前缀：只有**这个符号本身被切成一个单字符 token** 时才算危险
     *    （`$` + `1` → `$ 1` 会毁掉位置参数）。而 `$1` 已经是完整 token、
     *    后面跟 `,` 的情况（`$1,`）拆开完全无损，不能算（H-11）。
     *
     *    H5（第二轮审计）：`?` 只在与**数字/标识符**紧贴时才算危险（`?1` / `?name`
     *    这类位置参数）。`?||'%'` 是 JDBC 的「`?` 占位符 + 字符串拼接」，
     *    拆成 `? || '%'` 语义完全不变，不该被判成破坏 —— 旧规则把 punct 也算进来，
     *    于是 `?` + `||` 记了一条 hard 指纹，格式化后空格一加指纹就丢了，
     *    安全网整条回退（用户看到「按了没反应」）。 */
    if (av.length === 1 && DANGER_HEADS[av] &&
        (b.type === 'number' || b.type === 'word' ||
         (av !== '?' && b.type === 'punct'))) {
      hard.push(i + '=op:' + av + '|' + bv); continue;
    }
    /* 4) 运算符紧贴：只有拼起来**真的是一个已知多字符运算符**才算危险。
     *    旧规则还有一条"b 是多字符运算符 token 就一律算"，它把
     *    `?` + `||`（JDBC 的 `?||'%'`）也记成危险形态：这两个符号拼起来是
     *    `?||`，重新词法仍然是 `?` + `||`（`?|` 后跟 `|` 会被 pgOpAllowed 拒绝），
     *    加个空格完全无损，却被判成破坏 → 整条语句静默回退。
     *    真正被拆开过的多字符运算符（`-` + `>>`）拼回去就是 `->>`，在
     *    MULTI_OP_SET 里，第一条判据已经覆盖，不需要这个兜底。 */
    if (MULTI_OP_SET[av + bv]) {
      hard.push(i + '=punct:' + av + '|' + bv); continue;
    }
    /* 5) 点号后紧跟标识符/关键字（a.b、t.select）→ neutral（加空格语义无损） */
    if (a.type === 'punct' && av === '.') { neutral.push(i + '=dot:' + bv); continue; }
    /* 6) 标识符 + 左括号且原本紧贴（函数调用 f(x)）：拆开就变成"表名 + 括号"。
     * 排除三类本来是"列清单括号"的场景，否则会把正确改写误判成破坏：
     *   a) 该词在 SPACE_BEFORE_PAREN / FUNCTION_WORDS / DDL_PAREN_BEFORE 里；
     *   b) 该词前面是 "."（db.t(...) 里的 t 是限定名，括号是列清单）；
     *   c) 该词前面是位置词（INTO t(...) / TABLE t(...)）。
     * 这条记 neutral：`count (1)` 与 `count(1)` 是同一句，规整方向不该被判成破坏。 */
    if (b.type === 'punct' && bv === '(' &&
        (a.type === 'word' || a.type === 'quoted')) {
      if (SPACE_BEFORE_PAREN[av] || FUNCTION_WORDS[av] || DDL_PAREN_BEFORE[av]) continue;
      var pa = tokens[i - 1];
      var pa2 = tokens[i - 2];
      var afterDot = i > 0 && pa && pa.type === 'punct' && pa.value === '.';
      var afterNamePos = i > 0 && pa && pa.type === 'word' && NAME_POSITION[String(pa.value).toUpperCase()];
      if (afterDot) {
        /* a.b( → 先看 b 前面还有没有位置词：INTO db.t( */
        if (pa2 && pa2.type === 'word' && NAME_POSITION[String(pa2.value).toUpperCase()]) continue;
        /* 再往前一格（INTO db . t ( 的四 token 窗口） */
        var pa3 = tokens[i - 3];
        if (pa3 && pa3.type === 'word' && NAME_POSITION[String(pa3.value).toUpperCase()]) continue;
        /* 未知深度的点号链：保守放行（加空格语义无损） */
        continue;
      }
      if (afterNamePos) continue;
      neutral.push(i + '=call:' + av); continue;
    }
  }
  return { hard: hard.join('\u0002'), guarded: guarded.join('\u0002'), neutral: neutral };
}

/* 安全网：格式化结果必须与原文等价，否则原样返回，绝不改坏用户代码。 */
function sameTokenStream(a, b, lex) {
  var da = significant(a, lex), db = significant(b, lex);
  if (da.tokens !== db.tokens || da.comments !== db.comments) return false;
  /* 第二道：危险粘连指纹（见 dangerGlue 注释）。
   * 直接复用 significant() 已经算好的 token 列表，不重复词法分析。
   * hard / guarded 必须完全一致（guarded 目前是硬相等：10abc 拆开就丢 token）。
   * neutral 只是登记，不参与判定。 */
  var ga = dangerGlue(da.raw), gb = dangerGlue(db.raw);
  if (ga.hard !== gb.hard) return false;
  if (ga.guarded !== gb.guarded) return false;
  return true;
}

/* 文本里出现这些特征时，说明用户在用对应方言，需要打开相应词法开关。
 *
 * 反斜杠转义是这个文件里最难判的一件事：
 *   - MySQL / Hive 默认 `'it\'s'` 里的 \' 是转义；
 *   - PostgreSQL(standard_conforming_strings=on) / SQL Server 里 `'C:\temp\'`
 *     的末尾引号就是字符串结束，反斜杠只是普通字符。
 * 两者写法完全一样，只看字符无法区分。这里改用**自洽性判定**：
 *   先按 SQL 标准（无反斜杠转义）切一遍；如果切出"未闭合字符串"，
 *   而按反斜杠转义切能正常闭合，说明用户确实在用反斜杠转义 → 打开；
 *   否则一律按标准处理（`'C:\temp\'` 因此能正确闭合，不会被吞掉后半句）。 */
function detectLex(text, dialect) {
  var lex = { backslash: false, hashComment: false, hashMode: 'comment', dashSpace: false, dialect: String(dialect || '') };

  /* P0-9（2026-11-02 审计）：SQL*Plus / psql 的行级客户端命令要整行保留。
   * 只在明确是这两种客户端时才开 —— 别的库里 SHOW / COLUMN / CONNECT 是正常 SQL。 */
  var dl = String(dialect || '').toLowerCase();
  lex.clientLines = /oracle|plsql|psql|postgres|postgresql|pgsql|greenplum|redshift|duckdb|plpgsql/.test(dl);

  /* H2：反斜杠语义**先按方言定**。只有方言未知时才走"先标准切、未闭合再试反斜杠"的启发式。 */
  var bsMode = backslashModeOf(dialect);
  if (bsMode === true) {
    lex.backslash = true;
  } else if (bsMode === false) {
    lex.backslash = false;
  } else if (text.indexOf('\\') < 0) {
    /* P3-5（2026-11-09 复核）：**文本里一个反斜杠都没有时，两种切法必然等价**。
     * scanQuoted 里 backslash 开关只影响"遇到 `\` 时要不要跳过下一个字符"这一个
     * 分支（见 scanQuoted:1274），没有反斜杠就永远走不到那里 —— token 流必然
     * 逐字节相同。可以直接按标准处理，省掉下面最多两次整篇 tokenizeRaw。
     *
     * 实测：4000 条小语句（179 KB）上 detectLex 的 self 时间占 12.7%，
     * 其中绝大部分就是这两次纯属白跑的分词。 */
    lex.backslash = false;
  } else {
    var stdTokens = tokenizeRaw(text, { backslash: false, hashComment: false });
    if (stdTokens.unterminated) {
      var bsTokens = tokenizeRaw(text, { backslash: true, hashComment: false });
      if (!bsTokens.unterminated) lex.backslash = true;
    } else {
      /* P0-1（2026-11-02 审计）：两种切法**都能闭合**时才是最难办的情况。
       * 例：select 'a\'b' as x, 'c\'d' as y from t
       *   标准切法：'a\' 闭合 → b 是标识符 → 后面重新开字符串
       *   反斜杠切法：'a\'b' 是一个字符串
       * 两种都"合法"，文本无法自证。旧实现默默按标准排，内容被改。
       * 判据：比较两种切法的**字符串 token 值序列**，不一致即歧义。 */
      var bsToks2 = tokenizeRaw(text, { backslash: true, hashComment: false });
      if (!bsToks2.unterminated) {
        var strA = [], strB = [];
        for (var sa1 = 0; sa1 < stdTokens.length; sa1++) {
          if (stdTokens[sa1].type === 'string') strA.push(stdTokens[sa1].value);
        }
        for (var sb1 = 0; sb1 < bsToks2.length; sb1++) {
          if (bsToks2[sb1].type === 'string') strB.push(bsToks2[sb1].value);
        }
        if (strA.join('\u0001') !== strB.join('\u0001')) {
          lex.ambiguous = true;
        }
      }
    }
  }

  /* # 的语义由方言决定（见 HASH_DIALECT）：同一段 `select a # b from t`
   * 在 MySQL 里是注释、在 PG 里是异或，**文本本身无法区分**。
   * 调用方（extension）把 document.languageId 作为 dialect 传进来，
   * 这里只负责把它翻译成词法开关；未知方言才走启发式。 */
  /* MySQL 系方言的 `--` 需要后跟空白（H-3）；其它方言按标准 SQL 处理。 */
  lex.dashSpace = /mysql|mariadb/.test(String(dialect || '').toLowerCase());
  var mode = hashModeOf(dialect);
  if (mode) {
    lex.hashMode = mode;
    lex.hashComment = (mode === 'comment');
    return lex;
  }

  /* ---- 未知方言：启发式 ---- */
  /* P3-5（2026-11-09 复核）：文本里**一个 `#` 都没有**时，下面这段逐字符扫描
   * 必然什么也看不到 —— sawOperatorHash / sawCommentHash 都保持 false，
   * lex 留在初始的 hashMode='comment' / hashComment=false。
   * 直接返回即可，省掉一次整篇扫描（400 KB 的文本上是几十毫秒）。
   *
   * 等价性依据：循环体里唯一会设置这两个标志的分支都以 `qc === '#'` 为前提
   * （`#` 之前的引号 / 注释分支只推进 qi），没有 `#` 就一次都不会进。 */
  if (text.indexOf('#') < 0) return lex;

  /* 逐字符扫描，**跳过字符串 / 行注释 / 块注释**（旧实现是裸文本扫描，
   * 于是 `select '#' as h` 里一个 `#` 就把整篇按 MySQL 解析）。 */
  var qi = 0;
  var backslashOn = lex.backslash;
  var sawOperatorHash = false;
  var sawCommentHash = false;

  while (qi < text.length) {
    var qc = text.charAt(qi);
    /* 跳过引号内的内容（'...' / "..." / `...`，含 '' 双写与反斜杠转义） */
    if (qc === "'" || qc === '"' || qc === '`') {
      qi++;
      while (qi < text.length) {
        if (backslashOn && text.charAt(qi) === '\\') { qi += 2; continue; }
        if (text.charAt(qi) === qc) {
          if (text.charAt(qi + 1) === qc) { qi += 2; continue; }
          qi++;
          break;
        }
        qi++;
      }
      continue;
    }
    /* 跳过行注释与块注释里的 # */
    if (qc === '-' && text.charAt(qi + 1) === '-') {
      var nlq = text.indexOf('\n', qi);
      qi = nlq < 0 ? text.length : nlq;
      continue;
    }
    if (qc === '/' && text.charAt(qi + 1) === '*') {
      var bcq = text.indexOf('*/', qi + 2);
      qi = bcq < 0 ? text.length : bcq + 2;
      continue;
    }
    if (qc !== '#') { qi++; continue; }

    var nx = text.charAt(qi + 1);

    /* `#>` / `#>>`：PG JSON 取路径，绝不是注释 */
    if (nx === '>') { sawOperatorHash = true; qi++; continue; }

    var leftSp = /\s/.test(text.charAt(qi - 1) || '');
    var beforeHash = /([A-Za-z_]+)\s*$/.exec(text.slice(Math.max(0, qi - 40), qi));

    /* 左边紧贴（`payload#` / `x#y`）：只可能是运算符，绝不是注释 */
    if (!leftSp) {
      sawOperatorHash = true;
      qi++;
      continue;
    }
    /* 位置词后面的 `#tmp`（T-SQL 临时表） */
    if (beforeHash && /^(from|join|into|update|table|on|using|exists|in)$/i.test(beforeHash[1])) {
      sawOperatorHash = true;
      qi++;
      continue;
    }
    /* 右边紧贴非空白（`#note` / `#2020 销售额`）：MySQL/Hive 注释的招牌写法 */
    if (nx !== '' && !/\s/.test(nx)) { sawCommentHash = true; break; }

    /* 到这里 `#` 两侧都有空白 —— 唯一真正歧义的形态。
     *
     * 判据（B-01）：把右侧按「**一个操作数 + 紧随其后的子句关键字**」来匹配。
     * PG 的 `#` 是二元位异或，真写成 `a # b from t` 时一定有"操作数 b，
     * 然后是子句关键字 FROM"这个结构。
     * 旧实现的判据是「整行剩余部分是否**含有** from/where/join」，
     * 于是最常见的英文注释 `# get data from cache` 里的 from 让它被当成运算符，
     * 整条注释被当 SQL 重排成 `# get data` + `FROM cache`，
     * 凭空多出一个 FROM 子句 —— 注释内容被当成代码（B-01）。
     *
     * 现在的三条判据，任一成立才算异或：
     *   ① 右侧是数字/引号字面量（`5 # 3`、`a # 'x'`）；
     *   ② 右侧是「一个操作数 + 子句关键字」（`a # b from t`）；
     *   ③ 右侧是「一个操作数 + 运算符」（`a # b + 1`）。
     * 其余情况（含 `# get data from cache`、`# note`）一律按注释。
     * 精确控制请设置 snugSql.dialect，或让 languageId 表明方言。 */
    var leftOperand = /[A-Za-z0-9_$)`\]'"\u4e00-\u9fa5]\s*$/.test(
      text.slice(Math.max(0, qi - 40), qi));
    var eolAt = text.indexOf('\n', qi);
    var restOfLine = text.slice(qi + 1, eolAt < 0 ? text.length : eolAt)
      .replace(/--[^\n]*$/, '')                     /* 去掉行尾的 -- 注释再判中文 */
      .replace(/\/\*[\s\S]*?\*\//g, '');
    var proseLike = /[\u4e00-\u9fa5]/.test(restOfLine);
    var rightLiteral = /^\s*(?:[0-9]|'[^']*'|"[^"]*"|\(|\[)/.test(text.slice(qi + 1, qi + 12));

    /* 右侧第一段操作数（字面量 / 限定名 / 括号表达式） */
    var OPERAND_RE = /^\s*(?:'(?:[^']|'')*'|"(?:[^"]|"")*"|[0-9]+(?:\.[0-9]+)?|`[^`]*`|[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*|\([^()]*\))/;
    /* 操作数之后紧跟的结构：子句关键字 / 运算符（二者都能证明这是表达式） */
    var AFTER_OPERAND_RE = /^\s*(?:(?:FROM|WHERE|GROUP|ORDER|HAVING|LIMIT|UNION|INTERSECT|EXCEPT|MINUS|JOIN|ON|WINDOW|QUALIFY|CLUSTER|DISTRIBUTE|SORT|LATERAL|AND|OR|IS|NOT|LIKE|IN|BETWEEN)\b|[+\-*\/%<>=!|&^~#?@:]|\s*$|[,;)]\s*$)/i;

    var opM = OPERAND_RE.exec(restOfLine);
    var operandThenClauseOrOp = !!(opM && opM[0].length > 0 &&
      AFTER_OPERAND_RE.test(restOfLine.slice(opM[0].length)));

    if (leftOperand && !proseLike && (rightLiteral || operandThenClauseOrOp)) {
      sawOperatorHash = true; qi++; continue;
    }

    sawCommentHash = true;
    break;
  }

  if (sawCommentHash) {
    lex.hashMode = 'comment';
    lex.hashComment = true;
  } else if (sawOperatorHash) {
    lex.hashMode = 'xor';
    lex.hashComment = false;
  }
  return lex;
}


/* ============================ 结果缓存（P0） ============================ */
/* 格式化是**纯函数**：同样的 (text, 全部参数, 方言, 宽度比) 必然得到同样的字符串。
 * 编辑器里的调用绝大多数是"同一文件重复格式化"（format-on-save、切窗口回来、
 * 连按 Ctrl+S），命中缓存后耗时接近 0。
 *
 * 正确性要点（这是唯一可能出错的地方）：
 *   1. key 必须覆盖**所有**影响输出的输入 —— 漏一个就返回错误结果；
 *   2. 内核有几个**进程级全局量**（LEX 方言开关 / CJK_WIDTH_RATIO / JOIN_CASE），
 *      key 必须把"生效中的值"算进去，否则会跨调用串味；
 *   3. 命中返回同一个字符串（JS 字符串不可变，调用方无法篡改缓存内容）。
 *
 * 不缓存：文本超过 CACHE_MAX_TEXT（超大文件很少重复，不值得占内存）。
 */
var CACHE_MAX_ENTRIES = 64;
var CACHE_MAX_TEXT = 512 * 1024;          /* 512 KB 以上文本不缓存 */
var CACHE_MAX_BYTES = 16 * 1024 * 1024;   /* 缓存总量上限 16 MB */
/* P2-2（2026-11-04 审计，缺陷 C-3）：`text.length` 是 **UTF-16 码元数**，不是
 * 内存占用字节数。emoji / 扩展 B 汉字（`𠀀` 等代理对）在 UTF-16 里占 2 个码元、
 * 实际 4 字节；原来的 `length * 2` 只算出 4 字节 —— 恰好对上，但纯 ASCII 的
 * 1 MB 文本也是 1,048,576 个码元 × 2 = 2 MB，而它实际只占 1 MB。
 * 现在按真实码元数 × 2 逐项累加，并额外计入 Map 键与包装对象的固定开销，
 * 让 CACHE_MAX_BYTES 真正成为内存上限，而不是一个偏小的估算。 */
var CACHE_ENTRY_OVERHEAD = 256;           /* 每个条目的 Map 键 / 对象头等固定开销 */
var SQL_CACHE = new Map();                /* key -> {k,v,n}；Map 保持插入顺序做 LRU */
var SQL_CACHE_BYTES = 0;

/* 32 位 FNV-1a：比加密哈希快两个数量级。
 * 即便碰撞，value 里还存了**完整 key 字符串**做二次校验，
 * 碰撞的后果是"当作未命中"，不可能返回错误结果。 */
/* L1（第三轮审计）：单一 32 位 FNV 做缓存键会碰撞 —— 实测 300 万条
 * `select aNNNNNNN from t` 就能撞出一对，命中后**返回另一条语句的结果**。
 * 这里再加一路**独立**哈希（不同初值与乘子），两路同时碰撞才可能出错，
 * 概率从 1/2^32 降到 1/2^64 量级，而键长度只多十几个字符。 */
function cacheHash2(s) {
  var h = 0x9E3779B1;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 5) + (h << 11) + (h << 17) + (h << 23))) >>> 0;
  }
  return h.toString(36);
}
function cacheHash(s) {
  var h = 0x811C9DC5;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36) + '.' + cacheHash2(s);
}

function cacheGet(key, fullKey) {
  var hit = SQL_CACHE.get(key);
  if (hit === undefined) return undefined;
  if (hit.k !== fullKey) return undefined;   /* 碰撞 → 当作未命中 */
  SQL_CACHE.delete(key);                     /* LRU：命中后移到队尾 */
  SQL_CACHE.set(key, hit);
  return hit;
}

/* F6：`diag` 是产生 value 的那次调用留下的诊断（LAST_DIAG）。
 * 命中缓存时原样放回，调用方才能分清 not-sql / reverted / error / unchanged / formatted；
 * 旧实现命中时只会重算成 unchanged|formatted，"不是 SQL"在第二次执行时就变成"已是最佳排版"。 */
function cachePut(key, fullKey, value, diag) {
  if (SQL_CACHE.has(key)) {
    SQL_CACHE_BYTES -= SQL_CACHE.get(key).n;
    SQL_CACHE.delete(key);
  }
  /* 预算里必须计入键（fullKey 往往比 value 更长）与对象头，否则 16 MB 的
   * 上限只统计了 value，实际内存可以是它的两三倍。 */
  var n = value.length * 2 + String(fullKey).length * 2 + CACHE_ENTRY_OVERHEAD;
  SQL_CACHE.set(key, { k: fullKey, v: value, n: n, g: snapGlobals(),
    d: diag ? { status: diag.status, reason: diag.reason, changed: diag.changed } : null });
  SQL_CACHE_BYTES += n;
  while (SQL_CACHE.size > CACHE_MAX_ENTRIES || SQL_CACHE_BYTES > CACHE_MAX_BYTES) {
    var firstKey = SQL_CACHE.keys().next().value;
    if (firstKey === undefined) break;
    SQL_CACHE_BYTES -= SQL_CACHE.get(firstKey).n;
    SQL_CACHE.delete(firstKey);
    if (SQL_CACHE.size === 0) break;
  }
}

/* 全局态快照：sql() 每次调用都会改写这三个进程级变量。
 * 命中缓存时 Formatter 不会被构造，这些变量就不会更新 ——
 * 于是"下一次调用"看到的状态与不缓存时不同。
 * 把调用**结束后**的状态一并缓存，命中时写回，即可保证演化轨迹一致。 */
function snapGlobals() {
  return {
    r: CJK_WIDTH_RATIO,
    b: LEX.backslash,
    h: LEX.hashComment,
    m: LEX.hashMode,
    d: LEX.dashSpace,
    q: LEX.dialect,
    j: JOIN_CASE,
    t: TAB_WIDTH
  };
}

function restoreGlobals(g) {
  CJK_WIDTH_RATIO = g.r;
  LEX.backslash = g.b;
  LEX.hashComment = g.h;
  LEX.hashMode = g.m;
  LEX.dashSpace = g.d;
  LEX.dialect = g.q === undefined ? '' : g.q;
  JOIN_CASE = g.j;
  if (typeof g.t === 'number') setTabWidth(g.t);
}

/* C-06：这里原本还有一套「DDL 专用缓存」——独立的 Map、独立的字节计数、
 * 独立的清空函数。实际上 sqlddl() 用的是与 sql() **共用的同一张缓存**
 * （只是 key 加了 'd:' 前缀），那套结构从未被写入过一次，
 * 纯属误导后来者的死代码，已整体删除。
 * 需要同时清空 SQL 与 DDL 的缓存时调用 sqlCacheClear() 即可（本来就是同一张表）。 */

function clearSqlCache() { SQL_CACHE.clear(); SQL_CACHE_BYTES = 0; }
function sqlCacheStats() { return { entries: SQL_CACHE.size, bytes: SQL_CACHE_BYTES }; }

/* 诊断接口：查看结果缓存状态 / 清空缓存（测试与排查用） */
SQLBeautifyKernel.prototype.sqlCacheStats = function () { return sqlCacheStats(); };

/* C-03：让调用方**能分辨**「内容本来就是格式化好的」和「格式化后触发安全网、
 * 于是回退了原文」这两种情况。
 *
 * 旧行为：两条路径都返回同一份原文，扩展层看到 newText === oldText 就静默跳过，
 * 用户按了快捷键「什么都没发生」，也无法判断是"已是最优"还是"内核拒改"。
 * 现在每次调用都会把诊断信息写进这个只读窗口，扩展在无变更时读它给出准确提示。 */
var LAST_DIAG = { status: 'unknown', reason: '', changed: false };
SQLBeautifyKernel.prototype.lastDiagnostics = function () { return LAST_DIAG; };
/* extractddl 的"为什么提取不到列"原因（A-05）：空串返回 + 这条说明，
 * 由扩展层转成恰到好处的提示，而不是把注释写进用户文件。 */
var lastExtractReason = '';
/* P2-5（2026-11-02 审计）：本次提取里**类型是靠猜的**列表达式。
 * 非空时在 DDL 末尾追加一条说明，避免用户把猜出来的 STRING 当成事实。 */
var lastTypeGuess = "";
SQLBeautifyKernel.prototype.lastExtractReason = function () { return lastExtractReason; };
function setDiag(status, reason, changed) {
  /* P3-3（2026-11-09 复核）：`changed` 旧实现写死成 `status === 'formatted'`，
   * 于是 `partial` / `partial-unbalanced` / `extracted` 即使确实改动了文档
   * 也报 false —— 一旦有人用它判断"要不要写回"，就会漏写。
   * 现在允许调用方显式传入；不传时保持原来的保守默认（只有 formatted 算改过）。 */
  LAST_DIAG = {
    status: status,
    reason: reason || '',
    changed: (typeof changed === 'boolean') ? changed : (status === 'formatted')
  };
}

SQLBeautifyKernel.prototype.sqlCacheClear = function () { clearSqlCache(); };

/* 求"数据区"区间：字符串字面量 / 行注释 / 块注释。区间内的一切（含换行）都是
 * 用户数据，还原文档 EOL 时必须原样跳过。
 *
 * F9a（2026-10-29 复核）：旧实现只认字符串和块注释，**不认行注释**。
 * 于是 `-- don't do this` 里那个撇号被当成字符串起点，一路吃到下一个撇号
 * （没有就吃到文件尾），中间的换行全被判成"字面量内部换行"原样保留 ——
 * 结果是整篇 CRLF → LF，而用户只写了一句带撇号的注释。
 * 现在：
 *   · 行注释 `--`（MySQL 系还要 -- 后跟空白，与词法器 dashSpace 一致）
 *   · 行注释 `#`（仅 hashComment 方言；其它方言 # 是运算符）
 *   · 块注释
 *   · 字符串 '…' / "…" / `…`，含 '' 双写与反斜杠转义（与 scanQuoted 同款）
 * 返回按起点升序的 [start, end) 数组。 */
function protectedRanges(text, lex) {
  lex = lex || LEX;
  var out = [];
  var n = text.length, i = 0;
  while (i < n) {
    var ch = text.charAt(i);
    if (ch === '-' && text.charAt(i + 1) === '-') {
      /* dashSpace 方言（MySQL/MariaDB）要求 -- 后必须是空白/控制符/行尾，
       * 否则 `1--2` 是 1 减负 2，不是注释。 */
      var nx = text.charAt(i + 2);
      if ((!lex.dashSpace) || nx === '' || /[\s]/.test(nx)) {
        var je = text.indexOf('\n', i);
        var e1 = je < 0 ? n : je;
        /* 行尾的 \r 是**行终止符**，不是注释内容：区间止于它之前，
         * 否则 maskLiteralEols 会把 CRLF 里的 \r 换成占位符，
         * 输出多出一个 CR（`-- head\r\r\n`）。 */
        if (e1 > i && text.charAt(e1 - 1) === '\r') e1--;
        out.push([i, e1]);
        i = je < 0 ? n : je;
        continue;
      }
    }
    if (ch === '#' && lex.hashComment === true &&
        text.charAt(i + 1) !== '>' && text.charAt(i + 1) !== '<') {
      var jh = text.indexOf('\n', i);
      var e2 = jh < 0 ? n : jh;
      if (e2 > i && text.charAt(e2 - 1) === '\r') e2--;
      out.push([i, e2]);
      i = jh < 0 ? n : jh;
      continue;
    }
    if (ch === '/' && text.charAt(i + 1) === '*') {
      var close = text.indexOf('*/', i + 2);
      var e3 = close < 0 ? n : close + 2;
      out.push([i, e3]);
      i = e3;
      continue;
    }
    if (ch === '$') {
      var dollarEnd = matchDollarQuote(text, i);
      if (dollarEnd > i) {
        out.push([i, dollarEnd]);
        i = dollarEnd;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      var q = ch, j = i + 1;
      var bs = lex.backslash !== false && ch !== '`';
      while (j < n) {
        var cj = text.charAt(j);
        if (bs && cj === '\\') { j += 2; continue; }
        if (cj === q) {
          /* '' 与 "" 都是转义；`` 同理（反引号标识符的双写） */
          if (text.charAt(j + 1) === q) { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      j = Math.min(j, n);
      out.push([i, j]);
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/* F-01（2026-11-04 复核）：全角标点门槛只看**代码区**。
 *
 * 旧实现对整段文本做 `/[，；。：（）…]/.test(body)`，把注释与字符串字面量里的
 * 中文标点也算成"这不是 SQL"。中文注释里出现一个 `，` 就再也格式化不了，
 * 提示语还让用户"换成半角"——用户会真的去改自己的注释。
 *
 * 这里复用 protectedRanges（与 EOL 还原、安全网使用同一份数据区定义），
 * 只在数据区之外找全角标点。找不到就放行，找到才拒绝。
 */
var FULLWIDTH_PUNCT_RE = /[，；。：（）【】《》「」“”‘’、]/;

function hasCodeAreaFullwidth(text, lex) {
  var ranges = protectedRanges(text, lex);
  var ri = 0, i = 0, n = text.length;
  while (i < n) {
    while (ri < ranges.length && ranges[ri][1] <= i) ri++;
    if (ri < ranges.length && i >= ranges[ri][0] && i < ranges[ri][1]) { i = ranges[ri][1]; continue; }
    if (FULLWIDTH_PUNCT_RE.test(text.charAt(i))) return true;
    i++;
  }
  return false;
}

/* F9b（2026-10-29 复核）：`sql()` 入口的 `text.replace(/\r\n?/g, '\n')` 是**无差别**的，
 * 连字符串字面量**内部**的换行也一起压掉 ——
 *     select 'a<CR><LF>b' as s from t   →   SELECT 'a<LF>b' AS s
 * 字面量的值变了（PG 里 \r 是值的一部分，Hive/Spark 的多行字符串同理），
 * 而安全网发现不了：significant() 先做 EOL 归一，然后才比 token。
 *
 * 修法：进入格式化之前，把**引号内部**的 \r\n / \r 换成不可见占位符
 * （U+E000 / U+E001，Unicode 私有区），格式化结束后原样换回。
 * 为什么不会影响排版：
 *   · 词法器不把占位符当换行（不是 \n / \r），字面量仍是一个 token；
 *   · 宽度按字符数算，占位符算 1 列；
 *   · 占位符只出现在引号内部，不会跑到代码区干扰 matchClause。
 * 两个占位符分别对应 \r\n 与裸 \r —— 裸 CR 也是合法数据，不能一概并成 \r\n。 */
var EOL_PH_CRLF = '\uE000';
var EOL_PH_CR = '\uE001';
/* P3-3（2026-11-02 审计）：用户文本里可能**本来就有** U+E000 / U+E001。
 * 那时 unmask 会把它替换成真正的 CRLF —— 用户数据被改了，安全网也查不出来
 * （significant() 里占位符同样被还原成换行，两边一致）。
 * 用另一对私有区字符把"用户自己的占位符"先转义掉，结束时再换回来。
 *
 * P0-3（2026-11-06 复核）：只转义一层是不够的 —— 用户文本里若本来就有
 * U+E010 / U+E011，`unescape` 会把它们**无条件**换回 U+E000 / U+E001，
 * 于是 `select  from t` 被悄悄改成 `select  from t`（E010→E000），
 * 而安全网看不出来（它读的是同一份 unmask 结果）。
 * 现在改成三层固定映射，用**单遍扫描**实现（不能链式 replace：
 * E000→E010 之后会被下一轮 E010→E020 再改一次）：
 *
 *   正向：E000→E010, E001→E011, E010→E020, E011→E021
 *   反向：E010→E000, E011→E001, E020→E010, E021→E011
 *
 * 已知边界：同时含 E020 / E021 的文本仍会被改写。这两个码点不会出现在
 * 正常 SQL 里，再往上加层的收益远小于复杂度 —— 若要彻底解决，应改用
 * 带长度前缀的占位方案，而不是继续堆私有区字符。 */
var USER_PH_CRLF = '\uE010';
var USER_PH_CR = '\uE011';
var USER2_PH_CRLF = '\uE020';
var USER2_PH_CR = '\uE021';

/* 单遍映射：按**原字符**决定目标，避免链式替换互相覆盖。 */
function mapPlaceholderChars(text, table) {
  if (!text) return text;
  var out = '', last = 0, changed = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    var to = table[ch];
    if (to === undefined) continue;
    out += text.slice(last, i) + to;
    last = i + 1;
    changed = true;
  }
  if (!changed) return text;
  return out + text.slice(last);
}

var ESCAPE_TABLE = {};
ESCAPE_TABLE[EOL_PH_CRLF] = USER_PH_CRLF;
ESCAPE_TABLE[EOL_PH_CR] = USER_PH_CR;
ESCAPE_TABLE[USER_PH_CRLF] = USER2_PH_CRLF;
ESCAPE_TABLE[USER_PH_CR] = USER2_PH_CR;

var UNESCAPE_TABLE = {};
UNESCAPE_TABLE[USER_PH_CRLF] = EOL_PH_CRLF;
UNESCAPE_TABLE[USER_PH_CR] = EOL_PH_CR;
UNESCAPE_TABLE[USER2_PH_CRLF] = USER_PH_CRLF;
UNESCAPE_TABLE[USER2_PH_CR] = USER_PH_CR;

function escapeUserPlaceholders(text) {
  if (text.indexOf('\uE000') < 0 && text.indexOf('\uE001') < 0 &&
      text.indexOf(USER_PH_CRLF) < 0 && text.indexOf(USER_PH_CR) < 0) return text;
  return mapPlaceholderChars(text, ESCAPE_TABLE);
}

function unescapeUserPlaceholders(text) {
  if (text.indexOf(USER_PH_CRLF) < 0 && text.indexOf(USER_PH_CR) < 0 &&
      text.indexOf(USER2_PH_CRLF) < 0 && text.indexOf(USER2_PH_CR) < 0) return text;
  return mapPlaceholderChars(text, UNESCAPE_TABLE);
}

/* P3-3（2026-11-02 审计）：文档 EOL 只能由**代码区**决定。
 * `select a\nfrom t\nwhere b = 'x\ry'` 里的裸 CR 在字符串内部，
 * 它属于数据，不是"这份文档用 CR 换行"的证据。
 * 旧判据 `/\r/.test(text)` 把整篇的 \n 都改成了 \r。 */
/* 代码区是否含 LF 换行（数据区内部的换行不算）。
 *
 * P0-2（2026-11-06 复核）：用来判断"文本本身是否已经足以证明这是 LF 文档"。
 * 单行文本、或所有换行都落在字符串/注释里时，答案是"不能证明"，
 * 此时才允许采用调用方给的 eolHint（VS Code 的 document.eol）。 */
function codeAreaHasLf(text, lex) {
  var ranges;
  try { ranges = protectedRanges(text, lex); } catch (e) { return true; }
  var ri = 0, i = 0, n = text.length;
  while (i < n) {
    while (ri < ranges.length && ranges[ri][1] <= i) ri++;
    if (ri < ranges.length && i >= ranges[ri][0] && i < ranges[ri][1]) { i = ranges[ri][1]; continue; }
    if (text.charAt(i) === '\n') return true;
    i++;
  }
  return false;
}

function detectDocEol(text, lex, eolHint) {
  if (text.indexOf('\r') < 0) {
    /* P0-2（2026-11-06 复核）：单行文本（或所有换行都在数据区里）看不出文档 EOL，
     * 此时旧实现一律返回 '\n'，VS Code 侧明明知道文档是 CRLF 却被忽略 ——
     * 格式化一次就把整篇写成裸 LF。调用方（扩展层）把 document.eol 传进来即可。 */
    if (eolHint === '\r\n' && !codeAreaHasLf(text, lex)) return '\r\n';
    return '\n';
  }
  var ranges = protectedRanges(text, lex);
  var ri = 0, i = 0, n = text.length;
  /* F-02（2026-11-04 复核）：不能"遇到第一个 \r 就下结论"。
   * mysqldump 会写出 `\r\r\n`（空行 = CR + CRLF），旧实现看到第一个 \r 后面
   * 还是 \r 就判定整篇用 CR 换行，把全文 CRLF 改写成裸 CR —— 文件换行被破坏，
   * 且 git 里整片标红、安全网也查不出来（sameTokenStream 做 EOL 归一后比较）。
   * 现在对**代码区**的换行投票：CRLF 数 >= 裸 CR 数 → CRLF。 */
  var crlf = 0, crOnly = 0;
  while (i < n) {
    while (ri < ranges.length && ranges[ri][1] <= i) ri++;
    if (ri < ranges.length && i >= ranges[ri][0] && i < ranges[ri][1]) { i = ranges[ri][1]; continue; }
    var ch = text.charAt(i);
    if (ch === '\r') {
      if (text.charAt(i + 1) === '\n') { crlf++; i += 2; continue; }
      crOnly++; i++; continue;
    }
    i++;
  }
  if (crlf === 0 && crOnly === 0) return '\n';
  return crlf >= crOnly ? '\r\n' : '\r';
}

function maskLiteralEols(text, lex) {
  /* P3-3：不论有没有 \r，都要先转义用户自己的 U+E000/U+E001，
   * 否则 unmask 会把它们当占位符换成真正的换行。 */
  text = escapeUserPlaceholders(text);
  if (text.indexOf('\r') < 0) return { text: text, n: 0 };
  var ranges = protectedRanges(text, lex);
  if (!ranges.length) return { text: text, n: 0 };
  var out = '', pos = 0, n = 0;
  for (var ri = 0; ri < ranges.length; ri++) {
    out += text.slice(pos, ranges[ri][0]);
    var seg = text.slice(ranges[ri][0], ranges[ri][1]);
    if (seg.indexOf('\r') >= 0) {
      out += seg.replace(/\r\n/g, function () { n++; return EOL_PH_CRLF; })
        .replace(/\r/g, function () { n++; return EOL_PH_CR; });
    } else {
      out += seg;
    }
    pos = ranges[ri][1];
  }
  out += text.slice(pos);
  return { text: out, n: n };
}

/* 换回真实 EOL。字面量里的 \r\n 是用户写进数据的，与文档 EOL 无关，原样还原。 */
function unmaskLiteralEols(text) {
  if (text.indexOf(EOL_PH_CRLF) >= 0 || text.indexOf(EOL_PH_CR) >= 0) {
    text = text.split(EOL_PH_CRLF).join('\r\n').split(EOL_PH_CR).join('\r');
  }
  /* P3-3：把用户自己写的 U+E000/U+E001 换回来。 */
  return unescapeUserPlaceholders(text);
}

/* L2（第三轮审计）：把内部的 LF 还原成文档的 EOL 时，**不能**无脑 replace ——
 * 字符串字面量与注释内部的换行属于数据，改掉会改变查询语义
 * （`where c = 'x\ny'` 被改成 `'x\r\ny'`，PG 里 \r 成了值的一部分）。
 *
 * F9a：现在用 protectedRanges 求出数据区，只有数据区之外的 \n 才换 eol。 */
function applyEolTextCore(text, eol) {
  if (eol === '\n') return text;
  var ranges = protectedRanges(text, LEX);
  var out = '', i = 0, n = text.length, ri = 0;
  while (i < n) {
    var protectedRange = ri < ranges.length ? ranges[ri] : null;
    if (protectedRange && i === protectedRange[0]) {
      out += text.slice(i, protectedRange[1]);
      i = protectedRange[1];
      ri++;
      continue;
    }
    var nextStart = protectedRange ? protectedRange[0] : n;
    var codePart = text.slice(i, nextStart);
    out += codePart.replace(/\n/g, eol);
    i = nextStart;
  }
  return out;
}

/* 对外统一入口：先按文档 EOL 还原代码区，再把字面量里的占位符换回真实换行。
 * 顺序不能颠倒 —— 占位符不是 \n，先 unmask 会让字面量里的 \r\n 又被
 * applyEolTextCore 当成代码区换行处理掉。 */
function applyEolText(text, eol) {
  return unmaskLiteralEols(applyEolTextCore(text, eol));
}

SQLBeautifyKernel.prototype.sql = function (text, uppercase, comma_location, bracket_char, as_loc_cnt, max_line_length, extra) {
  if (typeof text !== 'string') return text;
  /* P3-4（2026-11-02 审计）：空文本/纯空白不是"格式化成功"，
   * 必须写 empty 诊断，否则扩展层只能显示"已是最佳排版"或"不是 SQL"。 */
  /* P3-4（2026-11-02 审计）：`lastExtractReason` 是全局的，只有 extractddl 写。
   * 不复位的话，`sql()` 判定失败时扩展层会把**上一次 Extract** 留下的
   * 通配符原因一起弹出来（"列清单全部是通配符（*）"）。 */
  if (typeof lastExtractReason !== "undefined") lastExtractReason = "";

  if (text === "") { setDiag('empty', '输入为空，没有可格式化的内容'); return text; }
  if (!/\S/.test(text)) { setDiag('empty', '输入只有空白字符，没有可格式化的内容'); return text; }

  /* ---- P0 查缓存 ----
   * key = text hash + 长度 + 全部影响输出的参数 + 生效中的全局态。
   * 全局态必须进 key：否则"先以 mysql 格式化、再以 pg 格式化同一段文本"
   * 会命中彼此的错误结果。 */
  var _cOn = text.length <= CACHE_MAX_TEXT;
  var _cKey = null, _cFull = null, _cHit;
  if (_cOn) {
    var _ex = extra || {};
    _cFull = cacheHash(text) + ':' + text.length + '\u0000' +
      (uppercase === false ? '0' : '1') + '\u0001' +
      (comma_location === true ? '1' : '0') + '\u0001' +
      (bracket_char === true ? '1' : '0') + '\u0001' +
      String(as_loc_cnt) + '\u0001' +
      String(max_line_length) + '\u0001' +
      (_ex.fragment ? '1' : '0') + '\u0001' +
      (_ex.dialect === undefined ? '' : String(_ex.dialect)) + '\u0001' +
      (typeof _ex.tabWidth === 'number' ? String(_ex.tabWidth) : '') + '\u0001' +
      (typeof _ex.hardWidth === 'number' ? String(_ex.hardWidth) : '') + '\u0001' +
      (typeof _ex.cjkWidth === 'number' ? String(_ex.cjkWidth) : '') + '\u0001' +
      /* P0-2（2026-11-06 复核）：eolHint 参与输出（单行文档的 CRLF/LF 由它决定），
       * 必须进缓存键 —— 否则同一段单行 SQL 在 CRLF 与 LF 文档间会串用缓存。 */
      (_ex.eolHint === undefined ? '' : String(_ex.eolHint)) + '\u0001' +
      String(CJK_WIDTH_RATIO) + '\u0001' +
      (LEX.backslash ? '1' : '0') + '\u0001' +
      (LEX.hashComment ? '1' : '0') + '\u0001' +
      String(LEX.hashMode) + '\u0001' +
      (LEX.dashSpace ? '1' : '0') + '\u0001' +
      String(JOIN_CASE) + '\u0001' +
      String(TAB_WIDTH);
    _cKey = _cFull.slice(0, _cFull.indexOf('\u0000'));
    _cHit = cacheGet(_cKey, _cFull);
    if (_cHit !== undefined) {
      /* 关键：把"这次调用本该造成的全局态变化"补上，
       * 否则命中缓存会让 CJK_WIDTH_RATIO / LEX / JOIN_CASE 停在旧值，
       * 后续调用（进而后续缓存键）与不缓存时不一致。 */
      restoreGlobals(_cHit.g);
      /* M-2（Claude 审计）：缓存命中**不能**让诊断停留在上一次调用的结果。
       * 旧实现直接 return，lastDiagnostics() 仍然是上一段的
       * {"status":"formatted"}，于是扩展在"本次其实什么都没改"时
       * 可能弹出错误的成功/失败提示。
       *
       * F6：M-2 的修法是按"缓存值与输入是否相同"重算，只能得到 unchanged|formatted，
       * 把 not-sql / reverted / error 都抹成了 unchanged（第二次执行提示"已是最佳排版"）。
       * 现在直接放回写缓存时那次调用的诊断；没有记录时才退回旧的重算。 */
      if (_cHit.d) setDiag(_cHit.d.status, _cHit.d.reason, _cHit.d.changed);
      else setDiag(_cHit.v === text ? 'unchanged' : 'formatted',
        _cHit.v === text ? '' : '（命中结果缓存）');
      return _cHit.v;
    }
  }

  /* 写缓存后返回。异常路径也走这里：同样的输入必然产生同样的回退结果。 */
  function _cPut(v) {
    if (_cOn) cachePut(_cKey, _cFull, v, LAST_DIAG);
    return v;
  }

  /* F-05（2026-11-04 复核）：**判定为"不格式化"的分支必须逐字节原样返回**。
   * 旧实现即使走 not-sql / XML / 括号残缺 / 安全网回退这些"不动"分支，
   * 也过一遍 `applyEolText(body, eol)` —— 而 eol 是**单一**值，于是文件里的
   * 混合换行被悄悄统一：诊断说"未做修改"，实际写回了一片 diff。
   * 现在这些分支统一返回 `_rawOriginal`（含 BOM、含原换行）。 */
  var _rawOriginal = text;
  function _rawPut() {
    return _cPut(_rawOriginal);
  }

  /* fragment=true 表示调用方在格式化"选区/片段"而不是整个文档。
   * 片段不满足"语句关键字开头"，需要放宽非 SQL 门槛（P1-1）。 */
  var fragment = !!(extra && extra.fragment);

  /* JSON / JSONL（N-24）：片段模式下"非 SQL 门槛"被放宽，于是
   * `{"a":1,"b":2}` 会被重排成 `{ "a" : 1, "b" : 2 }`。它对 JSON 解析等价，
   * 但用户选中的是 JSON 不是 SQL，改它就是"改用户代码"。
   * 能 JSON.parse 且顶层是对象/数组时原样返回。 */
  if (fragment) {
    /* P2-7（2026-11-02 审计）：这里原本是
     *   text.replace(/^\s+/, "").replace(/\s+$/, "")
     * 第二句是 O(n²)：正则在**每个**位置贪心吞下整段空白再发现 $ 不成立。
     * 实测 10 万个连续空格 → 2.8 秒，全部耗时落在这里。
     * 改用线性 ltrim / rtrim。 */
    var jt = rtrim(ltrim(text));
    var jc0 = jt.charAt(0);
    if (jc0 === "{" || jc0 === "[") {
      try {
        var jParsed = JSON.parse(jt);
        if (jParsed !== null && typeof jParsed === "object") {
          /* M-2：这个早退也必须写诊断（旧实现什么都不写）。 */
          setDiag('not-sql', '内容是合法的 JSON（对象/数组），不是 SQL，已原样保留');
          return text;
        }
      } catch (e) { /* 不是 JSON，继续按 SQL 处理 */ }
    }
  }

  /* 1) BOM：剥掉再格式化，之后原样加回。
   *    旧版 BOM 会被词法器当成一个 punct token，安全网判不等价 → 整段静默不格式化（P1-2）。 */
  var bom = '';
  if (text.charCodeAt(0) === 0xFEFF) { bom = '\uFEFF'; text = text.slice(1); }

  /* 2) 统一按 LF 处理，最后再还原原始 EOL（避免把 CRLF 文件改成 LF）。 */
  /* P3-3：EOL 只看代码区（字符串内部的裸 CR 不算），见 detectDocEol。
   * P0-2（2026-11-06 复核）：单行文档从文本里看不出 CRLF，需要调用方把
   * document.eol 传进来（extra.eolHint），否则格式化会写入裸 LF。 */
  /* P3-5（2026-11-09 复核）：原来这里和下面 9291 行各调一次 detectLex，**入参完全相同**
   * （同一个 text、同一个 extra.dialect），detectLex 又是纯函数、不写任何全局量。
   * 同一份词法结论算两遍纯属浪费 —— 直接复用。 */
  var lex = detectLex(text, extra && extra.dialect);
  var eol = detectDocEol(text, lex, extra && extra.eolHint);
  /* F9b：方言要先定下来（maskLiteralEols 用 dashSpace/hashComment 判注释边界），
   * 再把字面量内部的换行换成占位符 —— 否则下面这行 replace 会把字面量的值改掉。
   * 同一次 detectLex 结果直接交给 Formatter，不重复分词。 */
  var masked = maskLiteralEols(text, lex);
  var body = masked.text.replace(/\r\n?/g, '\n');

  /* 2.5) 记住原文末尾有几个换行。旧版 f.format() 会把尾部空行全部 pop 掉，
   * 于是"格式化整个文档"会吃掉文件末尾的换行（P2-4），
   * git 里显示成 `\ No newline at end of file`，且和 Prettier 等工具互相打架。 */
  var tailNl = 0;
  while (tailNl < body.length && body.charAt(body.length - 1 - tailNl) === '\n') tailNl++;

  /* 3) 方言（上面已算：lex = detectLex(text, …)）。
   *    extra.dialect 由调用方给（document.languageId），未知时走启发式。 */

  /* P0-1（2026-11-02 审计）：反斜杠转义到底算不算转义，文本本身无法判定，
   * 两种切法的字符串边界不一致。这时候**任何**排版都可能改坏数据，
   * 所以直接原样返回，并告诉用户去设置 snugSql.dialect。
   * 注意：方言明确时不会走到这里（detectLex 按方言直接定）。 */
  if (lex.ambiguous) {
    setDiag('ambiguous-escape',
      '文本里的反斜杠转义有歧义（两种切法的字符串边界不同），已原样返回。' +
      '请设置 snugSql.dialect 指明数据库（例如 mysql / hive / pgsql）。');
    return _rawPut();
  }

  /* P1-3（2026-11-02 审计）：选项提到变量里 —— 按语句隔离的兜底路径
   * 要用**同一份选项**重建 Formatter，否则两条路径的排版风格会不一致。 */
  var fmtOpts = {
    uppercase: uppercase !== false,
    commaLocation: comma_location === true,
    bracketChar: bracket_char === true,
    asLocCnt: as_loc_cnt,
    maxWidth: max_line_length,
    /* 硬阈值 = 屏幕 100%：一行只要还塞得进屏幕就完整保留，超过才折行。
       * 旧版 sql() 完全没有转发这个参数，扩展层算出来的 hardLine 被丢掉，
       * 内核自己按 maxWidth/0.8 反推 —— 于是「80%~100% 之间不硬拆」的设计
       * 在走 sql() 时彻底失效（N-7 / N-12）。 */
    hardWidth: (extra && typeof extra.hardWidth === 'number' && extra.hardWidth > 0)
      ? extra.hardWidth
      : undefined,
    backslash: lex.backslash,
    hashComment: lex.hashComment,
    hashMode: lex.hashMode,
    dashSpace: lex.dashSpace,
    clientLines: lex.clientLines === true,
    /* L3c：方言随 Formatter 一起传下去，matchClause 才能识别 PREWHERE 之类的专属子句。
     * 没有这一步，LEX.dialect 永远是空串，方言判断全部失效。 */
    dialect: lex.dialect,
    /* 缩进宽度（R3-9）：扩展层从 editor.tabSize 传来，缺省 4。 */
    tabWidth: (extra && typeof extra.tabWidth === 'number' && extra.tabWidth > 0)
      ? extra.tabWidth
      : 4,
    /* 汉字相对 ASCII 列的真实渲染宽度（默认 1.81818 = Consolas 0.550em + 微软雅黑 1.000em）。
     * 只影响 AS 对齐 / 注释对齐 / DDL 列对齐补几个空格；折行仍用整数 visLen。 */
    cjkWidth: (extra && typeof extra.cjkWidth === 'number' && extra.cjkWidth > 0)
      ? extra.cjkWidth
      : undefined
  };
  var f = new Formatter(fmtOpts);
  /* 按语句隔离的兜底路径用这个工厂重建同配置的 Formatter。 */
  var mkFmt = function () { return new Formatter(fmtOpts); };

  /* 3.5) 非 SQL 门槛：整段文本没有可识别的 SQL 结构时直接原样返回。
   * 旧版无此检查，`hello world this is not sql` 会被改成 `hello world this IS NOT sql`，
   * JSON / 日志 / CSV 也会被重排。判定看"语句级硬关键字"是否出现在语句开头
   * （可选地前面只跟注释/分号），避免把普通英文句子里的 IS/NOT/FULL/AT 误当关键字。
   *
   * 但这个门槛对**片段**是致命的（P1-1）：README 主推"一段段格式化"，
   * 而一段片段几乎都以 WHERE / ON / 逗号 / 括号开头，永远不满足"语句关键字开头"，
   * 于是用户选中 10 行按快捷键，看到的是"什么都没发生"。
   * 解决：由调用方（extension）通过 opts.fragment 声明"这是选区/片段"，
   * 片段模式跳过门槛；只有"格式化整个文档"才启用这段保护。 */
  var probe = tokenizeRaw(body, lex);

  /* P0-2 / P2-7（2026-11-05 复核）：**未闭合的块注释或 dollar-quote 一律原样返回**。
   * 这类输入多半是被截断的，任何重排都可能在"注释吃掉后半段"与
   * "把函数体当 SQL 排"之间来回摇摆：
   *   · `select a from t /* oops`         → 旧实现照排，注释边界被挪动
   *   · `select $tag$abc from t where x=1` → 旧实现把函数体当 SQL 重排
   * 原样返回 + 明确诊断，比"看起来成功"安全得多。 */
  if (probe.unterminated) {
    var uKind = probe.unterminatedKind || '';
    if (uKind === 'block-comment') {
      setDiag('unterminated-comment', '块注释没有闭合（找不到 */），已保留原文');
      return _rawPut();
    }
    if (uKind === 'dollar-quote') {
      setDiag('unterminated', '美元引号（$tag$…$tag$）没有闭合，函数体可能被截断，已保留原文');
      return _rawPut();
    }
    /* P1-9（2026-11-06 复核）：Oracle 的 `q'[…]'` / `nq'[…]'` 未闭合时，
     * 词法器会把一个字符串拆成 `q` + `'…`（两个 token），格式化后变成
     * `q '[abc…`。与 dollar-quote 同理，原样返回。 */
    if (uKind === 'q-quote') {
      setDiag('unterminated', 'q-quote（q\'[…]）没有闭合，已保留原文');
      return _rawPut();
    }
  }

  /* P1-4（2026-11-02 审计）：`DELIMITER //` 开头的存储过程脚本、
   * psql 的 `\c mydb` 开头的脚本，整篇被判 not-sql，"格式化文档"完全没反应。
   * 这些行是**客户端指令**，不是 SQL —— 门槛判定时直接跳过它们，
   * 让后面的真实 SQL 决定这是不是 SQL。
   * 注意只影响**判定**，不改变这些行的输出（它们由 P0-9 的 client token 原样保留）。 */
  (function () {
    var kept = [];
    for (var pz = 0; pz < probe.length; pz++) {
      if (probe[pz].type === 'client') continue;
      kept.push(probe[pz]);
    }
    if (kept.length && kept.length !== probe.length) probe = kept;
  })();

    /* 括号不平衡（P2-9）：`select (a from t` 这类残缺输入，格式化只会
     * 把它拆得更碎（`SELECT (` / `\ta` / `\tFROM t`），反而不如原样返回。
     * 只在缩进会跨越括号时才有害，所以判定很保守：显式不平衡就退出。
     *
     * C-02：退回的必须是**带 BOM 的原文**。此处 `text` 已在前面被剥掉了 BOM，
     * 直接 `return text` 会让 `\uFEFFselect (a` 这种残缺输入丢失 BOM ——
     * 用户什么都没改，文件编码却被悄悄改了。 */
    var bal = 0, balBad = false;
    for (var bi2 = 0; bi2 < probe.length; bi2++) {
      if (probe[bi2].type !== 'punct') continue;
      if (probe[bi2].value === '(') bal++;
      else if (probe[bi2].value === ')') { bal--; if (bal < 0) { balBad = true; break; } }
    }
    /* M-2：括号不平衡也必须写诊断，否则 lastDiagnostics() 停留在上一次的结果，
     * 扩展据此弹出"未通过安全网"之类的**错误**提示（或者干脆没提示）。
     * 注意这里要区分两种情况：括号不配对 vs 右括号多余。 */
    if (balBad || bal !== 0) {
      /* P1-3（2026-11-02 审计）：整篇括号不平衡时，旧实现**整篇原样返回**，
       * 于是「20 条好语句 + 1 条残缺语句」里那 20 条也不会被格式化。
       * 现在先试按语句隔离：残缺的那条保持原文，其余照常排版。
       * 隔离结果仍要过整篇 token 比对，不通过才回退原文。 */
      var isoBal = formatByStatement(body, lex, mkFmt);
      if (isoBal && isoBal !== body && sameTokenStream(body, isoBal, lex)) {
        setDiag('partial-unbalanced',
          '有语句括号不配对，已保留该语句原文；其余语句已重新格式化', true);
        return _cPut(bom + applyEolText(isoBal, eol));
      }
      if (balBad) {
        setDiag('unbalanced', '右括号多于左括号（片段可能从表达式中间截断），已保留原文');
      } else {
        setDiag('unbalanced', '括号不配对（片段可能截断在多行子查询中间），已保留原文');
      }
      return _cPut(bom + text);
    }
    /* 歧义语句词的"散文判定"（N-23）：SET / UPDATE / LOCK / CALL 这些词
     * 同时也是高频英文动词，`Set the table for dinner please.` 会被当成
     * `SET` 语句并把 TABLE / FOR 全大写。判定办法：数一数文本里有多少
     * "SQL 结构证据"（运算符、括号、逗号、分号、字符串、数字、星号）。
     * 真正的 SQL 语句至少有一个；英文句子一个都没有。 */
    var sqlEvidence = 0;
    for (var se = 0; se < probe.length; se++) {
      var st = probe[se];
      if (st.type === 'string' || st.type === 'number' || st.type === 'quoted') { sqlEvidence++; continue; }
      if (st.type !== 'punct') continue;
      if (st.value === '(' || st.value === ')' || st.value === ',' || st.value === ';' ||
          st.value === '=' || st.value === '*' || st.value === '<' || st.value === '>') { sqlEvidence++; }
    }
    /* 第六轮审计（A-6）：只由一个单词构成的"语句头"（`open` / `check`）
     * 既可能是语句残片，也可能是列名，无法判定 —— 保守起见不按 SQL 处理。
     * 判据：第一个代码词之后还有至少一个代码 token。 */
    var hasBodyAfterHead = false;
    var sawFirstCode = false;
    for (var hb = 0; hb < probe.length; hb++) {
      if (probe[hb].type === 'comment' || probe[hb].type === 'template') continue;
      if (probe[hb].type === 'punct' && probe[hb].value === ';') continue;
      if (!sawFirstCode) { sawFirstCode = true; continue; }
      hasBodyAfterHead = true;
      break;
    }
    var AMBIGUOUS_STMT = {
      SET: 1, UPDATE: 1, LOCK: 1, UNLOCK: 1, CALL: 1, DO: 1, LISTEN: 1, NOTIFY: 1,
      UNLISTEN: 1, COMMENT: 1, VALUES: 1, REPLACE: 1, DECLARE: 1, EXECUTE: 1,
      EXEC: 1, PREPARE: 1, RELEASE: 1, SECURITY: 1, IMPORT: 1, COPY: 1,
      ATTACH: 1, DETACH: 1, PRAGMA: 1, DISCARD: 1, REINDEX: 1, CHECKPOINT: 1,
      /* 第六轮审计（A-6）：这批语句头很明确，但同一个词也是高频英文词
       * （fetch / open / close / check / return / reset / install），
       * 因此放行白名单的同时留在这里过"散文判定"：
       * 只有整句一个 SQL 结构证据都没有、且以句号结尾时才当英文句子。 */
      FETCH: 1, OPEN: 1, CLOSE: 1, CHECK: 1, RESET: 1, RETURN: 1, INSTALL: 1
    };
    /* 这些词单独出现时（后面没有任何代码 token）既可能是语句残片，
     * 也可能是列名 —— 保守按"不知道"处理，原样返回。
     *
     * FETCH 不在此列：它本来就在语句门槛白名单里（单独出现的
     * `fetch` 大写成 `FETCH`），移除反而会造成回归。 */
    var BARE_WORD_HEADS = {
      KILL: 1, RESET: 1, PURGE: 1, REPAIR: 1, ASSERT: 1, INSTALL: 1,
      OPEN: 1, CLOSE: 1, CHECK: 1, UNLOAD: 1, FLASHBACK: 1,
      UNDROP: 1, SWAP: 1, SECURITY: 1
    };

    /* 判定"散文"：整句一个 SQL 结构证据都没有，且以句号结尾。
     * 这样 `Set the table for dinner please.` 被识别为英文句子，
     * 而 `lock table t` / `call p(1)` 这类真 SQL（没有句号、或有括号）照常格式化。 */
    var proseLike = sqlEvidence === 0 && /\.\s*$/.test(String(text || ""));

    /* M1（第三轮审计）：虚词表必须分成两档。
     *
     * `MAKE / GET / NEED / WANT / HAVE / HAS / IT / CAN / WILL …` 全都是**合法的
     * 列名/别名**（`select make, model from cars`、`count(*) as it`）。
     * 旧实现把它们和 `THE / PLEASE / YOU` 混在同一张"出现即否决"的表里，
     * 于是 `select make, model from cars where year > 2000` 被判成自然语言、
     * 原样返回 —— 用户看到"按了没反应"，而这是一条完全正常的 SQL。
     *
     * 现在分两档：
     *   PROSE_STRICT  —— 在 SQL 里**几乎不可能**作为独立单词出现的虚词（冠词/代词/
     *                    敬语/助动词的第三人称形式），出现即否决，无条件；
     *   PROSE_SOFT    —— 可能是列名的词。只有当文本**没有任何语句级结构**
     *                    （SELECT/FROM/WHERE/INSERT…）时才用来否决。
     * 这样 `Set the table for dinner please.` 仍然被拦（THE / PLEASE / FOR 在
     * STRICT 里），而 `select make, needs, want from t` 因为含 SELECT/FROM
     * 不再被误杀。 */
    /* P1-1（2026-11-02 审计）：这张表原来有 22 个词，其中
     *   THIS / THAT / THESE / THOSE —— 极常见的列名（this, that 都见过）
     *   WE / HE / SHE / THEY / YOU —— 极常见的表别名（`from hr_employee he`）
     *   OUR / THEIR / YOUR / BEEN / WERE / GOT —— 也能作标识符
     * 只要它们在文本里出现一次，哪怕整句是标准 SQL 也判 not-sql。
     * 实测 `select he.id from hr_employee he`、`select this, that from t`
     * 都返回原文 —— 用户看到"按了没反应"。
     *
     * 现在 STRICT 只保留**在 SQL 里绝无可能作为标识符**的词：
     * 冠词、敬语、情态动词、助动词的第三人称形式。
     * 其余全部下放到 SOFT，只在"整段没有任何语句结构"时才参与否决。 */
    var PROSE_STRICT = {
      THE: 1,
      WOULD: 1, SHOULD: 1, COULD: 1, MIGHT: 1
    };
    var PROSE_SOFT = {
      IT: 1, BE: 1, ARE: 1, WAS: 1, HAVE: 1, HAS: 1, HAD: 1, WILL: 1, CAN: 1,
      MY: 1, WANT: 1, NEED: 1, MAKE: 1, GET: 1, DO: 1,
      /* P1-1：从 STRICT 下放的词（可能作标识符） */
      THIS: 1, THAT: 1, THESE: 1, THOSE: 1, YOU: 1, YOUR: 1, WE: 1, THEY: 1,
      HE: 1, SHE: 1, BEEN: 1, WERE: 1, OUR: 1, THEIR: 1, GOT: 1,
      /* `select * from please` —— 可能作表名，下放 SOFT */
      PLEASE: 1, THANKS: 1,
      /* P1-2（2026-11-02 审计）：AS 从这张表里**删除** —— 它是 SQL 的别名关键字，
       * 也是片段里最常见的词（`col_a as b`）。留在 SOFT 里会让 fragment 判 not-sql。
       * 这里不再登记 AS。 */
      DONE: 1, ERROR: 1, DBMS: 1, NONE: 1, EXIT: 1, FAIL: 1
    };
    var proseStrictHit = false, proseSoftHit = false;
    for (var ph = 0; ph < probe.length; ph++) {
      var pht = probe[ph];
      if (pht.type !== 'word') continue;
      if (PROSE_STRICT[pht.upper]) { proseStrictHit = true; break; }
      if (PROSE_SOFT[pht.upper]) proseSoftHit = true;
    }
    /* STMT_LEVEL 提前到这里（原来在 FOREIGN_HARD 那段），软虚词需要它做豁免。 */
    var STMT_LEVEL = {
      SELECT: 1, INSERT: 1, UPDATE: 1, DELETE: 1, CREATE: 1, MERGE: 1,
      WITH: 1, FROM: 1, WHERE: 1, ALTER: 1, DROP: 1, TRUNCATE: 1, GRANT: 1,
      EXPLAIN: 1, SHOW: 1, DESCRIBE: 1, VALUES: 1, GROUP: 1, ORDER: 1, HAVING: 1,
      JOIN: 1, UNION: 1, ALL: 1, DISTINCT: 1, INTO: 1, TABLE: 1, SET: 1
    };
    var stmtLevelEarly = false;
    for (var sle = 0; sle < probe.length; sle++) {
      if (probe[sle].type === 'word' && STMT_LEVEL[probe[sle].upper]) { stmtLevelEarly = true; break; }
    }
    /* 第六轮审计（A-3）：**语句头本身就是强证据**。
     * `do $$ … $$`（PG 匿名块）、`do begin end` 这类语句的正文里没有
     * SELECT/FROM 这些"语句级结构词"，于是 `stmtLevelEarly` 为 false，
     * 而 DO 又恰好列在 PROSE_SOFT 里（它也是个常见英文单词），
     * 整条语句就被判成"自然语言"原样返回 ——
     * 这是相对早期版本的**回归**（原来 DO 会被正确大写）。
     *
     * 判据：第一个代码词是**确定无疑的 SQL 语句头**时，同样算「有语句级结构」。
     * 这不会放过英文句子：`Set the table for dinner please.` 仍被 PROSE_STRICT
     * 里的 THE / PLEASE 拦下（那条判据在前，无条件命中）。 */
    if (!stmtLevelEarly) {
      var HEAD_WORDS = {
        SELECT: 1, INSERT: 1, UPDATE: 1, DELETE: 1, CREATE: 1, DROP: 1, ALTER: 1,
        TRUNCATE: 1, MERGE: 1, GRANT: 1, REVOKE: 1, USE: 1, SET: 1, SHOW: 1,
        DESCRIBE: 1, DESC: 1, EXPLAIN: 1, ANALYZE: 1, MSCK: 1, LOAD: 1, ADD: 1,
        REFRESH: 1, CACHE: 1, UNCACHE: 1, BEGIN: 1, COMMIT: 1, ROLLBACK: 1,
        DECLARE: 1, CALL: 1, EXEC: 1, EXECUTE: 1, REPLACE: 1, VACUUM: 1,
        COMMENT: 1, DISCARD: 1, DO: 1, LISTEN: 1, NOTIFY: 1, UNLISTEN: 1,
        PREPARE: 1, DEALLOCATE: 1, SAVEPOINT: 1, RELEASE: 1, CHECKPOINT: 1,
        CLUSTER: 1, REINDEX: 1, SECURITY: 1, IMPORT: 1, COPY: 1, ATTACH: 1,
        DETACH: 1, PRAGMA: 1, LOCK: 1, UNLOCK: 1, RENAME: 1, FLUSH: 1,
        START: 1, OPTIMIZE: 1, SYSTEM: 1, COMPUTE: 1, INVALIDATE: 1,
        WITH: 1, VALUES: 1, FROM: 1
      };
      for (var hw = 0; hw < probe.length; hw++) {
        if (probe[hw].type === 'comment' || probe[hw].type === 'template') continue;
        if (probe[hw].type === 'punct' && probe[hw].value === ';') continue;
        if (probe[hw].type === 'word' && HEAD_WORDS[probe[hw].upper]) stmtLevelEarly = true;
        break;                                   /* 只看第一个代码词 */
      }
    }
    /* P1-1：STRICT 无条件否决 —— 这张表现在只剩冠词与情态动词，
     * 它们不可能作为 SQL 标识符出现。
     * （PLEASE / THANKS 已下放到 SOFT：`select * from please` 这种表名要放行，
     *  英文句子的拦截由 THE 保证。） */
    if (proseStrictHit) {
      setDiag('not-sql', '文本里出现英文虚词（the / please / you …），判定为自然语言而非 SQL');
      return _rawPut();
    }
    /* P1-2：片段模式下软虚词不否决（`and done = 1` 里的 done 是列名）。
     * 后面的 sawSql 片断判据仍要求强子句词或运算符，英文片段过不了那关。 */
    if (proseSoftHit && !stmtLevelEarly && !fragment) {
      setDiag('not-sql', '文本里出现英文虚词（the / please / you …），判定为自然语言而非 SQL');
      return _rawPut();
    }

    /* H-2：硬否决词 —— 出现即说明这是**别的语言**，与 SQL 关键字是否共存无关。
     * `def f(x, y): if x in (1, 2) and y == 3: return x, y` 里 if/in/and 全是
     * SQL 关键字，靠"有没有强子句"永远分不开；但 `def` / `lambda` / `elif`
     * 在 SQL 里不可能作为词出现，所以用它们做硬否决。 */
    /* P1-2（2026-11-02 审计）：DONE / ERROR 从硬否决里拿掉。
     *   · `and done = 1` —— done 是极常见的状态列；
     *   · `a.error = 0`  —— error 是日志表的列名。
     * 它们在 FOREIGN_HARD 里时，只要出现一次就判 not-sql（哪怕有 AND/WHERE）。
     * 现在交给 PROSE_SOFT 那一档：只有**整段没有任何语句结构**时才否决。
     * 其余 Python / shell 特征词保持硬否决 —— 它们在 SQL 里确实不可能出现。 */
    var FOREIGN_HARD = {
      DEF: 1, ELIF: 1, LAMBDA: 1, YIELD: 1, RAISE: 1, FINALLY: 1, NAMESPACE: 1,
      SELF: 1, ESAC: 1, ENDIF: 1, FI: 1, PRINTLN: 1,
      /* 日志等级词：保留 INFO / WARN / DEBUG / TRACE / FATAL，
       * ERROR 单独降级（见上）。 */
      INFO: 1, WARN: 1, WARNING: 1, DEBUG: 1, TRACE: 1, FATAL: 1
    };
    /* 但 `select info, warn from log_t`、`where error = 1` 是正常 SQL（列名叫 info/error），
     * 所以只有在**没有真正的 SQL 语句结构**时才用它们否决。
     * STMT_LEVEL 已在上面（软虚词豁免）定义过，这里直接复用。 */
    var foreignHit = false, stmtLevelHit = stmtLevelEarly;
    for (var fk = 0; fk < probe.length; fk++) {
      if (probe[fk].type === 'word' && FOREIGN_HARD[probe[fk].upper]) { foreignHit = true; break; }
    }
    if (foreignHit && !stmtLevelHit) {
      setDiag('not-sql', '文本里出现其它语言/日志的特征词（def / lambda / INFO …），未按 SQL 处理');
      return _rawPut();
    }

    /* 歧义词（SET/UPDATE/LOCK/CALL…）只在散文句里被拦下 */
  var stmtStart = true, sawSql = false;
  for (var pi = 0; pi < probe.length && !sawSql; pi++) {
    var pt = probe[pi];
    if (pt.type === 'comment' || pt.type === 'template') continue;
    if (pt.type === 'punct' && pt.value === ';') { stmtStart = true; continue; }
    /* 以括号开头的语句（`(select 1) union (select 2)`）也是 SQL，
     * 但语句关键字不在第一个 token 上；后面单独判定括号内是否含 SELECT。 */
    if (stmtStart && pt.type === 'punct' && pt.value === '(') { stmtStart = false; continue; }
    if (stmtStart && pt.type === 'word') {
      var pu = pt.upper;
      /* M-3：`FROM` 必须在白名单里 —— Hive/Spark 的 `FROM t INSERT …` /
       * `FROM t SELECT …`（多路插入、多路查询）是官方语法，而且 README 宣称
       * "对 hql 更兼容"。旧白名单没有 FROM，"格式化文档"对它直接判 not-sql。 */
      if (pu === 'FROM' ||
          pu === 'SELECT' || pu === 'INSERT' || pu === 'UPDATE' || pu === 'DELETE' ||
          pu === 'CREATE' || pu === 'DROP' || pu === 'ALTER' || pu === 'WITH' ||
          pu === 'SET' || pu === 'USE' || pu === 'TRUNCATE' || pu === 'MERGE' ||
          pu === 'GRANT' || pu === 'REVOKE' || pu === 'MSCK' || pu === 'VALUES' ||
          pu === 'EXPLAIN' || pu === 'ANALYZE' || pu === 'SHOW' || pu === 'DESCRIBE' ||
          pu === 'LOAD' || pu === 'ADD' || pu === 'REFRESH' || pu === 'CACHE' ||
          pu === 'UNCACHE' || pu === 'BEGIN' || pu === 'COMMIT' || pu === 'ROLLBACK' ||
          pu === 'DECLARE' || pu === 'CALL' || pu === 'EXEC' || pu === 'EXECUTE' ||
            pu === 'REPLACE' || pu === 'VACUUM' || pu === 'COMMENT' || pu === 'DISCARD' ||
            pu === 'DO' || pu === 'LISTEN' || pu === 'NOTIFY' || pu === 'UNLISTEN' ||
            pu === 'PREPARE' || pu === 'DEALLOCATE' || pu === 'SAVEPOINT' ||
            pu === 'RELEASE' || pu === 'CHECKPOINT' || pu === 'CLUSTER' ||
            pu === 'REINDEX' || pu === 'SECURITY' || pu === 'IMPORT' ||
            pu === 'COPY' || pu === 'ATTACH' || pu === 'DETACH' ||
            pu === 'PRAGMA' || pu === 'LOCK' || pu === 'UNLOCK' ||
            /* 方言兼容性检测报告 §3.3：这些是**确定无疑的 SQL 语句头词**，
             * 以前不在白名单里，整条语句被判 not-sql（用户按格式化没反应）。
             * 它们都不是英文常用词，也不可能是列名，所以不需要 AMBIGUOUS_STMT
             * 那套"散文判定"豁免，直接放行：
             *   DESC / DESCRIBE  —— MySQL/Hive 的简写与全称必须一致对待
             *   RENAME           —— `RENAME TABLE a TO b`
             *   FLUSH            —— `FLUSH PRIVILEGES` / `FLUSH TABLES`
             *   START            —— `START TRANSACTION`
             *   OPTIMIZE         —— MySQL / ClickHouse 的 `OPTIMIZE TABLE … [FINAL]`
             *   SYSTEM           —— ClickHouse 的 `SYSTEM RELOAD …`
             *   COMPUTE          —— Impala 的 `COMPUTE STATS t`
             *   INVALIDATE       —— Impala 的 `INVALIDATE METADATA t`
             *   EXISTS / ATTACH / DETACH 已在上面
             *   PREPARE 之类语义模糊的仍走原判据，不在此列。 */
            pu === 'DESC' || pu === 'RENAME' || pu === 'FLUSH' || pu === 'START' ||
            pu === 'OPTIMIZE' || pu === 'SYSTEM' || pu === 'COMPUTE' || pu === 'INVALIDATE' ||
            /* 第六轮审计（A-6）：这一批语句头**此前完全不在白名单里**，
             * 整条语句被判 not-sql，用户按格式化没有任何反应。它们都是
             * 各库的正式语句，且在 SQL 语境里不可能被当列名：
             *   UNLOAD     Redshift `UNLOAD ('select …') TO 's3://…' IAM_ROLE …`
             *   FLASHBACK  Oracle `FLASHBACK TABLE t TO BEFORE DROP`
             *   PURGE      Oracle `PURGE RECYCLEBIN` / `PURGE TABLE t`
             *   REPAIR     MySQL `REPAIR TABLE t`（MSCK REPAIR 早已单独支持）
             *   KILL       MySQL `KILL 123`
             *   ASSERT     T-SQL `ASSERT @x > 0` / PL-pgSQL `ASSERT cond`
             * 其余几个（FETCH / OPEN / CLOSE / CHECK / RESET / RETURN / INSTALL）
             * 同时也是高频英文词或 Python 词，放进来但挂在 AMBIGUOUS_STMT 下，
             * 仍然要过"散文判定"。 */
            pu === 'UNLOAD' || pu === 'FLASHBACK' || pu === 'PURGE' ||
            pu === 'REPAIR' || pu === 'KILL' || pu === 'ASSERT' ||
            pu === 'FETCH' || pu === 'OPEN' || pu === 'CLOSE' ||
            pu === 'CHECK' || pu === 'RESET' || pu === 'RETURN' ||
            pu === 'INSTALL') sawSql = (!AMBIGUOUS_STMT[pu] || !proseLike) &&
                                         (hasBodyAfterHead || !BARE_WORD_HEADS[pu]);
    }
    stmtStart = false;
  }
  /* 以括号开头的语句（`(select 1) union (select 2)`）：第一个 token 不是关键字，
   * 但括号里出现 SELECT 就足以判定是 SQL。只在这个前提下放行，
   * 避免把 "please select an option" 这类英文句子也当成 SQL。 */
  if (!sawSql && probe.length && probe[0].type === 'punct' && probe[0].value === '(') {
    for (var bj = 0; bj < probe.length; bj++) {
      if (probe[bj].type === 'word' && (probe[bj].upper === 'SELECT' || probe[bj].upper === 'WITH')) { sawSql = true; break; }
      if (probe[bj].type === 'punct' && probe[bj].value === ';') break;
    }
  }
  /* 片段模式（opts.fragment）：放宽"语句关键字开头"的要求，否则
   * WHERE / ON / 逗号 开头的片段永远格式化不了。
   *
   * H-2：旧判据是"出现**任意**一个 KEYWORDS 词、或任意一个 `( ) , = .` 就放行"，
   * 门槛形同虚设 —— Python、日志、英文句子全都能通过，被当成 SQL 重排：
   *     def f(x, y): if x in (1, 2) and y == 3: return x, y else: return None
   *       → def f(x, y) : IF x IN (1, 2) AND y == 3 : return x, y ELSE : return None
   *                                （`if` `in` `and` `else` 全被大写成 SQL 关键字）
   * 现在改成两级判据：
   *   1) **硬否决**：出现明显的非 SQL 语言关键字（def / import / return / print…）、
   *      日志等级词（INFO / ERROR…）、或行首日志时间戳 → 直接判 not-sql；
   *   2) **正向**：要么含一个"强子句关键字"（SELECT/FROM/WHERE/JOIN/GROUP BY/
   *      ORDER BY/HAVING/UNION/INSERT/UPDATE/DELETE/WITH/VALUES/LIMIT/OVER…），
   *      要么含 ≥2 个 SQL 关键字**且**至少一个比较/赋值运算符
   *      （这样 `and b = 1) or c = 2` 这种纯布尔片段仍然可用）。
   * 纯标点片段（只有 `,` `(` `)` 等）不再放行 —— 那种内容格式化后也不像 SQL。
   */
  if (!sawSql && fragment) {
    var STRONG_CLAUSE = {
      SELECT: 1, FROM: 1, WHERE: 1, JOIN: 1, HAVING: 1, UNION: 1, INTERSECT: 1,
      EXCEPT: 1, MINUS: 1, INSERT: 1, UPDATE: 1, DELETE: 1, MERGE: 1, WITH: 1,
      VALUES: 1, LIMIT: 1, OVER: 1, PARTITION: 1, LATERAL: 1, USING: 1,
      GROUP: 1, ORDER: 1, DISTRIBUTE: 1, CLUSTER: 1, SORT: 1, WINDOW: 1,
      AND: 1, OR: 1, NOT: 1, ON: 1, SET: 1, BY: 1
    };
    /* 别的语言 / 日志的特征词：只在**没有**强子句关键字时才用来否决，
     * 否则 `where error = 1`（error 是列名）会被误杀。 */
    var NON_SQL_WORDS = {
      DEF: 1, IMPORT: 1, RETURN: 1, PRINT: 1, ELIF: 1, LAMBDA: 1, YIELD: 1,
      RAISE: 1, FINALLY: 1, CLASS: 1, SELF: 1, DONE: 1, FI: 1, ESAC: 1,
      ENDIF: 1, FUNC: 1, NAMESPACE: 1, PUBLIC: 1, PRIVATE: 1, PROTECTED: 1,
      STATIC: 1, VOID: 1, INFO: 1, WARN: 1, WARNING: 1, ERROR: 1, DEBUG: 1,
      TRACE: 1, FATAL: 1
    };
    /* 英文虚词已在**入口**统一扫描并硬否决（见上方 proseHit），这里不再重复。 */
    var strongHit = false, kwCount = 0, opHit = false, softBad = false;
    for (var fj = 0; fj < probe.length; fj++) {
      var ft = probe[fj];
      if (ft.type === 'comment' || ft.type === 'template') continue;
      if (ft.type === 'punct') {
        if (ft.value === '=' || ft.value === '<' || ft.value === '>' || ft.value === '<=' ||
            ft.value === '>=' || ft.value === '<>' || ft.value === '!=' || ft.value === '::' ||
            ft.value === '+' || ft.value === '-' || ft.value === '*' || ft.value === '/') opHit = true;
        continue;
      }
      if (ft.type !== 'word') continue;
      if (NON_SQL_WORDS[ft.upper]) softBad = true;
      if (STRONG_CLAUSE[ft.upper]) strongHit = true;
      if (KEYWORDS[ft.upper] || STATEMENT_WORDS[ft.upper] || STRONG_CLAUSE[ft.upper]) kwCount++;
    }
    /* 行首日志时间戳（`2026-01-01 10:00:00 INFO …`、`[2026-01-01] …`）也是硬否决 */
    var logHead = /^\s*(?:\[?\d{4}[-/]\d{2}[-/]\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\]?|\[\w+\]|<\w+>)\s/.test(body);
    /* 放行条件（都必须先通过 logHead / softBad 否决）：
     *   a) 含强子句关键字（SELECT/FROM/WHERE/JOIN/ON/AND/OR/GROUP/ORDER/SET…）
     *      —— 覆盖 `where a=1`、`on t.id=u.id`、`and b=1) or c=2`；
     *   b) 含至少一个比较/赋值/算术运算符 —— 覆盖 `col_a = 1`、`a + b > 2`
     *      这类纯表达式片段（用户选中的就是一段条件）；
     *   c) 没有运算符时，至少 2 个 SQL 关键字（`group by dt`、`order by a`）。
     * 纯标点 / 纯标识符列表（`a,b,c,d`、`, col_a`）不满足任何一条，保持不动。 */
    /* P1-2：片段里只要出现 AND / OR / ON 这类**布尔连接词**，
     * 就说明这是 WHERE / ON 的一部分，不该被 softBad 否决。
     * `and done = 1 and a.error = 0` 现在能正常格式化。 */
    if (!logHead && (strongHit || !softBad) &&
        (strongHit || opHit || kwCount >= 2)) sawSql = true;
  }
  /* P3-6.1（2026-11-02 审计）：MyBatis 的 XML 动态 SQL 片段
   * （`<if test="b != null"> and b = #{b} </if>`）不是 SQL —— 它是一段
   * XML，`<if>` / `</if>` 必须原样保留。旧实现在 fragment 模式下把它当
   * SQL 重排成 `< IF test = "b != null" > AND b = #{b} < /IF >`，
   * 整个 mapper 文件直接失效。
   *
   * 判据：文本里出现 XML/HTML 形态的标签（`<名称 ...>` / `</名称>` / `<名称/>`），
   * 且标签名是 MyBatis / JSTL / 一般 XML 的常见词。只看**尖括号 + 标签名**，
   * 不会误伤 SQL 的比较运算（`a < b` 里 `<` 后面是空格或标识符但没有 `>`）。
   * 注意：SQL 的 `<` 比较不会命中 —— 它要求 `>` 收尾且标签名后面跟空白或 `/`。 */
  var XML_TAG_RE = /<\/?\s*(?:if|choose|when|otherwise|where|set|trim|foreach|bind|select|insert|update|delete|sql|include|resultMap|mapper|parameterMap|dynamic|isNotNull|isNull|isNotEmpty|isEmpty|isEqual|isNotEqual|else|then|otherwise)\b[^<>]*\/?>/i;
  if (XML_TAG_RE.test(body)) {
    setDiag('not-sql', '文本里含 XML 标签（MyBatis 动态 SQL），不是纯 SQL，已原样保留');
    return _rawPut();
  }

  /* P3-6.2（2026-11-02 审计）：全角标点。
   * 从中文文档里粘出来的 SQL 常带 `，` `；` `（` `）`，它们不是 SQL 标点，
   * 格式化器会原样保留并照样排版（`SELECT a ， b` / `FROM t ；`），
   * 用户以为成功了，粘贴执行却报语法错误。
   * 这里原样返回并说明原因 —— 不擅自把全角换成半角（那是在改用户内容）。
   *
   * F-01（2026-11-04 复核）：**只看代码区**。旧实现对整段文本做正则，
   * 于是注释里的中文逗号、字符串字面量里的全角括号（它们是用户数据）也会
   * 让整篇被拒 —— 实测 14 份真实脚本里 8 份被拦，其中 7 份的全角标点
   * 只出现在注释/字符串里（mysqldump 导出的 ipurchase.sql 有 509 处全在注释里）。
   * 中文团队写的 SQL 只要注释里有一个中文逗号就再也格式化不了。 */
  if (FULLWIDTH_PUNCT_RE.test(body)) {
    if (hasCodeAreaFullwidth(body, lex)) {
      setDiag('not-sql', '代码区含全角标点（，；（）等），它们不是 SQL 标点，请先换成半角再格式化');
      return _rawPut();
    }
  }

  if (!sawSql) {
    setDiag('not-sql', '文本里没有可识别的 SQL 结构（可能是 JSON / 日志 / 英文句子）');
    return _rawPut();
  }

  try {
    var out = f.format(body);

    /* 只有空白/无法识别的内容时保持原样，避免把用户选区清空。
     * 注意：这里只回退"内容"，BOM / EOL 仍要还原，否则会静默改变文件编码。 */
    if (out === '') {
      setDiag('empty', '格式化的输出为空，已回退原文（避免清空选区）');
      return _rawPut();
    }

    /* 最后一道防线：字符级不变量。不等价就退回原文。 */
    if (out !== body && !sameTokenStream(body, out, lex)) {
      /* P1-3：整篇不通过时先试按语句隔离 —— 让**没出问题的那几条**照常排版，
       * 只把出问题的那一条按原文保留。这不放宽安全约束：每条语句单独过比对，
       * 拼起来的整篇还要再整体过一遍。 */
      var iso = formatByStatement(body, lex, mkFmt);
      if (iso && iso !== body && sameTokenStream(body, iso, lex)) {
        setDiag('partial', '部分语句未通过安全网，已保留这些语句原文；其余语句已格式化', true);
        var isoTail = '';
        for (var itn = 0; itn < tailNl; itn++) isoTail += '\n';
        return _cPut(bom + applyEolText(iso + isoTail, eol));
      }
      setDiag('reverted', '格式化结果未通过安全网（token 不等价），已回退原文');
      return _rawPut();
    }

    /* 还原原文末尾的换行数（P2-4）。只补不删：f.format() 已经去掉了尾部空行。 */
    var tail = '';
    for (var tn = 0; tn < tailNl; tn++) tail += '\n';
    if (tail) out += tail;

    var finalText = bom + applyEolText(out, eol);
    setDiag(finalText === bom + body ? 'unchanged' : 'formatted', '');
    return _cPut(finalText);
  } catch (e) {
    /* 任何异常都不应该破坏用户代码。
     * 但要留下原因：旧实现连异常都吞掉，用户只能看到"没反应"（C-03）。 */
    setDiag('error', '格式化内核抛异常：' + (e && e.message ? e.message : String(e)));
    return _rawPut();
  }
};

/* ---------------------------- DDL 脚本分句与排版 ---------------------------- */

/* 按**顶层**分号把 DDL 脚本切成语句组。
 * 分号出现在括号内（`decimal(18,2)` 之后不会）、字符串里、注释里都不算分隔符 ——
 * 靠词法器已经把它们切成独立 token，这里只数括号深度即可。
 *
 * 注释**原地保留**，不抽出来另放：它既可能是语句的前导说明（`-- 建表`），
 * 也可能是语句中间的行尾注释（`a string, -- keep`）。旧写法把注释攒到
 * pendingComments 里、等下一个语句 token 才拼回去，于是中间的注释被搬到
 * 语句末尾，`b int)` 整段丢失（实测 `create table t (a string, -- keep\n b int)`
 * 输出变成 `create table t (a string, -- keep`，后半截没了）。 */
function splitDdlStatements(toks) {
  var groups = [], cur = [], depth = 0;
  /* F4（2026-10-29 复核）：存储过程 / 函数 / 触发器体里的分号是**语句内**
   * 分隔符，不是语句终止符。旧实现只跟括号深度，于是
   *     create procedure p() begin declare x int; set x = 1; select x; end
   * 被切成四段，输出里凭空多出三个空行、大小写也各段独立处理。
   * 现在跟一层 BEGIN…END 深度：只有 beginDepth === 0 时的 `;` 才切语句。
   * 判据刻意保守 —— 只在语句**以 CREATE** 开头时才启用 BEGIN 计数，
   * 避免把普通查询里 `begin` 当列名的情况算进去（那种词在 sql() 路径处理）。
   * 嵌套 BEGIN（`begin … begin … end; end`）靠深度递增自然支持。 */
  var beginDepth = 0;
  var stmtIsRoutine = false;
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i];

    /* 见到 depth===0 的 CREATE 就**向前看**：只要没先遇到 depth===0 的 `;`，
     * 中途出现 PROCEDURE / FUNCTION / TRIGGER / PACKAGE / EVENT 就是例程体。
     * 用向前看而不是"只看语句首词"，是因为 mysql 脚本常以 DELIMITER 行开头，
     * 且多行拼接后首词未必是 CREATE。 */
    if (!stmtIsRoutine && beginDepth === 0 && t.type === "word" && t.upper === "CREATE") {
      var lookDepth = 0;
      for (var lk = i + 1; lk < toks.length; lk++) {
        var lt = toks[lk];
        if (lt.type === "comment") continue;
        if (lt.type === "punct") {
          if (lt.value === "(") lookDepth++;
          else if (lt.value === ")") lookDepth = Math.max(0, lookDepth - 1);
          else if (lt.value === ";" && lookDepth === 0) break;
          continue;
        }
        if (lookDepth !== 0 || lt.type !== "word") continue;
        if (/^(PROCEDURE|FUNCTION|TRIGGER|PACKAGE|EVENT)$/.test(String(lt.upper))) {
          stmtIsRoutine = true;
          break;
        }
        /* 走到表名/视图名那一层还没见到例程词 → 不是例程语句 */
        if (/^(TABLE|VIEW|INDEX|SCHEMA|DATABASE|SEQUENCE|EXTERNAL|MATERIALIZED)$/.test(String(lt.upper))) break;
        if (/^(OR|REPLACE|UNIQUE|FULLTEXT|SPATIAL|TEMPORARY|TEMP)$/.test(String(lt.upper))) continue;
      }
    }

    /* F5（2026-10-29 复核）：`;` 后面**同一行**的注释属于刚结束的那条语句。
     * 以前它无条件落进 cur，于是 $"drop a; -- drop a\ndrop b;"$ 里
     * `-- drop a` 变成下一组的前导注释，输出成
     *     DROP TABLE a;
     *     <空行>
     *     -- drop a      ← 读起来像在描述 b
     *     DROP TABLE b;
     * 注释归属被悄悄改掉。sql() 路径的 splitStatements 早就有这条判据
     * （tokens[j].nl === 0 → 并入上一条），DDL 路径一直漏着。
     *
     * 只认"同行"（nl === 0），换行后的注释仍然算下一条的前导注释 —— 那是
     * 用户明确写在下一句上方的说明。 */
    if (t.type === "comment" && t.nl === 0 && groups.length &&
        (cur.length === 0 || (cur.length === 1 && cur[0].type === "punct" && cur[0].value === ";"))) {
      /* 分号已经被上一轮 push 进 groups 了，这里把注释补到那一组的末尾 */
      var lastGrp = groups[groups.length - 1];
      var lastTk = lastGrp[lastGrp.length - 1];
      if (lastTk && lastTk.type === "punct" && lastTk.value === ";") {
        lastGrp.push(t);
        continue;
      }
    }

    if (t.type === "comment") { cur.push(t); continue; }

    if (t.type === "punct" && t.value === "(") depth++;
    else if (t.type === "punct" && t.value === ")") depth = Math.max(0, depth - 1);

    /* F4：BEGIN / END 只在"过程/函数体"里计数。
     * END 后面可能跟 IF / LOOP / CASE / WHILE（`END IF`、`END LOOP`），
     * 那是同一个 END，不额外增减。 */
    if (stmtIsRoutine && t.type === "word" && depth === 0) {
      if (t.upper === "BEGIN") {
        beginDepth++;
      } else if (t.upper === "END" && beginDepth > 0) {
        /* F4：END IF / END LOOP / END CASE / END WHILE / END REPEAT 关闭的是
         * **控制结构**，不是 BEGIN 块。误递减会让 beginDepth 提前归零，
         * 后续分号又把过程体切开。 */
        var nxE = null;
        for (var e1 = i + 1; e1 < toks.length; e1++) {
          if (toks[e1].type === "comment") continue;
          nxE = toks[e1];
          break;
        }
        var closesCtrl = !!(nxE && nxE.type === "word" &&
          /^(IF|LOOP|CASE|WHILE|REPEAT)$/.test(String(nxE.upper)));
        if (!closesCtrl) beginDepth--;
      }
    }

    /* F-06（2026-11-04 复核）：**缺分号的多语句**不能粘成一条。
     * 旧实现只在顶层 `;` 处切组，于是
     *     drop table t
     *     create table u (b int);
     * 输出成 `DROP TABLE t CREATE TABLE u (…);` —— 两条语句被粘成非法 SQL，
     * 用户复制去执行直接报错。
     *
     * 判据刻意保守（四条同时成立才切）：
     *   · 括号深度 / BEGIN 深度都是 0，且不在例程体里；
     *   · 该词另起一行（nl > 0）且当前组里已有内容；
     *   · 它是**绝不可能**出现在语句中部的语句头词；
     *   · 上一行不是以需要续行的标点结尾（`,` `(` `.` `=` `+` `-` `*` `/` `<` `>` `&` `|`）。
     * `SET` 单独处理：`update t set …` / `alter table t set …` 里的 SET 不是新语句。 */
    if (depth === 0 && beginDepth === 0 && !stmtIsRoutine && cur.length > 0 &&
        t.type === "word" && t.nl > 0) {
      var STMT_HEAD_SPLIT = {
        CREATE: 1, DROP: 1, ALTER: 1, TRUNCATE: 1, RENAME: 1, MSCK: 1,
        INSERT: 1, DELETE: 1, UPDATE: 1, USE: 1, GRANT: 1, REVOKE: 1, ANALYZE: 1
      };
      var headW = String(t.upper);
      var firstW = "";
      for (var fi = 0; fi < cur.length; fi++) {
        if (cur[fi].type === "comment") continue;
        if (cur[fi].type === "word") firstW = String(cur[fi].upper);
        break;
      }
      var lastTk = cur[cur.length - 1];
      var contTail = !!(lastTk && lastTk.type === "punct" &&
        /^(,|\(|\.|=|\+|-|\*|\/|<|>|&|\|)$/.test(String(lastTk.value)));
      var doSplit = !!STMT_HEAD_SPLIT[headW];
      if (headW === "SET") {
        doSplit = !(firstW === "UPDATE" || firstW === "INSERT" || firstW === "ALTER" ||
                    firstW === "MERGE" || firstW === "CREATE");
      }
      if (doSplit && !contTail) {
        groups.push(cur);
        cur = [];
        stmtIsRoutine = false;
      }
    }

    cur.push(t);
    if (t.type === "punct" && t.value === ";" && depth === 0 && beginDepth === 0) {
      groups.push(cur);
      cur = [];
      stmtIsRoutine = false;
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/* 渲染一组 DDL 语句：返回行数组（不含空行）。
 *   - 前导注释各自成行，原样保留；
 *   - CREATE TABLE 走 ddl() 展开列定义；
 *   - CREATE … AS SELECT（CTAS）走 sql()，与原来一致；
 *   - 其余语句（DROP/ALTER/INSERT/DELETE/TRUNCATE/MERGE…）**保持原文**，
 *     只把它顶格、并把末尾分号并回语句最后一行。
 *     这样「强制换行、顶格、前面空一行」成立，同时不改写用户词句。 */
var DDL_LIKE_NON_CREATE = {
  DROP: 1, ALTER: 1, TRUNCATE: 1, RENAME: 1, COMMENT: 1, ANALYZE: 1,
  MSCK: 1, REPAIR: 1, USE: 1, SET: 1, GRANT: 1, REVOKE: 1
};

function renderDdlGroup(groupToks, rawSrc, self, uppercase, lex) {
  /* F3（2026-10-29 复核）：lex 由 sqlddl 透传，里面带着 maxWidth / hardWidth /
   * commaLocation / cjkWidth。以前这里只读 tabWidth / bracketChar，于是：
   *   · CREATE TABLE 的 maxWidth / commaLocation 被丢掉（只有缩进生效）；
   *   · 其余语句里嵌套的 self.sql() 用硬编码的 150/150，四个配置全失效。 */
  var gMax = (lex && typeof lex.maxWidth === 'number' && lex.maxWidth > 0) ? lex.maxWidth : 150;
  var gHard = (lex && typeof lex.hardWidth === 'number' && lex.hardWidth > 0) ? lex.hardWidth : undefined;
  var gComma = !!(lex && lex.commaLocation === true);
  var gTab = (lex && typeof lex.tabWidth === 'number' && lex.tabWidth > 0) ? lex.tabWidth : 4;
  var gBracket = !!(lex && lex.bracketChar === true);
  var gCjk = lex && typeof lex.cjkWidth === 'number' && lex.cjkWidth > 0 ? lex.cjkWidth : undefined;
  /* 统一的嵌套 sql() 调用：所有配置都带上，不再写死 150。 */
  function nestedSql(txt) {
    /* P2-3（2026-11-05 复核）：`bracket_char` 必须放在**第 4 个位置参数**上。
     * `sql()` 只读位置参数，不读 extra.bracketChar（extra 里没有这个字段的
     * 读取点）。旧实现把 false 写死在第 4 位，于是 `bracketChar=true` 时
     * CTAS / CREATE VIEW 里嵌套的查询仍然是制表符缩进，与 Beautify SQL
     * 的结果不一致 —— 用户设了 bracket_char 却只在部分路径生效。 */
    return self.sql(txt, uppercase, gComma, gBracket, gMax, gMax, {
      dialect: lex && lex.dialect,
      hardWidth: gHard,
      tabWidth: gTab,
      cjkWidth: gCjk,
      /* CTAS / 单条 DDL 都是"半条语句"（没有开头 SELECT 也正常），
       * 放宽非 SQL 门槛，否则 create table … as select 会被判 not-sql 而整体放弃。 */
      fragment: true
    });
  }
  var lead = [], i = 0;
  while (i < groupToks.length && groupToks[i].type === "comment") {
    lead.push(rawSrc.slice(groupToks[i].start, groupToks[i].end).replace(/\s+$/, ""));
    i++;
  }

  var body = groupToks.slice(i);

  /* F4：本组的**原始文本切片**（含分号、含原始空白）。DELIMITER 指令与
   * 自定义分隔符语句必须整段照抄原文 —— 它们由 mysql 客户端逐字解释，
   * 任何重排（哪怕只是补一个空格）都会改变语义。 */
  var rawGroupText = body.length
    ? rawSrc.slice(body[0].start, body[body.length - 1].end)
    : '';

  /* F5（2026-10-29 复核）：把分号之后**同一行**的注释摘出来，稍后贴在分号行尾。
   * splitDdlStatements 已把它们补进本组末尾，这里负责渲染 ——
   * 否则它们会变成"最后一条语句之后的独立注释行"，看起来像在描述下一条语句。 */
  var trailingSameLine = [];
  while (body.length && body[body.length - 1].type === "comment" &&
         body[body.length - 1].nl === 0) {
    trailingSameLine.unshift(body.pop());
  }

  var semi = false;
  if (body.length && body[body.length - 1].type === "punct" && body[body.length - 1].value === ";") {
    semi = true;
    body = body.slice(0, body.length - 1);
  }
  /* 摘出来的注释只有在确实跟着一个分号时才贴回去；否则退回语句内。
   * （没有分号的 'select a -- x'，注释本来就属于语句本身，不走这个分支。） */
  if (!semi && trailingSameLine.length) {
    for (var tr0 = 0; tr0 < trailingSameLine.length; tr0++) body.push(trailingSameLine[tr0]);
    trailingSameLine = [];
  }

  var lines = [];
  for (var q = 0; q < lead.length; q++) lines.push(lead[q]);

  if (!body.length) return lines;

  var bodyText = rawSrc.slice(body[0].start, body[body.length - 1].end);

  /* 语句的第一个词决定走哪条路径 */
  var firstWord = "";
  for (var k = 0; k < body.length; k++) {
    if (body[k].type === "word") { firstWord = body[k].upper; break; }
    if (body[k].type !== "comment") break;
  }

  /* F4：`DELIMITER` 是 mysql **客户端**指令，不是 SQL 语句。
   * `delimiter ;` 里的空格是语法的一部分（把语句分隔符设回分号）；
   * 交给 joinTokens 会被并成 `delimiter;` —— 意思变了。整段原样保留。
   *
   * 同理，凡是**含自定义分隔符**（如 `end //`）的语句也必须原样保留：
   * 词法器会把 `//` 拆成两个 `/` 运算符，渲染成 `end / /`，
   * 与原文 token 不等价 → 安全网判 reverted → 整篇回退。这类脚本本来
   * 就是"交给 mysql 客户端逐字执行"的，重排没有收益、只有风险。 */
  var delimRe = /^\s*DELIMITER\b/i;
  if (delimRe.test(rawGroupText)) {
    /* 整段照抄原文（仅去掉行首缩进）。`delimiter ;` 里的空格是语法的一部分，
     * 拼 bodyText + ';' 会把它变成 `delimiter;` —— 意思变了。 */
    var dlines = rawGroupText.replace(/^\s+/, '').replace(/\s+$/, '').split(/\r?\n/);
    for (var di = 0; di < dlines.length; di++) lines.push(dlines[di]);
    return lines;
  }
  /* 含自定义分隔符的语句：`//` / `$$` / `;;` 紧跟在语句末尾 */
  if (/\/\/\s*$/.test(rawGroupText) || /\$\$\s*$/.test(rawGroupText)) {
    /* 自定义分隔符的例程语句：词法器把 `//` 拆成两个 `/`，重排必然与原文
     * token 不等价（安全网会判 reverted）。这类脚本本就该逐字执行，整段照抄。 */
    var rl = rawGroupText.replace(/^\s+/, '').replace(/\s+$/, '').split(/\r?\n/);
    for (var ri2 = 0; ri2 < rl.length; ri2++) lines.push(rl[ri2]);
    return lines;
  }

  var rendered = bodyText;
  /* M5（第三轮审计）：`self.sql()` 会按**子语句**重新 detectLex，
   * 并把 CJK_WIDTH_RATIO 重置成默认值。sqlddl 是"整份脚本一次构造 Formatter"
   * （设好 cjk 比值和词法），中途嵌套调用 sql() 会把这些全局态污染掉 ——
   * 于是**同一条 CREATE TABLE 的结果取决于它前面有没有 DROP/ALTER**：
   *     cjk_width=2 时单独格式化对齐 8 空格，前面加一句 drop 就变 7 空格。
   * 修法：每次嵌套调用前后做快照/还原。彻底的重构（把全局态收进 Formatter
   * 实例）风险太大，这里先保证"嵌套调用不改变外部状态"。 */
  var snapBefore = snapGlobals();
  if (firstWord === "CREATE") {
    /* M4（第三轮审计）：要区分 **CREATE TABLE**（列定义列表，走 ddl()）与
     * 其余 CREATE 子类（INDEX / DATABASE / SCHEMA / SEQUENCE / FUNCTION / VIEW…），
     * 后者交给 SQL 路径统一大小写。
     *
     * 关键点：不能靠 `ddl(bodyText) !== bodyText` 来判断 —— 已经是理想排版的
     * CREATE TABLE 会让 ddl() 原样返回，若此时再落到 sql() 就会被**重新**排成
     * tab + 行首逗号的风格，二轮格式化抖动（破坏幂等）。
     * 所以先看语句头里有没有 TABLE 这个词。 */
    var headStop = bodyText.search(/[;(]/);
    var headText = headStop < 0 ? bodyText : bodyText.slice(0, headStop);
    var isCreateTable = /(^|\s)TABLE(\s|$)/i.test(headText);
    if (isCreateTable) {
      var viaDdl = ddl(bodyText, {
        tabWidth: gTab,
        bracketChar: gBracket,
        columnIndentKnown: !!(lex && typeof lex.tabWidth === 'number'),
        /* F3-2：以前漏了这两个 —— CREATE TABLE 的折行宽度和逗号位置不跟配置走。 */
        maxWidth: gMax,
        hardWidth: gHard,
        commaLocation: gComma
      });
      if (viaDdl !== bodyText) {
        rendered = viaDdl;
      } else {
        /* F3-1：ddl() 原样返回有两种原因 ——
         *   a) 它已经把这段排成理想形态（幂等，再走 sql() 反而会抖动）；
         *   b) 它根本处理不了（CTAS 的 `sawAs` 早退、找不到列定义括号等）。
         * 只有 (b) 才该落到 SQL 路径。区分方法：看语句头里有没有顶层
         * `AS SELECT` / `AS WITH` —— 那就是 CTAS，(b) 成立。
         * 注意不能只靠 token 等价判断，因为 (a) 也满足等价。
         *
         * P2-1（2026-11-05 复核）：带括号的 CTAS（`AS (SELECT …)`）同样是 (b)，
         * ddl() 现在会因为它是 CTAS 而早退 —— 这里必须一并识别，
         * 否则 `create table t as (select a, b from s)` 会原样返回、完全不排版。 */
        var ctasRe = /(^|[\s(])AS\s*\(*\s*(SELECT|WITH|VALUES|TABLE)\b/i;
        var headStopC = bodyText.search(/[;(]/);
        var headOnly = headStopC < 0 ? bodyText : bodyText.slice(0, headStopC);
        if (ctasRe.test(bodyText) || /(^|[\s(])LIKE\s+[\w."`\[]/i.test(headOnly)) {
          restoreGlobals(snapBefore);
          var ctasOut = nestedSql(bodyText);
          restoreGlobals(snapBefore);
          if (typeof ctasOut === "string" && ctasOut) rendered = ctasOut;
        }
        /* (a) 情况保持原文，不抖动。 */
      }
    } else {
      restoreGlobals(snapBefore);
      var sqlOut = nestedSql(bodyText);
      restoreGlobals(snapBefore);
      if (typeof sqlOut === "string" && sqlOut) rendered = sqlOut;
    }
  } else if (DDL_LIKE_NON_CREATE[firstWord]) {
    /* L-6：非 CREATE 的 DDL 语句（DROP / ALTER / TRUNCATE / RENAME / COMMENT）
     * 也必须走一遍 SQL 路径，把它们的关键字按 uppercase 配置统一大小写。
     * 旧实现「保持原文」，于是同一份脚本里
     *     CREATE TABLE t …     ← 全大写
     *     drop table u;        ← 全小写
     *     alter table t add columns (c int);
     * 大小写混杂，看起来像两种工具排出来的。
     * 走 sql() 是安全的：它有同一套 token 等价安全网，改坏会自动回退原文。
     * 仍然保留"原文优先"：只有当 sql() 的结果确实通过了安全网（即返回值
     * 与输入不同且非空）时才采用。 */
    restoreGlobals(snapBefore);
    var sqlOut2 = nestedSql(bodyText);
    restoreGlobals(snapBefore);
    if (typeof sqlOut2 === "string" && sqlOut2) rendered = sqlOut2;
  }

  rendered = String(rendered).replace(/^\s+/, "").replace(/\s+$/, "");
  if (semi) {
    rendered += ";";
    /* F5：同行尾注释贴在分号后面（两个空格分隔，与 SQL 惯例一致）。
     * 注释内容原样保留，只去尾部空白。 */
    for (var tr1 = 0; tr1 < trailingSameLine.length; tr1++) {
      var cmText = rawSrc.slice(trailingSameLine[tr1].start, trailingSameLine[tr1].end)
        .replace(/\s+$/, "");
      if (cmText) rendered += "  " + cmText;
    }
  }
  if (rendered) lines.push(rendered);
  return lines;
}

/* 把若干语句组的渲染结果拼成脚本：组间恰好 1 个空行，首组前不加空行。 */
function joinDdlGroups(renderedGroups) {
  var out = [];
  for (var i = 0; i < renderedGroups.length; i++) {
    var g = renderedGroups[i];
    if (!g || !g.length) continue;
    if (out.length) out.push("");
    for (var k = 0; k < g.length; k++) out.push(g[k]);
  }
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

SQLBeautifyKernel.prototype.sqlddl = function (text, uppercase, extra) {
  if (typeof text !== 'string' || text === '') return text;

  /* ---- P0 结果缓存（DDL 路径）----
   * 与 sql() 同一套设施、独立 key：参数集不同（DDL 只有 uppercase + extra）。 */
  var _dOn = text.length <= CACHE_MAX_TEXT;
  var _dKey = null, _dFull = null, _dHit;
  if (_dOn) {
    var _dex = extra || {};
    _dFull = cacheHash(text) + ':' + text.length + '\u0000' +
      (uppercase === false ? '0' : '1') + '\u0001' +
      (_dex.dialect === undefined ? '' : String(_dex.dialect)) + '\u0001' +
      (typeof _dex.cjkWidth === 'number' ? String(_dex.cjkWidth) : '') + '\u0001' +
      (typeof _dex.tabWidth === 'number' ? String(_dex.tabWidth) : '') + '\u0001' +
      /* M4：DDL 路径也要响应 max_line_length / comma_location / bracket_char，
       * 这几个参数必须进缓存键，否则改配置后命中旧结果。 */
      (typeof _dex.maxWidth === 'number' ? String(_dex.maxWidth) : '') + '\u0001' +
      (typeof _dex.hardWidth === 'number' ? String(_dex.hardWidth) : '') + '\u0001' +
      (_dex.commaLocation === true ? '1' : '0') + '\u0001' +
      (_dex.bracketChar === true ? '1' : '0') + '\u0001' +
      /* P1-7 / P0-2（2026-11-06 复核）：eolHint 决定输出换行，必须进缓存键。 */
      (_dex.eolHint === undefined ? '' : String(_dex.eolHint)) + '\u0001' +
      String(CJK_WIDTH_RATIO) + '\u0001' +
      (LEX.backslash ? '1' : '0') + '\u0001' +
      (LEX.hashComment ? '1' : '0') + '\u0001' +
      String(LEX.hashMode) + '\u0001' +
      (LEX.dashSpace ? '1' : '0') + '\u0001' +
      String(JOIN_CASE) + '\u0001' +
      String(TAB_WIDTH);
    _dKey = _dFull.slice(0, _dFull.indexOf('\u0000'));
    _dHit = cacheGet('d:' + _dKey, _dFull);
    if (_dHit !== undefined) {
      restoreGlobals(_dHit.g);
      /* F6：与 sql() 的命中分支一致，命中时也要放回诊断。
       * 旧实现这里什么都不写，lastDiagnostics() 停留在**上一次无关调用**的结果上。 */
      if (_dHit.d) setDiag(_dHit.d.status, _dHit.d.reason);
      return _dHit.v;
    }
  }

  function _dPut(v) {
    if (_dOn) {
      /* sqlddl 与 sql 共用 SQL_CACHE 会让 key 空间混用，这里用同一张表但
       * 前缀区分，避免与 sql() 的条目互相淘汰 */
      cachePut('d:' + _dKey, _dFull, v, LAST_DIAG);
    }
    return v;
  }

  /* BOM（P2-7）：旧版把 \uFEFF 当一个 punct token，输出成 `\uFEFF CREATE TABLE`。
   * 与 sql() 一样先剥再还原。 */
  var bom = '';
  if (text.charCodeAt(0) === 0xFEFF) { bom = '\uFEFF'; text = text.slice(1); }

    /* 与 sql() 一样保留原始 EOL（P2-4 / R3-15）：
     * 旧版 sqlddl 只按 \n 拼接输出，CRLF 文件里格式化一段 DDL 会把整段改成 LF，
     * git diff 里看不出改动却整段标红。
     * P1-7（2026-11-06 复核）：这里原本用裸正则 `/\r\n/.test(text)`，会被
     * **字符串内部的 CRLF** 带偏 —— LF 文档里只要有一个 `'a<CR><LF>b'`
     * 字面量，整份 DDL 输出就变成 CRLF。改用与 sql() 相同的
     * detectDocEol（只看代码区），并接受扩展层传入的 eolHint。 */
    var _ddlLexForEol = detectLex(text, extra && extra.dialect);
    var eolIn = detectDocEol(text, _ddlLexForEol, extra && extra.eolHint);
    /* F9b：DDL 路径同样要保护字面量内部换行（CTAS 里的 `'x<CR><LF>y'`、
     * 默认值字面量等）。 */
    var _maskedDdl = maskLiteralEols(text, _ddlLexForEol);
    var bodyDdl = _maskedDdl.text.replace(/\r\n?/g, '\n');

    /* C-02：记住原文末尾的换行数。`joinDdlGroups` 会把尾部空行全部 pop 掉，
     * 于是"格式化整个 DDL 脚本"会吃掉文件末尾的换行 → git 显示
     * `\ No newline at end of file`，且与 Prettier 等工具互相打架。
     * sql() 早就有这段（tailNl），DDL 路径一直漏着。 */
    var tailNlDdl = 0;
    while (tailNlDdl < bodyDdl.length && bodyDdl.charAt(bodyDdl.length - 1 - tailNlDdl) === '\n') tailNlDdl++;

  /* P1-12（2026-11-02 审计）：先判断"这是不是 DDL"，再判断"括号是否平衡"。
   * 都不通过就原样返回并写明确的诊断，而不是统一报 unchanged。 */
  var _dPreLex = detectLex(bodyDdl, extra && extra.dialect);
  var _dPreToks = [];
  try { _dPreToks = tokenizeRaw(bodyDdl, _dPreLex); } catch (e) { _dPreToks = []; }

  /* 1) 顶层括号不平衡 */
  var _dBal = 0, _dBalBad = false;
  for (var _db = 0; _db < _dPreToks.length; _db++) {
    if (_dPreToks[_db].type !== 'punct') continue;
    if (_dPreToks[_db].value === '(') _dBal++;
    else if (_dPreToks[_db].value === ')') { _dBal--; if (_dBal < 0) { _dBalBad = true; break; } }
  }
  if (_dBalBad || _dBal !== 0) {
    setDiag('unbalanced', '括号不配对：这不是一条完整的 DDL 语句，已保留原文');
    return _dPut(bom + text);
  }

  /* 2) 整篇找不到任何 DDL / DML 语句头。
   * 注意：CREATE INDEX / CREATE VIEW / CTAS 都算 DDL；
   * INSERT / DELETE / DROP / ALTER / TRUNCATE / RENAME / COMMENT ON / MSCK 也算
   * （项目的历史行为：这些语句在 Beautify DDL 里只统一大小写、不改结构）。 */
  var DDL_HEADS = {
    CREATE: 1, DROP: 1, ALTER: 1, TRUNCATE: 1, RENAME: 1, MSCK: 1,
    INSERT: 1, DELETE: 1, UPDATE: 1, MERGE: 1, REPLACE: 1,
    COMMENT: 1, USE: 1, SET: 1, REFRESH: 1, ANALYZE: 1, OPTIMIZE: 1
  };
  var _dSawHead = false, _dAtStart = true, _dDepth2 = 0;
  for (var _dh = 0; _dh < _dPreToks.length; _dh++) {
    var _dt = _dPreToks[_dh];
    if (_dt.type === 'comment' || _dt.type === 'template') continue;
    if (_dt.type === 'punct' && _dt.value === '(') { _dDepth2++; _dAtStart = false; continue; }
    if (_dt.type === 'punct' && _dt.value === ')') { _dDepth2 = Math.max(0, _dDepth2 - 1); continue; }
    if (_dt.type === 'punct' && _dt.value === ';') { _dAtStart = true; continue; }
    if (_dAtStart && _dDepth2 === 0 && _dt.type === 'word' && DDL_HEADS[_dt.upper]) {
      _dSawHead = true;
      break;
    }
    _dAtStart = false;
  }
  if (!_dSawHead) {
    setDiag('not-ddl', '这不是 DDL 语句（没有 CREATE / DROP / ALTER / INSERT 等语句头），已保留原文');
    return _dPut(bom + text);
  }

  try {
    /* ddl() 内部 tokenize 读全局 LEX；先按本文本做方言检测并构造 Formatter 刷新 LEX，
     * 否则残留的是"上一次调用"的方言开关（M-6：结果取决于调用顺序）。 */
    var lex = detectLex(bodyDdl, extra && extra.dialect);
    /* M4 / 配置覆盖不全（第三轮审计）：DDL 路径以前写死 2 空格缩进 + 150 列宽，
     * 忽略 bracket_char / tabSize / max_line_length / comma_location。
     * 现在跟随调用方传来的参数；没传时保持原来的 150 宽 / 2 空格行为。 */
    var ddlMax = (extra && typeof extra.maxWidth === 'number' && extra.maxWidth > 0) ? extra.maxWidth : 150;
    var ddlHard = (extra && typeof extra.hardWidth === 'number' && extra.hardWidth > 0) ? extra.hardWidth : undefined;
    /* eslint-disable no-unused-vars */
    var f = new Formatter({
      uppercase: uppercase !== false,
      commaLocation: !!(extra && extra.commaLocation === true),
      bracketChar: !!(extra && extra.bracketChar === true),
      asLocCnt: ddlMax, maxWidth: ddlMax,
      hardWidth: ddlHard,
      tabWidth: (extra && typeof extra.tabWidth === 'number' && extra.tabWidth > 0) ? extra.tabWidth : 4,
      backslash: lex.backslash, hashComment: lex.hashComment, hashMode: lex.hashMode,
        dashSpace: lex.dashSpace,
      dialect: lex.dialect,
      cjkWidth: (extra && typeof extra.cjkWidth === 'number' && extra.cjkWidth > 0)
        ? extra.cjkWidth
        : undefined
    });
    /* 多语句 DDL 脚本（P-新）：旧版只对**第一条** CREATE TABLE 展开列定义，
     * 后续语句原样拼在上一行尾（`);CREATE TABLE b (…`），且语句之间没有空行。
     * 现在按顶层分号切组，每组各自顶格另起一行，组间固定 1 个空行 ——
     * INSERT / DELETE / DROP / ALTER 语句前面的「强制换行 + 一行空行」由此满足。
     * 同时不再产生 `);\nDROP TABLE u\n;` 里孤立成行的分号。 */
    var ddlGroups = splitDdlStatements(tokenizeRaw(bodyDdl, lex));
    var renderedGroups = [];
    for (var dgi = 0; dgi < ddlGroups.length; dgi++) {
      /* F3（2026-10-29 复核）：以前这里只传 dialect / tabWidth / bracketChar，
       * 于是 renderDdlGroup 内部的嵌套 sql() 只能用硬编码的 150，
       * CREATE TABLE 也拿不到 maxWidth / commaLocation。现在整份透传。 */
      renderedGroups.push(renderDdlGroup(ddlGroups[dgi], bodyDdl, this, uppercase !== false,
        { dialect: extra && extra.dialect,
          tabWidth: extra && extra.tabWidth,
          bracketChar: extra && extra.bracketChar,
          maxWidth: ddlMax,
          hardWidth: ddlHard,
          commaLocation: !!(extra && extra.commaLocation === true),
          cjkWidth: (extra && typeof extra.cjkWidth === 'number' && extra.cjkWidth > 0)
            ? extra.cjkWidth : undefined }));
    }
    var out = joinDdlGroups(renderedGroups);

    if (uppercase === false) {
      /* 大写关闭时 DDL 也不该把关键字全大写（P2-12：旧版 sqlddl 忽略 uppercase） */
        /* 大小写已在 joinTokens 里按 token 处理，这里不再二次处理 */
    }

    /* 安全网：DDL 美化也必须与原文 token 等价，否则原样返回。
     * ddl() 内部对非 CREATE TABLE 已经返回原样，这里再兜一层防止边界场景改坏。 */
    if (out !== text && !sameTokenStream(bodyDdl, out, lex)) {
      setDiag('reverted', 'DDL 结果未通过安全网（token 不等价），已回退原文');
      return bom + text;
    }
      /* 还原原文末尾的换行数（只补不删，与 sql() 的 tailNl 一致） */
      for (var tnD = 0; tnD < tailNlDdl; tnD++) out += '\n';
      /* 输出统一按 LF 拼接，最后只还原代码区 EOL，保护字面量与注释内容。 */
      var finalDdl = bom + applyEolText(out, eolIn);
      setDiag(finalDdl === bom + text ? 'unchanged' : 'formatted', '');
      return _dPut(finalDdl);
  } catch (e) {
    setDiag('error', 'DDL 内核抛异常：' + (e && e.message ? e.message : String(e)));
    return _dPut(bom + text);
  }
};

/* 把 DDL 输出里的"纯关键字行/词"转成小写。只处理独立成词的 KEYWORDS，
 * 不动列名/表名/类型名（那些本来就被保留原样）。 */
  /* 旧版这里用正则把整个 DDL 输出里「像关键字的词」全小写，
   * 但正则分不清关键字与标识符，`DATA` / `TYPE` / `SIZE` 这类列名会被一起改掉，
   * 而安全网对大小写不敏感（significant 统一 toUpperCase），发现不了（H-5 / P1-4b）。
   * 现在大小写只在 token 级、按 tk.keyword 标记处理（见 joinTokens 的 JOIN_CASE），
   * 不再需要这个后处理。 */

SQLBeautifyKernel.prototype.extractddl = function (text, extra) {
  if (typeof text !== 'string' || text === '') return text;
  try {
    /* P2-5：把整个 extra 传下去（含 uppercase / tabWidth / bracketChar / 宽度）。 */
    var r = extractddl(text, extra);
    /* M-2 / M-7：提取路径也要写诊断。旧实现全程不碰 LAST_DIAG，
     * 于是扩展只能拿到上一次 sql() 留下的状态，提示会张冠李戴。
     * 异常时（下面 catch）同样写，并且说明"回退了原文"。 */
    if (r) setDiag('extracted', '', r !== text);
    else if (!lastExtractReason) setDiag('empty', '没有从 SELECT 列表里识别出任何列');
    else setDiag('empty', lastExtractReason);
    return r;
  } catch (e) {
    setDiag('error', 'DDL 提取内核抛异常：' + (e && e.message ? e.message : String(e)));
    lastExtractReason = 'DDL 提取内核抛异常：' + (e && e.message ? e.message : String(e));
    return text;
  }
};

/* 词法结果交给诊断引擎（src/lint.js）。
 *
 * 为什么不把 lint 直接写进内核：诊断是**只读**的，它不该改写格式化路径上的
 * 全局态（LEX / JOIN_CASE / CJK_WIDTH_RATIO）。所以这里只暴露一个薄入口：
 * 按 dialect 决定词法开关，返回 `{ tokens, lex, unterminated }`。
 *
 * 复用同一个词法器是必须的 —— `#` 是注释还是异或、反斜杠算不算转义、
 * `$$…$$` 到哪里结束，如果诊断另写一套切词，它给出的位置必然与排版结果
 * 对不上，用户看到的波浪线会落在错误的字符上。
 *
 * ⚠ 但 `markKeywords` 内部会读**全局** `LEX.dialect`（ClickHouse 的大小写
 * 敏感分支、PREWHERE、方言软关键字），而那个全局值由上一次次 `sql()` 调用
 * 决定。不处理的话，诊断结果就依赖于"上一次格式化用的是哪种方言"：
 * 先用 clickhouse 格式化、再用 mysql 诊断，`array(…)` 会被误判成标识符。
 *
 * 所以这里**临时**把全局 LEX.dialect 设成本次方言，跑完立刻还原。
 * 是本进程里唯一一处为了只读路径去改全局态的地方 —— 代价可接受，
 * 换来的是诊断结果与调用顺序无关。 */
SQLBeautifyKernel.prototype.tokenizeForLint = function (text, dialect) {
  if (typeof text !== 'string' || text === '') {
    return { tokens: [], lex: detectLex('', dialect), unterminated: false };
  }
  var lex = detectLex(text, dialect);
  var raw = tokenizeRaw(text, lex);
  /* `unterminated` 是挂在**数组本身**上的标记，而 markGenericTypes 返回一个
   * 新数组（它会重排 token），标记会丢。先取出来再传下去。
   * P1-6（2026-11-05 复核）：除了布尔量，还要把**类型与起点**带出来，
   * 否则诊断只能猜是哪一处没闭合（旧实现把闭合正常的字符串报成错误）。 */
  var unterminated = raw.unterminated === true;
  var unterminatedKind = raw.unterminatedKind || '';
  var unterminatedStart = typeof raw.unterminatedStart === 'number' ? raw.unterminatedStart : -1;
  var toks = markGenericTypes(raw);

  /* P1-3（2026-11-05 复核）：诊断必须与格式化用**同一套**路径标记。
   * 旧实现跳过了 markPathTokens，于是 `add jar /a/where/b.jar` 里的 where
   * 被当成 WHERE 子句，诊断报"子句顺序错误"/"重复子句"——
   * 而格式化结果完全正确，两边说法互相矛盾。
   * 路径标记只看空白分隔的紧贴 token 段，不会影响正常 SQL。 */
  toks = markPathTokens(toks);

  var prevDialect = LEX.dialect;
  try {
    LEX.dialect = lex.dialect;
    markKeywords(toks);
  } finally {
    LEX.dialect = prevDialect;
  }

  return {
    tokens: toks, lex: lex, unterminated: unterminated,
    unterminatedKind: unterminatedKind, unterminatedStart: unterminatedStart
  };
};

module.exports = new SQLBeautifyKernel();

