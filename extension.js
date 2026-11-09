// Snug SQL Formatter —— VS Code 扩展入口
//
// 修复要点：
//   1) 多个选区按文档倒序应用编辑，避免前面的替换让后面的 Range 失效；
//   2) 没有活动编辑器时直接返回，不再抛异常；
//   3) max_line_length 支持显式配置；未配置时用探测到的屏幕宽度 × 80%
//      （内核自身的兜底值是 160 列，与本文档的默认值无关），
//      不再用「估算屏幕宽度 × 80%」猜出一个和文档不一致的固定列数；
//   4) 格式化结果为空 / 结构未变时不再写回文档：
//        - 空结果会让选区被清空（Extract DDL 常见）；
//        - 无变化也要写回会产生多余的 undo 步与脏标记；
//   5) 注册 DocumentFormattingEditProvider / RangeFormattingEditProvider，
//      让「格式化文档」「格式化选定内容」真正可用（之前只有命令）；
//   6) 旧版 extension.* 配置项仍然生效（带弃用提示），不再是死配置；
//   7) 多光标且全是零长度选区时不再意外格式化整个文件。

var vscode = require('vscode');
/* 内核是自己的代码（src/kernel.js），不依赖任何第三方格式化库。
 * 这里不做 try/catch 回退：内核是仓库的一部分，缺失说明打包坏了，
 * 静默退到别的实现只会让"格式化和预期不一样"变成难以定位的谜题。 */
var kernel = require('./src/kernel');
/* 诊断引擎（src/lint.js）：把 SQL 里的错误写法与不规范写法变成
 * 「问题」面板里的条目。它与格式化共用同一个词法器，所以波浪线落在的
 * 位置与排版结果必然一致。 */
var linter = require('./src/lint');

/* 折行宽度 = 屏幕可见列数 × 该比例。用户说"换行太短"时主要看这里：
 * 旧版还会去文档里找"排版墙"反推宽度，导致**同一份 SQL 两次格式化宽度不同**
 * （第一次按文件现有行宽算出 88，格式化后行变短，第二次回到 150）。
 * 现在宽度只由配置/编辑器设置决定，与文档内容无关 → 结果稳定、可复现。 */
var WRAP_RATIO = 0.8;
var MIN_WIDTH = 80;
var MAX_WIDTH = 320;
/* M9（第三轮审计）：`max_line_length` 是**用户显式配置**的硬上限，
 * 不能因为"自动推导的宽度不该太窄"就把它抬到 80 —— 用户设 40 就该是 40。
 * 只保留一个真正意义上的下限（再窄就没法排版了）。 */
var MIN_CONFIGURED_WIDTH = 20;
/* 探测不到真实视口时的"典型编辑器可见列数"。
 * VS Code 没有把视口宽度暴露给扩展的 API，只能用一个保守的常见值。
 *
 * M9（第三轮审计）：旧值 200（软化后 160）对一般团队规范明显偏宽 ——
 * 主流约定都在 80~120 列。改成 120（软宽 96，硬宽 120），
 * 既接近 Prettier / dbt 社区默认，也不会把常见语句内部条件拆碎。
 * 需要更宽直接设 snugSql.max_line_length 或 screen_width。 */
var DEFAULT_SCREEN_WIDTH = 120;

/* 内核"原样返回、没有改动内容"的状态集合。
 *
 * 接入层三处（命令路径、范围 provider、reportNoChange）都要判断同一件事：
 * 这个 status 是否意味着"什么都没改，不能补缩进、要提示原因"。
 * 旧实现把名单散落在三处手写，新增状态时必然漏一处（P2-11 就是这么漏的），
 * 所以集中到这里，单一来源。 */
var NO_CHANGE_STATUSES = {
    'not-sql': 1,
    'unbalanced': 1,
    'ambiguous-escape': 1,
    'reverted': 1,
    'error': 1,
    'empty': 1,
    'not-ddl': 1,
    /* P0-2 / P2-7：未闭合的块注释 / dollar-quote —— 内核现在原样返回。 */
    'unterminated-comment': 1,
    'unterminated': 1
};

/* 内核**部分成功**的状态：内容会写回，但文本里既有重排过的语句、也有
 * 原样保留的语句（原样保留的那些已经带着原文缩进）。
 *
 * P0-1（2026-11-06 复核）：这类结果绝不能再走 `preserveRangeIndent` 的
 * "逐行补基础缩进" —— 内核拼回时已经把语句间空白（含行首缩进）照抄了，
 * 再补一层就变成每次执行命令缩进翻倍（实测 2 → 4 → 8 → 16 空格）。
 * 缩进由内核自己保留（见 kernel.js 的 formatByStatement），EOL 归一仍要做。 */
var PARTIAL_STATUSES = {
    'partial': 1,
    'partial-unbalanced': 1
};

/* 配置命名空间。
 *
 * 1.0.0 是第一个公开发行版，命名空间定为 `snugSql.*`（与扩展名对齐）。
 * 早期内部试用版用过别的前缀，这里不再做兼容 —— 那是未发布的中间状态，
 * 没有真实用户配置需要迁移。 */
var CONFIG_NS = 'snugSql';

/* 「排版墙」探测：如果文件里已经有相当多的行齐刷刷地停在某一列，
 * 说明它本来就是按那个宽度排版过的，可以直接沿用该宽度。
 * 判定要足够严格：至少 20% 的行（且不少于 5 行）落在同一列 ±8 列内，
 * 否则偶发几个同样长度的行就会把整篇宽度带偏。
 * 用桶计数按 8 列对齐分桶，把 O(n²) 的最坏情况降到 O(n)。
 *
 * ⚠ 这个函数默认**不被调用**。它会让"宽度取决于文档当前长什么样"，
 * 于是第一次格式化按文件现有行宽算出 88、格式化后行变短、第二次回到 150 ——
 * 同一份 SQL 两次结果不同。只有用户显式把 `snugSql.screen_width`
 * 设成 -1（"从文件排版推断"）时才会走到这里，属于可选的进阶用法。 */
function detectWrapWall(doc) {
    var buckets = Object.create(null);
    var total = 0;
    var lineCount = Math.min(doc.lineCount, 4000);
    for (var i = 0; i < lineCount; i++) {
        var t = doc.lineAt(i).text;
        if (!t || !t.trim()) continue;
        var w = t.replace(/\t/g, '    ').length;
        if (w < MIN_WIDTH || w > MAX_WIDTH) continue;
        var b = Math.round(w / 8);
        buckets[b] = (buckets[b] || 0) + 1;
        total++;
    }
    if (total < 20) return 0;

    var need = Math.max(5, Math.ceil(total * 0.2));
    /* 从最大宽度往回找，保持与旧版"取最宽那堵墙"的行为一致 */
    var keys = Object.keys(buckets).map(Number).sort(function (a, b) { return b - a; });
    for (var k = 0; k < keys.length; k++) {
        if (buckets[keys[k]] >= need) return keys[k] * 8;
    }
    return 0;
}

/* 读取配置。用 inspect() 而不是 get() 来区分"用户配过"和"拿到默认值"：
 * workspace.getConfiguration('snugSql').get('uppercase') 在用户没配过时
 * 也会返回默认值 true，无法据此判断用户到底有没有表过态。 */
function getConfig(doc) {
    var cfg = vscode.workspace.getConfiguration(CONFIG_NS, doc);

    function read(key) { return cfg.get(key); }
    return { get: read, isExplicit: function (key) { return isExplicit(cfg, key); } };
}

/* 判断某个 snugSql.* 键是否被用户**显式**配置过。
 * M2 需要它来区分"用户明确要 Tab"和"用户没说过，跟随编辑器"。 */
function isExplicitSetting(doc, key) {
    try {
        return isExplicit(vscode.workspace.getConfiguration(CONFIG_NS, doc), key);
    } catch (e) { return false; }
}

/* 配置对象是否显式设置了 key。
 * `defaultLanguageValue` / `defaultValue` 是**扩展自己贡献的默认值**，不是用户配置
 *（E-5：旧实现把 defaultLanguageValue 也算进来，于是只要 package.json 给
 * 某个命名空间贡献过语言级默认值，每个用户都会被判定成"显式配过旧键"）。 */
function isExplicit(c, key) {
    if (!c || typeof c.inspect !== 'function') return false;
    var i;
    try { i = c.inspect(key); } catch (e) { return false; }
    if (!i) return false;
    return i.globalValue !== undefined ||
        i.workspaceValue !== undefined ||
        i.workspaceFolderValue !== undefined ||
        i.globalLanguageValue !== undefined ||
        i.workspaceLanguageValue !== undefined ||
        i.workspaceFolderLanguageValue !== undefined;
}

/* 估算"屏幕可见列数"。
 *
 * VS Code 没有把视口宽度暴露给扩展的 API（`window.activeTextEditor` 上没有
 * `visibleColumnCount` 之类），所以只能靠可观测的信号逼近。优先级：
 *   1) `snugSql.screen_width` —— 用户显式配置，最准；
 *   2) **本机最大那块屏幕**推算出的可见列数（多显示器时取最宽的那块，
 *      用户明确要求：多屏按最大屏判定，好把长语句放在大屏上不折行）；
 *   3) `editor.wordWrapColumn` —— 用户开了自动折行时，这就是他认定的宽度；
 *   4) 返回 0，由调用方用 DEFAULT_SCREEN_WIDTH 保底。
 *
 * 2026-11-04 复核（缺陷 D-1）：package.json 一直写着
 * `0 = auto (detect the widest monitor; falls back to editor.wordWrapColumn,
 * then 120 columns)`，但实现里多了一道 `detectScreenWidth === true` 的判断 ——
 * 默认配置下探测结果**永远用不上**，宽度恒为 120 列，
 * 与"插件启动时按最大显示器宽度 W 排版、超过 80% 折行"的预设不符。
 * 现在恢复文档承诺的语义：屏幕探测默认启用（可用 detectScreenWidth=false 关闭），
 * 探测结果在 screen_width=0 时直接生效。
 *
 * 旧版还有一条：扫描文档里"齐刷刷停在某一列"的行反推宽度。
 * 那条必须只在显式 screen_width=-1 时才走 —— 否则会让**宽度取决于文档当前长什么样**，
 * 同一份 SQL 两次格式化宽度不同。
 *
 * 注意：屏幕探测结果在 activate 时一次性算好并缓存（`detectedScreenCols`），
 * 格式化时会先 await 它再读宽度，因此同一会话内**第一次格式化就已用上终值**，
 * 不会出现"第一次 200 列、第二次 240 列"的抖动。
 */
var detectedScreenCols = 0;
/* 2026-11-07 复核：探测得到的**像素宽度**才是跨会话稳定的量。
 * 列数 = f(像素, editor.fontSize)，字号一改就得重算 —— 只缓存列数会让
 * 同一块 2560px 的屏在 28 号字下仍按 14 号字算出的 240 列排版。 */
var detectedScreenPx = 0;

/* 推断编辑器可见列数时用到的保守常量。
 * 这些值只需要"大致对"，因为最终宽度还会取 80% 作理想值、100% 作折行阈值。 */
var CHROME_PX = 540;         /* 侧边栏 + 行号 + minimap + 滚动条 + 内边距，经验值 */
var CHAR_PX_NUM = 6;         /* 等宽字体一个字符宽 ≈ fontSize × 0.6（14 × 0.6 = 8.4） */
var CHAR_PX_DEN = 10;

/* 折行宽度的取值优先级（自上而下，第一个非零的胜出）：
 *   1) screen_width 显式配置（-1 表示从文件现有排版反推）；
 *   2) 屏幕探测结果（detectScreenWidth 默认 true，可用 false 关闭）；
 *   3) editor.wordWrapColumn（wordWrap 为 wordWrapColumn / bounded 时）；
 *   4) DEFAULT_SCREEN_WIDTH = 120。
 *
 * 历史：这里曾写死"默认固定 120，探测只在 detectScreenWidth=true 时启用"，
 * 与 package.json 的说明和用户"按最宽屏排版"的预期都不符 —— 默认配置下
 * 探测结果被彻底丢弃。现在探测默认启用，上面那段优先级才是实际行为。
 *
 * 探测结果在 activate 时算好并缓存进 `detectedScreenCols`，格式化前会先
 * await 它，所以同一会话内第一次格式化就已用上终值，不会出现
 * "第一次 200 列、第二次 240 列"的抖动。 */
