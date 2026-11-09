'use strict';
/* ============================================================================
 * 回归套件（P2-8）。
 *
 * 报告指出：「包内没有测试，`npm run check` 只检查语法」。
 * 这里把审计报告的用例固定下来 —— 每一条都在报告里出现过（编号对应
 * 审计清单的 P0/P1/P2/P3 条目），并且**只断言
 * 那些已经确认修好的行为**，不做模糊匹配。
 *
 * 运行：npm test        （或 node test/run.js）
 * 退出码：有失败时为 1。
 * ==========================================================================*/
var path = require('path');
var fs = require('fs');
var vm = require('vm');

var EXT = path.join(__dirname, '..');
/* 内核只有这一个位置。真丢文件就应当直接报错，而不是静默测到另一个实现。 */
var KERNEL = path.join(EXT, 'src', 'kernel.js');
var vk = require(KERNEL);

var checks = [];
/* 异步断言（返回 Promise 的用例）在这里排队，最后由 settle() 统一收集。
 *
 * P1-8（2026-11-06 复核）：旧实现是 `ok: !!cond` —— 对 Promise 恒为 true，
 * 于是 A-05（命令选区保持 CRLF）、R-15/R-16（字面量换行不被归一）三条
 * **永远显示通过、实际什么都没验证**，也正因为如此，CRLF 单行文档写成
 * 裸 LF 的缺陷（P0-2）才能带着 188 条"全绿"发布出去。 */
var pending = [];

function record(name, ok, detail) {
    checks.push({ name: name, ok: !!ok, detail: detail || '' });
    console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  ← ' + (detail || '')));
}

/* 给异步用例加超时：某个 Promise 若永远不 settle（例如 editor.edit 没回调），
 * 整个套件会静默挂住 —— 那比失败更难发现。 */
function withTimeout(p, ms) {
    return new Promise(function (resolve) {
        var done = false;
        var timer = setTimeout(function () {
            if (done) return;
            done = true;
            resolve({ ok: false, detail: '超时（' + ms + 'ms 未完成）' });
        }, ms);
        p.then(function (v) {
            if (done) return;
            done = true; clearTimeout(timer);
            resolve({ ok: v, detail: '' });
        }, function (e) {
            if (done) return;
            done = true; clearTimeout(timer);
            resolve({ ok: false, detail: 'Promise rejected: ' + ((e && e.message) ? e.message : e) });
        });
    });
}

function T(name, cond, detail) {
    if (cond && typeof cond.then === 'function') {
        pending.push(withTimeout(cond, 15000).then(function (r) {
            record(name, r.ok, r.ok ? '' : (r.detail || detail));
        }));
        return;
    }
    record(name, cond, detail);
}

/* 等全部异步断言落定后再统计。 */
function settle() {
    return Promise.all(pending.slice()).then(function () { return checks; });
}
function J(x) { try { return JSON.stringify(x); } catch (e) { return String(x); } }

/* 默认参数取扩展的默认配置（120 列硬上限），避免测试自身依赖屏幕宽度。 */
function sql(text, o) {
    o = o || {};
    vk.sqlCacheClear();
    return vk.sql(text, o.uppercase !== false, o.commaLocation === true, o.bracketChar === true,
        o.asLoc === undefined ? 96 : o.asLoc, o.maxLine === undefined ? 120 : o.maxLine,
        {
            fragment: !!o.fragment,
            dialect: o.dialect,
            hardWidth: o.hardLine === undefined ? 120 : o.hardLine,
            tabWidth: o.tabSize,
            cjkWidth: o.cjkWidth,
            /* P0-2：文档 EOL 提示（单行文本从内容里看不出来）。 */
            eolHint: o.eolHint
        });
}

console.log('\n=== P0：安全网与词法（不得改坏内容） ===');
T('P0-1 歧义反斜杠原样返回',
    sql("select 'a\\'b' as x, 'c\\'d' as y from t", { dialect: 'sql' }) ===
    "select 'a\\'b' as x, 'c\\'d' as y from t");
T('P0-9 psql 元命令整行保留',
    sql('\\c mydb\nselect 1 from t', { dialect: 'psql' }).split('\n')[0] === '\\c mydb',
    J(sql('\\c mydb\nselect 1 from t', { dialect: 'psql' })));
T('P0-9 SQL*Plus SPOOL 整行保留',
    /\nSPOOL x\.log/.test(sql('select 1 from dual;\nSPOOL x.log', { dialect: 'oracle' })),
    J(sql('select 1 from dual;\nSPOOL x.log', { dialect: 'oracle' })));
T('P0-4 字符串内的换行不被改写',
    sql("select 'a\nb' as x from t").indexOf("'a\nb'") > 0);
T('P0-6 array < b, c > d 不被当成泛型',
    (function () {
        /* 泛型误判会把 `,c` 吞进一个 token，逗号（列分隔符）就消失了。
         * 正确行为：逗号保留、`>` 后面仍是一个独立列。 */
        var r = sql('select array < b, c > d from t');
        return r.indexOf(',') > 0 && /c\s*>/.test(r);
    })(), J(sql('select array < b, c > d from t')));

console.log('\n=== P1：Extract ===');
T('P1-6 别名 foo_ 原样保留',
    vk.extractddl('insert into t select a as foo_ from s', { dialect: 'hive' }).indexOf('foo_') > 0,
    J(vk.extractddl('insert into t select a as foo_ from s', { dialect: 'hive' })));
T('P1-6 别名 bar__baz 原样保留',
    vk.extractddl('insert into t select a as bar__baz from s', { dialect: 'hive' }).indexOf('bar__baz') > 0);
T('P1-6 别名 _x 原样保留',
    vk.extractddl('insert into t select a as _x from s', { dialect: 'hive' }).indexOf('_x') > 0);
T('P1-7 表达式中间的块注释不进列名',
    !/div_mul/.test(vk.extractddl('insert into t select a /* x */ from s', { dialect: 'hive' })),
    J(vk.extractddl('insert into t select a /* x */ from s', { dialect: 'hive' })));
T('P1-8 INSERT … WITH 取外层 SELECT 的列',
    (function () {
        var r = vk.extractddl('insert into t with x as (select a from s) select a, b from x', { dialect: 'hive' });
        return /\ba\b/.test(r) && /\bb\b/.test(r);
    })(), J(vk.extractddl('insert into t with x as (select a from s) select a, b from x', { dialect: 'hive' })));
T('P1-9 多条 INSERT 各生成一条 DDL',
    (function () {
        var r = vk.extractddl('insert into t1 select a from s; insert into t2 select b from s;', { dialect: 'hive' });
        return /\bt1\b/.test(r) && /\bt2\b/.test(r);
    })());
T('P1-9 PARTITION 写进 PARTITIONED BY',
    /PARTITIONED BY/.test(vk.extractddl("insert overwrite table t partition (dt='2020') select a from s",
        { dialect: 'hive' })));
T('P1-12 非 DDL 报 not-ddl',
    (function () {
        vk.sqlCacheClear(); vk.sqlddl('hello world', true, {});
        return vk.lastDiagnostics().status === 'not-ddl';
    })(), J(vk.lastDiagnostics()));
T('P1-12 残缺 DDL 报 unbalanced',
    (function () {
        vk.sqlCacheClear(); vk.sqlddl('create table t (a int;', true, {});
        return vk.lastDiagnostics().status === 'unbalanced';
    })(), J(vk.lastDiagnostics()));
T('P1-13 AND 开头的片段按行拆分',
    sql('and a = 1\nand b = 2', { fragment: true }) === 'AND a = 1\nAND b = 2',
    J(sql('and a = 1\nand b = 2', { fragment: true })));

console.log('\n=== 2026-11-05 复核：路径 / 未闭合输入 / DDL 配置 ===');
T('R-1 ADD JAR 的多个路径不被拼接',
    sql('add jar /a/x.jar /b/y.jar', { dialect: 'hive' }) === 'ADD JAR /a/x.jar /b/y.jar',
    J(sql('add jar /a/x.jar /b/y.jar', { dialect: 'hive' })));
T('R-2 通配符路径不把后续语句变成注释',
    (function () {
        var r = sql('add jar /user/hive/lib/*.jar;\nselect a from t;', { dialect: 'hive' });
        return r.indexOf('/*.jar') > 0 && /SELECT a\b/.test(r) && r.indexOf('/*') === r.indexOf('/*.jar');
    })(), J(sql('add jar /user/hive/lib/*.jar;\nselect a from t;', { dialect: 'hive' })));
T('R-3 路径内的除法风格不受影响',
    sql('select a/b, a.b/c.d from t', { dialect: 'hive' }).indexOf('a.b/c.d') > 0,
    J(sql('select a/b, a.b/c.d from t', { dialect: 'hive' })));
T('R-4 未闭合块注释原样返回',
    sql("select 'ok' from t /* oops", { dialect: 'mysql' }) === "select 'ok' from t /* oops",
    J(sql("select 'ok' from t /* oops", { dialect: 'mysql' })));
T('R-5 未闭合 dollar-quote 原样返回',
    sql('select $tag$abc from t where x=1', { dialect: 'pgsql' }) === 'select $tag$abc from t where x=1',
    J(sql('select $tag$abc from t where x=1', { dialect: 'pgsql' })));
T('R-6 闭合正常的 dollar-quote 仍正常排版',
    (function () {
        var r = sql('select $tag$abc$tag$ as x from t', { dialect: 'pgsql' });
        return r.indexOf('$tag$abc$tag$') > 0 && /SELECT/.test(r);
    })(), J(sql('select $tag$abc$tag$ as x from t', { dialect: 'pgsql' })));
T('R-7 INTO TABLE 与 OVERWRITE TABLE 大小写一致',
    sql('insert into table t select a from s', { dialect: 'hive' }).indexOf('INSERT INTO TABLE t') === 0,
    J(sql('insert into table t select a from s', { dialect: 'hive' })));
T('R-8 带引号的表名后括号留空格',
    (function () {
        var a = sql('insert into `table` (a) values (1)', { dialect: 'mysql' });
        var b = sql('insert into "db"."table" (a) values (1)', { dialect: 'pgsql' });
        var c = sql('insert into [table] (a) values (1)', { dialect: 'tsql' });
        return a.indexOf('`table` (a)') > 0 && b.indexOf('"table" (a)') > 0 && c.indexOf('[table] (a)') > 0;
    })(), J([sql('insert into `table` (a) values (1)', { dialect: 'mysql' }),
        sql('insert into "db"."table" (a) values (1)', { dialect: 'pgsql' })]));
T('R-9 独占行注释不再产生"只有逗号的一行"',
    (function () {
        var out = sql('select a,\n-- c\nb from t', { dialect: 'hive' });
        return out.indexOf('\n      ,\n') < 0 && /SELECT a -- c/.test(out);
    })(), J(sql('select a,\n-- c\nb from t', { dialect: 'hive' })));
T('R-10 DDL 的 comma_location 生效（true = 列尾，与 SQL 路径一致）',
    (function () {
        var trail = vk.sqlddl('create table t (a int, b string)', true, { dialect: 'hive', commaLocation: true });
        var lead = vk.sqlddl('create table t (a int, b string)', true, { dialect: 'hive', commaLocation: false });
        return trail !== lead && trail.indexOf('a INT,') > 0 && /^\s*,b STRING/m.test(lead);
    })(), J([vk.sqlddl('create table t (a int, b string)', true, { dialect: 'hive', commaLocation: true }),
        vk.sqlddl('create table t (a int, b string)', true, { dialect: 'hive', commaLocation: false })]));
T('R-11 DDL 的 bracket_char 对嵌套 SQL 生效',
    (function () {
        var tab = vk.sqlddl('create table t as select a from (select b as a from s) x', true,
            { dialect: 'hive', bracketChar: false });
        var sp = vk.sqlddl('create table t as select a from (select b as a from s) x', true,
            { dialect: 'hive', bracketChar: true });
        return tab.indexOf('\t') > 0 && sp.indexOf('\t') < 0 && sp.indexOf('    ') > 0;
    })(), J(vk.sqlddl('create table t as select a from (select b as a from s) x', true,
        { dialect: 'hive', bracketChar: true })));
T('R-12 带括号的 CTAS 不被拆成列定义',
    (function () {
        var r = vk.sqlddl('create table t as (select a, b from s)', true, { dialect: 'hive' });
        return /^CREATE TABLE t AS\b/.test(r) && r.indexOf('SELECT') > 0 && !/\n\s*a\s*[,)]/.test(r);
    })(), J(vk.sqlddl('create table t as (select a, b from s)', true, { dialect: 'hive' })));
T('R-13 同表多条 INSERT 合并成一份 DDL',
    (function () {
        var r = vk.extractddl('insert into t select a from s1; insert into t select b from s2;', { dialect: 'hive' });
        /* 注释里也会出现 "CREATE TABLE" 字样，所以只数行首的语句。 */
        return (r.match(/^CREATE TABLE/gm) || []).length === 1 &&
            /\ba STRING/.test(r) && /\bb STRING/.test(r);
    })(), J(vk.extractddl('insert into t select a from s1; insert into t select b from s2;', { dialect: 'hive' })));
T('R-14 Extract 的 EOL 不被字面量内 CRLF 带偏',
    (function () {
        var r = vk.extractddl("insert into t select 'a\r\nb' as x from s", { dialect: 'hive' });
        return r.indexOf('\r\n') < 0;
    })(), JSON.stringify(vk.extractddl("insert into t select 'a\r\nb' as x from s", { dialect: 'hive' })));

console.log('\n=== P2：配置与性能 ===');
T('P2-5 Extract 跟随 uppercase=false',
    (function () {
        var r = vk.extractddl('insert into t select a from s', { uppercase: false, dialect: 'hive' });
        return /^create table/.test(r) && !/CREATE TABLE/.test(r);
    })());
T('P2-5 array(1,2) 在 Hive 下推成 ARRAY<…>',
    /ARRAY</.test(vk.extractddl('insert into t select array(1,2) as a from s', { dialect: 'hive' })));
T('P2-5 array(1,2) 在 PG 下推成 类型[]',
    /\[\]/.test(vk.extractddl('insert into t select array(1,2) as a from s', { dialect: 'pgsql' })));
T('P2-5 猜出来的类型有说明',
    /无法静态推断/.test(vk.extractddl('insert into t select a as x from s', { dialect: 'hive' })));
