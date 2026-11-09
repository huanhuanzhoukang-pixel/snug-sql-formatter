# 第三方声明 / Third-Party Notices

本扩展的部分源代码衍生自 **SQL Beautify**，依据其 MIT 许可使用。

This extension contains code derived from **SQL Beautify**, used under its MIT license.

---

## SQL Beautify

| 项 | 值 |
|---|---|
| Marketplace ID | `clarkyu.vscode-sql-beautify` |
| 原作者 | Clark Yu |
| 上游版本 | 0.3.23 |
| 许可 | MIT |
| 项目页 | https://github.com/clarkyu2016/sql-beautify |

### 衍生范围

本项目的下列文件包含衍生自 SQL Beautify 0.3.23 衍生版的代码，并在此基础上继续修改：

- `src/kernel.js` —— SQL 格式化内核（词法器、子句状态机、折行、对齐、DDL、Extract）
- `extension.js` —— VS Code 接入层（命令、格式化 provider、选区处理、缩进保护）
- `probe.ps1` —— 屏幕宽度探测脚本

`src/lint.js`、`test/` 与 `images/` 下的素材为本项目原创，`README.md` 为本项目重写。

### 修改说明

上游代码在本项目中被大幅修改与扩展，主要变更见 `CHANGELOG.md` 与 `AUDIT-REPORT.md`。
所有修改同样以 MIT 许可发布。

### 上游版权声明（原文保留）

```
MIT License

Copyright (c) 2019 Clark Yu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 其它参考（不含代码）

排版行为（宽度 + 分组模型、逗号位置风格、`AS` 对齐规则）参考了 Prettier、
sql-formatter、sqlfluff 等公开项目的**行为**；关键字表来自 SQL 标准与各数据库厂商
文档（事实性内容）。这些项目没有代码进入本发布包。

---

## 运行时依赖

无。`package.json` 的 `dependencies` 为空，发布包中没有 `node_modules/`。