function estimateScreenWidth(doc) {
    var cfg = getConfig(doc);
    var explicit = Number(cfg.get('screen_width'));
    if (isFinite(explicit) && explicit > 0) return explicit;
    /* 显式配置 -1 = "从文件现有排版推断宽度"（进阶用法，会牺牲幂等性） */
    if (explicit === -1) {
        var wall = doc ? detectWrapWall(doc) : 0;
        if (wall) return Math.round(wall / WRAP_RATIO);
        return 0;
    }

    /* 屏幕探测：**默认启用**（D-1，2026-11-04 复核）。
     * package.json 的 screen_width 说明一直是 "0 = auto (detect the widest
     * monitor; falls back to editor.wordWrapColumn, then 120 columns)"，
     * 而旧实现要求 detectScreenWidth === true 才使用探测值 —— 默认配置下
     * 探测结果被彻底丢弃，宽度恒为 120 列，与用户"按最大屏宽度排版"的预设不符。
     * 现在：只有用户**显式把 detectScreenWidth 设为 false** 时才关闭探测；
     * 探测不可用（非 Windows / 受限工作区 / 失败）时 detectedScreenCols 为 0，
     * 自然回落到 wordWrapColumn → 120。
     *
     * 2026-11-07 复核：列数必须按**当前文档的 editor.fontSize** 现算。
     * 缓存里同时留着探测到的像素宽度 `detectedScreenPx`，字号一改
     * （14 → 28）就重新换算 —— 只缓存列数会让同一块 2560px 的屏在 28 号字下
     * 仍按 14 号字算出的 240 列排版，实际可见宽度只有一半。 */
    if (cfg.get('detectScreenWidth') !== false) {
        var probed = detectedScreenCols;
        if (detectedScreenPx > 0) {
            var recol = pxToColumns(detectedScreenPx, doc);
            if (recol > 0) probed = recol;
        }
        if (probed > 0) return probed;
    }

    var editorCfg = vscode.workspace.getConfiguration('editor', doc);
    var wrap = editorCfg.get('wordWrap');
    var wrapColumn = Number(editorCfg.get('wordWrapColumn'));
    if ((wrap === 'wordWrapColumn' || wrap === 'bounded') && isFinite(wrapColumn) && wrapColumn > 0) {
        return wrapColumn;
    }

    return 0;
}

function readOptions(doc, fmtOptions) {
    var cfg = getConfig(doc);
    var editor = vscode.window.activeTextEditor;
    var targetDoc = doc || (editor && editor.document);

    var configured = Number(cfg.get('max_line_length'));
    if (!isFinite(configured) || configured < 0) configured = 0;

    var maxLine;
    var screenCols;
    var hardLine;
    if (configured > 0) {
        /* M-10：`max_line_length` 的语义是**上限**（"超过该宽度后自动折行"，
         * package.json 的原话）。旧实现把它当"理想宽度"，反推出
         * screenCols = configured / 0.8 → hardLine = 1.25 × configured，
         * 配 120 时实际一行能到 150 列，用户设的上限形同虚设。
         * 现在：hardLine = configured（真正的硬上限），
         *       maxLine  = configured × 0.8（软目标，用于对齐/收尾判断）。
         *
         * M9（第三轮审计）：这里的夹紧必须区分"用户配置"与"自动推导"。
         * 用户显式配 40，就该按 40 排版；旧实现套用 [80,320]，把 40 静默抬到 80，
         * 用户看到的是"设了没用"。自动推导那条路径仍用 [80,320]（避免探测异常
         * 把宽度推到离谱区间）。 */
        hardLine = configured;
        if (hardLine < MIN_CONFIGURED_WIDTH) hardLine = MIN_CONFIGURED_WIDTH;
        if (hardLine > MAX_WIDTH) hardLine = MAX_WIDTH;
        maxLine = Math.round(hardLine * WRAP_RATIO);
        if (maxLine < MIN_CONFIGURED_WIDTH) maxLine = MIN_CONFIGURED_WIDTH;
        if (maxLine > hardLine) maxLine = hardLine;
        screenCols = hardLine;
    } else {
        var screen = targetDoc ? estimateScreenWidth(targetDoc) : 0;
        if (!(screen > 0)) screen = DEFAULT_SCREEN_WIDTH;

        /* 2026-11-04（缺陷 D-2）：先把**屏幕宽度**夹进 [MIN_WIDTH, MAX_WIDTH]，
         * 再按 80% 计算折行目标。旧实现顺序反了（先算 maxLine 再夹 hardLine），
         * 于是：
         *   · screen_width=750 → maxLine 夹到 320、hardLine 也夹到 320，
         *     折行目标（320）等于硬上限（320）= 屏幕的 100%，
         *     "80% 就折行"在宽屏上彻底失效；
         *   · editor.wordWrapColumn=80 → maxLine=round(64) 被 MIN_WIDTH 抬到 80，
         *     目标宽度又等于 100%，窄屏上同样不按 80% 排版。
         * 现在 maxLine 一定是 hardLine 的 80%（允许的最小 20 列），
         * 两档阈值始终分开。
         *
         * P1-7（2026-11-05 复核）：夹紧的下限要区分"用户显式配置"与"自动推导"。
         * `snugSql.screen_width` 是用户写死的列数（package.json 明确写着"跨机器
         * 结果一致"），设 40 就该按 40 排版；套用 [80,320] 等于静默抬到 80，
         * "设了没用"。`max_line_length` 路径（M9）早就改成了 MIN_CONFIGURED_WIDTH，
         * screen_width 这条没跟上。探测/推断出来的宽度仍用 [MIN_WIDTH, MAX_WIDTH]，
         * 避免异常探测把宽度推到离谱区间。 */
        var explicitScreen = Number(cfg.get('screen_width'));
        var screenIsExplicit = isFinite(explicitScreen) && explicitScreen > 0;
        screenCols = screen;
        if (screenCols < (screenIsExplicit ? MIN_CONFIGURED_WIDTH : MIN_WIDTH)) {
            screenCols = screenIsExplicit ? MIN_CONFIGURED_WIDTH : MIN_WIDTH;
        }
        if (screenCols > MAX_WIDTH) screenCols = MAX_WIDTH;
        hardLine = Math.round(screenCols);
        maxLine = Math.round(hardLine * WRAP_RATIO);
        if (maxLine < MIN_CONFIGURED_WIDTH) maxLine = MIN_CONFIGURED_WIDTH;
        if (maxLine > hardLine) maxLine = hardLine;
    }

    /* as_loc_cnt：0（默认）= 跟随 maxLine，其余为显式列号上限；
     * 负数表示「不限制」（见 package.json 说明）。内核现在把 <0 映射成 Infinity。 */
    var asLocCnt = Number(cfg.get('as_loc_cnt'));
    if (!isFinite(asLocCnt)) asLocCnt = 0;
    if (asLocCnt === 0) asLocCnt = maxLine;

    /* 缩进：**用户显式配置优先**，没配时才跟随 VS Code 传进来的 FormattingOptions。
     *
     * M2（第三轮审计）：旧实现写成"只要有 insertSpaces 布尔值就覆盖"，
     * 而 VS Code 在 provideDocumentFormattingEdits 里**总会**传 insertSpaces，
     * 于是 `snugSql.bracket_char` 永远被 editor.insertSpaces 覆盖 ——
     * 用户明确设 bracket_char=false（要 Tab）而编辑器默认 insertSpaces=true 时，
     * 输出仍是空格，设置形同虚设。
     * 判据必须是"用户**显式**配置过这个键"（inspect() 有 globalValue/workspaceValue…），
     * 与 getConfig().isExplicit 用的是同一套规则。 */
    var useSpaces;
    if (isExplicitSetting(doc, 'bracket_char')) {
        useSpaces = cfg.get('bracket_char') === true;
    } else if (fmtOptions && typeof fmtOptions.insertSpaces === 'boolean') {
        useSpaces = fmtOptions.insertSpaces;
    } else {
        useSpaces = cfg.get('bracket_char') === true;
    }
    /* 缩进宽度跟随编辑器的 tabSize（R3-9）：内核的 bracket_char 只控制
     * "用空格还是制表符"，用几个空格由 tabSize 决定。
     * 旧版写死 4 空格，tabSize=2 的项目里格式化后缩进直接翻倍。 */
    var tabSize = 4;
    if (fmtOptions && typeof fmtOptions.tabSize === 'number' && fmtOptions.tabSize > 0) {
        tabSize = fmtOptions.tabSize;
    }

    /* 方言：显式配置优先，其次 document.languageId。
     * `#` 在 MySQL 是行注释、在 PG/Hive 是位异或，文本本身无法区分，
     * 必须由这里把编辑器已知的语言 id 交给内核（残留 3）。 */
    var dialect = cfg.get('dialect');
    if (!dialect || dialect === 'auto') {
        dialect = (doc && doc.languageId) || (targetDoc && targetDoc.languageId) || '';
    }

    /* 汉字相对 ASCII 列的真实渲染宽度（默认 1.81818）。
     * 依据：VS Code 默认字体 Consolas 的 ASCII = 0.550em，
     * 而 Consolas 无 CJK 字形、汉字回落微软雅黑 = 1.000em → 1.8182 列。
     * 用等宽中文字体（更纱黑体 / Sarasa Mono SC）时设 2。
     * 非法值（<=0、>4、NaN）留空，内核用默认值。 */
    var cjkWidth = Number(cfg.get('cjk_width'));
    if (!isFinite(cjkWidth) || cjkWidth <= 0 || cjkWidth > 4) cjkWidth = 0;

    return {
        uppercase: cfg.get('uppercase') !== false,
        commaLocation: cfg.get('comma_location') === true,
        bracketChar: useSpaces,
        asLocCnt: asLocCnt,
        maxLine: maxLine,
        hardLine: hardLine,
        dialect: dialect,
        tabSize: tabSize,
        cjkWidth: cjkWidth,
        /* P0-2（2026-11-06 复核）：把 VS Code 已知的文档 EOL 交给内核。
         * 内核只能从**文本内容**推断 EOL，单行文档（或所有换行都在字符串里）
         * 推断不出 CRLF，于是格式化一次就把整篇写成裸 LF。 */
        eolHint: eolHintOf(targetDoc)
    };
}

/* document.eol → 内核可用的 EOL 字符串；未知（测试桩 / 老宿主）时返回 undefined。 */
function eolHintOf(doc) {
    if (!doc) return undefined;
    if (doc.eol === 2) return '\r\n';
    if (doc.eol === 1) return '\n';
    return undefined;
}

/* ========================= 屏幕探测（可选，默认启用） =========================
 * P2-1（2026-11-02 审计）/ D-1（2026-11-04 复核）：以下代码在
 * `snugSql.detectScreenWidth !== false` 时参与宽度推导（`screen_width = 0` 时生效）。
 * 用户把 detectScreenWidth 设为 false、或显式配了 screen_width / max_line_length 时，
 * 这些探测完全不参与。
 * ========================================================================== */


/* 探测本机屏幕几何信息（P6-2）。
 *
 * 历史问题：旧实现把 PowerShell 内联成一个 `-Command` 字符串、超时只给 4 秒。
 * VS Code 冷启动时几十个扩展同时在拉子进程，PowerShell 首次加载
 * System.Windows.Forms 就要 2~4 秒，实测 8 路并发下 **8/8 全部被 4 秒超时杀掉**。
 * 杀掉后代码静默 resolve(0)，缓存从来没写成功过，于是宽度永远回落到
 * DEFAULT_SCREEN_WIDTH=200 → 160 列，用户看到的格式化结果和他要求的宽度无关。
 *
 * 现在：
 *   1) 探测逻辑放进随扩展发布的 probe.ps1，用 -File 调用（不再拼内联命令串）；
 *   2) **有界超时**（M-8 / F1，数值见 PROBE_TIMEOUT_MS）。旧值 20 秒 × 2 次尝试 = 最坏 40 秒，
 *      而 VS Code 保存时格式化默认只等 750 ms；但超时也不能紧贴探测的正常耗时 ——
 *      实测探测空闲时约 1.6~2 秒、负载下 2.3~4.2 秒，所以现在是 6 秒；
 *   3) 失败原因写进诊断信息，随 globalState 一起落盘，方便事后确认。
 *
 * 返回 Promise<{ maxMonitorPx, windowPx, monitorCount, error }>
 * maxMonitorPx 是「最大那块屏幕」的宽度（多屏时取最宽，用户明确要求）。
 */
function powershellPath() {
    var root = process.env.SystemRoot || process.env.windir || 'C:\\WINDOWS';
    return root + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
}

/* E-1 / M8：单次探测的超时（毫秒）。
 * M8（第三轮审计）：只尝试一次绝对路径（旧版两次尝试串行，最坏等 10 秒）。
 *
 * F1（2026-10-29 审计，复核后更正）：旧值 2000 几乎没有余量。probe.ps1 单次运行
 * （PowerShell 启动 + 加载 System.Windows.Forms）空闲时约 1.6~2.0 秒，
 * 负载下（冷启动、多个扩展同时拉子进程）2.3~4.2 秒。所以 2000 毫秒是**间歇性**失败，不是必然失败：
 * 空闲时十次里被杀过两次，负载下经常被杀；被杀时缓存里记 error=timeout，且没有可用宽度。
 * （此前写的"探测从未成功"不对：补丁前 VS Code 里已有一次成功落盘的记录 maxScreenCols=240。）
 * 现在取 6000：覆盖实测上限（4.2 秒）并留约 40% 余量。探测在激活时于后台运行，
 * 成功一次后宽度就落盘，之后的会话命中缓存、不再阻塞格式化（见 activate）；
 * 只有从未探测成功过的会话，第一次格式化才会等到探测结束（通常 2~4 秒，最长 6 秒）。 */