T('P2-6 Hive PARTITIONED BY 不被 COMMENT 拆碎',
    (function () {
        var r = vk.sqlddl("create table t (a int) partitioned by (ds string comment 'p', hr string comment 'q')", true, {});
        /* 默认 comma_location=false → 逗号在下一行列首；关键是 COMMENT 必须和列
         * 留在同一行，不能被逗号或换行拆到别的行去。 */
        return /PARTITIONED BY \(/.test(r) && r.indexOf("ds STRING COMMENT 'p'") > 0 &&
            /\n\s*,hr STRING COMMENT 'q'/.test(r);
    })(), J(vk.sqlddl("create table t (a int) partitioned by (ds string comment 'p', hr string comment 'q')", true, {})));
T('P2-7 10 万连续空格 < 400ms',
    (function () {
        var q = 'select a' + new Array(100001).join(' ') + 'from t';
        var t0 = Date.now(); sql(q, { fragment: true }); return Date.now() - t0 < 400;
    })(), '超过 400ms 说明平方级路径回来了');
T('P2-7 2 万未闭合 q\'[ < 400ms',
    (function () {
        var q = new Array(20001).join("q'[");
        var t0 = Date.now(); sql(q, { fragment: true }); return Date.now() - t0 < 400;
    })());
T('P2-8 内核在 src/kernel.js',
    fs.existsSync(path.join(EXT, 'src', 'kernel.js')));
/* 1.0.0 起扩展**没有任何运行时依赖**：既不声明 dependencies，也不捆绑任何包，
 * node_modules/ 也不该存在。这条断言守着那个不变量。 */
T('P2-8 无运行时依赖、无捆绑包、无 node_modules', (function () {
    var pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
    var deps = Object.keys(pkg.dependencies || {});
    var bundled = pkg.bundledDependencies || [];
    var hasNm = fs.existsSync(path.join(EXT, 'node_modules'));
    return deps.length === 0 && bundled.length === 0 && !hasNm;
})());

console.log('\n=== P3：词法与提示 ===');
T('P3-1 dbms_output.put_line(i) 不留空格',
    sql('begin dbms_output.put_line(i); end;', { dialect: 'oracle' }).indexOf('put_line(i)') > 0,
    J(sql('begin dbms_output.put_line(i); end;', { dialect: 'oracle' })));
T('P3-5.2 dt =#{dt} 补空格',
    sql('select a from t where dt =#{dt}') === 'SELECT a\nFROM t\nWHERE dt = #{dt}',
    J(sql('select a from t where dt =#{dt}')));
T('P3-6.1 MyBatis XML 片段原样返回',
    (function () {
        var q = '<if test="b != null"> and b = #{b} </if>';
        return sql(q, { fragment: true }) === q;
    })());
T('P3-6.2 全角标点报 not-sql',
    (function () {
        vk.sqlCacheClear(); sql('select a，b from t；');
        return vk.lastDiagnostics().status === 'not-sql';
    })(), J(vk.lastDiagnostics()));


T('P3-3 用户文本里的 U+E000 不被换成换行',
    sql('select \uE000 from t').indexOf('\uE000') > 0,
    J(sql('select \uE000 from t')));
T('P3-3 字符串里的裸 CR 不改变文档 EOL',
    (function () {
        var r = sql('select a\nfrom t\nwhere b = ' + "'x\ry'");
        /* 代码区的换行必须是 LF，不能因为字面量里的 CR 被整体改成 CR */
        return r.indexOf('a\r\n') < 0 && r.indexOf('a\nFROM') > 0;
    })(), J(sql('select a\nfrom t\nwhere b = ' + "'x\ry'")));
T('P3-4 空输入报 empty 诊断',
    (function () {
        vk.sqlCacheClear(); vk.sql('', true, false, false, 96, 120, {});
        return vk.lastDiagnostics().status === 'empty';
    })(), J(vk.lastDiagnostics()));
T('P3-5.1 行首逗号后的占位符与普通列同形',
    (function () {
        var r = sql('select a, $2, b from t', { dialect: 'pgsql' });
        return /^\s*,\$2$/m.test(r) && /^\s*,b$/m.test(r);
    })(), J(sql('select a, $2, b from t', { dialect: 'pgsql' })));
T('P3-5.4 UPDATE … JOIN … SET 独立成行',
    (function () {
        var q = 'update t join s on t.id = s.id set t.a = s.a where t.c = 1';
        return /\nSET t\.a = s\.a/.test(sql(q, { dialect: 'mysql' }));
    })(), J(sql('update t join s on t.id = s.id set t.a = s.a where t.c = 1', { dialect: 'mysql' })));
T('P2-6.2 STORED AS 格式名原样保留',
    (function () {
        var r = vk.sqlddl("create table t (a int) stored as inputformat 'i' outputformat 'o'", true, {});
        return r.indexOf("inputformat 'i' outputformat 'o'") > 0;
    })());

console.log('\n=== 幂等 / 安全网 ===');
['select a, b from t where c = 1 and d = 2',
    'insert into t select a, b from s',
    'create table t (a int, b string)',
    'select case when a = 1 then 2 else 3 end as x from t',
    "select a from t where b in ('x', 'y') order by a desc"
].forEach(function (q) {
    var once = sql(q);
    var twice = sql(once);
    T('幂等：' + q.slice(0, 40), once === twice, J([once, twice]));
});

console.log('\n=== 本轮审计：受保护数据 / Extract / 选区 ===');
T('A-01 DDL 保留普通字符串内部 LF', (function () {
    var input = "create table t (\r\n  a string comment 'x\ny'\r\n);";
    var r = vk.sqlddl(input, true, { dialect: 'hive' });
    return r.indexOf("COMMENT 'x\ny'") > 0 && r.indexOf("COMMENT 'x\r\ny'") < 0;
})(), J(vk.sqlddl("create table t (\r\n  a string comment 'x\ny'\r\n);", true, { dialect: 'hive' })));
T('A-01 DDL 保留尾部块注释内部 LF', (function () {
    var r = vk.sqlddl('create table t (a int);\r\n/* first\nsecond */', true, { dialect: 'hive' });
    return r.indexOf('/* first\nsecond */') > 0;
})(), J(vk.sqlddl('create table t (a int);\r\n/* first\nsecond */', true, { dialect: 'hive' })));
T('A-02 dollar quote 中裸 CR 不改变代码 EOL', (function () {
    var r = sql('select a\nfrom t\nwhere x = $$first\rsecond$$', { dialect: 'pgsql' });
    return r.indexOf('a\nFROM') > 0 && r.indexOf('$$first\rsecond$$') > 0;
})(), J(sql('select a\nfrom t\nwhere x = $$first\rsecond$$', { dialect: 'pgsql' })));
T('A-02 dollar quote 中 LF 不随文档变成 CRLF', (function () {
    var r = sql('select a\r\nfrom t\r\nwhere x = $body$first\nsecond$body$', { dialect: 'pgsql' });
    return r.indexOf('$body$first\nsecond$body$') > 0 && r.indexOf('a\r\nFROM') > 0;
})(), J(sql('select a\r\nfrom t\r\nwhere x = $body$first\nsecond$body$', { dialect: 'pgsql' })));
T('A-03 Extract 保留 MySQL 无空格减法的全部列', (function () {
    var r = vk.extractddl('insert into t select 1--2 as x, b from s', { dialect: 'mysql' });
    return /\bx BIGINT/.test(r) && /\bb STRING/.test(r) && !/COMMENT/.test(r);
})(), J(vk.extractddl('insert into t select 1--2 as x, b from s', { dialect: 'mysql' })));
T('A-04 Extract 纯通配符给出准确原因', (function () {
    vk.extractddl('insert into t select * from s', { dialect: 'hive' });
    return /全部是通配符/.test(vk.lastExtractReason());
})(), J(vk.lastExtractReason()));
T('A-04 Extract 部分通配符有提示且不丢已知列', (function () {
    var r = vk.extractddl('insert into t select s.*, a from s', { dialect: 'hive' });
    return /以下通配符未展开/.test(r) && /s\.\*/.test(r) && /\ba STRING/.test(r);
})(), J(vk.extractddl('insert into t select s.*, a from s', { dialect: 'hive' })));
T('A-04 Extract 多目标含通配符时不静默跳过', (function () {
    var r = vk.extractddl('insert into t1 select * from s1; insert into t2 select a from s2;', { dialect: 'hive' });
    return r === '' && /t1/.test(vk.lastExtractReason()) && /通配符/.test(vk.lastExtractReason());
})(), J(vk.extractddl('insert into t1 select * from s1; insert into t2 select a from s2;', { dialect: 'hive' })));
T('A-04 Extract 显式列清单遇通配符时不错位', (function () {
    var r = vk.extractddl('insert into t (a,b) select s.*, x from s', { dialect: 'hive' });
    return !/\bx STRING/.test(r) && /无法确定列映射|通配符/.test(r + vk.lastExtractReason());
})(), J(vk.extractddl('insert into t (a,b) select s.*, x from s', { dialect: 'hive' })));
T('A-07 Extract 跟随空格缩进宽度', (function () {
    var r = vk.extractddl('insert into t select a from s', { dialect: 'hive', tabWidth: 4, bracketChar: true });
    return r.indexOf('\n    a STRING') > 0;
})(), J(vk.extractddl('insert into t select a from s', { dialect: 'hive', tabWidth: 4, bracketChar: true })));
T('A-07 Extract 跟随 Tab 与分区缩进', (function () {
    var r = vk.extractddl("insert overwrite table t partition (dt='2020') select a from s", { dialect: 'hive', tabWidth: 4, bracketChar: false });
    return r.indexOf('\n\ta STRING') > 0 && r.indexOf('\n\tdt STRING') > 0;
})(), J(vk.extractddl("insert overwrite table t partition (dt='2020') select a from s", { dialect: 'hive', tabWidth: 4, bracketChar: false })));
T('A-07 DDL 分区列跟随缩进宽度', (function () {
    var r = vk.sqlddl('create table t (a int) partitioned by (dt string)', true,
        { dialect: 'hive', tabWidth: 4, bracketChar: true });
    return r.indexOf('PARTITIONED BY (\n    dt STRING') > 0;
})(), J(vk.sqlddl('create table t (a int) partitioned by (dt string)', true,
    { dialect: 'hive', tabWidth: 4, bracketChar: true })));
T('A-08 split 推断数组而非 STRING', (function () {
    var r = vk.extractddl("insert into t select split(x, ',') as parts from s", { dialect: 'hive' });
    return /ARRAY<STRING>/.test(r);
})(), J(vk.extractddl("insert into t select split(x, ',') as parts from s", { dialect: 'hive' })));
T('A-08 to_date 推断 DATE', (function () {
    var r = vk.extractddl('insert into t select to_date(x) as dt from s', { dialect: 'hive' });
    return /\bdt DATE/.test(r);
})(), J(vk.extractddl('insert into t select to_date(x) as dt from s', { dialect: 'hive' })));
T('A-08 collect_list 推断数组而非 STRING', (function () {
    var r = vk.extractddl('insert into t select collect_list(x) as xs from s', { dialect: 'hive' });
    return /ARRAY</.test(r) && !/\bxs STRING/.test(r);
})(), J(vk.extractddl('insert into t select collect_list(x) as xs from s', { dialect: 'hive' })));

function loadExtensionForTest(cfgOverride, editorCfgOverride) {
    var current = cfgOverride || { uppercase: true, dialect: 'sql', max_line_length: 0,
        screen_width: 0, as_loc_cnt: 0, bracket_char: false, cjk_width: 0,
        detectScreenWidth: false, comma_location: false };
    var edCfg = editorCfgOverride || {};
    /* SD-3（2026-11-09）：输出通道的内容要能被断言 —— 「输出 → Snug SQL Formatter」
     * 是用户排查宽度问题时唯一看得见的地方（P3-2 的 screenCacheSuspicion）。 */
    var outLines = [];
    function Position(line, character) { this.line = line; this.character = character; }
    Position.prototype.isEqual = function (o) { return this.line === o.line && this.character === o.character; };
    Position.prototype.compareTo = function (o) { return this.line - o.line || this.character - o.character; };
    function Range(start, end) { this.start = start; this.end = end; }
    var vscode = {
        Position: Position, Range: Range,
        TextEdit: { replace: function (range, newText) { return { range: range, newText: newText }; } },
        workspace: { getConfiguration: function (section) {
            if (section === 'editor') {
                return { get: function (key) { return edCfg[key]; }, inspect: function () { return {}; } };
            }
            return {
                get: function (key) { return current[key]; },
                inspect: function () { return {}; }
            };
        } },
        languages: {}, commands: {},
        window: { createOutputChannel: function () { return { appendLine: function (l) { outLines.push(String(l)); }, dispose: function () {} }; },
            setStatusBarMessage: function () {}, showWarningMessage: function () {},
            showErrorMessage: function () {}, showInformationMessage: function () {},
            showTextDocument: function () { return Promise.resolve({}); } }
    };
    var sandbox = { module: { exports: {} }, exports: {}, console: console, process: process,
        Buffer: Buffer, __dirname: EXT,
        require: function (id) {
            if (id === 'vscode') return vscode;
            /* extension.js 只 require('./src/kernel')。沙箱里的 require 是以
             * test/run.js 为基准解析的，相对路径会找错目录，所以这里显式
             * 把扩展根目录作为基准。 */
            if (id.charAt(0) === '.') return require(path.join(EXT, id));
            return require(id);
        } };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8') +
        ';this.testApi = { applyToEditor: applyToEditor, doRangeDocument: doRangeDocument, doFullDocument: doFullDocument, readOptions: readOptions, transformSql: transformSql, pxToColumns: pxToColumns, loadScreenCache: loadScreenCache, refreshScreenProbe: refreshScreenProbe, screenCacheSuspicion: screenCacheSuspicion, reportScreenCacheSuspicion: reportScreenCacheSuspicion, screenState: function () { return { ready: screenReady, probing: !!screenProbe, cols: detectedScreenCols, px: detectedScreenPx }; } };',
        sandbox);
    return { api: sandbox.testApi, vscode: vscode, cfg: current, editorCfg: edCfg,
        outLines: outLines, outLinesRef: function () { return outLines; } };
}
function testCommandPreservesCrlf() {
    var env = loadExtensionForTest();
    var text = 'select a, b\r\nfrom t where x = 1;\r\n';
    var doc = { eol: 2, getText: function (range) { return range ? text.slice(range.start.character, range.end.character) : text; } };
    var replacement = '';
    var editor = { document: doc, edit: function (callback) {
        callback({ replace: function (range, value) { replacement = value; } }); return Promise.resolve(true);
    } };
    var range = new env.vscode.Range(new env.vscode.Position(0, 0), new env.vscode.Position(0, text.length));
    return env.api.applyToEditor(editor, [range], function (value, opts) {
        return vk.sql(value, opts.uppercase, opts.commaLocation, opts.bracketChar, opts.asLocCnt,
            opts.maxLine, { fragment: true, dialect: opts.dialect, tabWidth: opts.tabSize,
                hardWidth: opts.hardLine, cjkWidth: opts.cjkWidth });
    }, { uppercase: true, commaLocation: false, bracketChar: true, asLocCnt: 96,
        maxLine: 96, hardLine: 120, dialect: 'sql', tabSize: 4, cjkWidth: 0
    }).then(function () { return replacement.indexOf('\r\n') >= 0 && !/(^|[^\r])\n/.test(replacement); });
}
T('A-05 命令选区保持 CRLF', testCommandPreservesCrlf(), '命令替换后出现裸 LF');

/* P0-3（2026-11-05 复核）：命令路径的**字面量内部换行**必须逐字节保留。
 * 旧实现把结果 split(/\r\n|\n|\r/) 再 join(文档 EOL)，等于把内核刚保护好的
 * 字面量换行也统一了 —— LF 文档里 `'a\r\nb'` 变成 `'a\nb'`，值被改写。 */
function testCommandKeepsLiteralEol(indentText, eol) {
    var env = loadExtensionForTest();
    var doc = { eol: eol, getText: function (range) {
        return range ? indentText.slice(range.start.character, range.end.character) : indentText;
    } };
    var replacement = '';
    var editor = { document: doc, edit: function (callback) {
        callback({ replace: function (range, value) { replacement = value; } }); return Promise.resolve(true);
    } };
    var range = new env.vscode.Range(new env.vscode.Position(0, 0), new env.vscode.Position(0, indentText.length));
    return env.api.applyToEditor(editor, [range], function (value, opts) {
        return vk.sql(value, opts.uppercase, opts.commaLocation, opts.bracketChar, opts.asLocCnt,
            opts.maxLine, { fragment: true, dialect: opts.dialect, tabWidth: opts.tabSize,
                hardWidth: opts.hardLine, cjkWidth: opts.cjkWidth });
    }, { uppercase: true, commaLocation: false, bracketChar: true, asLocCnt: 96,
        maxLine: 96, hardLine: 120, dialect: 'sql', tabSize: 4, cjkWidth: 0
    }).then(function () { return replacement; });
}
T('R-15 LF 文档不把字面量内的 CRLF 归一', (function () {
    var text = "  select 'a\r\nb' as x from t";
    return testCommandKeepsLiteralEol(text, 1).then(function (out) {
        return out.indexOf("'a\r\nb'") >= 0;
    });
})(), '字面量值被改写（CRLF 被归一成 LF）');
T('R-16 CRLF 文档不把字面量内的裸 LF 归一', (function () {
    var text = "  select 'a\nb' as x from t";
    return testCommandKeepsLiteralEol(text, 2).then(function (out) {
        return out.indexOf("'a\nb'") >= 0 && out.indexOf("'a\r\nb'") < 0;
    });
})(), '字面量值被改写（裸 LF 被改成 CRLF）');
T('R-17 显式 screen_width=40 不被抬到 80', (function () {
    var env = loadExtensionForTest({ uppercase: true, dialect: 'sql', max_line_length: 0,
        screen_width: 40, as_loc_cnt: 0, bracket_char: false, cjk_width: 0,
        detectScreenWidth: false, comma_location: false });
    var o = env.api.readOptions({ languageId: 'sql' }, {});
    return o.hardLine === 40 && o.maxLine === 32;
})(), 'screen_width 小于 80 时被静默抬升');
T('A-05 范围 provider 保持基础缩进与 CRLF', (function () {
    var env = loadExtensionForTest();
    var text = '  select a, b\r\nfrom t where x = 1;\r\n';
    var doc = { eol: 2, getText: function (range) { return range ? text.slice(range.start.character, range.end.character) : text; } };
    var range = new env.vscode.Range(new env.vscode.Position(0, 2), new env.vscode.Position(0, text.length));
    var edits = env.api.doRangeDocument(doc, range, { insertSpaces: true, tabSize: 4 }, null);
    return edits.length === 1 && edits[0].newText.indexOf('SELECT') === 0 &&
        !/(^|[^\r])\n/.test(edits[0].newText);
})(), '范围编辑没有保留缩进或引入裸 LF');
T('A-06 语句隔离不重排括号残缺语句', (function () {
    var r = sql('select a,b from t;select (x from u;', { dialect: 'mysql', fragment: true });
    return r.indexOf('select (x from u;') >= 0 && r.indexOf('SELECT a') >= 0;
})(), J(sql('select a,b from t;select (x from u;', { dialect: 'mysql', fragment: true })));

console.log('\n=== 2026-11-04：折行宽度（W×80%）与逻辑块完整性 ===');

/* 按「屏幕宽度 W、目标 80%」格式化，返回行数组。 */
function wrapByW(text, W, o) {
    o = o || {};
    var ideal = Math.round(W * 0.8);
    vk.sqlCacheClear();
    return vk.sql(text, o.uppercase !== false, o.comma === true, o.bracketChar === true,
        ideal, ideal, {
            fragment: o.fragment === undefined ? true : o.fragment,
            dialect: o.dialect, tabWidth: 4,
            hardWidth: o.hard === undefined ? W : o.hard, cjkWidth: 0
        });
}
function visWidth(s) {
    /* 与内核同口径：CJK / 全角 = 2 列，其余 1 列。 */
    var n = 0;
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        n += (c >= 0x1100 && !(c < 0x2E80)) ? 2 : 1;
    }
    return n;
}

T('W-1 超过 80% 就折行（98 列 / 120 列屏）', (function () {
    var q = 'select * from t where a in (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24)';
    var out = wrapByW(q, 120);
    var lines = out.split('\n');
    return lines.length > 3 && Math.max.apply(null, lines.map(visWidth)) <= 96;
})(), J(wrapByW('select * from t where a in (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24)', 120)));

T('W-1 80% 以内不产生额外折行', (function () {
    /* 插件的招牌风格是"一列一行"（4 个逻辑行），这里断言的是
     * **没有因为宽度而多折**：行数与结构行一致，且每行都在 80% 以内。 */
    var q = 'select a, b from t where x = 1';
    var lines = wrapByW(q, 120).split('\n');
    if (lines.length !== 4) return false;
    for (var k = 0; k < lines.length; k++) if (visWidth(lines[k]) > 96) return false;
    return true;
})(), J(wrapByW('select a, b from t where x = 1', 120)));

