# 致谢 / Acknowledgements

---

## 衍生自 SQL Beautify（MIT）

本扩展的格式化内核与 VS Code 接入层**衍生自 SQL Beautify**
（Marketplace ID `clarkyu.vscode-sql-beautify`，作者 Clark Yu，MIT 许可），
并在此基础上做了大幅修改与扩展。上游版权声明与完整许可文本见
[NOTICE.md](NOTICE.md)。

涉及的文件：`src/kernel.js`、`extension.js`、`probe.ps1`。
`src/lint.js`、`test/`、`images/`、`README.md` 为本项目原创或重写。

---

## 排版行为的设计参考（不含代码）

以下项目的**公开行为**（折行宽度语义、逗号位置风格、`AS` 对齐规则）被作为需求参考，
没有代码进入本发布包：

- **Prettier**（MIT）—— 通用代码格式化的"宽度 + 分组"模型
- **sql-formatter / sqlfluff / dbt**（MIT / Apache-2.0）—— SQL 子句切分边界的公开讨论
- 各家数据库官方文档 —— 方言词法（`#` 注释、反引号、`::` 转型、`$$` 分隔符等）

关键字表属于**事实性内容**（SQL 标准与各厂商文档里的保留字），不构成受版权保护的表达。

---

## 第三方组件

无。`package.json` 的 `dependencies` 为空，发布包中没有 `node_modules/`。
上游 SQL Beautify 曾捆绑 `vkbeautify`，本项目已完全不使用它（内核为独立实现）。