var PROBE_TIMEOUT_MS = 6000;

/* M8：受信任工作区判断。
 * package.json 的 capabilities 里写明「受限工作区跳过 PowerShell 探测」，
 * 但旧实现全文没有 isTrusted 检查 —— 声明与实现不符。
 * VS Code 1.56+ 才有 workspace.isTrusted；没有该 API 时按"受信任"处理（老版本行为不变）。 */
function isTrustedWorkspace() {
    try {
        if (vscode.workspace && typeof vscode.workspace.isTrusted === 'boolean') {
            return vscode.workspace.isTrusted;
        }
    } catch (e) { /* 忽略 */ }
    return true;
}

function probeScreenOnce() {
    return new Promise(function (resolve) {
        var blank = { maxMonitorPx: 0, windowPx: 0, monitorCount: 0, error: '' };
        if (process.platform !== 'win32') {
            blank.error = 'not-win32';
            return resolve(blank);
        }
        /* M8：受限工作区不启动 PowerShell（与 package.json 的声明一致）。 */
        if (!isTrustedWorkspace()) {
            blank.error = 'untrusted-workspace';
            return resolve(blank);
        }

        var script = '';
        try {
            script = require('path').join(__dirname, 'probe.ps1');
        } catch (e) { /* 交给下面的失败分支 */ }
        if (!script || !require('fs').existsSync(script)) {
            blank.error = 'probe.ps1 missing';
            return resolve(blank);
        }

        var cp = require('child_process');
        /* M8：只用**绝对路径**。旧实现在失败后退回裸名 `powershell`，
         * 那会按 PATH 和当前目录搜索 —— 当前目录可被仓库内容控制，
         * 属于典型的可执行文件劫持面。 */
        var exe = powershellPath();
        var args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];

        var settled = false;
        function finish(v) {
            if (settled) return;
            settled = true;
            resolve(v);
        }
        var child;
        try {
            child = cp.execFile(exe, args, {
                timeout: PROBE_TIMEOUT_MS,
                windowsHide: true,
                maxBuffer: 1024 * 256
            }, function (err, stdout) {
                if (settled) return;
                if (err) {
                    return finish({
                        maxMonitorPx: 0, windowPx: 0, monitorCount: 0,
                        error: (err.killed ? 'timeout' : String(err.code || err.message || 'error'))
                    });
                }
                var parts = String(stdout || '').trim().split('|');
                var mx = parseInt(parts[0], 10);
                var mc = parseInt(parts[1], 10);
                if (!isFinite(mx) || mx <= 0) {
                    return finish({
                        maxMonitorPx: 0, windowPx: 0, monitorCount: 0,
                        error: 'bad-output:' + JSON.stringify(String(stdout || '').slice(0, 40))
                    });
                }
                finish({
                    maxMonitorPx: mx,
                    windowPx: 0,
                    monitorCount: (isFinite(mc) && mc > 0) ? mc : 0,
                    error: ''
                });
            });
        } catch (e) {
            return finish({ maxMonitorPx: 0, windowPx: 0, monitorCount: 0,
                error: 'spawn:' + (e && e.message ? e.message : e) });
        }
        if (child && child.on) {
            /* 启动失败（ENOENT）时 execFile 的回调**和** error 事件都可能触发，
             * settled 保证 resolve 只发生一次，不会重复探测。 */
            child.on('error', function (e) {
                finish({ maxMonitorPx: 0, windowPx: 0, monitorCount: 0,
                    error: 'onerror:' + (e && e.message ? e.message : e) });
            });
        }
    });
}

/* activate 时调用：启动一次屏幕探测并把结果缓存下来。
 * 返回 Promise；如果探测已经结束（成功或失败），后续调用立即 resolve。
 *
 * 同时维护一个同步可见的 `screenReady` 标志：provider 在探测已完成时
 * **同步返回数组**（而不是 Promise），这样对同步调用方（测试、其它扩展）的行为
 * 和旧版完全一致；只有探测还没结束时才返回 Promise。
 *
 * M-8：**有磁盘缓存时绝不阻塞**。`loadScreenCache` 已经把上次的列数同步读进
 * `detectedScreenCols`，此时 activate 直接置 `screenReady = true`，
 * 探测在后台跑、成功后再悄悄更新（下一次格式化就用新值）。
 * 旧实现即使缓存命中也要等探测完成才格式化，最坏 20s×2 = 40s，
 * 而保存时格式化（`editor.formatOnSaveTimeout` 默认 750ms）根本等不到。 */
function detectScreenOnce(doc, context) {
    /* P2-2（2026-11-02 审计）：以下三种情况**完全不需要**启动 PowerShell：
     *   1) 用户显式关掉了探测（`detectScreenWidth: false`）；
     *   2) 用户显式配了 max_line_length 或 screen_width —— 那两个值优先，
     *      探测结果根本不会被用到；
     *   3) 已经有成功缓存。
     * 旧实现每次都启动 1 次 probe.ps1（参数含 -ExecutionPolicy Bypass，
     * 企业安全软件会告警，单次耗时 1.6~4.2 秒）。
     *
     * D-1（2026-11-04 复核）：判定从"必须显式 true"改为"只要不是显式 false"，
     * 与 package.json 里 screen_width "0 = auto detect" 的说明一致。
     *
     * F-07（2026-11-04 复核）：这三条早退分支除了返回 0，还必须**同步置
     * `screenReady = true`**。旧实现只在真正探测成功/失败时才写它，于是
     * 「关了探测 / 配了 max_line_length / 配了 screen_width」三种配置下
     * screenReady 永远是 false：provider 热路径从"同步返回数组"退化为
     * "返回 Promise"，每条路径多一次微任务跳转，和 save-time formatting 的
     * 750 ms 预算抢时间（首个保存可能因此放弃格式化）。
     */
    try {
        var probeCfg = getConfig(doc);
        if (probeCfg.get('detectScreenWidth') === false) { screenReady = true; return Promise.resolve(0); }
        var ml = Number(probeCfg.get('max_line_length'));
        var sw = Number(probeCfg.get('screen_width'));
        if (isFinite(ml) && ml > 0) { screenReady = true; return Promise.resolve(0); }
        if (isFinite(sw) && sw !== 0) { screenReady = true; return Promise.resolve(0); }
    } catch (e) { /* 读配置失败就按默认关掉 */ }

    if (screenProbe) {
        if (doc && !screenDoc) screenDoc = doc;
        return screenProbe;
    }
    screenProbe = probeScreenOnce().then(function (info) {
        screenInfo = info;
        if (info.maxMonitorPx > 0) {
            /* 记下**像素**宽度：列数随 editor.fontSize 变化，只有像素是稳定的。 */
            detectedScreenPx = info.maxMonitorPx;
            var cols = pxToColumns(info.maxMonitorPx, screenDoc || doc);
            if (cols > 0) {
                detectedScreenCols = cols;
            }
        }
        /* F12e：探测成功后，如果上次落盘的宽度被标记为 stale 且与本次结果明显不同，
         * 记一条日志（不打扰用户，只在排查时有用）。
         * 2026-11-09：日志现在同时写进输出通道，不再只有开发者工具里能看到。 */
        if (info.maxMonitorPx > 0) {
            reportScreenCacheSuspicion(screenCacheSuspicion());
        }
        /* 无论成功失败都落盘：失败时把 error 一起记下来，
         * 下次排查"为什么宽度是 160"能直接看到原因，而不是只能靠猜。 */
        saveScreenCache(context || screenContext);
        /* 本次探测已经把新值落盘，stale 标记随之失效 */
        cachedStale = false;
        cachedScreenInfo = null;
        screenReady = true;
        return detectedScreenCols;
    }).catch(function (e) {
        screenInfo = { maxMonitorPx: 0, windowPx: 0, monitorCount: 0, error: 'throw:' + (e && e.message) };
        screenReady = true;
        return 0;
    });
    return screenProbe;
}

var screenProbe = null;
var screenReady = false;
var screenDoc = null;
var screenContext = null;
var screenInfo = null;
/* F12d：上次落盘的 screenInfo（含 stale 标记），以及"上次探测是否失败"的速记 */
var cachedScreenInfo = null;
var cachedStale = false;
var screenCacheKey = 'snugSql.maxScreenCols';
var screenInfoKey = 'snugSql.screenInfo';

/* 从 globalState 同步取出上次探测结果：
 * 这样**第二次会话起的第一次格式化**就已经用上真实宽度，
 * 不需要"先格式化一次才变准"。 */
function loadScreenCache(context) {
    try {
        if (!context || !context.globalState) return;
        var v = Number(context.globalState.get(screenCacheKey));
        if (isFinite(v) && v > 0) detectedScreenCols = Math.round(v);
        /* F12（2026-10-29 复核）：stale 以前只写不读，是个死字段。现在读回来，
         * 为后面的"缓存宽度是否可疑"判断留出依据。 */
        var raw = context.globalState.get(screenInfoKey);
        if (raw && typeof raw === 'object') {
            cachedScreenInfo = raw;
            /* 2026-11-07 复核：把像素宽度也读回来 —— 列数只是"上次那个字号下"
             * 的换算结果，用户改了 editor.fontSize 之后必须用像素重新换算，
             * 否则同一块屏在 28 号字下仍按 14 号字的列数排版（宽度只有一半）。 */
            var px = Number(raw.maxMonitorPx);
            if (isFinite(px) && px > 0) detectedScreenPx = px;
            if (raw.stale === true) {
                cachedStale = true;
            }
        }
    } catch (e) { /* 缓存坏了就当没有 */ }
}

/* F12d：缓存里的宽度是否可疑（stale 标记 + 与本次探测值差异 > 20%）。
 * 不改宽度、不打扰用户，只把结论写进输出通道。
 *
 * 2026-11-07 复核：比较口径统一到**像素**。列数是 f(像素, fontSize) 的换算结果，
 * 用户改了字号之后同一块屏的列数本来就会变 —— 拿列数比会把"只是换了字号"
 * 误报成"屏幕宽度变了"。
 *
 * 2026-11-09 复核：把缓存里的 `at` / `error` / `monitorCount` / `windowPx`
 * 一并带出来。这四个字段以前**只写不读** —— 用户问"为什么宽度是 160 列"时，
 * 光说"缓存过期"没有用，得让人看出这个宽度是哪次探测留下的、失败原因是什么。 */
function screenCacheSuspicion() {
    if (!cachedStale) return '';
    var c = cachedScreenInfo;
    var meta = [];
    if (c && c.at) {
        try { meta.push('缓存于 ' + new Date(c.at).toISOString()); }
        catch (e) { /* 时间戳坏了就跳过这一项 */ }
    }
    if (c && c.error) meta.push('上次探测失败：' + c.error);
    if (c && c.monitorCount > 0) meta.push('显示器 ' + c.monitorCount + ' 台');
    if (c && c.windowPx > 0) meta.push('窗口宽 ' + c.windowPx + 'px');
    var suffix = meta.length ? '（' + meta.join('；') + '）' : '';

    if (!c || !(c.cols > 0)) {
        return '上次探测失败，当前宽度沿用更早的结果（' +
            detectedScreenCols + ' 列），可能已过期' + suffix;
    }
    var oldPx = Number(c.maxMonitorPx);
    if (detectedScreenPx > 0 && oldPx > 0) {
        var pxDiff = Math.abs(detectedScreenPx - oldPx) / Math.max(oldPx, detectedScreenPx);
        if (pxDiff > 0.2) {
            return '缓存宽度基于 ' + oldPx + 'px，本次探测 ' + detectedScreenPx +
                'px，相差 ' + Math.round(pxDiff * 100) + '%，已按新值生效' + suffix;
        }
        return '';
    }
    var old = Number(c.cols);
    if (detectedScreenCols > 0 && old > 0) {
        var diff = Math.abs(detectedScreenCols - old) / Math.max(old, detectedScreenCols);
        if (diff > 0.2) {
            return '缓存宽度 ' + old + ' 列与本次探测 ' + detectedScreenCols +
                ' 列相差 ' + Math.round(diff * 100) + '%，已按新值生效' + suffix;
        }
    }
    return '';
}

/* 把"缓存可疑"的结论送到用户看得见的地方。
 *
 * 2026-11-09 复核：以前只有一句 `console.warn` —— 那要去扩展宿主控制台
 * （Help → Toggle Developer Tools）才看得到，而"宽度不对"恰恰是最常被
 * 反馈、又最难自查的问题。现在同时写进「输出 → Snug SQL Formatter」，
 * 用户在命令面板里一开就能对上时间戳与失败原因。 */
function reportScreenCacheSuspicion(text) {
    if (!text) return;
    var ch = getOutputChannel();
    if (ch && ch.appendLine) {
        try { ch.appendLine('[' + new Date().toISOString() + '] 屏幕宽度缓存可疑：' + text); }
        catch (e) { /* 输出通道不可用就只留控制台 */ }
    }
    try { console.warn('[Snug SQL Formatter] 屏幕宽度缓存可疑：' + text); }
    catch (e) { /* 忽略 */ }
}