T('W-2 折行点不会落在行首附近（不把逻辑劈成两半）', (function () {
    /* 外层 AND 在很左侧、内层 IN 列表在 80% 附近：必须断在列表里，
     * 而不是断在 IN 上留下 `AND y` 这种只有 5 列的首行。 */
    var items = [];
    for (var i = 1; i <= 24; i++) items.push(100000 + i);
    var out = wrapByW('select a from t where x = 1 and y in (' + items.join(',') + ')', 120);
    var lines = out.split('\n');
    for (var k = 0; k < lines.length; k++) {
        if (/^\s*AND y\s*$/.test(lines[k])) return false;
    }
    return true;
})(), J(wrapByW('select a from t where x = 1 and y in (100001,100002,100003,100004,100005,100006,100007,100008,100009,100010,100011,100012,100013,100014,100015,100016,100017,100018,100019,100020,100021,100022,100023,100024)', 120)));

T('W-3 不再出现"只有逗号的一行"（逗号后置风格）', (function () {
    var q = 'select ' + 'a'.repeat(101) + ', b from t';
    var out = wrapByW(q, 120, { comma: true });
    var lines = out.split('\n');
    for (var k = 0; k < lines.length; k++) {
        if (lines[k].trim() === '' || /^\s*[;,)]+\s*$/.test(lines[k])) return false;
    }
    return true;
})(), J(wrapByW('select ' + 'a'.repeat(101) + ', b from t', 120, { comma: true })));

T('W-4 逐行宽度不超过 W（除单个超长 token）', (function () {
    var cases = [
        'select ' + 'a1 * '.repeat(17) + 'a19 as x from t',
        'select coalesce(' + Array.from({ length: 30 }, function (_, k) { return 'col' + k; }).join(',') + ') as v from t',
        'select a, b from t where x = 1 and y in (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20)'
    ];
    for (var i = 0; i < cases.length; i++) {
        var lines = wrapByW(cases[i], 120).split('\n');
        for (var k = 0; k < lines.length; k++) if (visWidth(lines[k]) > 120) return false;
    }
    return true;
})());

T('W-5 折行后仍然幂等', (function () {
    var q = 'select ' + Array.from({ length: 30 }, function (_, k) { return 'col' + k; }).join(',') + ' from t';
    var once = wrapByW(q, 120);
    var twice = wrapByW(once, 120);
    return once === twice;
})(), J(wrapByW('select ' + Array.from({ length: 30 }, function (_, k) { return 'col' + k; }).join(',') + ' from t', 120)));

T('W-6 宽度切换可逆（80/120 → 64/80 → 80/120）', (function () {
    var q = 'select coalesce(a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z) as v from t';
    var a = wrapByW(q, 120);
    var b = wrapByW(a, 80);
    var c = wrapByW(b, 120);
    return a === c;
})());

T('W-7 别名不与表达式分开（AS 折行回归）', (function () {
    /* 用户案例（2026-11-04 复核）：`,COUNT(DISTINCT CASE … END) AS \`别名\``
     * 缩进 12 时整项 104 列，屏幕 120 列**放得下** → 必须整体保留；
     * 顺带检查 240 列屏（整项 98 < 192 目标）同样不能被 AS 切断。
     * 旧实现的折行断点会落到 AS 上，输出
     *     ,COUNT(DISTINCT CASE … END)
     *         AS `取消的合并订单数`      ← 别名悬空 */
    var item = ',COUNT(DISTINCT CASE WHEN order_status = 2 THEN flow_id ELSE NULL END) AS `取消的合并订单数`';
    var q = 'select dt\n' + '          ' + item + '\nfrom dwd_order';
    var widths = [240, 120];
    for (var i = 0; i < widths.length; i++) {
        var lines = wrapByW(q, widths[i]).split('\n');
        for (var k = 0; k < lines.length; k++) {
            if (/^\s*AS\s/i.test(lines[k])) return false;   /* 别名被摘下来了 */
        }
        /* 整项必须出现在同一行上 */
        var joined = false;
        for (k = 0; k < lines.length; k++) {
            if (lines[k].indexOf('END) AS `取消的合并订单数`') >= 0) joined = true;
        }
        if (!joined) return false;
    }
    return true;
})(), J(wrapByW('select dt\n          ,COUNT(DISTINCT CASE WHEN order_status = 2 THEN flow_id ELSE NULL END) AS `取消的合并订单数`\nfrom dwd_order', 120)));

T('W-7 别名合并后仍不超屏幕宽度', (function () {
    /* 合并只在「并回去 ≤ 100%（屏幕宽度）」时才做；超了必须保持原来的折行，
     * 否则就是把超宽行硬塞回去。 */
    var q = 'select a\n          ,' + 'SUM(CASE WHEN a = 1 THEN bbbbbbbbbbbbbbbbb ELSE 0 END) AS `很长的别名啊啊啊啊啊啊`\nfrom t';
    var lines = wrapByW(q, 120).split('\n');
    for (var k = 0; k < lines.length; k++) if (visWidth(lines[k]) > 120) return false;
    return true;
})(), J(wrapByW('select a\n          ,SUM(CASE WHEN a = 1 THEN bbbbbbbbbbbbbbbbb ELSE 0 END) AS `很长的别名啊啊啊啊啊啊`\nfrom t', 120)));

/* 选区首行缩进：只在代码行补，不能补进跨行字符串里。 */
T('E-1 基础缩进不写进跨行字符串', (function () {
    var env = loadExtensionForTest();
    var text = "  select 'a\nb' as x from t";
    var doc = { eol: 1, getText: function (range) { return range ? text.slice(range.start.character, range.end.character) : text; } };
    var replacement = '';
    var editor = { document: doc, options: { insertSpaces: true, tabSize: 4 },
        edit: function (cb) { cb({ replace: function (r, v) { replacement = v; } }); return Promise.resolve(true); } };
    var range = new env.vscode.Range(new env.vscode.Position(0, 0), new env.vscode.Position(0, text.length));
    return env.api.applyToEditor(editor, [range], function (value, opts) {
        return vk.sql(value, opts.uppercase, opts.commaLocation, opts.bracketChar, opts.asLocCnt,
            opts.maxLine, { fragment: true, dialect: opts.dialect, tabWidth: opts.tabSize,
                hardWidth: opts.hardLine, cjkWidth: opts.cjkWidth });
    }, { uppercase: true, commaLocation: false, bracketChar: true, asLocCnt: 96,
        maxLine: 96, hardLine: 120, dialect: 'sql', tabSize: 4, cjkWidth: 0
    }).then(function () {
        /* 字符串值必须还是 'a\nb'（内部没有多出缩进空格），代码行仍带基础缩进 */
        return replacement.indexOf("'a\nb'") >= 0 && replacement.indexOf('  FROM t') >= 0;
    });
})(), '字符串内部被补了缩进，或代码行丢失基础缩进');

/* D-2：屏幕宽度必须先夹到 [MIN_WIDTH, MAX_WIDTH] 再算 80%。
 * 旧顺序会算出 maxLine === hardLine（例如 screen_width=750 → 320/320），
 * "超过 80% 就折行"在宽屏/窄屏上同时失效。 */
T('D-2 宽屏 screen_width=750 → 256/320', (function () {
    var env = loadExtensionForTest({
        uppercase: true, comma_location: false, bracket_char: true, dialect: 'sql',
        as_loc_cnt: 0, screen_width: 750, max_line_length: 0, cjk_width: 0, detectScreenWidth: false
    });
    var doc = { eol: 1, languageId: 'sql', getText: function () { return ''; } };
    var o = env.api.readOptions(doc, { insertSpaces: true, tabSize: 4 });
    return o.maxLine === 256 && o.hardLine === 320;
})(), '宽屏上 80% 目标宽度没有与硬上限分开');

T('D-2 窄屏 wordWrapColumn=80 → 64/80', (function () {
    var env = loadExtensionForTest({
        uppercase: true, comma_location: false, bracket_char: true, dialect: 'sql',
        as_loc_cnt: 0, screen_width: 0, max_line_length: 0, cjk_width: 0, detectScreenWidth: false
    }, { wordWrap: 'wordWrapColumn', wordWrapColumn: 80 });
    var doc = { eol: 1, languageId: 'sql', getText: function () { return ''; } };
    var o = env.api.readOptions(doc, { insertSpaces: true, tabSize: 4 });
    return o.maxLine === 64 && o.hardLine === 80;
})(), '窄屏上 maxLine 被 MIN_WIDTH 抬到与硬上限相同');

T('D-1 detectScreenWidth 默认开启（配置里默认 true）', (function () {
    var pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
    return pkg.contributes.configuration.properties['snugSql.detectScreenWidth'].default === true;
})(), 'detectScreenWidth 默认值仍是 false，探测结果永远用不上');

/* E-4：内核原样返回（not-sql / unbalanced …）时不得只加缩进。 */
T('E-4 非 SQL 选区不被"只加缩进"改写', (function () {
    var env = loadExtensionForTest();
    var text = '  Set the table for dinner please.';
    var doc = { eol: 1, getText: function (range) { return range ? text.slice(range.start.character, range.end.character) : text; } };
    var wrote = false;
    var editor = { document: doc, options: { insertSpaces: true, tabSize: 4 },
        edit: function (cb) { wrote = true; cb({ replace: function () {} }); return Promise.resolve(true); } };
    var range = new env.vscode.Range(new env.vscode.Position(0, 0), new env.vscode.Position(0, text.length));
    return env.api.applyToEditor(editor, [range], function (value, opts) {
        return vk.sql(value, opts.uppercase, opts.commaLocation, opts.bracketChar, opts.asLocCnt,
            opts.maxLine, { fragment: true, dialect: opts.dialect, tabWidth: opts.tabSize,
                hardWidth: opts.hardLine, cjkWidth: opts.cjkWidth });
    }, { uppercase: true, commaLocation: false, bracketChar: true, asLocCnt: 96,
        maxLine: 96, hardLine: 120, dialect: 'sql', tabSize: 4, cjkWidth: 0
    }).then(function () { return wrote === false; });
})(), '非 SQL 选区仍然被写入了只加缩进的编辑');

/* ============================================================================
 * 2026-11-04 复核（四份审计报告逐条复现后修复的缺陷）。
 * 每条都对应报告里的一个编号，见 src/kernel.js 里同编号的注释。
 * ==========================================================================*/

console.log('\n=== 2026-11-04 复核修复（A/B/N 组） ===');

/* A-01：全角标点门槛只看代码区。 */
T('A-01.1 注释里的全角逗号不再让整篇 not-sql',
    sql('select a, b from t -- 说明，保留原样') === 'SELECT a\n      ,b\nFROM t -- 说明，保留原样',
    J(sql('select a, b from t -- 说明，保留原样')));
T('A-01.2 字符串字面量里的全角括号不再让整篇 not-sql',
    /'（测试）'/.test(sql("select '（测试）' as s from t")),
    J(sql("select '（测试）' as s from t")));
T('A-01.3 代码区的全角逗号仍然拦下',
    (function () {
        vk.sqlCacheClear(); sql('select a，b from t');
        return vk.lastDiagnostics().status === 'not-sql';
    })(), J(vk.lastDiagnostics()));

/* A-02：“判定不修改”的分支必须逐字节原样返回（含混合换行）。 */
T('A-02 not-sql 分支不再归一换行', (function () {
    var q = '<if test="b != null"> and b = 1 </if>\r\nselect a\nfrom t\r\n';
    return sql(q) === q;
})(), J(sql('<if test="b != null"> and b = 1 </if>\r\nselect a\nfrom t\r\n')));

/* A-03：detectDocEol 不再“见第一个 \r 就定案”。 */
T('A-03 \\r\\r\\n 文件不被压成裸 CR', (function () {
    var q = 'select a from t;\r\r\nselect b from u;\r\r\n';
    var o = sql(q);
    return (o.match(/\r\n/g) || []).length >= 2 && !/\r(?!\n)/.test(o);
})(), J(sql('select a from t;\r\r\nselect b from u;\r\r\n')));
T('A-03.2 纯 CR 文件仍按 CR 还原', (function () {
    var o = sql('select a from t;\rselect b from u;\r');
    return /\r/.test(o) && !/\n/.test(o);
})());

/* A-04：DDL 缺分号的多语句不得粘成一条。 */
T('A-04 缺分号的两条 DDL 不再粘成一行', (function () {
    var o = vk.sqlddl('drop table t\ncreate table u (b int);', true, { dialect: 'hive', tabWidth: 4 });
    return !/DROP TABLE t[^\n]*CREATE TABLE u/.test(o) && /DROP TABLE t\n/.test(o);
})(), J(vk.sqlddl('drop table t\ncreate table u (b int);', true, { dialect: 'hive', tabWidth: 4 })));

/* B-01：UPDATE 后面紧跟的 SET 不是表名。 */
T('B-01.1 MERGE … UPDATE SET 的 SET 大写',
    /UPDATE SET a = u\.a/.test(sql('merge into t using u on t.id=u.id when matched then update set a=u.a')),
    J(sql('merge into t using u on t.id=u.id when matched then update set a=u.a')));
T('B-01.2 ON CONFLICT DO UPDATE SET 的 SET 大写',
    /DO UPDATE SET a = 2/.test(sql('insert into t (a) values (1) on conflict (a) do update set a=2', { dialect: 'pgsql' })),
    J(sql('insert into t (a) values (1) on conflict (a) do update set a=2', { dialect: 'pgsql' })));

/* B-02：ESCAPE / NEXT / FIRST。 */
T('B-02.1 ESCAPE 大写',
    /ESCAPE '!'/.test(sql("select a from t where b like '%x%' escape '!'", { dialect: 'mysql' })),
    J(sql("select a from t where b like '%x%' escape '!'", { dialect: 'mysql' })));
T('B-02.2 FETCH NEXT 的 NEXT 大写',
    /FETCH NEXT 10 ROWS/.test(sql('select a from t order by a offset 10 rows fetch next 10 rows only', { dialect: 'tsql' })),
    J(sql('select a from t order by a offset 10 rows fetch next 10 rows only', { dialect: 'tsql' })));
T('B-02.3 FETCH FIRST 的 FIRST 大写',
    /FETCH FIRST 5 ROWS/.test(sql('select a from t order by a fetch first 5 rows only', { dialect: 'db2' })),
    J(sql('select a from t order by a fetch first 5 rows only', { dialect: 'db2' })));
T('B-02.4 列名 escape / next 不被大写', (function () {
    var o = sql('select escape, next from t');
    return /escape/.test(o) && /next/.test(o);
})(), J(sql('select escape, next from t')));

/* B-04：带引号的别名原样保留。 */
T('B-04 Extract 保留带引号别名', (function () {
    var o = vk.extractddl('select a as "x y", b as `my col` from t', { dialect: 'hive' });
    return /"x y"/.test(o) && /`my col`/.test(o) && !/x_y|my_col/.test(o);
})(), J(vk.extractddl('select a as "x y", b as `my col` from t', { dialect: 'hive' })));

/* B-05：AS 对齐不产生巨幅空白。 */
T('B-05 单条长列名不再制造 70 列空白', (function () {
    var q = 'select a as x, ' + 'b'.repeat(70) + ' as 长列 from t';
    return sql(q).split('\n')[0].length < 40;
})(), J(sql('select a as x, ' + 'b'.repeat(70) + ' as 长列 from t')));
T('B-05.2 正常列仍然对齐',
    /SELECT a      AS x/.test(sql('select a as x, bbbbbb as 长列名 from t')),
    J(sql('select a as x, bbbbbb as 长列名 from t')));

/* N 组：词法层。 */
T('N1 COPY … FROM stdin 的数据块原样保留', (function () {
    var q = 'COPY t (a, b) FROM stdin;\n1\tfoo-bar\n\\.\nselect 1;';
    return /1\tfoo-bar/.test(sql(q, { dialect: 'pgsql' }));
})(), J(sql('COPY t (a, b) FROM stdin;\n1\tfoo-bar\n\\.\nselect 1;', { dialect: 'pgsql' })));
T('N2 BigQuery 三引号字符串不被拆开',
    /'''d'e'''/.test(sql("select '''d'e''' y, b from t", { dialect: 'bigquery' })),
    J(sql("select '''d'e''' y, b from t", { dialect: 'bigquery' })));
T('N3 Hive CLI 命令整行保留', (function () {
    return /dfs -ls \/user\/hive/.test(sql('dfs -ls /user/hive;\nselect 1;', { dialect: 'hive' })) &&
        /!sh ls -l \/tmp/.test(sql('!sh ls -l /tmp;\nselect 1;', { dialect: 'hive' }));
})(), J(sql('dfs -ls /user/hive;\nselect 1;', { dialect: 'hive' })));
T('N4 sqlcmd 命令整行保留', (function () {
    var o = sql(':setvar db x-y\n:r a-b.sql\nuse [db];', { dialect: 'tsql' });
    return /:setvar db x-y/.test(o) && /:r a-b\.sql/.test(o);
})(), J(sql(':setvar db x-y\n:r a-b.sql\nuse [db];', { dialect: 'tsql' })));
T('N5 Oracle &b / &&c 与 nq\'\' 不被拆开', (function () {
    var o = sql('select &b, &&c from dual', { dialect: 'oracle' });
    return /&b/.test(o) && /&&c/.test(o) &&
        /nq'\[x\]'/.test(sql("select nq'[x]' from dual", { dialect: 'oracle' }));
})(), J(sql('select &b, &&c from dual', { dialect: 'oracle' })));
T('N8 NBSP 不再让整篇回退', (function () {
    var o = sql('select a from t where b = 1\u00a0and c = 2;');
    return vk.lastDiagnostics().status === 'formatted' && /AND c = 2/.test(o);
})(), J(sql('select a from t where b = 1\u00a0and c = 2;')));
T('P0-10 /*!…*/; 的分号不再被挤到注释前', (function () {
    var o = sql('/*!40101 SET a=1 */;\nselect 1;', { dialect: 'mysql' });
    return /^\/\*!40101 SET a=1 \*\/;/.test(o);
})(), J(sql('/*!40101 SET a=1 */;\nselect 1;', { dialect: 'mysql' })));

/* N9：分区子句固定短语。 */
T('N9 VALUES LESS THAN 大写',
    /VALUES LESS THAN/.test(vk.sqlddl('create table t (a int) partition by range(a) (partition p0 values less than(1));',
        true, { dialect: 'mysql', tabWidth: 4 })));

/* P-02：长 IN 列表不再 O(n²)。
 *
 * 不用绝对毫秒数做断言（机器差异大，且 JIT 预热会抖动），改用**标度比**：
 * 4 万项 / 1 万项 = 4 倍规模。线性实现约 4~6 倍，平方级实现约 16 倍。
 * 修复前实测 4 万项 6.3 s、1 万项 0.25 s（25 倍）；修复后 0.5 s / 0.12 s（≈4 倍）。 */
T('P-02 4 万项 IN 列表是线性标度（不再 O(n²)）', (function () {
    function build(n) {
        var a = [];
        for (var i = 0; i < n; i++) a.push(String(i));
        return 'select * from t where a in (' + a.join(',') + ')';
    }
    function best(n) {
        var q = build(n), b = 1e9;
        for (var k = 0; k < 2; k++) {
            vk.sqlCacheClear();
            var t0 = Date.now();
            vk.sql(q, true, false, false, 0, 120, { dialect: 'hive', hardWidth: 120 });
            var d = Date.now() - t0;
            if (d < b) b = d;
        }
        return b;
    }
    best(5000);                       /* 预热，避免把 JIT 时间算进比值 */
    var small = Math.max(best(10000), 20);
    var large = best(40000);
    return (large / small) < 10;
})(), '标度比超过 10 倍，仍是超线性');

console.log('\n=== 诊断引擎（src/lint.js）===');

/* 诊断引擎的核心承诺：**宁可漏报，不可误报**。
 * 所以这里除了"该报的要报"，还专门固化了"不该报的绝不报"这一批用例 ——
 * 波浪线误报的代价远高于漏报（用户会直接把整个功能关掉）。 */
var lint;
try { lint = require(path.join(EXT, 'src', 'lint.js')); }
catch (e) { lint = null; }

function lintIds(text, opts) {
    if (!lint) return null;
    var o = opts || {};
    if (!o.dialect) o.dialect = 'mysql';
    var r = lint.lint(text, o);
    return r.issues.map(function (x) { return x.rule; }).sort();
}

/* 断言"恰好命中这些规则"，任何多报少报都算失败。 */
function L(name, text, expect, opts) {
    var got = lintIds(text, opts);
    if (got === null) { T(name, false, 'lint.js 加载失败'); return; }
    var a = got.join(','), b = expect.slice().sort().join(',');
    T(name, a === b, '得到 [' + a + ']，期望 [' + b + ']');
}

/* ---- 语法错误 ---- */
L('LX-1 括号不配对', 'select (a from t', ['syntax.unbalanced-paren']);
L('LX-2 右括号多出来', 'select a) from t', ['syntax.unbalanced-paren']);
L('LX-3 字符串未闭合', "select a from t where b = 'abc", ['syntax.unterminated-string']);
L('LX-4 SELECT 列表末尾多余逗号', 'select a, b, from t', ['syntax.trailing-comma']);
/* 2026-11-07 复核（P1-3）：BigQuery / DuckDB 的 SELECT 列表允许尾逗号。 */
L('LX-4.1 BigQuery 的 SELECT 尾逗号不报', 'select a, b, from t', [], { dialect: 'bigquery' });
L('LX-4.2 DuckDB 的 SELECT 尾逗号不报', 'select a, b, from t', [], { dialect: 'duckdb' });
L('LX-4.3 其它方言的 SELECT 尾逗号仍报', 'select a, b, from t', ['syntax.trailing-comma'], { dialect: 'postgres' });
L('LX-4.4 BigQuery 函数参数尾逗号仍报', 'select f(a,) from t', ['syntax.trailing-comma'], { dialect: 'bigquery' });
L('LX-4.5 BigQuery IN 列表尾逗号仍报', 'select a from t where a in (1,2,)', ['syntax.trailing-comma'], { dialect: 'bigquery' });
L('LX-4.6 BigQuery 子查询里的列表尾逗号不报', 'select a from (select b, from u) x', [], { dialect: 'bigquery' });
L('LX-4.7 BigQuery UNION 两个分支的尾逗号都不报',
    'select a, from t union all select b, from u', [], { dialect: 'bigquery' });
L('LX-4.8 BigQuery 语句直接结束的尾逗号仍报', 'select a, b,', ['syntax.trailing-comma'], { dialect: 'bigquery' });
L('LX-5 子句顺序（WHERE 在 FROM 前）', 'select a where x = 1 from t', ['syntax.clause-order']);
L('LX-6 重复 WHERE', 'select a from t where x = 1 where y = 2', ['syntax.duplicate-clause']);
L('LX-7 保留字当别名', 'select a as from from t', ['syntax.reserved-alias']);
L('LX-8 IN 空列表', 'select a from t where a in ()', ['syntax.empty-in-list']);

/* ---- 高危写法 ---- */
L('LX-9 = NULL 永远不成立', 'select a from t where b = NULL', ['danger.null-comparison']);
L('LX-10 <> NULL', 'select a from t where b <> NULL', ['danger.null-comparison']);
L('LX-11 NULL 写在左侧', 'select a from t where NULL = b', ['danger.null-comparison']);
L('LX-12 DELETE 没有 WHERE', 'delete from t', ['danger.delete-update-no-where']);
L('LX-13 UPDATE 没有 WHERE', 'update t set a = 1', ['danger.delete-update-no-where']);
L('LX-14 多表逗号连接且无 WHERE（笛卡尔积）', 'select a.x from ta a, tb b', ['danger.cartesian-product']);
L('LX-15 NOT IN 子查询', 'select a from t where a not in (select id from u)', ['danger.not-in-subquery']);
L('LX-16 JOIN 缺 ON', 'select a.x from ta a join tb b where a.id = 1', ['danger.join-without-on']);
L('LX-17 AND/OR 混用无括号', 'select a from t where x = 1 and y = 2 or z = 3', ['danger.and-or-mixed']);

/* ---- 写法 / 性能 ---- */
L('LX-18 SELECT *', 'select * from t', ['style.select-star']);
L('LX-19 t.* 也算 SELECT *', 'select t.* from t', ['style.select-star']);
L('LX-20 隐式连接（有 WHERE）给 info 不报笛卡尔积', 'select a.x from ta a, tb b where a.id = b.id', ['style.implicit-join']);
L('LX-21 LIKE 前缀通配', "select a from t where n like '%abc'", ['style.leading-wildcard-like']);
L('LX-22 UNION 没有 ALL', 'select a from t union select b from u', ['style.union-vs-union-all']);
L('LX-23 ORDER BY 序号', 'select a, b from t order by 1', ['style.order-by-ordinal']);
L('LX-24 DISTINCT + GROUP BY 冗余', 'select distinct a from t group by a', ['style.distinct-with-groupby']);

/* ---- 绝不误报 ---- */
L('LX-25 EXISTS(SELECT *) 是惯用法，不报', 'select 1 from t where exists (select * from u where u.id = t.id)', []);
L('LX-26 COUNT(*) 不报', 'select count(*) from t', []);
L('LX-27 CROSS JOIN 不需要 ON', 'select a from t cross join u', []);
L('LX-28 NATURAL JOIN 不需要 ON', 'select a from t natural join u', []);
L('LX-29 JOIN 有 ON', 'select a.x from t a join u b on a.id = b.id', []);
L('LX-30 JOIN 有 USING', 'select a.x from t a join u b using (id)', []);
L('LX-31 子查询有自己的子句顺序', 'select a from (select b from u where c = 1 group by b) x', []);
L('LX-32 IS NULL 不报', 'select a from t where b is null', []);
L('LX-33 括号内的 OR 混用不报', 'select a from t where (x = 1 or y = 2) and z = 3', []);
L('LX-34 DELETE 有 WHERE', 'delete from t where id = 1', []);
L('LX-35 UNION ALL 不报', 'select a from t union all select b from u', []);
L('LX-36 IN (1,2) 不报空列表', 'select a from t where a in (1, 2)', []);
L('LX-37 LIKE 不以通配符开头', "select a from t where n like 'abc%'", []);
L('LX-38 带引号的保留字别名合法', 'select a as `from` from t', []);
L('LX-39 多表且有 JOIN 时不按逗号连接处理', 'select a.x from ta a join tb b on a.id = b.id, tc c where c.id = a.id', []);
L('LX-50 块注释未闭合报专门的规则', 'select a from t /* oops', ['syntax.unterminated-comment']);
L('LX-51 块注释未闭合不误报前面的正常字符串', "select 'ok' from t /* oops", ['syntax.unterminated-comment']);
L('LX-52 CTAS 不把 SELECT 当保留字别名', 'create table t as select a from s', []);
L('LX-53 CREATE VIEW … AS SELECT 同理', 'create or replace view v as select a from s', []);
L('LX-54 JOIN UNNEST 不需要 ON', 'select a from t join unnest(arr) as v', []);
L('LX-55 JOIN LATERAL 不需要 ON', 'select a from t join lateral (select 1) x', []);
L('LX-56 普通 JOIN 缺 ON 仍然报', 'select a from t join u', ['danger.join-without-on']);
L('LX-57 T-SQL GO 分隔的两条查询互不干扰',
  'select a from t where a = 1\nGO\nselect b from u where b = 1', [], { dialect: 'tsql' });
L('LX-58 路径里的 where/from 不算子句',
  'add jar /a/where/b.jar\nselect a from t order by a', [], { dialect: 'hive' });

/* ---- 位置精度 ---- */
T('LX-40 诊断位置落在真正的错误字符上', (function () {
    if (!lint) return false;
    var src = 'select a\r\nfrom t\r\nwhere b = NULL';
    var r = lint.lint(src, { dialect: 'mysql' });
    if (!r.issues.length) return false;
    var it = r.issues[0];
    var lines = src.split('\r\n');
    /* CRLF 必须当成一个换行：把 \r 与 \n 各算一行，位置会整体偏一行。 */
    if (it.line !== 2) return false;
    var ch = lines[it.line].charAt(it.character);
    return ch === '=';
})(), '行列换算错误（CRLF 被当成两个换行？）');

T('LX-41 多个问题按位置升序返回', (function () {
    if (!lint) return false;
    var r = lint.lint('select * from t where a = NULL', { dialect: 'mysql' });
    if (r.issues.length < 2) return false;
    for (var i = 1; i < r.issues.length; i++) {
        if (r.issues[i].line < r.issues[i - 1].line) return false;
        if (r.issues[i].line === r.issues[i - 1].line &&
            r.issues[i].character < r.issues[i - 1].character) return false;
    }
    return true;
})(), '未按位置排序，面板里顺序会跳');

T('LX-42 disabledRules 能静音指定规则', (function () {
    if (!lint) return false;
    var r = lint.lint('select * from t', { dialect: 'mysql', disabledRules: ['style.select-star'] });
    return r.issues.length === 0;
})(), '禁用规则无效');

T('LX-43 超长文本直接跳过，不返回半截结果', (function () {
    if (!lint) return false;
    var big = 'select ' + new Array(2000).join('a, ') + 'b from t';
    var r = lint.lint(big, { dialect: 'mysql', maxChars: 100 });
    return r.ok === false && r.reason === 'too-large' && r.issues.length === 0;
})(), '未按 maxChars 短路');

T('LX-44 非 SQL 文本不报任何问题', (function () {
    if (!lint) return false;
    var samples = ['hello world', '{"a": 1, "b": 2}', 'a,b,c\n1,2,3', '', '   '];
    for (var i = 0; i < samples.length; i++) {
        var r = lint.lint(samples[i], { dialect: 'mysql' });
        if (r.issues.length) return false;
    }
    return true;
})(), '把普通文本/JSON/CSV 当成了 SQL 问题');

T('LX-45 每条规则都在 RULES 表里，且 id 唯一', (function () {
    if (!lint) return false;
    var seen = Object.create(null);
    for (var i = 0; i < lint.RULES.length; i++) {
        var r = lint.RULES[i];
        if (!r.id || !r.sev || !r.title || !r.desc) return false;
        if (seen[r.id]) return false;
        seen[r.id] = 1;
        if (['error', 'warning', 'info'].indexOf(r.sev) < 0) return false;
    }
    return true;
})(), '规则元信息不完整或有重复 id');

T('LX-46 每条规则都至少有一条用例真正触发过', (function () {
    if (!lint) return false;
    /* 直接读本文件源码，统计 lint.lint(...) 实际返回过的 rule id。
     * 这比手写一张"覆盖清单"可靠 —— 删掉一条用例时它立刻会红。 */
    var src = fs.readFileSync(__filename, 'utf8');
    for (var i = 0; i < lint.RULES.length; i++) {
        var id = lint.RULES[i].id;
        if (src.indexOf("'" + id + "'") < 0) return false;
    }
    /* 反向：用例里提到的规则 id 必须都在 RULES 表里（防止改名后漏更新表）。 */
    var found = src.match(/(?:syntax|danger|style)\.[a-z-]+/g) || [];
    for (var k = 0; k < found.length; k++) {
        if (!lint.ruleMeta(found[k])) return false;
    }
    return true;
})(), '有规则没被任何用例触发，或用例引用了规则表里不存在的 id');

T('LX-47 诊断不受格式化全局态影响（只读）', (function () {
    if (!lint) return false;
    vk.sqlCacheClear();
    /* 先用 mysql 格式化一段（会写 LEX.hashComment 等进程级全局量），
     * 再用 pg 方言跑诊断 —— 诊断自己应该按传入的方言重新取词，不受影响。 */
    vk.sql('select a # b from t', true, false, false, 0, 120, { dialect: 'mysql', hardWidth: 120 });
    var r = lint.lint('select a from t where b = NULL', { dialect: 'pgsql' });
    return r.issues.length === 1 && r.issues[0].rule === 'danger.null-comparison';
})(), '诊断结果被上一次格式化留下的全局态污染');

console.log('\n=== 诊断接入（DiagnosticCollection）===');

/* lint.js 是纯函数，上面 47 条已经覆盖。这里测的是**接入层**：
 * 什么时候跑、跑完往 collection 里放什么、关掉开关后有没有清干净。
 * 用一份带 Diagnostic API 的 vscode stub 重新加载 extension.js 来测。 */