function saveScreenCache(context) {
    try {
        if (!context || !context.globalState) return;
        var info = screenInfo || {};
        /* C-05：把"这个值是不是本次探测出来的"记清楚。
         * 旧实现无论探测成功还是失败都把 detectedScreenCols 原样写回，
         * 于是"上次成功探测的 160 列"和"这次探测失败的 160 列"在磁盘上完全无法区分：
         * 用户换了显示器、或者换了机器，屏幕探测一直失败，就永远沿用陈旧宽度，
         * 而且从缓存里看不出任何异常。
         * 现在额外记录 stale / 本次是否成功，诊断时能一眼看出宽度是不是过期值。 */
        var stale = !!(info.error) || !(info.maxMonitorPx > 0);
        var p = context.globalState.update(screenCacheKey, detectedScreenCols);
        if (p && p.catch) p.catch(function () { });
        var q = context.globalState.update(screenInfoKey, {
            cols: detectedScreenCols,
            maxMonitorPx: info.maxMonitorPx || 0,
            windowPx: info.windowPx || 0,
            monitorCount: info.monitorCount || 0,
            error: info.error || '',
            /* stale=true 表示"这几列不是本次探测得来的，沿用上次结果" */
            stale: stale,
            at: Date.now()
        });
        if (q && q.catch) q.catch(function () { });
    } catch (e) { /* 写不进去不影响功能 */ }
}


/* 把像素宽度换算成"编辑器可见列数"。
 * fontSize 从编辑器配置读；字符宽按 fontSize × 0.6 估（Consolas/Cascadia 大致如此）。
 * 结果夹在 [MIN_WIDTH, 600] 之间，避免异常输入把宽度推到离谱的区间。 */
function pxToColumns(px, doc) {
    var fontSize = 14;
    try {
        var editorCfg = vscode.workspace.getConfiguration('editor', doc);
        var fs2 = Number(editorCfg.get('fontSize'));
        if (isFinite(fs2) && fs2 > 6 && fs2 < 40) fontSize = fs2;
    } catch (e) { /* 读不到就用 14 */ }

    var charPx = fontSize * CHAR_PX_NUM / CHAR_PX_DEN;
    var usable = px - CHROME_PX;
    if (usable <= 0) return 0;

    var cols = Math.floor(usable / charPx);
    if (cols < MIN_WIDTH) cols = MIN_WIDTH;
    if (cols > 600) cols = 600;
    return cols;
}

/* 收集待格式化的 Range。
 * - 有非空选区就只处理这些选区；
 * - 没有任何非空选区 → 格式化整个文档；
 * - 多光标且全是零长度选区（常见于误触）→ 不做任何事，避免整篇被重排。 */
function collectRanges(editor) {
    var selections = [];
    var sel = editor.selections;

    for (var i = 0; i < sel.length; i++) {
        if (!sel[i].start.isEqual(sel[i].end)) selections.push(new vscode.Range(sel[i].start, sel[i].end));
    }

    if (selections.length === 0) {
        if (sel.length > 1) return [];
        var doc = editor.document;
        selections.push(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)));
    }

    /* 重叠 / 嵌套的选区会让 editor.edit 抛 "Overlapping ranges are not allowed"。
     * 旧实现直接**丢弃**重叠的那个选区（只保留先遍历到的），于是
     * `[0,18)` 与 `[10,37)` 同时存在时，前一段选区被静默跳过，
     * 用户看到的是一部分没被格式化（H-3 / R3-14）。
     * 现在改成**合并**：重叠或首尾相接的选区合成一个并集，
     * 一段文本都不会漏掉；合并后的区间天然互不重叠，editor.edit 也不会报错。 */
    selections.sort(function (a, b) { return a.start.compareTo(b.start); });

    var merged = [];
    for (var k = 0; k < selections.length; k++) {
        var r = selections[k];
        var last = merged.length ? merged[merged.length - 1] : null;
        /* 双向重叠判断 + 允许首尾相接（touching）也算可合并 */
        if (last && r.start.compareTo(last.end) <= 0) {
            if (r.end.compareTo(last.end) > 0) merged[merged.length - 1] = new vscode.Range(last.start, r.end);
        } else {
            merged.push(r);
        }
    }

    /* 应用替换时按起点倒序，避免前面的编辑让后面的 range 失效 */
    merged.sort(function (a, b) { return b.start.compareTo(a.start); });
    return merged;
}

/* 找到 oldText 里"数据区"（字符串 / 注释）跨越换行时，每一行的行首是否落在
 * 数据区**内部**。返回一个函数 inLiteral(lineStartIndex)，用于 preserveRangeIndent
 * 判断"这一行能不能补基础缩进"。
 *
 * 为什么需要（2026-11-04 审计，缺陷 E-1）：旧实现给结果的**每一行**都补选区
 * 首行缩进，于是选区里带有跨行字符串时，字符串内部的行（属于用户数据）也被
 * 加了空格：
 *     输入: "  select 'a\nb' as x from t"
 *     输出: "  SELECT 'a\n  b' AS x\n  FROM t"       ← 值从 'a\nb' 变成 'a\n  b'
 * 这不是排版差异，而是改写了字符串内容；内核的 token 安全网也查不出来
 *（两边都是同一个 string token，value 却已经变了）。
 * 现在只在**代码行**的行首补缩进，数据区内部的行原样保留。 */
function collectLiteralSpans(text, backslash, hashComment) {
    var spans = [];
    var n = text.length, i = 0;
    function push(a, b) { if (b > a) spans.push([a, b]); }

    while (i < n) {
        var ch = text.charAt(i);
        if (ch === '-' && text.charAt(i + 1) === '-') {
            var nl = text.indexOf('\n', i);
            push(i, nl < 0 ? n : nl);
            i = nl < 0 ? n : nl;
            continue;
        }
        if (hashComment && ch === '#' && text.charAt(i + 1) !== '>' && text.charAt(i + 1) !== '<') {
            var nl2 = text.indexOf('\n', i);
            push(i, nl2 < 0 ? n : nl2);
            i = nl2 < 0 ? n : nl2;
            continue;
        }
        if (ch === '/' && text.charAt(i + 1) === '*') {
            var close = text.indexOf('*/', i + 2);
            var end = close < 0 ? n : close + 2;
            push(i, end);
            i = end;
            continue;
        }
        if (ch === '$') {
            var dm = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
            if (dm) {
                var tag = dm[0];
                var stop = text.indexOf(tag, i + tag.length);
                var dend = stop < 0 ? n : stop + tag.length;
                push(i, dend);
                i = dend;
                continue;
            }
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            var q = ch, j = i + 1;
            while (j < n) {
                if (backslash && q !== '`' && text.charAt(j) === '\\') { j += 2; continue; }
                if (text.charAt(j) === q) {
                    if (text.charAt(j + 1) === q) { j += 2; continue; }
                    j++;
                    break;
                }
                j++;
            }
            push(i, Math.min(j, n));
            i = j;
            continue;
        }
        i++;
    }
    return spans;
}

/* 找到 oldText 里"数据区"（字符串 / 注释）跨越换行时，每一行的行首是否落在
 * 数据区**内部**。返回一个函数 inLiteral(lineStartIndex)，用于 preserveRangeIndent
 * 判断"这一行能不能补基础缩进"。
 *
 * 为什么需要（2026-11-04 审计，缺陷 E-1）：旧实现给结果的**每一行**都补选区
 * 首行缩进，于是选区里带有跨行字符串时，字符串内部的行（属于用户数据）也被
 * 加了空格：
 *     输入: "  select 'a\nb' as x from t"
 *     输出: "  SELECT 'a\n  b' AS x\n  FROM t"       ← 值从 'a\nb' 变成 'a\n  b'
 * 这不是排版差异，而是改写了字符串内容；内核的 token 安全网也查不出来
 *（两边都是同一个 string token，value 却已经变了）。
 *
 * 现在只在**代码行**的行首补缩进，数据区内部的行原样保留。
 * 反斜杠语义无法从文本自证，所以两种切法**都算**：宁可少补一次缩进（观感问题），
 * 也绝不把空格补进字符串（数据问题）。 */
function buildLiteralMask(text, backslash, hashComment) {
    var a = collectLiteralSpans(text, backslash, hashComment);
    var b = collectLiteralSpans(text, !backslash, hashComment);

    /* F-08（2026-11-04 复核）：原来的 hit() 每次调用都从 spans[0] 重新线性扫描，
     * 而 preserveRangeIndent 会对**每一行**调用两次 —— 10 000 行的选区
     * 实测 114 ms 全耗在这里（复杂度 O(行数 × 区间数)）。
     * 行起点是单调递增的，所以给每个 spans 配一个游标，均摊 O(1)。 */
    function makeHit(spans) {
        var cur = 0;
        return function (idx) {
            while (cur < spans.length && spans[cur][1] <= idx) cur++;
            return cur < spans.length && idx > spans[cur][0] && idx < spans[cur][1];
        };
    }
    var hitA = makeHit(a);
    var hitB = makeHit(b);

    return function insideLiteral(idx) {
        return hitA(idx) || hitB(idx);
    };
}

/* 该方言里 `#` 之后到行尾是不是注释（只有 MySQL / MariaDB 是）。
 * preserveRangeIndent 用它判断"数据区"，判错只会少补一次缩进，
 * 多补才会改用户数据，所以这里宁可保守。 */
function isHashCommentDialect(dialect) {
    return /mysql|mariadb/i.test(String(dialect || ''));
}

/* 保留选区首行缩进，并按文档 EOL 拼接，避免把 LF 混入 CRLF 选区。
 *
 * E-1（2026-11-04 审计）：只给**代码行**补缩进。跨行字符串 / 块注释 / dollar
 * quote 内部的行是数据，补了就是改内容（见 buildLiteralMask 的注释）。
 *
 * P0-3（2026-11-05 复核）：**换行符也只改代码区的**。
 * 旧实现先 `split(/\r\n|\n|\r/)` 再 `join(nlStr)`，等于把结果里**所有**换行
 * 统一成文档 EOL —— 包括内核刚用 maskLiteralEols 保护好的字面量内部换行：
 *   LF 文档 + `'a\r\nb'` → `'a\nb'`   （值被改）
 *   CRLF 文档 + `'a\nb'` → `'a\r\nb'` （值被改）
 * 安全网查不出来（significant 先做 EOL 归一）。现在逐行扫描、逐行拼接：
 * 数据区内的换行符**原样保留**，只有代码区的换行才换成文档 EOL。 */
function preserveRangeIndent(oldText, newText, eol, lexInfo) {
    if (typeof newText !== 'string' || !newText) return newText;
    /* 没有任何换行 → 既不需要补缩进，也不需要归一 EOL。 */
    if (newText.indexOf('\n') < 0) return newText;
    var info = lexInfo || {};
    /* P0-1（2026-11-06 复核）：`partial` / `partial-unbalanced` 时内核返回的文本里
     * **未改动的语句已经带着原文缩进**，若这里再给每一行补 baseIndent，缩进会
     * 每执行一次命令就叠加一层（实测 2 → 4 → 8 → 16 空格）。调用方通过
     * applyIndent=false 关闭缩进补偿，但 **EOL 归一必须继续做** —— 否则
     * CRLF 文档里被重排的行会写成裸 LF。 */
    var applyIndent = info.applyIndent !== false;
    var baseIndent = applyIndent ? ((/^[ \t]*/.exec(oldText) || [''])[0]) : '';
    /* P0-2（2026-11-06 复核）：旧实现在 baseIndent 为空时直接 return，等于
     * **完全跳过 EOL 归一**。单行选区（或列 0 起的选区）没有前导空白，于是
     * CRLF 文档里格式化一次就混进裸 LF。现在缩进可以为空，EOL 归一照做。 */
    var nlStr = eol === 2 ? '\r\n' : '\n';
    if (eol !== 1 && eol !== 2) {
        var nlMatch = /\r\n|\n|\r/.exec(newText);
        if (nlMatch) nlStr = nlMatch[0];
    }
    /* 快通道：目标就是 LF、文本里也没有 CR、又不用补缩进 → 原样返回。 */
    if (!applyIndent && nlStr === '\n' && newText.indexOf('\r') < 0) return newText;
    var insideLiteral = buildLiteralMask(newText,
        info.backslash === true, info.hashComment === true);

    var out = '';
    var i = 0, n = newText.length;
    while (i <= n) {
        var j = i;
        while (j < n && newText.charAt(j) !== '\n' && newText.charAt(j) !== '\r') j++;
        var lineText = newText.slice(i, j);
        /* 数据区内部的行（跨行字符串 / 块注释 / dollar quote）不补缩进 */
        if (lineText !== '' && !insideLiteral(i)) out += baseIndent;
        out += lineText;
        if (j >= n) break;
        var rawNl = (newText.charAt(j) === '\r' && newText.charAt(j + 1) === '\n')
            ? '\r\n' : newText.charAt(j);
        /* 数据区内部的换行是用户数据，逐字节保留；代码区的换行才统一成文档 EOL */
        out += insideLiteral(j) ? rawNl : nlStr;
        i = j + rawNl.length;
    }
    return out;
}

/* 对若干 Range 应用 transform，返回被修改的范围数量。 */
function applyToEditor(editor, ranges, transform, opts) {
    if (!ranges.length) return Promise.resolve(0);

    /* 用户显式执行命令（选中 → 快捷键 / 命令面板）时一律按"片段"放宽非 SQL 门槛（P1-1）。
     * 门槛只用于自动流程（格式化文档 / format-on-save），避免把 JSON、日志、CSV 重排；
     * 用户主动说"美化这段"时，他不希望看到"什么都没发生"。 */
    var subOpts = {};
    for (var ok in opts) if (Object.prototype.hasOwnProperty.call(opts, ok)) subOpts[ok] = opts[ok];
    subOpts.fragment = true;

    /* M7（第三轮审计）：命令路径同样要受规模保护 —— 用户全选几 MB 的
     * mysqldump 文件按快捷键时，同步格式化会冻结整个扩展宿主。
     * 这里在进入循环前先拦一次（选区总量）。
     *
     * E-3（2026-11-04 审计）：这里以前用 `text.length * 2`（UTF-16 码元 ×2）
     * 估字节，而下面的 formatSizeGuard 用真实 UTF-8 字节 —— 两处阈值口径不同：
     * 纯 ASCII 的 1.5 MB 文本会被算成 3 MB 而**直接跳过**，纯中文的 1.4 MB
     * 文本只会被算成 2.8 MB（实际 4.2 MB）而放行。现在统一走 textByteLength。 */
    var totalBytes = 0;
    for (var gi = 0; gi < ranges.length; gi++) totalBytes += textByteLength(editor.document.getText(ranges[gi]));
    if (totalBytes > MAX_FORMAT_BYTES_SKIP) {
        vscode.window.showWarningMessage(
            'Snug SQL Formatter：选中内容约 ' + (totalBytes / 1024 / 1024).toFixed(1) +
            ' MB，超过 2 MB 上限，已跳过以保证编辑器不卡死。请分段格式化。');
        return Promise.resolve(0);
    }

    var replacements = [];
    var changed = 0;
    var empty = 0;
    var reverted = 0;
    var revertReason = '';
    /* M1b（第三轮审计）：命令路径必须区分并提示全部失败原因。
     * `not-sql`（门槛判定不是 SQL）、`unbalanced`（括号不配对）、
     * `error`（内核抛异常）以前全部静默 —— 用户只看到"按了没反应"。 */
    var notSql = 0, unbalanced = 0, errored = 0;
    var skipped = 0;                                  /* P3-4：空白选区，静默跳过 */
    var lastStatus = '';
    var lastReason = '';
    for (var i = 0; i < ranges.length; i++) {
        var oldText = editor.document.getText(ranges[i]);

        /* P3-4（2026-11-02 审计）：空白选区 / 空文档直接跳过。
         * 旧实现会走完整个流程，最后弹"选中的内容不是可识别的 SQL"，
         * 若上一次刚做过 Extract，还会带上那次留下的通配符原因 ——
         * 用户只是对着空文档按了快捷键，却收到一串莫名其妙的警告。 */
        if (!/[^\s\uFEFF]/.test(oldText)) { skipped++; continue; }

        var newText = transform(oldText, subOpts);

        /* E-4（2026-11-04 审计）：内核**原样返回**时（not-sql / unbalanced /
         * ambiguous-escape / reverted / error / empty），绝不能再补基础缩进 ——
         * 那会把"什么都没改"变成"改了缩进"：选中的英文句子、JSON、括号残缺的
         * 片段，每按一次快捷键就多出 2 个空格，且诊断仍然说"已保留原文"。
         * 先记住内核给的状态，只有真正格式化过的结果才做缩进补全。 */
        var diagNow = (kernel.lastDiagnostics ? kernel.lastDiagnostics() : null);
        if (diagNow) { lastStatus = diagNow.status || ''; lastReason = diagNow.reason || ''; }
        var untouched = !!(diagNow && NO_CHANGE_STATUSES[diagNow.status]);

        /* P1-13（2026-11-02 审计）：选区首行的**基础缩进**必须保留。
         * 用户从子查询中间选一段（前面有 9 个空格），格式化后以前会被
         * 挤回第 0 列，整段 SQL 的层次就乱了，还容易与相邻代码错位。
         * 这里取出首行的前导空白，给结果的每个**代码行**补上同样的前缀。
         *
         * E-1（2026-11-04 审计）：数据区（跨行字符串 / 块注释 / dollar quote）
         * 内部的行不能补 —— 那是用户数据，补空格等于改内容。 */
        /* P0-1（2026-11-06 复核）：`partial` / `partial-unbalanced` 时内核拼回的
         * 文本里既有重排过的语句、也有**原样保留**的语句（后者带着原文缩进）。
         * 这时再逐行补基础缩进就会让缩进每次执行翻倍（实测 2 → 4 → 8 → 16），
         * 所以关闭缩进补偿 —— 但 EOL 归一仍要做（见 preserveRangeIndent 注释）。 */
        var isPartial = !!(diagNow && PARTIAL_STATUSES[diagNow.status]);
        if (!untouched && newText !== oldText) {
            newText = preserveRangeIndent(oldText, newText, editor.document.eol,
                { hashComment: isHashCommentDialect(subOpts.dialect), applyIndent: !isPartial });
        }

        /* 空结果 / 非字符串：绝不写回，否则会把选区清空（P3-1） */
        if (typeof newText !== 'string' || newText === '') { empty++; continue; }
        /* 结构没变：跳过，避免产生无意义的 undo 步与脏标记。
         * C-03：但要把"为什么没变"记下来 —— 内核已格式化好 vs 安全网回退，
         * 两者的用户体验完全不同，不能都静默。 */
        if (newText === oldText) {
            if (diagNow) {
                if (diagNow.status === 'reverted') { reverted++; revertReason = diagNow.reason || ''; }
                else if (diagNow.status === 'not-sql') notSql++;
                else if (diagNow.status === 'unbalanced') unbalanced++;
                else if (diagNow.status === 'error') errored++;
            }
            continue;
        }

        /* 选区尾部换行必须原样补回（P2-11）：
         * VS Code「选中整行」默认包含行尾 \n，直接替换会把下一条语句粘到上一行
         * （`FROM t1;select c,d from t2;`）。
         *
         * 内核现在已自己保留尾部换行（tailNl），所以这条分支实际不会触发；
         * 保留它作为兜底，但补的必须是**文档的 EOL**，不能硬编码 \n ——
         * CRLF 文档里补裸 \n 会产生混合换行（豆包 BUG-10 指出的形态）。 */
        if (/[\r\n]$/.test(oldText) && !/[\r\n]$/.test(newText)) {
            newText += (editor.document.eol === 2 ? '\r\n' : '\n');
        }

        replacements.push({ range: ranges[i], text: newText });
        changed++;
    }

    if (!replacements.length) {
        /* 静默 no-op 是最糟的体验：用户不知道是"已美化"还是"失败"。
         * C-03：现在能区分得更细 —— 内核会通过 lastDiagnostics() 说明
         * 是自己判定"不是 SQL"、输出为空、还是安全网回退了原文。 */
        if (empty > 0) {
            /* C-03 / A-05：把内核给出的具体原因原样带上，
             * 用户才知道是"不是 SQL"还是"列清单全是通配符"。 */
            var why = (kernel.lastExtractReason && kernel.lastExtractReason()) || '';
            vscode.window.showWarningMessage('Snug SQL Formatter：选中的内容不是可识别的 SQL（或提取不到列），未做修改。' +
                (why ? '（' + why + '）' : ''));
        } else if (reverted > 0) {
            vscode.window.showWarningMessage(
                'Snug SQL Formatter：格式化结果未通过安全网校验，已保留原文未做修改。' +
                (revertReason ? '（' + revertReason + '）' : ''));
        } else if (unbalanced > 0) {
            vscode.window.showWarningMessage(
                'Snug SQL Formatter：选中的片段括号不配对（可能从多行子查询中间截断），已保留原文。' +
                '请选中完整语句后重试。');
        } else if (errored > 0) {
            vscode.window.showErrorMessage(
                'Snug SQL Formatter：格式化时发生错误，已保留原文。' +
                (lastReason ? '（' + lastReason + '）' : ''));
        } else if (notSql > 0) {
            vscode.window.showWarningMessage(
                'Snug SQL Formatter：未识别为 SQL，未做修改。' +
                (lastReason ? '原因：' + lastReason + '。' : '') +
                '如确认是 SQL，可设置 snugSql.dialect 指定方言后重试。');
        } else if (lastStatus === 'unchanged' || lastStatus === 'formatted') {
            /* 已经是理想排版：给一条轻提示，避免用户以为命令没生效。 */
            vscode.window.setStatusBarMessage('Snug SQL Formatter：已是最佳排版，无需修改', 3000);
        } else if (lastStatus && NO_CHANGE_STATUSES[lastStatus]) {
            /* P2-11（2026-11-05 复核）：not-ddl / ambiguous-escape / 未闭合输入
             * 以前落到这里什么都不弹 —— 用户按了快捷键，界面毫无反应。
             * 内核其实已经写好了完整原因（"这不是 DDL 语句…"、
             * "文本里的反斜杠转义有歧义…请设置 snugSql.dialect"），直接展示即可。 */
            vscode.window.showWarningMessage(
                'Snug SQL Formatter：未做修改。' +
                (lastReason ? '原因：' + lastReason : ''));
        }
        return Promise.resolve(0);
    }

    return Promise.resolve(editor.edit(function (builder) {
        for (var j = 0; j < replacements.length; j++) {
            builder.replace(replacements[j].range, replacements[j].text);
        }
    })).then(function (ok) {
        /* N7（2026-11-04 复核）：**部分失败必须提示**。
         * 旧实现只在"全部选区都没改"时才报告原因；只要有一个选区成功，
         * 失败的几个就被完全吞掉（实测：两个选区、第二个含 `he` 别名 →
         * 1 处修改、0 条提示），用户以为自己选中的全都被格式化了。
         * 这里把失败个数与最常见的原因一并说出来。 */
        if (ok && replacements.length) {
            var failN = notSql + unbalanced + errored + reverted;
            if (failN > 0) {
                var why2 = lastReason ? ('（' + lastReason + '）') : '';
                vscode.window.showWarningMessage(
                    'Snug SQL Formatter：' + replacements.length + ' 处已格式化，' + failN +
                    ' 处未修改' + why2 + '。未修改的多为不是 SQL、括号残缺或未通过安全网的内容。');
            }
        }
        return ok ? changed : 0;
    });
}

function transformSql(text, opts) {
    /* fragment=true 让内核放宽"非 SQL 门槛"（P1-1）：
     * 片段几乎都以 WHERE / ON / 逗号开头，按"整篇文档"的判据会被整段拦下，
     * 用户看到的是"按了快捷键什么都没发生"。
     * dialect 透传 document.languageId：`#` 在 MySQL 是注释、在 PG 是位异或，
     * 光看文本无法区分，必须靠编辑器已知的语言 id 决定（残留 3 的根治办法）。 */
    return kernel.sql(text, opts.uppercase, opts.commaLocation, opts.bracketChar,
        opts.asLocCnt, opts.maxLine, {
            fragment: !!(opts && opts.fragment),
            dialect: opts && opts.dialect,
            /* 缩进宽度（R3-9）：bracket_char 只决定制表符/空格，宽度由 tabSize 决定。 */
            tabWidth: opts && opts.tabSize,
            /* 硬阈值 = 屏幕 100%：一行只要还塞得进屏幕就完整保留，
             * 超过才折行（maxWidth 只是"理想宽度"，用于对齐和收尾判断）。 */
            hardWidth: opts && opts.hardLine,
            /* 汉字宽度比：默认 1.81818，等宽中文字体设 2 */
            cjkWidth: opts && opts.cjkWidth,
            /* P0-2（2026-11-06 复核）：文档 EOL。单行文档从文本里看不出 CRLF，
             * 不传的话格式化结果会被写成裸 LF。 */
            eolHint: opts && opts.eolHint
        });
}

function transformDdl(text, opts) {
    /* M4 / 配置覆盖不全（第三轮审计）：DDL 路径以前只传 dialect + cjkWidth，
     * 于是 `bracket_char / tabSize / max_line_length / comma_location` 全部失效 ——
     * Beauty DDL 恒用 2 空格缩进、150 列宽，与文档里"DDL 也跟随配置"矛盾。
     * 现在把用户配置整体转过去（内核 sqlddl 已支持这些字段）。 */
    opts = opts || {};
    return kernel.sqlddl(text, opts.uppercase !== false, {
        dialect: opts.dialect,
        cjkWidth: opts.cjkWidth,
        tabWidth: opts.tabSize,
        maxWidth: opts.maxLine,
        hardWidth: opts.hardLine,
        commaLocation: opts.commaLocation === true,
        bracketChar: opts.bracketChar === true,
        /* P1-7 / P0-2（2026-11-06 复核）：DDL 路径同样需要文档 EOL，
         * 否则单行 CRLF 文档里的 DDL 会被写成裸 LF。 */
        eolHint: opts.eolHint
    });
}