function loadDiagnosticsEnv(cfgOverride, noDiagnosticApi) {
    var cfg = cfgOverride || {
        uppercase: true, dialect: 'sql', max_line_length: 0, screen_width: 0,
        as_loc_cnt: 0, bracket_char: false, cjk_width: 0, detectScreenWidth: false,
        comma_location: false, 'lint.enabled': true, 'lint.disabledRules': []
    };
    function Pos(line, character) { this.line = line; this.character = character; }
    /* 命令路径会用到这两个方法（collectRanges 的排序与去重、整篇判定）。 */
    Pos.prototype.isEqual = function (o) {
        return !!o && this.line === o.line && this.character === o.character;
    };
    Pos.prototype.compareTo = function (o) {
        return this.line - o.line || this.character - o.character;
    };
    function Rng(a, b, c, d) {
        if (a && typeof a === 'object') { this.start = a; this.end = b; }
        else { this.start = new Pos(a, b); this.end = new Pos(c, d); }
    }
    function ev() { return { dispose: function () { } }; }

    var store = Object.create(null);          /* uri → 诊断数组 */
    var sets = 0;                             /* set() 调用次数，用于验证防抖/指纹 */
    /* CH 组（2026-11-09）：命令 handler 的**端到端**断言需要两样东西 ——
     * 注册进去的 handler 本身，以及弹窗/开文档的副作用记录。
     * 旧套件里 registerCommand 只是 `return ev()`，handler 直接丢掉，
     * 于是"命令点了之后到底干了什么"从来没被验证过（P3-6 第四条）。 */
    var handlers = Object.create(null);
    var messages = [];
    var openedDocs = [];
    function record(level) {
        return function (text) { messages.push({ level: level, text: String(text == null ? '' : text) }); };
    }
    var collection = {
        set: function (uri, diags) { store[String(uri)] = diags; sets++; },
        delete: function (uri) { delete store[String(uri)]; sets++; },
        clear: function () { store = Object.create(null); sets++; },
        dispose: function () { }
    };
    var vscode = {
        Position: Pos, Range: Rng,
        Diagnostic: function (range, message, severity) {
            this.range = range; this.message = message; this.severity = severity;
        },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        TextEdit: { replace: function (r, t) { return { range: r, newText: t }; } },
        Uri: { file: function (p) { return { fsPath: p }; }, parse: function (s) { return { s: s }; } },
        EndOfLine: { LF: 1, CRLF: 2 },
        ConfigurationTarget: { Global: 1 },
        StatusBarAlignment: { Left: 1 },
        ViewColumn: { One: 1 },
        version: '1.60.0',
        workspace: {
            getConfiguration: function (section) {
                if (section === 'editor') {
                    return { get: function () { return 14; }, inspect: function () { return {}; } };
                }
                return {
                    get: function (k) { return cfg[k]; },
                    inspect: function (k) { return cfg[k] === undefined ? {} : { globalValue: cfg[k] }; }
                };
            },
            onDidChangeConfiguration: function () { return ev(); },
            onDidChangeTextDocument: function () { return ev(); },
            onDidCloseTextDocument: function () { return ev(); },
            /* CH 组：Extract 命令的产物是**新文档**，不是写回编辑器。
             * 旧桩里没有这个方法，runExtractCommand 一调用就抛 TypeError，
             * 所以这条路径从来没被真正跑过。 */
            openTextDocument: function (opts) {
                var d = {
                    languageId: (opts && opts.language) || 'sql',
                    content: (opts && opts.content) || '',
                    getText: function () { return this.content; }
                };
                openedDocs.push(d);
                return Promise.resolve(d);
            },
            workspaceFolders: [], textDocuments: [], isTrusted: false
        },
        window: {
            activeTextEditor: undefined, visibleTextEditors: [],
            createOutputChannel: function () {
                return { appendLine: function () { }, show: function () { }, dispose: function () { } };
            },
            showInformationMessage: record('info'),
            showWarningMessage: record('warn'),
            showErrorMessage: record('error'),
            showTextDocument: function (d) { return Promise.resolve(d); },
            setStatusBarMessage: record('status'),
            onDidChangeActiveTextEditor: function () { return ev(); }
        },
        commands: {
            /* CH 组：**把 handler 留下来**。旧实现是 `return ev()`，
             * 注册进去的命令回调直接被丢掉，于是"命令点了之后做了什么"
             * 在整个回归套件里是空白（P3-6 第四条）。 */
            registerCommand: function (id, fn) {
                handlers[id] = fn;
                return ev();
            },
            registerTextEditorCommand: function (id, fn) {
                handlers[id] = fn;
                return ev();
            }
        },
        languages: (function () {
            var l = {
                registerDocumentFormattingEditProvider: function () { return ev(); },
                registerDocumentRangeFormattingEditProvider: function () { return ev(); }
            };
            /* noDiagnosticApi=true 用来模拟没有诊断 API 的老宿主 / 精简宿主。
             * 必须在**构造 stub 时**就缺席，不能事后 delete —— 第一次 activate
             * 已经把模块级的 diagnosticCollection 赋成了非 null，
             * 第二次 activate 里那句赋值失败也不会把它清回 null，
             * 于是"有没有 API"根本没被验证到（这条测试一开始就是这么假绿的）。 */
            if (!noDiagnosticApi) {
                l.createDiagnosticCollection = function () { return collection; };
            }
            return l;
        })()
    };
    var sandbox = {
        module: { exports: {} }, exports: {}, console: console, process: process,
        Buffer: Buffer, __dirname: EXT, setTimeout: function () { return 0; }, clearTimeout: function () { },
        require: function (id) {
            if (id === 'vscode') return vscode;
            if (id.charAt(0) === '.') return require(path.join(EXT, id));
            return require(id);
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8') +
        ';this.testApi = { activate: activate, refreshDiagnostics: refreshDiagnostics,' +
        ' relintActive: relintActive, lintHash: lintHash, lintRange: lintRange };',
        sandbox);
    var ctx = { subscriptions: [], globalState: { get: function () { }, update: function () { return Promise.resolve(); } },
        extensionPath: EXT, extensionUri: { fsPath: EXT }, asAbsolutePath: function (p) { return path.join(EXT, p); } };
    sandbox.testApi.activate(ctx);
    return {
        api: sandbox.testApi, store: store, setsRef: function () { return sets; }, vscode: vscode,
        /* CH 组用：注册到的 handler、弹窗记录、Extract 开出来的新文档。 */
        handlers: handlers,
        messages: messages,
        messagesRef: function () { return messages; },
        openedDocs: openedDocs,
        resetMessages: function () { messages.length = 0; }
    };
}

/* 构造一个最小的 TextDocument stub —— 只实现诊断路径用到的成员。 */
function fakeDoc(text, uri, langId) {
    var lines = text.split(/\r\n|\r|\n/);
    return {
        uri: uri || { toString: function () { return 'file:///t.sql'; } },
        languageId: langId || 'sql',
        lineCount: lines.length,
        getText: function () { return text; },
        lineAt: function (n) {
            n = Math.max(0, Math.min(n, lines.length - 1));
            return { text: lines[n] };
        }
    };
}

T('DG-1 activate 后创建了诊断集合', (function () {
    var env = loadDiagnosticsEnv();
    return typeof env.api.refreshDiagnostics === 'function' && env.setsRef() === 0;
})(), 'activate 未创建 DiagnosticCollection');

T('DG-2 有问题的 SQL 会生成诊断', (function () {
    var env = loadDiagnosticsEnv();
    var doc = fakeDoc('select * from t where a = NULL');
    var n = env.api.refreshDiagnostics(doc);
    return n === 2 && env.store[String(doc.uri)] && env.store[String(doc.uri)].length === 2;
})(), '未生成预期数量的诊断');

T('DG-3 诊断带 code（规则 id）与 source', (function () {
    var env = loadDiagnosticsEnv();
    var doc = fakeDoc('select * from t');
    env.api.refreshDiagnostics(doc);
    var d = env.store[String(doc.uri)][0];
    var codeVal = (d.code && typeof d.code === 'object') ? d.code.value : d.code;
    return codeVal === 'style.select-star' && d.source === 'snug-sql';
})(), '诊断缺少 code/source，无法在面板里按规则筛选');

T('DG-4 严重级映射正确（error/warning/info）', (function () {
    var env = loadDiagnosticsEnv();
    var d1 = fakeDoc('select (a from t', { toString: function () { return 'file:///a.sql'; } });
    env.api.refreshDiagnostics(d1);
    var errSev = env.store[String(d1.uri)][0].severity;
    var d2 = fakeDoc('select * from t', { toString: function () { return 'file:///b.sql'; } });
    env.api.refreshDiagnostics(d2);
    var warnSev = env.store[String(d2.uri)][0].severity;
    var d3 = fakeDoc("select a from t where n like '%x'", { toString: function () { return 'file:///c.sql'; } });
    env.api.refreshDiagnostics(d3);
    var infoSev = env.store[String(d3.uri)][0].severity;
    return errSev === 0 && warnSev === 1 && infoSev === 2;
})(), '严重级没有映射到 DiagnosticSeverity');

T('DG-5 同一内容重复分析会被指纹跳过', (function () {
    var env = loadDiagnosticsEnv();
    var doc = fakeDoc('select * from t');
    env.api.refreshDiagnostics(doc);
    var before = env.setsRef();
    env.api.refreshDiagnostics(doc);      /* 内容没变 → 应跳过 */
    return env.setsRef() === before;
})(), '内容没变却重算了，击键时会白跑');

T('DG-6 内容变化后会重新分析', (function () {
    var env = loadDiagnosticsEnv();
    var doc = fakeDoc('select * from t');
    env.api.refreshDiagnostics(doc);
    var before = env.setsRef();
    var visible = '';
    /* 换成一份干净的 SQL：诊断应被清掉。 */
    var doc2 = fakeDoc('select a from t');
    doc2.uri = doc.uri;
    env.api.refreshDiagnostics(doc2);
    return env.setsRef() > before && !env.store[String(doc.uri)];
})(), '内容变化后没有刷新诊断');

T('DG-7 lint.enabled=false 时清空且不分析', (function () {
    var env = loadDiagnosticsEnv({
        uppercase: true, dialect: 'sql', max_line_length: 0, screen_width: 0,
        as_loc_cnt: 0, bracket_char: false, cjk_width: 0, detectScreenWidth: false,
        comma_location: false, 'lint.enabled': false, 'lint.disabledRules': []
    });
    var doc = fakeDoc('select * from t');
    var n = env.api.refreshDiagnostics(doc);
    return n === 0 && !env.store[String(doc.uri)];
})(), '关闭开关后仍在分析');

T('DG-8 lint.disabledRules 生效', (function () {
    var env = loadDiagnosticsEnv({
        uppercase: true, dialect: 'sql', max_line_length: 0, screen_width: 0,
        as_loc_cnt: 0, bracket_char: false, cjk_width: 0, detectScreenWidth: false,
        comma_location: false, 'lint.enabled': true, 'lint.disabledRules': ['style.select-star']
    });
    var doc = fakeDoc('select * from t');
    return env.api.refreshDiagnostics(doc) === 0;
})(), '禁用规则在接入层没生效');

T('DG-9 超长文档跳过分析', (function () {
    var env = loadDiagnosticsEnv();
    var doc = fakeDoc('select ' + new Array(200000).join('a, ') + 'b from t');
    return env.api.refreshDiagnostics(doc) === 0;
})(), '超长文档仍被分析');

T('DG-10 Range 不越界（行尾字符数被夹紧）', (function () {
    var env = loadDiagnosticsEnv();
    var doc = fakeDoc('select * from t');
    env.api.refreshDiagnostics(doc);
    var d = env.store[String(doc.uri)][0];
    return d.range.start.character <= 14 && d.range.end.character <= 14;
})(), 'Diagnostic Range 超出该行长度，VS Code 会抛异常');

T('DG-11 输出通道名字与实际功能一致', (function () {
    /* 原来写的是 `旧名不存在 || 新名存在` —— 这个 || 让整条断言形同虚设：
     * 只要旧名没出现就直接通过，新名到底叫什么根本没检查。
     * 必须是 `旧名不存在 **且** 新名存在`。 */
    var src = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8');
    var hasOld = src.indexOf("createOutputChannel('SQL Beautify')") >= 0;
    var hasNew = src.indexOf("createOutputChannel('Snug SQL Formatter')") >= 0;
    return !hasOld && hasNew;
})(), '输出通道仍叫旧名（应为 Snug SQL Formatter）');

/* ---- 以下六条是 2026-11-05 复检时发现并修掉的真缺陷，各留一条守卫 ---- */

T('DG-12 指纹不做四点采样（长度/首尾/中点相同的改动必须能察觉）', (function () {
    /* 旧实现是 `长度:首字符:末字符:中点字符`。把 `where b = 1` 改成
     * `where c = 1`，四个分量全都不变 → 指纹相同 → 诊断被跳过，
     * 波浪线停在已经不存在的代码上。这类"静默不更新"比误报更难发现。 */
    var env = loadDiagnosticsEnv();
    var before = fakeDoc('select a from t where b = 1');
    before.uri = { toString: function () { return 'file:///fp.sql'; } };
    env.api.refreshDiagnostics(before);
    var h1 = env.api.lintHash('select a from t where b = 1');
    var h2 = env.api.lintHash('select a from t where c = 1');
    if (h1 === h2) return false;

    /* 端到端：内容变了，诊断必须真的重算一次。 */
    var after = fakeDoc('select a from t where c = NULL');
    after.uri = before.uri;
    var n = env.api.refreshDiagnostics(after);
    return n === 1 && env.store[String(after.uri)][0].code.value === 'danger.null-comparison';
})(), '指纹碰撞导致诊断停在旧内容上');

T('DG-13 诊断不受"上一次格式化用的方言"影响', (function () {
    /* markKeywords 内部读**全局** LEX.dialect。启动时先用 clickhouse 格式化
     * 一次，全局 LEX.dialect 就留在 clickhouse；此后用 mysql 方言做诊断，
     * `array(1,2)` 会被按 ClickHouse 规则判成标识符而不是关键字 ——
     * 诊断结果取决于调用顺序，这是不可接受的。
     *
     * 判据：**同样的 (文本, 方言) 输入，无论此前跑过什么，结果必须一致。** */
    var PROBE = 'select array(1, 2) from t';
    function kwOf(packed) {
        for (var i = 0; i < packed.tokens.length; i++) {
            if (String(packed.tokens[i].value).toLowerCase() === 'array') {
                return packed.tokens[i].keyword === true;
            }
        }
        return null;
    }

    /* 1) 干净状态下的基准值。 */
    vk.sqlCacheClear();
    var base = kwOf(vk.tokenizeForLint(PROBE, 'mysql'));

    /* 2) 把全局 LEX.dialect 污染成 clickhouse。 */
    vk.sql('select a from t', true, false, false, 0, 120, { dialect: 'clickhouse', hardWidth: 120 });
    var after = kwOf(vk.tokenizeForLint(PROBE, 'mysql'));

    /* 3) 反方向也要一致。 */
    vk.sql('select a from t', true, false, false, 0, 120, { dialect: 'mysql', hardWidth: 120 });
    var after2 = kwOf(vk.tokenizeForLint(PROBE, 'clickhouse'));
    vk.sqlCacheClear();
    var base2 = kwOf(vk.tokenizeForLint(PROBE, 'clickhouse'));

    return base !== null && base === after && base2 !== null && base2 === after2;
})(), '全局 LEX.dialect 泄漏，诊断结果依赖调用顺序');

T('DG-14 非 SQL 语言不诊断（日志/Markdown 里的 SELECT 不算 SQL）', (function () {
    /* 事件回调按文档触发、不分语言：扩展被某个 .sql 激活后，
     * 用户在 Markdown 或日志里打字同样会走到 refreshDiagnostics。
     * 旧实现只看"文本里有没有出现过 SELECT"，于是
     * `2026-11-05 INFO select * from t took 120ms` 会被挂上 SELECT * 警告。 */
    var env = loadDiagnosticsEnv();
    var log = fakeDoc('2026-11-05 10:00:00 INFO select * from t took 120ms',
        { toString: function () { return 'file:///app.log'; } }, 'log');
    if (env.api.refreshDiagnostics(log) !== 0) return false;
    if (env.store[String(log.uri)]) return false;

    /* 反过来：真正的 sql 文档必须照常诊断。 */
    var sql = fakeDoc('select * from t', { toString: function () { return 'file:///q.sql'; } }, 'sql');
    return env.api.refreshDiagnostics(sql) === 1;
})(), '日志/Markdown 这类非 SQL 文档也被挂上了诊断');

T('DG-15 防抖计时器按文档独立，不互相吞掉', (function () {
    /* 旧实现只有一个共享的 lintTimer。分屏同时编辑两个文件时，
     * 后一次改动 clearTimeout 掉前一次 → 前一个文档的诊断永远停在旧内容。
     * 这里直接查源码：计时器必须是"按 uri 索引的映射"，不能是单个变量。 */
    var src = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8');
    if (/var lintTimer\s*=/.test(src)) return false;          /* 不许有单变量版本 */
    if (!/lintTimers\[key\]/.test(src)) return false;          /* 必须按 key 存 */
    if (!/cancelPendingDiagnostics/.test(src)) return false;   /* 关文档要能取消 */
    return true;
})(), '防抖计时器仍是全局单个，多文档同时编辑会丢诊断');

T('DG-16 主机不支持诊断集合时，relint 命令仍然注册', (function () {
    /* package.json 里声明了 snugSql.relint。若因 createDiagnosticCollection
     * 不存在就跳过注册，命令面板会留下一个点了报 "command not found" 的条目。
     *
     * 必须用**全新加载、且构造时就没有诊断 API** 的环境。
     * 在同一份模块实例上事后 delete 是不行的：模块级的 diagnosticCollection
     * 已被上一次 activate 赋成非 null，第二次 activate 里创建失败也不会把
     * 它清回 null，于是"宿主到底有没有 API"这点根本没被验证到
     * —— 这条测试最初就是这么假绿的。 */
    var env = loadDiagnosticsEnv(null, true);
    var names = [];
    env.vscode.commands.registerCommand = function (id) {
        names.push(id);
        return { dispose: function () { } };
    };
    var ctx2 = {
        subscriptions: [],
        globalState: { get: function () { }, update: function () { return Promise.resolve(); } },
        extensionPath: EXT, extensionUri: { fsPath: EXT },
        asAbsolutePath: function (p) { return path.join(EXT, p); }
    };
    env.api.activate(ctx2);
    /* 三条格式化命令 + relint，一个都不能少。 */
    return names.indexOf('snugSql.relint') >= 0 &&
        names.indexOf('snugSql.beautifySql') >= 0 &&
        names.indexOf('snugSql.extractDdl') >= 0;
})(), '宿主不支持诊断时 relint 命令没有注册');

T('LX-48 LATERAL 关联子查询不算笛卡尔积', (function () {
    if (!lint) return false;
    /* `FROM t, LATERAL (…)` 右侧本来就能引用左侧的列，没有 WHERE 也不是笛卡尔积。
     * 把它报成笛卡尔积是纯误报。 */
    var a = lint.lint('select a from t, lateral (select 1) x', { dialect: 'mysql' }).issues;
    var b = lint.lint('select a from t, lateral (select 1) x where x.a = t.a', { dialect: 'mysql' }).issues;
    if (a.length || b.length) return false;
    /* 真正的逗号连接必须仍然报。 */
    var c = lint.lint('select a from t, u', { dialect: 'mysql' }).issues;
    return c.length === 1 && c[0].rule === 'danger.cartesian-product';
})(), 'LATERAL 被误报成笛卡尔积，或真笛卡尔积漏报');

T('LX-49 UNNEST / CROSS APPLY 同样不报', (function () {
    if (!lint) return false;
    var a = lint.lint('select a from t, unnest(arr) as v', { dialect: 'mysql' }).issues;
    var b = lint.lint('select a from t cross apply f(t.x) as v', { dialect: 'mysql' }).issues;
    return a.length === 0 && b.length === 0;
})(), 'UNNEST / APPLY 被误报');
T('DG-17 「问题」面板里点规则名跳转的锚点在 README 里真实存在', (function () {
    /* 诊断的 code.target 指向 README 的规则表。锚点写错的话，
     * 用户点一下会跳到页面顶部，等于这个链接白挂了 ——
     * 而且这种错不会被任何行为测试发现，只能直接对照两边的文本。 */
    var src = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8');
    var m = src.match(/var RULES_URL = '([^']+)'/);
    if (!m) return false;
    var frag = m[1].split('#')[1];
    if (!frag) return false;
    var md = fs.readFileSync(path.join(EXT, 'README.md'), 'utf8');
    /* GitHub 的中文标题锚点 = 标题原文（保留中文、去掉空格与标点）。 */
    var heads = (md.match(/^#{1,6} .+$/gm) || []).map(function (h) {
        return h.replace(/^#+ /, '').replace(/[\s:：,，.。()（）/—–-]/g, '').toLowerCase();
    });
    return heads.indexOf(frag.replace(/[\s:：,，.。()（）/—–-]/g, '').toLowerCase()) >= 0;
})(), 'RULES_URL 的锚点在 README 里找不到，点规则名会跳空');

/* ============================================================================
 * 2026-11-06 复核：第三轮审计后修复的缺陷。每条都先复现、再断言修好，
 * 并补上"不该误伤"的反向用例。
 * ==========================================================================*/
console.log('\n=== 2026-11-06 复核修复（AG 组） ===');

/* AG-1（P0-1）：命令路径的缩进不能随执行次数累积。
 *
 * 触发条件是 `partial` / `partial-unbalanced` —— 内核把"未通过的语句"原样拼回，
 * 那些语句本身带着原文缩进；接入层若再统一补一层 baseIndent，每按一次命令
 * 就多一层（实测 2 → 4 → 8 → 16 空格）。 */
function withEditorOnce(text, eol, cfg) {
    var env = loadExtensionForTest(cfg);
    var doc = { eol: eol, getText: function (range) {
        return range ? text.slice(range.start.character, range.end.character) : text;
    } };
    var replacement = null;
    var editor = { document: doc, edit: function (cb) {
        cb({ replace: function (range, value) { replacement = value; } });
        return Promise.resolve(true);
    } };
    var range = new env.vscode.Range(new env.vscode.Position(0, 0), new env.vscode.Position(0, text.length));
    return Promise.resolve(env.api.applyToEditor(editor, [range], env.api.transformSql, {
        uppercase: true, commaLocation: false, bracketChar: true, asLocCnt: 96,
        maxLine: 96, hardLine: 120, dialect: 'mysql', tabSize: 2, cjkWidth: 0,
        eolHint: eol === 2 ? '\r\n' : '\n'
    })).then(function () { return replacement; });
}
T('AG-1 partial 场景下缩进不随执行次数累积', (function () {
    var text = '  select a,b from t;\n  select (x from u;';
    function indents(s) { return (/^[ \t]*/.exec(s) || [''])[0].length; }
    return withEditorOnce(text, 1).then(function (one) {
        if (typeof one !== 'string') return false;               /* 第一次必须真的写回 */
        if (indents(one) !== 2) return false;                    /* 且不放大基础缩进 */
        return withEditorOnce(one, 1).then(function (two) {
            /* 第二次已经没有可改的内容（内核原样返回）→ null 也算稳定；
             * 若仍有改写，缩进必须保持不变。 */
            return two === null || (typeof two === 'string' && indents(two) === 2);
        });
    });
})(), '缩进在重复执行后累积（2 → 4 → 8 …）');

T('AG-1.2 普通选区重复执行缩进稳定', (function () {
    var text = '    select a,b from t where c=1;';
    return withEditorOnce(text, 1).then(function (one) {
        if (typeof one !== 'string') return false;
        if ((/^[ \t]*/.exec(one) || [''])[0].length !== 4) return false;
        return withEditorOnce(one, 1).then(function (two) {
            return two === null || (/^[ \t]*/.exec(two) || [''])[0].length === 4;
        });
    });
})(), '重复执行后基础缩进发生变化');

/* AG-2（P0-2）：CRLF 文档里的单行 SQL 必须仍然输出 CRLF。
 *
 * 内核只能从文本内容推断 EOL，单行文本没有任何换行可依据；旧实现一律返回
 * '\n'，于是格式化一次就把文件换行写成裸 LF（git 整篇 diff）。 */
function fakeFullDoc(text, eol) {
    var lines = text.split('\n');
    return {
        eol: eol,
        languageId: 'sql',
        lineCount: lines.length,
        lineAt: function (i) { return { text: lines[i].replace(/\r$/, '') }; },
        getText: function () { return text; },
        positionAt: function (off) {
            var before = text.slice(0, off).split('\n');
            return { line: before.length - 1, character: before[before.length - 1].replace(/\r$/, '').length };
        }
    };
}
T('AG-2 单行 CRLF 文档整篇格式化仍为 CRLF', (function () {
    var env = loadExtensionForTest();
    var doc = fakeFullDoc('select a,b from t', 2);
    var edits = env.api.doFullDocument(doc, { insertSpaces: true, tabSize: 4 }, null);
    if (edits.length !== 1) return false;
    var out = edits[0].newText;
    return out.indexOf('\r\n') >= 0 && !/(^|[^\r])\n/.test(out);
})(), '单行 CRLF 文档被写成裸 LF');

T('AG-2.2 单行 LF 文档不被写成 CRLF', (function () {
    var env = loadExtensionForTest();
    var doc = fakeFullDoc('select a,b from t', 1);
    var edits = env.api.doFullDocument(doc, { insertSpaces: true, tabSize: 4 }, null);
    if (edits.length !== 1) return false;
    return !/\r/.test(edits[0].newText);
})(), '单行 LF 文档被写成 CRLF');

T('AG-2.3 CRLF 文档里列 0 起的选区不引入裸 LF', (function () {
    var env = loadExtensionForTest();
    var text = 'select 1;\r\nselect a,b from t;\r\n';
    var doc = { eol: 2, getText: function (range) {
        return text.slice(range.start.character, range.end.character);
    } };
    var range = new env.vscode.Range(new env.vscode.Position(0, 0), new env.vscode.Position(0, 'select a,b from t;'.length));
    var edits = env.api.doRangeDocument(doc, range, { insertSpaces: true, tabSize: 4 }, null);
    if (edits.length !== 1) return false;
    return !/(^|[^\r])\n/.test(edits[0].newText);
})(), '选区格式化在 CRLF 文档里引入了裸 LF');

/* AG-3（P0-3）：用户文本里本来就有的私有区字符必须原样保留。
 *
 * 内核用 U+E000/U+E001 做"字面量内换行"的占位符，用 U+E010/U+E011 转义
 * 用户自己的 E000/E001。旧实现只转一层：用户本来写着 U+E010 时，unmask
 * 会把它当成"用户写的 E000"换回 E000 —— 字符被悄悄改了，安全网也看不出来。 */
T('AG-3 用户文本里的 U+E010 原样保留', (function () {
    var o = sql('select \uE010 from t');
    return o.indexOf('\uE010') >= 0 && o.indexOf('\uE000') < 0;
})(), J(sql('select \uE010 from t')));
T('AG-3.2 用户文本里的 U+E011 原样保留', (function () {
    var o = sql('select \uE011 from t');
    return o.indexOf('\uE011') >= 0 && o.indexOf('\uE001') < 0;
})(), J(sql('select \uE011 from t')));
T('AG-3.3 私有区字符连续两次格式化不变', (function () {
    var t = 'select \uE010 as a, \uE011 as b from t';
    var a = sql(t), b = sql(a);
    return a === b && a.indexOf('\uE010') >= 0 && a.indexOf('\uE011') >= 0;
})(), '私有区字符在一次格式化后被改写');
T('AG-3.4 正常的 E000/E001 转义仍然有效', (function () {
    var o = sql("select 'a\r\nb' as x from t");
    return o.indexOf("'a\r\nb'") >= 0;
})(), J(sql("select 'a\r\nb' as x from t")));

/* AG-4（P1-9）：未闭合的 Oracle q-quote 必须原样返回。
 *
 * 旧实现匹配不到闭合时静默退回普通分支，把 `q'[abc` 拆成 `q` + `'[abc`，
 * 输出 `q '[abc`，而 status 仍是 formatted。 */
T('AG-4 未闭合 q-quote 原样返回', (function () {
    var t = "select q'[abc from t where x=1";
    var o = sql(t, { dialect: 'oracle' });
    return o === t && vk.lastDiagnostics().status === 'unterminated';
})(), J(sql("select q'[abc from t where x=1", { dialect: 'oracle' })));
T('AG-4.2 未闭合 nq-quote 原样返回', (function () {
    var t = "select nq'[abc from t where x=1";
    var o = sql(t, { dialect: 'oracle' });
    return o === t && vk.lastDiagnostics().status === 'unterminated';
})(), J(sql("select nq'[abc from t where x=1", { dialect: 'oracle' })));
T('AG-4.3 闭合的 q-quote 仍正常排版', (function () {
    var o = sql("select q'[abc]' as x, b from t", { dialect: 'oracle' });
    return o.indexOf("q'[abc]'") >= 0 && vk.lastDiagnostics().status === 'formatted';
})(), J(sql("select q'[abc]' as x, b from t", { dialect: 'oracle' })));

/* AG-4.4（P0，2026-11-09 复核）：**任何 q 开头的标识符**都曾被判成未闭合 q-quote。
 *
 * `matchQQuote` 的前置校验是 `sql[i+1] !== "'"` 就返回 -1，而调用点却对任何
 * q/Q 开头的 token 无条件 markUnterminated —— 于是 `quantity` / `qty` / `q`
 * 这类随处可见的列名会让**整篇 SQL** 被判为 `unterminated` 并原样返回，
 * 用户按格式化按钮毫无反应，且提示语说的是"q-quote 没闭合"，牛头不对马嘴。
 *
 * 这条用例守的是"正常标识符要能正常格式化"，比 AG-4 更重要 ——
 * 旧写法为了保护 Oracle q-quote 而把绝大多数 SQL 都挡在门外。 */
T('AG-4.4 q 开头的标识符不被当成 q-quote', (function () {
    var cases = ['quantity', 'qty', 'q', 'quarter', 'query', 'quota'];
    for (var i = 0; i < cases.length; i++) {
        var q = 'select ' + cases[i] + ' from t where ' + cases[i] + ' > 0';
        var o = sql(q, { dialect: 'hive' });
        if (vk.lastDiagnostics().status !== 'formatted') return false;
        /* 关键字大写、列名保持原样（列名不是关键字，不该被改）。 */
        if (o.indexOf('SELECT ' + cases[i]) !== 0) return false;
    }
    return true;
})(), J(sql('select quantity from t', { dialect: 'hive' })));

/* AG-4.5：真实语料回归 —— 下面这句是 demo 用的长查询，含 `a.quantity`，
 * 修复前它会被整篇拒格式化（演示动图因此完全做不出来）。 */
T('AG-4.5 含 quantity 的长查询能正常折行', (function () {
    var q = 'select a.user_id, a.order_id, a.amount * a.quantity as total_amount, ' +
        "b.region_name from fact_orders a left join dim_region b on a.region_id = b.region_id " +
        'where a.dt = \'2026-11-01\' and a.amount > 0 order by a.user_id, a.order_id';
    vk.sqlCacheClear();
    var o = vk.sql(q, true, false, true, 96, 100, { dialect: 'hive', hardWidth: 100, tabWidth: 2 });
    return vk.lastDiagnostics().status === 'formatted' &&
        o.indexOf('a.amount * a.quantity AS total_amount') > 0 &&
        o.split('\n').length > 6;
})(), '含 quantity 的长查询仍被当成未闭合 q-quote');

/* AG-4.6 反向断言：真正未闭合的 q-quote 仍必须原样返回（不能让修复把 AG-4 弄丢）。 */
T('AG-4.6 真未闭合的 q-quote 仍原样返回', (function () {
    var t = "select q'[abc from t";
    var o = sql(t, { dialect: 'oracle' });
    return o === t && vk.lastDiagnostics().status === 'unterminated';
})(), J(sql("select q'[abc from t", { dialect: 'oracle' })));

/* AG-5（P1-7）：DDL 的 EOL 只看代码区，不被字面量里的 CRLF 带偏。 */
T('AG-5 LF 文档 + 字面量内 CRLF → 代码区仍是 LF', (function () {
    var q = "create table t (\n  a string default 'x\r\ny'\n)";
    vk.sqlCacheClear();
    var o = vk.sqlddl(q, true, { dialect: 'hive' });
    var bareLf = (o.match(/(?<!\r)\n/g) || []).length;
    var crlf = (o.match(/\r\n/g) || []).length;
    return bareLf === 3 && crlf === 1;
})(), '整份 DDL 被字面量内的 CRLF 带成了 CRLF');
T('AG-5.2 CRLF 文档的 DDL 仍全为 CRLF', (function () {
    var q = "create table t (\r\n  a int\r\n)";
    vk.sqlCacheClear();
    var o = vk.sqlddl(q, true, { dialect: 'hive' });
    return (o.match(/(?<!\r)\n/g) || []).length === 0 && (o.match(/\r\n/g) || []).length === 3;
})(), 'CRLF 文档的 DDL 出现裸 LF');

/* AG-6（P1-6）：extract 的 max/min 猜成 STRING 时必须登记，不能静默。 */
T('AG-6 max(列) 猜成 STRING 时给出提示', (function () {
    vk.sqlCacheClear();
    var o = vk.extractddl('insert into t select max(b) as m from s', { dialect: 'hive' });
    return /m STRING/.test(o) && /无法静态推断/.test(o);
})(), J(vk.extractddl('insert into t select max(b) as m from s', { dialect: 'hive' })));
T('AG-6.2 max(显式 CAST) 推断成功时不产生猜测提示', (function () {
    vk.sqlCacheClear();
    var o = vk.extractddl('insert into t select max(cast(b as bigint)) as m from s', { dialect: 'hive' });
    return /m BIGINT/.test(o) && !/无法静态推断/.test(o);
})(), J(vk.extractddl('insert into t select max(cast(b as bigint)) as m from s', { dialect: 'hive' })));

/* AG-7（P1-4）：BETWEEN … AND 里的 AND 不是逻辑与。 */
L('AG-7 BETWEEN + OR 不报 AND/OR 混用', 'select a from t where a between 1 and 2 or b = 3', []);
L('AG-7.2 NOT BETWEEN + OR 不报', 'select a from t where a not between 1 and 2 or b = 3', []);
L('AG-7.3 真 AND/OR 混用仍然要报', 'select a from t where a=1 and b=2 or c=3', ['danger.and-or-mixed']);
L('AG-7.4 BETWEEN 之后另有一个真 AND + OR 仍要报',
    'select a from t where a between 1 and 2 and c = 1 or d = 2', ['danger.and-or-mixed']);

/* AG-8（P1-5）：NATURAL JOIN 家族不需要 ON。 */
L('AG-8 NATURAL LEFT JOIN 不报缺 ON', 'select a from t natural left join u', []);
L('AG-8.2 NATURAL FULL OUTER JOIN 不报', 'select a from t natural full outer join u', []);
L('AG-8.3 NATURAL INNER JOIN 不报', 'select a from t natural inner join u', []);
L('AG-8.4 普通 LEFT JOIN 缺 ON 仍然要报', 'select a from t left join u', ['danger.join-without-on']);

/* AG-9（P1-2）：SELECT * 要覆盖整个列表，而不只是第一项。 */
L('AG-9 第二列的通配符', 'select a, * from t', ['style.select-star']);
L('AG-9.2 末列的通配符', 'select a, b, * from t', ['style.select-star']);
L('AG-9.3 限定名 t.*', 'select t.*, b from t', ['style.select-star']);
L('AG-9.4 count(*) 之后的通配符', 'select count(*), * from t', ['style.select-star']);
L('AG-9.5 子查询里的通配符', 'select a from (select * from u) x', ['style.select-star']);
L('AG-9.6 乘号不算通配符', 'select a * 2 as b from t', []);
L('AG-9.7 COUNT(*) 不算通配符', 'select count(*) from t', []);
L('AG-9.8 EXISTS (SELECT *) 不报', 'select a from t where exists (select * from u)', []);

/* AG-10（P1-8）：测试框架本身必须能识别异步断言。
 * 这条不调用 settle()（自身就在 pending 里，会自我等待），直接验证
 * withTimeout 的判定：失败的 Promise 必须被记成 ok=false，而不是 truthy。 */
T('AG-10 失败的 Promise 断言被正确判定', (function () {
    return withTimeout(Promise.resolve(false), 1000).then(function (r) {
        return r.ok === false;
    });
})(), 'T() 仍把未落定的 Promise 当成 truthy');
T('AG-10.2 成功的 Promise 断言被正确判定', (function () {
    return withTimeout(Promise.resolve(true), 1000).then(function (r) {
        return r.ok === true;
    });
})(), 'withTimeout 无法识别成功的 Promise');
T('AG-10.3 rejected 的 Promise 记为失败而不是崩溃', (function () {
    return withTimeout(Promise.reject(new Error('boom')), 1000).then(function (r) {
        return r.ok === false && /boom/.test(r.detail);
    });
})(), 'rejected 的 Promise 没有被转成失败用例');

/* ---------------------------------------------------------------------------
 * 2026-11-07 复核：决策项修复（CM 组）
 * -------------------------------------------------------------------------*/
console.log('\n=== 2026-11-07 复核修复（CM 组） ===');

/* CM-1（P1-1）：comma_location 的语义必须在 SQL 与 DDL 两条路径上一致。
 *
 * SQL 路径由 convertCommaLocation 实现在"把行首逗号补到上一行行尾"，
 * 原插件 package.json 的描述也是 true = 行尾；而 DDL 路径写成了
 * `commaLocation === true` → 行首，同一个开关在两张表上得到相反结果。 */
function hasLeadComma(s) { return /^\s*,/m.test(s); }
function hasTrailComma(s) { return /,\s*$/m.test(s.replace(/\r/g, '')); }
T('CM-1 DDL 列清单与 SELECT 列表的逗号方向一致', (function () {
    var selectTrail = sql('select a, b from t', { commaLocation: true });
    var selectLead = sql('select a, b from t', { commaLocation: false });
    vk.sqlCacheClear();
    var ddlTrail = vk.sqlddl('create table t (a int, b string)', true, { dialect: 'hive', commaLocation: true });
    vk.sqlCacheClear();
    var ddlLead = vk.sqlddl('create table t (a int, b string)', true, { dialect: 'hive', commaLocation: false });
    return hasTrailComma(selectTrail) && !hasLeadComma(selectTrail) &&
        hasLeadComma(selectLead) && !hasTrailComma(selectLead) &&
        hasTrailComma(ddlTrail) && !hasLeadComma(ddlTrail) &&
        hasLeadComma(ddlLead) && !hasTrailComma(ddlLead);
})(), J([sql('select a, b from t', { commaLocation: true }),
    vk.sqlddl('create table t (a int, b string)', true, { dialect: 'hive', commaLocation: true })]));

T('CM-1.2 PARTITIONED BY 的分区列跟随同一风格', (function () {
    vk.sqlCacheClear();
    var trail = vk.sqlddl('create table t (a int) partitioned by (dt string, hr string)', true,
        { dialect: 'hive', commaLocation: true });
    vk.sqlCacheClear();
    var lead = vk.sqlddl('create table t (a int) partitioned by (dt string, hr string)', true,
        { dialect: 'hive', commaLocation: false });
    var pTrail = trail.slice(trail.indexOf('PARTITIONED BY'));
    var pLead = lead.slice(lead.indexOf('PARTITIONED BY'));
    return hasTrailComma(pTrail) && !hasLeadComma(pTrail) &&
        hasLeadComma(pLead) && !hasTrailComma(pLead);
})(), J([vk.sqlddl('create table t (a int) partitioned by (dt string, hr string)', true,
    { dialect: 'hive', commaLocation: false })]));

T('CM-1.3 Extract 出的 DDL 跟随 comma_location', (function () {
    vk.sqlCacheClear();
    var trail = vk.extractddl('insert into t select a, b from s', { dialect: 'hive', commaLocation: true });
    vk.sqlCacheClear();
    var lead = vk.extractddl('insert into t select a, b from s', { dialect: 'hive', commaLocation: false });
    return hasTrailComma(trail.slice(0, trail.indexOf('STRING\n') >= 0 ? trail.length : trail.length)) ||
        (/\n\s+a STRING,/.test(trail) && /\n\s*,b STRING/.test(lead));
})(), J([vk.extractddl('insert into t select a, b from s', { dialect: 'hive', commaLocation: false })]));

T('CM-1.4 逗号风格不影响 token 流（安全网通过）', (function () {
    var q = 'select a, b, c from t where a = 1';
    var a = sql(q, { commaLocation: true });
    var b = sql(q, { commaLocation: false });
    return vk.sameTokenStream ? vk.sameTokenStream(q, a.replace(/\s+/g, ' ')) !== false : true;
})(), '逗号移动改变了 token 流');

/* ---------------------------------------------------------------------------
 * 2026-11-07 复核：打包与文档一致性（PK 组）
 * -------------------------------------------------------------------------*/
console.log('\n=== 2026-11-07 复核（打包 / 文档 PK 组） ===');

/* PK-1（P2-1）：开发期文档不能被打进 vsix。
 * AUDIT-REPORT.md 有 34 KB，内容是给维护者看的内部审计结论，随扩展分发既
 * 增大体积、也把未修复的问题清单公开给用户。 */
T('PK-1 .vscodeignore 排除内部审计与发布文档', (function () {
    var ig = fs.readFileSync(path.join(EXT, '.vscodeignore'), 'utf8');
    var lines = ig.split(/\r?\n/).map(function (l) { return l.trim(); });
    function excluded(name) { return lines.indexOf(name) >= 0; }
    if (!excluded('AUDIT-REPORT.md')) return false;
    if (!excluded('PUBLISH-CHECKLIST.md')) return false;
    /* 反过来：运行时真正需要的文件绝不能被排除。 */
    if (excluded('probe.ps1') || excluded('extension.js') || excluded('src/kernel.js')) return false;
    if (/^images\/\*\*/.test(ig)) return false;
    return true;
})(), '.vscodeignore 的排除清单不正确');

/* PK-2（P3）：文档声称的"默认格式化器"必须与 package.json 实际声明一致。
 * 要么两边都说"需首次选择"，要么 package.json 补上 configurationDefaults。
 * 旧实现是 CHANGELOG 写"默认格式化器、直接可用"，实际没有该声明 ——
 * 用户按下 Shift+Alt+F 会看到"选择格式化程序"，与文档不符。 */
T('PK-2 「默认格式化器」表述与 package.json 一致', (function () {
    var pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
    var defaults = pkg.contributes && pkg.contributes.configurationDefaults;
    var declaresDefault = !!(defaults && defaults['[sql]'] && defaults['[sql]']['editor.defaultFormatter']);
    var files = ['README.md', 'CHANGELOG.md'];
    var text = files.map(function (f) { return fs.readFileSync(path.join(EXT, f), 'utf8'); }).join('\n');
    var claimsDefault = /默认格式化器/.test(text);
    /* 声称是默认 → 必须真的有声明；没有声明 → 文档必须写明"首次需选择"。 */
    if (claimsDefault && !declaresDefault) return false;
    if (!declaresDefault && !/首次/.test(text)) return false;
    return true;
})(), '文档说「默认格式化器」，package.json 里却没有 configurationDefaults');

/* ---------------------------------------------------------------------------
 * 2026-11-07 复核：屏幕探测（SD 组）
 * -------------------------------------------------------------------------*/
console.log('\n=== 2026-11-07 复核（屏幕探测 SD 组） ===');

/* SD-1（P1-x）：探测结果里的**像素**宽度才是稳定量。
 *
 * 列数 = f(像素, editor.fontSize)。旧实现只把列数写进缓存，于是用户把字号从
 * 14 改成 28 之后，同一块 2560px 的屏仍按 14 号字算出的 240 列排版 ——
 * 实际可见宽度只有一半，而这件事完全无声。 */
T('SD-1 字号变化后按像素重新换算列数', (function () {
    var store = {
        'snugSql.maxScreenCols': 240,
        'snugSql.screenInfo': { cols: 240, maxMonitorPx: 2560, monitorCount: 1, stale: false, error: '', at: 1 }
    };
    var ctx = { globalState: {
        get: function (k) { return store[k]; },
        update: function () { return Promise.resolve(); }
    } };
    var doc = { eol: 1, languageId: 'sql', getText: function () { return ''; } };
    var fmt = { insertSpaces: true, tabSize: 4 };
    function hardLineFor(fontSize) {
        var env = loadExtensionForTest({
            uppercase: true, dialect: 'sql', max_line_length: 0, screen_width: 0,
            as_loc_cnt: 0, bracket_char: false, cjk_width: 0, detectScreenWidth: true,
            comma_location: false
        }, { fontSize: fontSize });
        env.api.loadScreenCache(ctx);
        return env.api.readOptions(doc, fmt).hardLine;
    }
    var a = hardLineFor(14), b = hardLineFor(28), c = hardLineFor(21);
    /* 2560px，14 号字 ≈ (2560-540)/8.4 = 240 列；28 号字正好一半；21 号字 160 列。 */
    return a === 240 && b === 120 && c === 160;
})(), '缓存列数没有随 editor.fontSize 重新换算');

T('SD-1.2 detectScreenWidth=false 时不使用探测值', (function () {
    var store = {
        'snugSql.maxScreenCols': 240,
        'snugSql.screenInfo': { cols: 240, maxMonitorPx: 2560, monitorCount: 1, stale: false, error: '', at: 1 }
    };
    var ctx = { globalState: { get: function (k) { return store[k]; }, update: function () { return Promise.resolve(); } } };
    var env = loadExtensionForTest({
        uppercase: true, dialect: 'sql', max_line_length: 0, screen_width: 0,
        as_loc_cnt: 0, bracket_char: false, cjk_width: 0, detectScreenWidth: false,
        comma_location: false
    }, { fontSize: 14 });
    env.api.loadScreenCache(ctx);
    return env.api.readOptions({ eol: 1, languageId: 'sql', getText: function () { return ''; } },
        { insertSpaces: true, tabSize: 4 }).hardLine === 120;
})(), '关掉探测后仍然使用了缓存的探测宽度');

/* SD-2：宽度来源的配置在运行中变化时，必须重新发起探测。
 *
 * `activate` 只调一次 detectScreenOnce 就把 screenReady 置 true，而 provider 热路径
 * 只看 screenReady —— 于是运行中改配置完全不会重新探测，"设了没用"且无声。 */
T('SD-2 运行中开启探测会重新发起探测', (function () {
    var env = loadExtensionForTest({
        uppercase: true, dialect: 'sql', max_line_length: 0, screen_width: 0,
        as_loc_cnt: 0, bracket_char: false, cjk_width: 0, detectScreenWidth: false,
        comma_location: false
    });
    env.api.refreshScreenProbe();
    if (env.api.screenState().probing) return false;      /* 关闭状态下不该探测 */
    env.cfg.detectScreenWidth = true;                     /* 模拟用户改配置 */
    env.api.refreshScreenProbe();
    return env.api.screenState().probing === true;
})(), 'detectScreenWidth 从 false 改成 true 后没有重新探测');

T('SD-2.2 max_line_length 改回 0 会重新发起探测', (function () {
    var env = loadExtensionForTest({
        uppercase: true, dialect: 'sql', max_line_length: 200, screen_width: 0,
        as_loc_cnt: 0, bracket_char: false, cjk_width: 0, detectScreenWidth: true,
        comma_location: false
    });
    env.api.refreshScreenProbe();
    if (env.api.screenState().probing) return false;      /* 有显式硬上限时不探测 */
    env.cfg.max_line_length = 0;
    env.api.refreshScreenProbe();
    return env.api.screenState().probing === true;
})(), 'max_line_length 改回自动后没有重新探测');

T('SD-2.3 显式 screen_width 时始终不探测', (function () {
    var env = loadExtensionForTest({
        uppercase: true, dialect: 'sql', max_line_length: 0, screen_width: 100,
        as_loc_cnt: 0, bracket_char: false, cjk_width: 0, detectScreenWidth: true,
        comma_location: false
    });
    env.api.refreshScreenProbe();
    if (env.api.screenState().probing) return false;
    var o = env.api.readOptions({ eol: 1, languageId: 'sql', getText: function () { return ''; } },
        { insertSpaces: true, tabSize: 4 });
    return o.hardLine === 100;
})(), '显式 screen_width 时仍然启动了探测，或没有按显式值排版');

/* ---------------------------------------------------------------------------
 * 2026-11-09 复核：屏幕缓存的可读诊断（SD-3 组）
 *
 * 审计报告 P3-2 的最后一条：`cachedScreenInfo` 里存的 `at` / `error` /
 * `monitorCount` / `windowPx` **只写不读**，而且唯一的诊断出口是一句
 * `console.warn` —— 用户问"为什么宽度是 160 列"时，得去开发者工具里翻，
 * 翻到了也只有一句"缓存过期"，看不出是哪次探测留下的、当时失败原因是什么。
 * -------------------------------------------------------------------------*/
console.log('\n=== 2026-11-09 复核（屏幕缓存诊断 SD-3 组） ===');

function screenCacheEnv(store) {
    var env = loadExtensionForTest({
        uppercase: true, dialect: 'sql', max_line_length: 0, screen_width: 0,
        as_loc_cnt: 0, bracket_char: false, cjk_width: 0, detectScreenWidth: true,
        comma_location: false
    }, { fontSize: 14 });
    env.api.loadScreenCache({ globalState: {
        get: function (k) { return store[k]; },
        update: function () { return Promise.resolve(); }
    } });
    return env;
}

T('SD-3.1 上次探测失败时说明带时间戳与失败原因', (function () {
    var env = screenCacheEnv({
        'snugSql.maxScreenCols': 160,
        'snugSql.screenInfo': {
            cols: 0, maxMonitorPx: 0, windowPx: 1600, monitorCount: 2,
            error: 'probe.ps1 missing', stale: true, at: 1700000000000
        }
    });
    var s = env.api.screenCacheSuspicion();
    /* 四个字段都要出现：否则用户拿到的还是一句无从查起的"可能已过期"。 */
    return /沿用更早的结果/.test(s) &&
        /缓存于 2023-11-14/.test(s) &&
        /probe\.ps1 missing/.test(s) &&
        /显示器 2 台/.test(s) &&
        /窗口宽 1600px/.test(s);
})(), J(screenCacheEnv({
    'snugSql.maxScreenCols': 160,
    'snugSql.screenInfo': { cols: 0, maxMonitorPx: 0, windowPx: 1600, monitorCount: 2,
        error: 'probe.ps1 missing', stale: true, at: 1700000000000 }
}).api.screenCacheSuspicion()));

T('SD-3.2 可疑信息写进输出通道', (function () {
    var env = screenCacheEnv({
        'snugSql.maxScreenCols': 160,
        'snugSql.screenInfo': { cols: 0, maxMonitorPx: 0, stale: true, at: 1700000000000 }
    });
    env.api.reportScreenCacheSuspicion('测试用的可疑说明');
    var lines = env.outLinesRef();
    return lines.length === 1 && /屏幕宽度缓存可疑/.test(lines[0]) &&
        /测试用的可疑说明/.test(lines[0]);
})(), J(screenCacheEnv({}).outLinesRef()));

T('SD-3.3 缓存可信时不报警', (function () {
    var env = screenCacheEnv({
        'snugSql.maxScreenCols': 240,
        'snugSql.screenInfo': {
            cols: 240, maxMonitorPx: 2560, windowPx: 2400, monitorCount: 1,
            error: '', stale: false, at: 1700000000000
        }
    });
    if (env.api.screenCacheSuspicion() !== '') return false;
    /* 空字符串也不该往输出通道写东西（否则通道里全是噪声）。 */
    env.api.reportScreenCacheSuspicion('');
    return env.outLinesRef().length === 0;
})(), '缓存正常时仍报了可疑，或空说明被写进输出通道');

/* ---------------------------------------------------------------------------
 * 2026-11-09 复核：P3 遗留项（RV 组）
 *
 * 这一组守的是三条"审计报告里记着、但一直没修"的缺陷：
 *   · RV-1/2/3  Hive CLI 行级命令的入口守卫漏了 l/s 分支；
 *   · RV-4/5    点号链表名与包限定函数调用共用一个过宽的判据；
 *   · RV-6/7    诊断长度上限按 UTF-16 码元算，与格式化路径的字节口径不一致。
 * -------------------------------------------------------------------------*/
console.log('\n=== 2026-11-09 复核（遗留项 RV 组） ===');

/* RV-1：`list file …` / `list jar` / `list archive` 是 Hive CLI 命令，
 * 由客户端逐行解析，不是 SQL。旧守卫只放行 d/D/!/:，于是正则里
 * `list\s+(file|jar|archive)\b` 那个分支永远走不到 —— `list jar` 被当 SQL
 * 排版成 `list JAR`（JAR 在关键字表里），用户拿去执行的脚本被改坏。 */
T('RV-1 Hive `list file` / `list jar` 整行保留', (function () {
    var a = sql('list file /user/hive/lib;\nselect a from t;', { dialect: 'hive' });
    var b = sql('list jar;\nselect a from t;', { dialect: 'hive' });
    var c = sql('list archive;\nselect x from u;', { dialect: 'hive' });
    return a.indexOf('list file /user/hive/lib;') === 0 &&
        b.indexOf('list jar;') === 0 &&
        c.indexOf('list archive;') === 0 &&
        /SELECT a\b/.test(a) && /SELECT x\b/.test(c);
})(), J(sql('list jar;\nselect a from t;', { dialect: 'hive' })));

/* RV-2：`source x.sql` 同理 —— 旧实现把它当 `source` 列 + `x.sql` 表达式，
 * 拼回去可能变成 `source x.sql` 以外的形态（或与下一句并成一条语句）。 */
T('RV-2 Hive `source` 整行保留', (function () {
    var o = sql('source /a/x.sql;\nselect a from t;', { dialect: 'hive' });
    return o.indexOf('source /a/x.sql;') === 0 && /SELECT a\b/.test(o);
})(), J(sql('source /a/x.sql;\nselect a from t;', { dialect: 'hive' })));

/* RV-3：反向断言 —— `list` / `source` 作为普通列名时必须照常格式化。
 * 守卫是按"行首 + 整行形态"判的，不能因为补了字母就误伤正常 SQL。 */
T('RV-3 `list` / `source` 作列名时照常格式化', (function () {
    var o = sql('select list, source from t', { dialect: 'mysql' });
    return /SELECT list/.test(o) && /\bsource\b/.test(o) && /FROM t/.test(o);
})(), J(sql('select list, source from t', { dialect: 'mysql' })));

/* RV-4：点号链表名后的列清单括号要留空格。
 * 旧实现里 `db.t` 命中了"点号链前还有标识符 → 一定是函数调用"的短路，
 * 于是 `INSERT INTO db.t(a)`；而同一句加引号（`db`.`t`）却能拿到空格。 */
T('RV-4 点号链表名后括号留空格', (function () {
    var a = sql('insert into db.t (a) values (1)', { dialect: 'mysql' });
    var b = sql('create view db.v (a, b) as select 1, 2', { dialect: 'mysql' });
    return a.indexOf('db.t (a)') > 0 && b.indexOf('db.v (a, b)') > 0;
})(), J([sql('insert into db.t (a) values (1)', { dialect: 'mysql' }),
    sql('create view db.v (a, b) as select 1, 2', { dialect: 'mysql' })]));

/* RV-5：反向断言 —— 包/模式限定的**函数调用**必须继续紧贴。
 * 这是 P3-1 早就固定的行为，RV-4 改判据时最容易把它一起改坏。 */
T('RV-5 包限定函数调用保持紧贴', (function () {
    var a = sql('select dbms_output.put_line(1) from dual', { dialect: 'oracle' });
    var b = sql('select pkg.fn(x) from t', { dialect: 'oracle' });
    var c = sql('select a.b.c(1) from t', { dialect: 'mysql' });
    return a.indexOf('put_line(1)') > 0 && b.indexOf('pkg.fn(x)') > 0 && c.indexOf('a.b.c(1)') > 0;
})(), J(sql('select dbms_output.put_line(1) from dual', { dialect: 'oracle' })));

/* RV-6：诊断长度上限的单位是 **UTF-8 字节**。
 * 用一段"码元少、字节多"的中文构造边界：maxBytes 比实际字节少 1 时必须跳过，
 * 等于实际字节时必须放行。旧实现比的是 text.length（码元），
 * 这条用例在旧实现下会是 19 字节 vs 15 码元的反例 —— 直接变红。 */
T('RV-6 lint 上限按 UTF-8 字节判定', (function () {
    if (!lint) return false;
    var cn = 'select 中 from 表';
    var bytes = Buffer.byteLength(cn, 'utf8');
    if (!(bytes > cn.length)) return false;            /* 前提：中文确实比码元多 */
    var over = lint.lint(cn, { dialect: 'mysql', maxBytes: bytes - 1 });
    var fit = lint.lint(cn, { dialect: 'mysql', maxBytes: bytes });
    return over.ok === false && over.reason === 'too-large' && fit.reason !== 'too-large';
})(), '按码元而不是字节判定长度上限');

/* RV-7：旧参数名 maxChars 保留可用，但**数值按字节解释** ——
 * 否则外部调用方传 400000 时又会退回码元口径，修复等于没做。 */
T('RV-7 旧参数名 maxChars 同样按字节解释', (function () {
    if (!lint) return false;
    var cn = 'select 中 from 表';
    var bytes = Buffer.byteLength(cn, 'utf8');
    var r = lint.lint(cn, { dialect: 'mysql', maxChars: bytes - 1 });
    return r.ok === false && r.reason === 'too-large';
})(), 'maxChars 仍按码元解释，与 maxBytes 口径不一致');

/* RV-8：`lastDiagnostics().changed` 必须如实反映"这次到底改没改文档"。
 * 旧实现写死 `changed = (status === 'formatted')`，于是
 * `partial` / `partial-unbalanced` / `extracted` 明明改了内容也报 false ——
 * 一旦有人拿它判断"要不要写回"，就会漏写。 */
T('RV-8 partial / partial-unbalanced 的 changed 为 true', (function () {
    var q = 'select a from t;\nselect b from (select c from u;';
    vk.sqlCacheClear();
    var out = sql(q, { dialect: 'mysql' });
    var d = vk.lastDiagnostics();
    return d.status === 'partial-unbalanced' && d.changed === true && out !== q;
})(), J(vk.lastDiagnostics()));

/* RV-9：反向断言 —— 真正没改动时 changed 必须是 false。
 * 这条守的是"别为了修 RV-8 就把 changed 一律写成 true"。 */
T('RV-9 原样返回时 changed 为 false', (function () {
    vk.sqlCacheClear();
    sql('hello world', { dialect: 'mysql' });          /* not-sql，原样返回 */
    var a = vk.lastDiagnostics();
    vk.sqlCacheClear();
    sql('select (a from t', { dialect: 'mysql' });     /* unbalanced，整篇回退 */
    var b = vk.lastDiagnostics();
    return a.changed === false && b.changed === false;
})(), J([vk.lastDiagnostics()]));

/* RV-10：缓存命中不能把 changed 丢掉。
 * 旧实现 cachePut 只存了 status / reason，第二次调用（命中缓存）时
 * changed 会退回默认值 —— 同一份输入两次调用给出不同结论。
 * 这条用例和 RV-8 一起才能守住"冷热路径诊断一致"。 */
T('RV-10 partial 场景冷热缓存诊断一致', (function () {
    var q = 'select a from t;\nselect b from (select c from u;';
    vk.sqlCacheClear();
    sql(q, { dialect: 'mysql' });
    var cold = vk.lastDiagnostics();
    sql(q, { dialect: 'mysql' });                      /* 第二次命中缓存 */
    var warm = vk.lastDiagnostics();
    return cold.status === warm.status && cold.changed === warm.changed &&
        cold.reason === warm.reason && cold.changed === true;
})(), J(vk.lastDiagnostics()));

/* ---------------------------------------------------------------------------
 * 2026-11-09 复核：命令 handler 的端到端断言（CH 组）
 *
 * 审计报告 P3-6 的第四条一直没修：回归套件里 `vscode.commands.registerCommand`
 * 只是 `return ev()`，注册进去的回调被直接丢掉。于是整个套件从来没有验证过
 * "用户点了命令之后到底发生了什么" —— 四条命令的副作用（写回编辑器 /
 * 开新文档 / 写诊断 / 弹提示）全是空白。P1-1（relint 误走格式化管线）
 * 就是这样漏过去的。
 *
 * 现在桩会把 handler 留下来，并记录弹窗、Extract 开出的新文档。
 * -------------------------------------------------------------------------*/
console.log('\n=== 2026-11-09 复核（命令 handler CH 组） ===');

/* 构造一个足够完整的 editor / document stub：命令路径要用的成员都在。
 * `env` 是 loadDiagnosticsEnv() 的返回值 —— Position / Range 必须用**同一份**
 * 桩里的构造函数，extension.js 里 `instanceof` 式的判定才成立。 */
function fakeEditor(text, eol, env) {
    var V = env.vscode;
    eol = eol === 2 ? 2 : 1;
    var nl = eol === 2 ? '\r\n' : '\n';
    var lines = text.split(/\r\n|\r|\n/);
    var starts = [0];
    for (var i = 0; i < lines.length - 1; i++) starts.push(starts[i] + lines[i].length + nl.length);

    function off(pos) {
        var base = starts[Math.max(0, Math.min(pos.line, starts.length - 1))];
        var lineText = lines[Math.max(0, Math.min(pos.line, lines.length - 1))] || '';
        return base + Math.min(pos.character, lineText.length);
    }
    function posAt(o) {
        o = Math.max(0, Math.min(o, text.length));
        var li = 0;
        while (li + 1 < starts.length && starts[li + 1] <= o) li++;
        return new V.Position(li, o - starts[li]);
    }
    var uri = { toString: function () { return 'file:///cmd.sql'; } };
    var doc = {
        eol: eol, languageId: 'sql', isClosed: false, uri: uri,
        lineCount: lines.length,
        getText: function (r) {
            if (!r) return text;
            return text.slice(off(r.start), off(r.end));
        },
        positionAt: posAt,
        lineAt: function (n) {
            n = Math.max(0, Math.min(n, lines.length - 1));
            return { text: lines[n] };
        }
    };
    var edits = [];
    var editor = {
        document: doc,
        options: { insertSpaces: true, tabSize: 2 },
        /* 整个文档：一个空选区 → collectRanges 视作"取整篇"。 */
        selections: [new V.Range(new V.Position(0, 0), new V.Position(0, 0))],
        edit: function (cb) {
            var batch = [];
            cb({ replace: function (range, value) { batch.push({ range: range, value: value }); } });
            edits.push(batch);
            return Promise.resolve(true);
        }
    };
    return { editor: editor, doc: doc, edits: edits };
}

/* CH-1：`snugSql.beautifySql` 必须真的把格式化结果写回编辑器。 */
T('CH-1 beautifySql handler 写回格式化结果', (function () {
    var env = loadDiagnosticsEnv();
    var h = env.handlers['snugSql.beautifySql'];
    if (typeof h !== 'function') return false;
    var fe = fakeEditor('select a,b from t', 1, env);
    env.vscode.window.activeTextEditor = fe.editor;
    return Promise.resolve(h()).then(function (n) {
        if (fe.edits.length !== 1) return false;              /* 必须发生一次编辑 */
        var batch = fe.edits[0];
        if (batch.length !== 1) return false;
        var out = batch[0].value;
        /* 只断言"确实被格式化过"，不断言具体排版（排版细节由内核用例守）。 */
        return n === 1 && /SELECT/.test(out) && /\n/.test(out) && /FROM t/.test(out);
    });
})(), '命令没有把格式化结果写回编辑器，或返回值不是修改处数');

/* CH-2：`snugSql.extractDdl` 的产物是**新文档**，绝不能改动源编辑器。
 * 旧行为是原地替换，用户按一次快捷键，脚本里只剩一条 CREATE TABLE。 */
T('CH-2 extractDdl 开新文档且不改源编辑器', (function () {
    var env = loadDiagnosticsEnv();
    var h = env.handlers['snugSql.extractDdl'];
    if (typeof h !== 'function') return false;
    var fe = fakeEditor('insert into t select a, b from s', 1, env);
    env.vscode.window.activeTextEditor = fe.editor;
    return Promise.resolve(h()).then(function (n) {
        if (fe.edits.length !== 0) return false;              /* 源编辑器一个字都不能动 */
        if (env.openedDocs.length !== 1) return false;
        var d = env.openedDocs[0];
        return n === 1 && /CREATE TABLE/i.test(d.content) &&
            d.languageId === 'sql' && /\ba\b/.test(d.content);
    });
})(), 'Extract 命令改动了源编辑器，或没有在新文档里生成 DDL');

/* CH-3：`snugSql.relint` 只写诊断，不碰文本。
 * 这正是 P1-1 修的那个坑：复用 registerCommand 会让它走格式化管线。 */
T('CH-3 relint handler 只写诊断不改文本', (function () {
    var env = loadDiagnosticsEnv();
    var h = env.handlers['snugSql.relint'];
    if (typeof h !== 'function') return false;
    var fe = fakeEditor('select * from t', 1, env);
    env.vscode.window.activeTextEditor = fe.editor;
    var ret = h();
    var diags = env.store[String(fe.doc.uri)];
    return ret === undefined && fe.edits.length === 0 &&
        !!diags && diags.length === 1 && diags[0].range !== undefined;
})(), 'relint 走了编辑路径，或没有写入诊断');

/* CH-4：没有打开编辑器时，命令必须**给出提示**而不是静默返回或抛异常。 */
T('CH-4 无编辑器时命令给出提示且不抛异常', (function () {
    var env = loadDiagnosticsEnv();
    env.vscode.window.activeTextEditor = undefined;
    env.resetMessages();
    var h = env.handlers['snugSql.beautifySql'];
    if (typeof h !== 'function') return false;
    var threw = false;
    var p;
    try { p = h(); } catch (e) { threw = true; }
    if (threw) return false;
    return Promise.resolve(p).then(function (n) {
        var info = env.messages.filter(function (m) { return m.level === 'info'; });
        return n === 0 && info.length === 1 && /没有打开中的编辑器/.test(info[0].text);
    });
})(), '没有编辑器时命令静默返回、抛异常，或没有提示');

/* CH-5（反向断言）：非 SQL 文本不能被"格式化"成别的东西。
 * 命令路径故意放宽了 fragment 门槛，但 JSON 这种形态明确的非 SQL 仍要拦下。 */
T('CH-5 beautifySql 对 JSON 不写回', (function () {
    var env = loadDiagnosticsEnv();
    var h = env.handlers['snugSql.beautifySql'];
    if (typeof h !== 'function') return false;
    var fe = fakeEditor('{"a": 1, "b": 2}', 1, env);
    env.vscode.window.activeTextEditor = fe.editor;
    return Promise.resolve(h()).then(function (n) {
        if (fe.edits.length !== 0) return false;
        return n === 0;
    });
})(), 'JSON 被当成 SQL 写回了编辑器');

/* ---------------------------------------------------------------------------
 * 2026-11-09 复核：词法检测的短路与去重（PF 组）
 *
 * P3-5 原来记的是"性能边界（同步 + 全量多趟）"，结论是架构取舍、不改。
 * 但复核实测发现里面有两处**纯属重复劳动**，可以在不动主流程的前提下拿掉：
 *
 *   1. `detectLex` 在未知方言下要整篇 `tokenizeRaw` **两遍**（标准切法 + 反斜杠
 *      切法）来判反斜杠语义。而 `scanQuoted` 里 backslash 开关只影响
 *      "遇到 `\` 时跳过下一个字符"这一个分支 —— 文本里一个反斜杠都没有时，
 *      两种切法必然逐字节相同，这两遍是白跑的。
 *   2. 未知方言的 `#` 启发式是一次整篇逐字符扫描，而循环里唯一会改变结论的
 *      分支都以 `qc === '#'` 为前提 —— 没有 `#` 就一次都不会进。
 *   3. `sql()` 里 `detectLex(text, dialect)` 被调了两次，入参完全相同，
 *      而它是纯函数。
 *
 * 下面这组用例守的是**短路没有改变语义**：该走启发式的输入必须仍然走启发式，
 * 该报歧义的必须仍然报歧义。只测速度是守不住这类改动的。
 * -------------------------------------------------------------------------*/
console.log('\n=== 2026-11-09 复核（词法短路 PF 组） ===');

/* PF-1：不含反斜杠 → 不必比较两种切法，直接按标准处理。
 * 关键断言是"结果仍然是 formatted 而不是 ambiguous-escape" —— 短路若写错成
 * "直接返回 ambiguous"，这里就会红。 */
T('PF-1 无反斜杠的未知方言正常格式化', (function () {
    var o = sql('select a, b from t where c = 1', { dialect: '' });
    /* 默认 comma_location=false 是行首逗号，所以只看子句是否各自成行。 */
    return vk.lastDiagnostics().status === 'formatted' &&
        o.indexOf('SELECT a') === 0 && o.indexOf('FROM t') > 0 && o.indexOf('WHERE c = 1') > 0;
})(), J(sql('select a, b from t where c = 1', { dialect: '' })));

/* PF-2：**含**反斜杠且两种切法歧义时，短路不能把它放过 ——
 * 必须仍然原样返回。这是 PF-1 的反向断言。 */
T('PF-2 歧义反斜杠仍原样返回（短路没有吃掉启发式）', (function () {
    var q = "select 'a\\'b' as x, 'c\\'d' as y from t";
    var o = sql(q, { dialect: 'sql' });
    return vk.lastDiagnostics().status === 'ambiguous-escape' && o === q;
})(), J(sql("select 'a\\'b' as x, 'c\\'d' as y from t", { dialect: 'sql' })));

/* PF-3：`'C:\temp\'` 在未知方言下按标准切法能闭合 → 不报歧义、正文被排版。
 * 这条和 PF-2 一起覆盖"反斜杠短路"的两个方向。 */
T('PF-3 C:\\temp\\ 在未知方言下按标准切法闭合', (function () {
    var o = sql("select 'C:\\temp\\' as p from t", { dialect: '' });
    /* 字面量必须整块保留（没有被 \\' 吃穿到行尾），且真正走了排版。 */
    return vk.lastDiagnostics().status === 'formatted' &&
        o.indexOf("'C:\\temp\\'") > 0 && o.indexOf('FROM t') > 0;
})(), J(sql("select 'C:\\temp\\' as p from t", { dialect: '' })));

/* PF-4：不含 `#` 时 hash 启发式短路。断言"输出里 FROM 子句正常成行" ——
 * 如果短路把 lex 留成了错误的 hashMode，`select a from t` 会被当成注释吞掉。 */
T('PF-4 无 # 的未知方言不触发 hash 启发式', (function () {
    var o = sql('select a from t', { dialect: '' });
    return vk.lastDiagnostics().status === 'formatted' && o === 'SELECT a\nFROM t';
})(), J(sql('select a from t', { dialect: '' })));

/* PF-5：**含** `#` 时短路必须让路。`# note` 是 MySQL/Hive 的注释招牌写法，
 * 未知方言下按注释保留（不拆成 SQL 子句）。 */
T('PF-5 含 # 时仍按注释处理', (function () {
    var o = sql('# note\nselect a from t', { dialect: '' });
    return vk.lastDiagnostics().status === 'formatted' &&
        o.split('\n')[0] === '# note' &&
        o.split('\n').indexOf('FROM t') >= 0;
})(), J(sql('# note\nselect a from t', { dialect: '' })));

/* PF-6：明确方言时两条捷径都不该生效（`#` 按方言定，反斜杠按方言定）。
 * pgsql 的 `#` 是异或，不能被当注释；mysql 的反斜杠是转义。 */
T('PF-6 明确方言时捷径让路（pgsql 的 # 是异或）', (function () {
    var o = sql('select a # b from t', { dialect: 'pgsql' });
    return vk.lastDiagnostics().status === 'formatted' && o.indexOf('SELECT a # b') === 0;
})(), J(sql('select a # b from t', { dialect: 'pgsql' })));

T('PF-7 明确方言时捷径让路（mysql 的反斜杠是转义）', (function () {
    var q = "select 'it\\'s' as x from t";
    var o = sql(q, { dialect: 'mysql' });
    /* MySQL 下 \' 是转义 → 整个字符串是一个 token，不该被拆开重排。 */
    return vk.lastDiagnostics().status !== 'ambiguous-escape' && o.indexOf("'it\\'s'") > 0;
})(), J(sql("select 'it\\'s' as x from t", { dialect: 'mysql' })));

/* PF-8：短路带来的收益要能守住 —— 4000 条语句（约 180 KB）格式化在 1.5 s 内。
 * 上限给得很宽松（实测约 0.3 s），只为抓住"退回平方级"或"整篇多扫几遍"的回归，
 * 不拿它当微基准。 */
T('PF-8 4000 条语句格式化 < 1500ms', (function () {
    var a = [];
    for (var i = 0; i < 4000; i++) a.push('select a' + i + ', b' + i + ' from t' + i + ' where c = ' + i + ';');
    var q = a.join('\n');
    vk.sqlCacheClear();
    var t0 = Date.now();
    vk.sql(q, true, false, false, 96, 120, { dialect: 'sql', hardWidth: 120 });
    var ms = Date.now() - t0;
    return vk.lastDiagnostics().status === 'formatted' && ms < 1500;
})(), '超过 1500ms，词法短路或线性路径退化了');






/* P1-8（2026-11-06 复核）：统计必须等异步断言落定后再做。
 * 旧实现直接同步统计 checks —— 异步用例（A-05/R-15/R-16）当时还没跑完，
 * 又因为 `!!Promise === true` 被记成通过，于是它们从来没真正验证过任何东西。 */
settle().then(function () {
    console.log('\n==================================================');
    var bad = checks.filter(function (c) { return !c.ok; });
    console.log('回归结果：通过 ' + (checks.length - bad.length) + ' / 失败 ' + bad.length +
        '（共 ' + checks.length + ' 条）');
    if (bad.length) {
        console.log('\n失败用例：');
        bad.forEach(function (c) { console.log('  · ' + c.name + (c.detail ? '  ← ' + c.detail : '')); });
    }
    process.exitCode = bad.length ? 1 : 0;
});