function transformExtract(text, opts) {
    /* P2-5（2026-11-02 审计）：以前只传 dialect，`uppercase=false`、
     * tabSize、bracket_char、折行宽度全部不生效 —— 提取出的 DDL
     * 永远是 2 空格缩进、全大写、150 列，与文档说的"跟随配置"不符。 */
    opts = opts || {};
    return kernel.extractddl(text, {
        dialect: opts.dialect,
        uppercase: opts.uppercase !== false,
        bracketChar: opts.bracketChar === true,
        /* 2026-11-07 复核：漏了逗号位置，提取出的 DDL 永远用默认风格。 */
        commaLocation: opts.commaLocation === true,
        tabWidth: opts.tabSize,
        maxWidth: opts.maxLine,
        hardWidth: opts.hardLine,
        cjkWidth: opts.cjkWidth
    });
}


function runCommand(transform) {
    var editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('Snug SQL Formatter：没有打开中的编辑器。');
        return Promise.resolve(0);
    }
    if (editor.document.isClosed) return Promise.resolve(0);

    /* 探测还没结束（扩展宿主刚启动）就先等它：早先用默认 200 列算出来的
     * 160 列排版会直接写进用户的文件，而且和之后的会话不一致。 */
    var ready = screenReady ? Promise.resolve(detectedScreenCols)
        : detectScreenOnce(editor.document, screenContext);

    return ready.then(function () {
        /* M5：**必须等 await 结束之后再取选区和文档**。
         * 旧实现在 `ready` 之前就 collectRanges()，而探测最长要 20 秒；
         * 这期间用户完全可能滚动、编辑、在选区上方插入或删除行，
         * 于是 Range 里的行列号指向的已经是**另外一段文本**——
         * 格式化会写错位置（实测：选区选第 2 行，等待期间在上方插一行，
         * 被改写的是原第 1 行，用户选中的语句一个字没动）。
         * 现在延后到探测完成后再读，并对"文档在等待期间被改过"做一次校验。 */
        if (editor.document.isClosed) return 0;
        var ranges = collectRanges(editor);
        if (!ranges.length) return 0;

        /* 命令路径拿不到 FormattingOptions，但 editor.options 里有 tabSize / insertSpaces。
         * 旧版这里不传，命令执行时 insertSpaces 恒为 undefined → 缩进永远用 \t，
         * 而 provider 路径给 4 空格，同一条 SQL 两种缩进（R3-9）。 */
        var opts = readOptions(editor.document, editor.options);
        var result;
        try {
            result = applyToEditor(editor, ranges, transform, opts);
        } catch (e) {
            vscode.window.showErrorMessage('Snug SQL Formatter 失败：' + (e && e.message ? e.message : e));
            return 0;
        }
        /* editor.edit 在文档被外部关闭等竞态下会 reject，不接住会变成未处理的
         * promise rejection（E-2）。 */
        return result.catch(function (e) {
            vscode.window.showErrorMessage('Snug SQL Formatter 失败：' + (e && e.message ? e.message : e));
            return 0;
        });
    });
}

/* P1-10（2026-11-02 审计）：`extract` 为 true 时，结果输出到**新文档**，
 * 不写回原编辑器 —— 旧行为是直接替换选区/整篇，用户按一次快捷键，
 * 脚本里只剩一条 CREATE TABLE，虽然可以撤销，但结果完全出人意料。 */
function registerCommand(context, name, transform, extract) {
    context.subscriptions.push(vscode.commands.registerCommand(name, function () {
        return extract ? runExtractCommand(transform) : runCommand(transform);
    }));
}

/* P1-10：Extract dedicated 命令入口 —— 结果写进新文档。
 *
 * 为什么不用 applyToEditor：Extract 的输出与输入**结构不同**（SELECT → CREATE TABLE），
 * 原地替换会毁掉用户正在写的查询；而且它常用于"看一眼表结构"，
 * 用户并不想改动源文件。开新文档既能看又不破坏任何东西。 */
function runExtractCommand(transform) {
    var editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('Snug SQL Formatter：没有打开中的编辑器。');
        return Promise.resolve(0);
    }
    if (editor.document.isClosed) return Promise.resolve(0);

    var ranges = collectRanges(editor);
    if (!ranges.length) return Promise.resolve(0);
    /* 没有选区（= 取整篇）时先说明，避免用户以为只处理了光标所在语句。 */
    var wholeDoc = ranges.length === 1 &&
        ranges[0].start.isEqual(new vscode.Position(0, 0)) &&
        ranges[0].end.isEqual(editor.document.positionAt(editor.document.getText().length));

    var opts = readOptions(editor.document, editor.options);
    var optFrag = {};
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) optFrag[k] = opts[k];
    optFrag.fragment = true;

    var texts = [];
    for (var i = 0; i < ranges.length; i++) {
        var src = editor.document.getText(ranges[i]);
        var got = transform(src, optFrag);
        if (typeof got === "string" && got) texts.push(got);
    }

    var reason = (kernel.lastExtractReason && kernel.lastExtractReason()) || "";
    if (!texts.length) {
        vscode.window.showWarningMessage('Snug SQL Formatter：提取不到列清单，未生成 DDL。' +
            (reason ? '（' + reason + '）' : ''));
        return Promise.resolve(0);
    }

    var doc = vscode.workspace.openTextDocument({
        language: "sql",
        content: texts.join("\n\n")
    });
    return doc.then(function (d) {
        return vscode.window.showTextDocument(d, { preview: false });
    }).then(function () {
        if (wholeDoc) {
            vscode.window.setStatusBarMessage(
                'Snug SQL Formatter：没有选区，已按整篇文档提取；结果在新文档里，原文件未修改。', 6000);
        }
        return texts.length;
    });
}

/* --------------------------- 格式化提供器 --------------------------- */

/* M7（第三轮审计）：超大输入的规模保护。
 * 内核是同步执行的，几 MB 级文本会长时间占用扩展宿主线程，而 VS Code 保存时
 * 格式化默认只等约 750 ms —— 超时后编辑被放弃、用户只看到"没反应"。
 * 这里有两条阈值：
 *   · 单块超过 2 MB：直接跳过并提示（建议先分段）；
 *   · 超过 1 MB：仍然排版，但给一条"可能需要几秒"的状态栏提示。
 * 阈值取 1~2 MB 是因为实测 84 KB 的 IN 列表约 0.5 s，2 MB 约 12 s，
 * 已经远超任何自动保存能接受的范围。 */
/* P3-7（2026-11-02 审计）：两个阈值都是**字节**，但旧实现按
 * `text.length * 2` 估算 —— 那是 UTF-16 的码元数 ×2。
 * 中文文本在 UTF-16 里每个字占 1 个码元（2 字节），在 UTF-8 里占 3 字节，
 * 于是纯中文的 1.4 MB 文件会被算成 1.4 MB 而实际是 4.2 MB；
 * 反过来纯 ASCII 的 2 MB 文件被算成 4 MB，明明能处理却被跳过。
 * 现在按真实 UTF-8 字节数（Buffer.byteLength）判断。
 * 常量名也改成反映语义。 */
/* 阈值单位是**字节**。旧常量名与实现一致（BYTES），但实现按
 * `text.length * 2` 估算 —— 那是 UTF-16 码元，不是 UTF-8 字节。
 * 现在按真实字节数判断（见 textByteLength）。 */
var MAX_TEXT_CHARS = 1024 * 1024;          /* 1 MB：超过则提示"可能较慢" */
var MAX_FORMAT_BYTES_WARN = MAX_TEXT_CHARS;
var MAX_FORMAT_BYTES_SKIP = 2 * MAX_TEXT_CHARS;

/* 按 UTF-8 真实字节数。Node 环境用 Buffer.byteLength（O(n)，一次扫描）；
 * 若不可用（极老宿主）退回保守的"码元数 × 3"上界 —— 宁可早提示，不要卡死。 */
function textByteLength(text) {
    if (typeof text !== 'string') return 0;
    if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
        return Buffer.byteLength(text, 'utf8');
    }
    return text.length * 3;
}

function formatSizeGuard(text, scope) {
    var bytes = textByteLength(text);
    if (bytes > MAX_FORMAT_BYTES_SKIP) {
        vscode.window.showWarningMessage(
            'Snug SQL Formatter：' + scope + '约 ' + Math.round(bytes / 1024 / 1024) +
            ' MB，超过 2 MB 上限，已跳过以保证编辑器不卡死。请分段格式化。');
        return 'skip';
    }
    if (bytes > MAX_FORMAT_BYTES_WARN) {
        vscode.window.setStatusBarMessage(
            'Snug SQL Formatter：文本较大（约 ' + Math.round(bytes / 1024) + ' KB），正在排版，可能需要数秒…',
            5000);
        return 'warn';
    }
    return 'ok';
}

function fullRange(doc) {
    return new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
}

/* 整篇格式化。同步执行，供探测已完成时直接调用。 */
function doFullDocument(document, fmtOptions, token) {
    /* E-2：尊重 CancellationToken。VS Code 在用户继续打字、关闭文档、
     * 或保存格式化超时后会 cancel；旧实现不检查，仍然把整篇替换写完，
     * 于是"用户已经改了内容"和"扩展的旧结果"互相覆盖。 */
    if (token && token.isCancellationRequested) return [];
    /* 整篇格式化：保留严格门槛（不重排 JSON / 日志）。 */
    var opts = readOptions(document, fmtOptions);
    var oldText = document.getText();
    if (formatSizeGuard(oldText, '整篇文档') === 'skip') return [];
    var newText = transformSql(oldText, opts);
    if (token && token.isCancellationRequested) return [];
    if (typeof newText !== 'string' || newText === '' || newText === oldText) {
        /* M-4：**提供器路径也要让用户看见原因**。
         * 旧实现直接返回 []，"格式化文档 / 保存时格式化"看上去毫无反应，
         * 用户无法区分"已经是最优"和"被安全网回退了"。 */
        reportNoChange('格式化文档', oldText, newText);
        return [];
    }
    return [vscode.TextEdit.replace(fullRange(document), newText)];
}

function doRangeDocument(document, range, fmtOptions, token) {
    /* 选区格式化 = 片段模式（P1-1）：必须放宽非 SQL 门槛，
     * 否则"从 WHERE 开始选一段"永远格式化不了。
     * 另外补回选区尾部的换行，避免与下一行粘连（P2-11）。 */
    if (token && token.isCancellationRequested) return [];
    var opts = readOptions(document, fmtOptions);
    opts.fragment = true;
    var oldText = document.getText(range);
    if (formatSizeGuard(oldText, '选中内容') === 'skip') return [];
    /* E-1：与命令路径共用同一套"只在代码行补缩进"的逻辑，
     * 否则跨行字符串在「格式化选定内容」里仍会被改内容。
     * E-4：内核原样返回（not-sql / unbalanced / reverted / error …）时
     * **不补缩进** —— 否则"格式化选定内容"会对一段被判为非 SQL 的文本
     * 产生一条只加缩进的编辑。 */
    var rawNew = transformSql(oldText, opts);
    var diag = (kernel.lastDiagnostics && kernel.lastDiagnostics()) || null;
    var untouched = !!(diag && NO_CHANGE_STATUSES[diag.status]);
    /* P0-1（2026-11-06 复核）：与命令路径一致 —— `partial*` 时内核已经保留了
     * 未改动语句的原文缩进，这里不能再补一层。 */
    var isPartial = !!(diag && PARTIAL_STATUSES[diag.status]);
    var newText = (untouched || rawNew === oldText)
        ? rawNew
        : preserveRangeIndent(oldText, rawNew, document.eol,
            { hashComment: isHashCommentDialect(opts.dialect), applyIndent: !isPartial });
    if (token && token.isCancellationRequested) return [];
    if (typeof newText !== 'string' || newText === '' || newText === oldText) {
        reportNoChange('格式化选区', oldText, newText);
        return [];
    }
    /* C-02：补的必须是**文档的 EOL**，不能硬编码 \n ——
     * CRLF 文档里补裸 \n 会造出混合换行（与 applyToEditor 的兜底同因）。 */
    if (/[\r\n]$/.test(oldText) && !/[\r\n]$/.test(newText)) {
        newText += (document.eol === 2 ? '\r\n' : '\n');
    }
    return [vscode.TextEdit.replace(range, newText)];
}

/* M-4：把"为什么没改"写到输出通道，并在状态栏闪一下提示。
 * 提供器路径没有弹窗（会打断格式化文档/保存的流程），
 * 但用户至少能在"输出 → Snug SQL Formatter"里看到准确原因。
 * 只在**确实有话说**时写（安全网回退 / 非 SQL / 异常），
 * "已经格式化好了"不写，避免刷屏。 */

/* ========================= 诊断：把 lint 结果画进「问题」面板 =========================
 *
 * 触发时机：
 *   1) 打开 / 切换文档（立即跑一次，用户不必先执行格式化）
 *   2) 文档改动后 500 ms 防抖（边写边看）
 *   3) 格式化之后 —— 不需要单独挂一个钩子：格式化返回的 TextEdit 由 VS Code
 *      应用时会触发 onDidChangeTextDocument，第 2 条自然接上，
 *      而且分析的是**已经写进文档**的内容，不会出现"波浪线指向旧文本"。
 *
 * 为什么用 push 模型而不是 pull：VS Code 没有「诊断惰性求值」的 API，
 * DiagnosticCollection.set() 必须给出具体条目。所以这里自己控制时机，
 * 并用**指纹**避免重复分析 —— 同一份文本、同一份配置、同一批禁用规则，
 * 分析结果必然相同，没必要重算。
 *
 * 上限保护见下方 MAX_LINT_BYTES 的说明。
 * ========================================================================== */

/* 诊断的长度上限。**单位是 UTF-8 字节**，不是字符数。
 *
 * 为什么比格式化的 1 MB 保守（400 KB）：诊断是**每次击键
 * 500 ms 后**都要跑一遍的，而格式化只在用户显式触发时跑一次。
 * 实测 400 KB 文本的 lint 约 39 ms、指纹约 1.7 ms，合计仍在预算内；
 * 再往上加，击键延迟就会开始被感知到。
 *
 * P3-4（2026-11-06 复核）：旧实现按 `text.length`（UTF-16 码元）判断，
 * 注释却写"400 KB"。一个汉字在 UTF-16 里 1 码元、UTF-8 里 3 字节，
 * 于是 400k 码元的中文实际 1.2 MB 仍会被分析 —— 上限形同虚设；
 * 反过来纯 ASCII 的 400 KB 又恰好在边界上。现在与格式化路径
 * （textByteLength）统一按 UTF-8 字节判定，见 lintByteLimit()。
 *
 * 超限时**清空诊断并跳过**，而不是报"文件太大" —— 给一个 5 MB 的
 * mysqldump 挂几千个波浪线，用户只会觉得整个编辑器卡住了。 */
var MAX_LINT_BYTES = 400000;
var LINT_DEBOUNCE_MS = 500;
/* 「问题」面板里点规则名会跳到这个锚点。发布成 Marketplace 扩展后
 * 这个链接指向仓库 README 的规则表。 */
var RULES_URL = 'https://github.com/huanhuanzhoukang-pixel/snug-sql-formatter#规则表';

var diagnosticCollection = null;
/* 文档 uri → 防抖计时器。**每个文档各一个**，见 scheduleDiagnostics 的说明。 */
var lintTimers = Object.create(null);
/* 文档 uri → 内容指纹，用于跳过内容没变的重算。 */
var lintFingerprints = Object.create(null);

/* 内容指纹：FNV-1a 全串散列。
 *
 * 最初写的是"长度 + 首字符 + 末字符 + 中间字符"的四点采样，理由是怕
 * 整篇 hashing 太慢。这是错的 —— 四点采样在两个方向上都会出事：
 *
 *   · **假阴性**（更严重）：`where b = 1` 改成 `where c = 1`，长度、首尾、
 *     中点全部不变，指纹相同 → refreshDiagnostics 直接跳过 →
 *     波浪线停在**已经不存在的那行代码**上。用户改了一句错 SQL，
 *     诊断却还是旧的那一条，这种错比不报还难发现。
 *   · 假阳性：白算一次，无害。
 *
 * 实测 FNV-1a 在 3.3 MB 文本上 8.9 ms，而 400 KB 上限内不到 1 ms，
 * 完全在 500 ms 防抖的预算里。用真散列换掉采样。 */
function lintHash(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return text.length + ':' + h.toString(36);
}

function lintDisabledRules(doc) {
    var cfg = getConfig(doc);
    var raw = cfg.get('lint.disabledRules');
    if (typeof raw === 'string') {
        raw = raw.split(',');
    }
    if (!raw || typeof raw.length !== 'number') return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
        var s = String(raw[i] || '').trim();
        if (s) out.push(s);
    }
    return out;
}

function severityOf(name) {
    if (name === 'error') return vscode.DiagnosticSeverity.Error;
    if (name === 'warning') return vscode.DiagnosticSeverity.Warning;
    return vscode.DiagnosticSeverity.Information;
}

/* 把 lint 的 {line, character} 转成 Range。
 * 不直接用 document.positionAt(offset)：诊断引擎给的是行列，
 * 而那个行列是按**文本内容**算的，与 document 的换行归一化无关。 */
function lintRange(doc, issue) {
    var maxLine = Math.max(0, doc.lineCount - 1);
    var l1 = Math.min(issue.line, maxLine);
    var l2 = Math.min(issue.endLine, maxLine);
    var c1 = issue.character;
    var c2 = issue.endCharacter;
    try {
        var t1 = doc.lineAt(l1).text;
        if (c1 > t1.length) c1 = t1.length;
        var t2 = doc.lineAt(l2).text;
        if (c2 > t2.length) c2 = t2.length;
    } catch (e) { /* lineAt 失败就用原值，Range 构造会自己夹紧 */ }
    if (l2 < l1 || (l2 === l1 && c2 < c1)) { l2 = l1; c2 = c1 + 1; }
    return new vscode.Range(l1, c1, l2, c2);
}

/* 分析一份文档并刷新它挂的诊断。返回条目数（便于命令与测试断言）。
 *
 * force=true 时跳过语言门槛（供「重新检查」命令使用）。 */
function refreshDiagnostics(doc, force) {
    if (!diagnosticCollection || !doc) return 0;

    /* **先看语言标识**。
     *
     * 事件回调是按文档触发、不区分语言的：扩展一旦被某个 .sql 文件激活，
     * 之后用户在 Markdown / 日志 / JS 里打字同样会走到这里。而"文本里出现
     * 过 SELECT"这个门槛太松 —— 一句 `INFO select * from t took 120ms`
     * 的日志会立刻被挂上「SELECT *」的警告。
     *
     * 所以自动触发时只认 SQL 家族的语言标识。
     *
     * 注意这里**不能**用 `snugSql.dialect` 作为例外：那是个全局配置，
     * 用户一旦设成 `hive`（很常见的做法），所有文档就都绕过门槛了 ——
     * 等于门槛失效。需要强制检查非标准语言时，走「重新检查」命令，
     * 那条路径显式传 force=true。 */
    if (!force && !SQL_LANG_SET[String(doc.languageId || '')]) {
        diagnosticCollection.delete(doc.uri);
        delete lintFingerprints[String(doc.uri)];
        return 0;
    }

    var cfgOn = getConfig(doc).get('lint.enabled') !== false;
    var text = '';
    try { text = doc.getText(); } catch (e) { return 0; }

    /* 关掉功能 / 太大 → 清空这条 uri 下的所有诊断。
     * 上限按 **UTF-8 字节**判定（与格式化路径的 textByteLength 同口径）。 */
    if (!cfgOn || textByteLength(text) > MAX_LINT_BYTES) {
        diagnosticCollection.delete(doc.uri);
        delete lintFingerprints[String(doc.uri)];
        return 0;
    }

    var disabled = lintDisabledRules(doc);

    /* 指纹必须把**所有影响结果的输入**都算进去：文本、禁用规则列表、
     * 开关状态、方言。少算一项就会出现"改了配置但波浪线没变"——
     * 用户改了 `snugSql.dialect` 或切换了文档语言模式，
     * 诊断却还是按旧方言算出来的。 */
    var cfgDialect0 = String(getConfig(doc).get('dialect') || '');
    var effDialect = (!cfgDialect0 || cfgDialect0 === 'auto')
        ? String(doc.languageId || '')
        : cfgDialect0;

    var fp = lintHash(text) + '|' + disabled.join(',') + '|' +
        (cfgOn ? '1' : '0') + '|' + effDialect;
    var key = String(doc.uri);
    if (lintFingerprints[key] === fp) return -1;      /* -1 = 跳过，调用方不用管 */

    var res;
    try {
        /* 方言判定必须与 readOptions **完全一致**，否则同一份 SQL 在
         * 格式化与诊断里会被按两种方言理解 —— `#` 是注释还是异或、
         * 反斜杠算不算转义，两边给出不同答案，用户会看到
         * "排出来的样子"和"报出来的问题"互相矛盾。
         * 规则同 readOptions：显式配置优先，`auto`/空才回落到 languageId。
         *
         * 这里不直接调 readOptions，是因为它会顺带做屏幕宽度估算，
         * 对一个只读的诊断路径来说是白费的计算。 */
        res = linter.lint(text, {
            dialect: effDialect,
            disabledRules: disabled,
            maxBytes: MAX_LINT_BYTES
        });
    } catch (e) {
        diagnosticCollection.delete(doc.uri);
        return 0;
    }

    var diags = [];
    for (var i = 0; i < res.issues.length; i++) {
        var it = res.issues[i];
        var d = new vscode.Diagnostic(
            lintRange(doc, it),
            it.title + '：' + it.message,
            severityOf(it.severity)
        );
        /* code 用 {value, target} 形式：面板里点一下就能跳到规则说明。
         * target 只在 Uri.parse 可用时挂（老宿主没有这个 API）。 */
        d.code = it.rule;
        if (vscode.Uri && typeof vscode.Uri.parse === 'function') {
            try {
                d.code = { value: it.rule, target: vscode.Uri.parse(RULES_URL) };
            } catch (e) { /* 保持字符串形式 */ }
        }
        d.source = 'snug-sql';
        diags.push(d);
    }

    if (diags.length) diagnosticCollection.set(doc.uri, diags);
    else diagnosticCollection.delete(doc.uri);

    lintFingerprints[key] = fp;
    return diags.length;
}

/* 防抖版：用户连续打字时只在停下来之后分析一次。
 *
 * 计时器**按文档各一个**（lintTimers 在文件上方声明），不能共用同一个。
 * 共用的话，在分屏里同时改两个文件（或格式化在后台文档上执行）时，
 * 后一次改动会 clearTimeout 掉前一次的计时器 —— 前一个文档的诊断
 * 就永远停在旧内容上，用户看到的是一条指向已不存在代码的波浪线。 */

function scheduleDiagnostics(doc) {
    if (!diagnosticCollection || !doc) return;
    var key = String(doc.uri);
    if (lintTimers[key]) { clearTimeout(lintTimers[key]); }
    lintTimers[key] = setTimeout(function () {
        delete lintTimers[key];
        /* 只要文档还开着就分析。这里**不要求它当前可见**：
         * 分屏里两块都可见，后台标签页也可能刚刚被格式化过；
         * 用一个"可见"过滤会让诊断与内容脱节。开销由指纹挡住 ——
         * 内容没变的话，refreshDiagnostics 会立刻返回。 */
        try {
            if (doc.isClosed) return;
            refreshDiagnostics(doc);
        } catch (e) { /* 文档已销毁，忽略 */ }
    }, LINT_DEBOUNCE_MS);
}

function cancelPendingDiagnostics(doc) {
    var key = String(doc && doc.uri);
    if (lintTimers[key]) { clearTimeout(lintTimers[key]); delete lintTimers[key]; }
}

/* 只分析当前可见的编辑器。后台标签页的文档等它被切到前台再说 ——
 * 没打开的 200 个标签页不该在启动时把扩展宿主占满。 */
function refreshVisibleDiagnostics() {
    var editors = vscode.window.visibleTextEditors || [];
    for (var i = 0; i < editors.length; i++) refreshDiagnostics(editors[i].document);
}

/* 命令：手动重跑当前文档的诊断（清掉指纹强制重算）。
 *
 * 传 force=true：这是用户**主动**要求检查，即便当前文档的语言标识不在
 * SQL 家族里（比如一段 .txt 或 .md 里粘的 SQL）也应该照做 —— 自动触发
 * 才需要保守。 */
function relintActive() {
    var editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('Snug SQL Formatter：没有打开中的编辑器。');
        return;
    }
    delete lintFingerprints[String(editor.document.uri)];
    var n = refreshDiagnostics(editor.document, true);
    if (n < 0) n = 0;
    if (n === 0) {
        vscode.window.setStatusBarMessage('Snug SQL Formatter：未发现问题。', 4000);
    } else {
        vscode.window.setStatusBarMessage(
            'Snug SQL Formatter：发现 ' + n + ' 处问题，详见「问题」面板。', 4000);
    }
}

var outputChannel = null;
function getOutputChannel() {
    if (outputChannel) return outputChannel;
    try {
        if (vscode.window.createOutputChannel) {
            outputChannel = vscode.window.createOutputChannel('Snug SQL Formatter');
        }
    } catch (e) { /* 创建失败就算了，不影响格式化 */ }
    return outputChannel;
}

function reportNoChange(scope, oldText, newText) {
    var diag = (kernel.lastDiagnostics && kernel.lastDiagnostics()) || null;
    if (!diag) return;
    var status = diag.status;
    /* 只有"用户会困惑"的几种状态才报告。
     * P2-11（2026-11-05 复核）：not-ddl / ambiguous-escape / 未闭合输入
     * 这三种以前漏在名单外 —— 用户按快捷键什么都没发生，输出通道里也没有
     * 任何记录。直接用统一的 NO_CHANGE_STATUSES，新增状态不会再漏。 */
    if (!NO_CHANGE_STATUSES[status]) return;
    var reason = diag.reason || status;
    var ch = getOutputChannel();
    if (ch && ch.appendLine) {
        try {
            ch.appendLine('[' + new Date().toISOString() + '] ' + scope +
                '：未做修改（' + status + '）—— ' + reason);
        } catch (e) { /* 忽略 */ }
    }
    try {
        if (vscode.window.setStatusBarMessage) {
            vscode.window.setStatusBarMessage('Snug SQL Formatter：未做修改（' + status + '），详见"输出 → Snug SQL Formatter"', 4000);
        }
    } catch (e) { /* 忽略 */ }
}

/* F12（2026-10-29 复核）：旧签名是 `provider(kind)`，但函数体内从未引用 kind ——
 * 调用处传的 `provider()` 也不带参数。删掉参数，避免读者以为有两种 provider。 */
function provider() {
    return {
        provideDocumentFormattingEdits: function (document, options, token) {
            /* M-1：**必须先把参数存进局部变量**。旧实现写的是
             *     return screenProbeOrWait(document).then(function () {
             *         return doFullDocument(document, arguments[1]);
             *     });
             * 这里的 `arguments` 是 **then 回调自己**的 arguments（探测结果 + index），
             * 不是 provider 的 (document, options)。于是 arguments[1] 恒为 0/undefined，
             * FormattingOptions 丢失 → 缩进退回内核默认的 Tab，
             * 而探测完成后的第二次格式化又用上了 insertSpaces/tabSize，
             * 同一文件前后缩进不一致（实测 insertSpaces:true,tabSize:2 时
             * 首次 Tab、之后 2 空格）。arrow function 也一样会踩，所以直接显式传参。
             *
             * 返回值：探测已完成 → **同步返回数组**（热路径零开销）；
             * 探测未完成 → 返回 Promise（VS Code 原生支持），保证首次也用终值。 */
            if (screenReady) return doFullDocument(document, options, token);
            return screenProbeOrWait(document).then(function () {
                return doFullDocument(document, options, token);
            });
        },
        provideDocumentRangeFormattingEdits: function (document, range, options, token) {
            if (screenReady) return doRangeDocument(document, range, options, token);
            return screenProbeOrWait(document).then(function () {
                return doRangeDocument(document, range, options, token);
            });
        }
    };
}

/* 等待（必要时启动）屏幕探测，返回 Promise。provider 与命令共用同一个 promise，
 * 不会重复 spawn 子进程。 */
function screenProbeOrWait(doc) {
    if (screenReady) return Promise.resolve(detectedScreenCols);
    return detectScreenOnce(doc, screenContext).then(function (v) {
        return v;
    }, function () {
        return 0;
    });
}

/* 2026-11-07 复核：宽度来源的配置在运行中变化时，必须让探测重新跑一遍。
 *
 * `activate` 里只调一次 `detectScreenOnce` 就把 `screenReady` 置为 true，
 * 而 provider 热路径只检查 `screenReady`（`if (screenReady) return doFullDocument(...)`），
 * 于是运行中改配置完全不会重新探测：
 *   · `detectScreenWidth: false → true`：用户以为打开了自动探测，实际一直是 120 列；
 *   · `max_line_length: 200 → 0`：回到"自动"后仍然不探测，宽度停在旧的硬上限。
 * 这两条都属于"设了没用"，而且完全无声。
 *
 * 只在**确实需要探测**（没关探测、也没显式配置宽度）时重跑；显式配置优先。 */
function refreshScreenProbe() {
    try {
        var cfg = getConfig(null);
        var needProbe = cfg.get('detectScreenWidth') !== false;
        var ml = Number(cfg.get('max_line_length'));
        var sw = Number(cfg.get('screen_width'));
        if (isFinite(ml) && ml > 0) needProbe = false;
        if (isFinite(sw) && sw !== 0) needProbe = false;
        if (!needProbe) return;
        /* 清掉旧 promise，否则 detectScreenOnce 会直接把它返回，不会重新 spawn。 */
        screenProbe = null;
        screenDoc = null;
        /* 没有任何可用列数时才让下一次格式化等探测（与首次安装一致）；
         * 已有缓存值时先沿用，探测结果回来后自动替换。 */
        if (!(detectedScreenCols > 0)) screenReady = false;
        detectScreenOnce(null, screenContext);
    } catch (e) { /* 读配置失败就维持现状 */ }
}

/* 语言选择器：SQL 家族。用通配 + language id 两种写法，
 * 兼容 hive-sql / spark-sql / mysql 等第三方语言扩展。 */
var SQL_SELECTOR = [
    { language: 'sql', scheme: '*' },
    { language: 'hive-sql', scheme: '*' },
    { language: 'hivesql', scheme: '*' },
    { language: 'spark-sql', scheme: '*' },
    { language: 'mysql', scheme: '*' },
    { language: 'pgsql', scheme: '*' },
    { language: 'plsql', scheme: '*' },
    { language: 'bigquery', scheme: '*' },
    { language: 'snowflake-sql', scheme: '*' },
    { language: 'sql-bigquery', scheme: '*' },
    { language: 'impala', scheme: '*' },
    { language: 'clickhouse', scheme: '*' },
    { language: 'tsql', scheme: '*' },
    /* L4（第三轮审计）：主流 SQL 扩展的 languageId 覆盖不全 ——
     * 这些文件以前完全无法用本扩展格式化（右键菜单里也没有本项目）。
     * 只加**确定是 SQL 方言**的 ID，不加 .prisma / .graphql 这类近似语言。 */
    { language: 'postgres', scheme: '*' },
    { language: 'postgresql', scheme: '*' },
    { language: 'plpgsql', scheme: '*' },
    { language: 'mssql', scheme: '*' },
    { language: 'sqlserver', scheme: '*' },
    { language: 'trino', scheme: '*' },
    { language: 'presto', scheme: '*' },
    { language: 'redshift', scheme: '*' },
    { language: 'snowflake', scheme: '*' },
    { language: 'duckdb', scheme: '*' },
    { language: 'oracle', scheme: '*' },
    { language: 'sqlite', scheme: '*' },
    { language: 'db2', scheme: '*' },
    { language: 'databricks', scheme: '*' },
    { language: 'doris', scheme: '*' },
    { language: 'starrocks', scheme: '*' },
    { language: 'maxcompute', scheme: '*' },
    { language: 'odps', scheme: '*' }
];

/* SQL_SELECTOR 的语言 id 集合，供诊断路径做 O(1) 判定。
 * 从选择器直接派生，避免两处各写一份以后悄悄分叉。 */
var SQL_LANG_SET = (function () {
    var s = Object.create(null);
    for (var i = 0; i < SQL_SELECTOR.length; i++) s[SQL_SELECTOR[i].language] = 1;
    return s;
})();

function activate(context) {
    /* 1) 先同步读上次的探测缓存 → 本次会话的第一次格式化就是准的；
     * 2) 再后台探测一遍（屏幕可能换了）刷新缓存。
     * 探测不阻塞扩展宿主启动。
     *
     * M-8：缓存命中时**立刻**置 screenReady，provider/命令走同步快路径；
     * 后台探测完成后 `detectedScreenCols` 被悄悄更新，下一次格式化自动用新值。
     * 只有完全没缓存（首次安装）时才让第一次格式化等探测 —— 那种情况本来也没有
     * 可用宽度，等一下比用错的默认值更好。 */
    screenContext = context;
    loadScreenCache(context);
    if (detectedScreenCols > 0) screenReady = true;
    detectScreenOnce(null, context);

    var p = provider();
    context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(SQL_SELECTOR, p));
    context.subscriptions.push(vscode.languages.registerDocumentRangeFormattingEditProvider(SQL_SELECTOR, p));

    registerCommand(context, 'snugSql.beautifySql', transformSql);
    registerCommand(context, 'snugSql.beautifySqlddl', transformDdl);
    registerCommand(context, 'snugSql.extractDdl', transformExtract, true);

    /* ---------- 诊断 ----------
     * 采集器挂在扩展的 subscriptions 上，停用/重载时自动释放，
     * 不会在「问题」面板里留下幽灵条目。 */
    try {
        if (vscode.languages.createDiagnosticCollection) {
            diagnosticCollection = vscode.languages.createDiagnosticCollection('snug-sql');
            context.subscriptions.push(diagnosticCollection);
        }
    } catch (e) { diagnosticCollection = null; }

    if (diagnosticCollection) {
        /* 1) 打开 / 切换文档 → 立刻分析。放在 setImmediate 里，
         *    让扩展宿主先把激活流程走完，不拖慢窗口启动。 */
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(function (ed) {
            if (ed) setTimeout(function () { refreshDiagnostics(ed.document); }, 0);
        }));

        /* 2) 文档改动 → 防抖分析。只分析被改的那一份。 */
        context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(function (ev) {
            if (ev && ev.document) scheduleDiagnostics(ev.document);
        }));

        /* 3) 文档关闭 → 清掉它的诊断，避免 uri 表无限增长。 */
        context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(function (doc) {
            if (!doc) return;
            /* 文档关了就把待触发的计时器一起取消 —— 否则回调醒来时
             * 文档已经销毁，doc.getText() 会抛异常（已被 try 吞掉，
             * 但那是一次白跑的唤醒，且 lintTimers 里会留一个死键）。 */
            cancelPendingDiagnostics(doc);
            if (!diagnosticCollection) return;
            try { diagnosticCollection.delete(doc.uri); } catch (e) { /* 忽略 */ }
            delete lintFingerprints[String(doc.uri)];
        }));

        /* 4) 配置变了（开了/关了、改了禁用规则）→ 全部重算。 */
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (ev) {
            /* P1-8（2026-11-05 复核）：指纹里包含 dialect（用户显式设置的
             * `snugSql.dialect` 会改变 `#` 是注释还是异或、反斜杠算不算转义），
             * 但旧判据只在 `snugSql.lint.*` 变更时才重算 —— 用户把方言从
             * mysql 改成 pgsql 之后，波浪线还是按旧方言算出来的，
             * 直到下次编辑才更新。
             * 诊断结果依赖的配置不多（开关、禁用规则、方言），但它们都在
             * `snugSql.*` 之下，所以统一按"任何 snugSql 配置变更都重算"处理。
             * 重算本身有指纹兜底：结果没变时不会重复分析，代价可忽略。 */
            if (ev && ev.affectsConfiguration && !ev.affectsConfiguration('snugSql')) return;
            lintFingerprints = Object.create(null);
            refreshVisibleDiagnostics();
        }));

        /* 首次：等宿主空闲后再跑，避免与屏幕探测抢启动时间。 */
        setTimeout(refreshVisibleDiagnostics, 300);
    }

    /* 5) 宽度来源的配置变了 → 让探测重新跑一遍（见 refreshScreenProbe）。
     * 这个监听**不能**塞进上面的 `if (diagnosticCollection)` 里 ——
     * 宿主不支持诊断集合时，屏幕探测照样要响应配置变化。 */
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (ev) {
        if (ev && ev.affectsConfiguration) {
            var hit = ev.affectsConfiguration('snugSql.detectScreenWidth') ||
                ev.affectsConfiguration('snugSql.max_line_length') ||
                ev.affectsConfiguration('snugSql.screen_width');
            if (!hit) return;
        }
        refreshScreenProbe();
    }));

    /* 「重新检查」命令**无条件**注册。
     * package.json 里声明了它，若此处因 diagnosticCollection 创建失败而不注册，
     * 命令面板里会留下一个点了报「command not found」的条目 ——
     * 宁可让它执行时提示"诊断不可用"，也不要留一个幽灵命令。
     *
     * P1-1（2026-11-05 复核）：**必须单独注册**，不能复用 registerCommand。
     * registerCommand 的约定是"命令 = 对每个选区各调一次 transform，再把返回值
     * 当作格式化结果写回"，而 relint 是无副作用的检查命令：
     *   · 它不返回文本 → applyToEditor 走"结果为空"分支，弹出
     *     "选中的内容不是可识别的 SQL"这条与本操作完全无关的假警告；
     *   · 它会对**每个选区**各跑一次，状态栏提示重复 N 次。
     * 现在直接注册一个什么都不返回的 handler。 */
    context.subscriptions.push(vscode.commands.registerCommand('snugSql.relint', function () {
        if (!diagnosticCollection) {
            vscode.window.showWarningMessage(
                'Snug SQL Formatter：当前宿主不支持诊断集合，无法运行 SQL 检查。');
            return;
        }
        relintActive();
    }));

    /* M-4：把输出通道挂到订阅上，扩展停用/重载时一并释放。 */
    var ch = getOutputChannel();
    if (ch && context.subscriptions.push) {
        try { context.subscriptions.push(ch); } catch (e) { /* 忽略 */ }
    }
}

exports.activate = activate;

function deactivate() { }
exports.deactivate = deactivate;
