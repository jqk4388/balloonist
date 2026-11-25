# InDesign 平台坑位清单

这张表里的每条都踩过一次。写新功能前先扫一眼，能省掉「脚本没报错但结果全错」的排查。

## 单位与几何

- **计量单位默认跟文档标尺**。毫米稿上 `pageWidth`、`geometricBounds` 全部返回毫米，362×516 pt 的页会读成 128×182，随后所有阈值、框对齐、像素换算统统错位。运行时 `B.id.forcePoints()` 强制设为 `POINTS`，返回值也统一按点解释。
- **页面原点不一定等于 `page.bounds[0..1]`**。对开页、右到左版式、按索引摆放的页面都会让 `bounds` 偏离真实左上角。`pageOrigin` 取「覆盖整页的最大图形去掉出血后的左上角」作为原点。
- **扩边/出血**：导出图含出血时，图片坐标与页面坐标差一个出血量。分析框由页面局部坐标经 `pad` 外扩后再乘 `dpi/72` 换算，不能直接拿 `geometricBounds` 当像素坐标。
- **退化定界框会抛错**。宽或高不到 10 pt 的框调 `setLocalBounds` 会失败，所以安全框小于 12 pt 的结果直接丢弃；安全框退化时退回原尺寸居中。

## 页面身份

- `Page.pageNumber` 与 `Page.documentOffset` 在 InDesign 2025 **不存在**，访问即抛错；旧实现因此算出第 0 页，导出报「导出的页码设置无效」。
- 唯一可靠的页面标识是 `page.name`（页面标签）。`pageString` 接受它，导出文件名也按它生成。
- 需要的序号用 `pageNumber()`：先 `parseInt(page.name)`，失败再按 `doc.pages` 索引匹配。
- `pngForPage` 依次尝试 `base + 页名`、`base + 序号`、`base`——三种命名在不同页面标签下都可能出现。

## 导出图片

- `doc.exportFile(PNG_FORMAT, Folder)` 在 2025 返回成功但产出 **0 个文件**。必须给 `File` 基名。
- `EXPORT_ALL` 的产出命名是：第 1 页 `<base>.png`，其后 `<base>2.png` … `<base>N.png`，与页面标签无关，需自己映射。
- `EXPORT_RANGE` 必须设 `pageString`，且 `exportingSpread = false`；对开页导出会把两页拼成一张，坐标全废。
- 导出目录要先清同名旧图，否则读到上一轮的残留会得到"对得上但其实是旧页"的结果。
- 导出前删 `file`（`exportFile` 对已存在文件的行为不稳定）。
- 逐页导出 + 每页开关图层 = 肉眼可见的闪烁。批量路径改成整轮隐藏一次、一次 `EXPORT_ALL`、整轮恢复一次。
- 批量导出可能因为挂载、节、特殊页码而零产出；`bubbleTargets` 检测到 0 文件后自动退回逐页导出。

## 图层与对象

- **Layer 上的集合不能直接 `add`**：`layer.polygons.add()` / `layer.rectangles.add()` 抛「不允许在此对象上执行操作」或「无法创建附加项目」。正确顺序是先在 `doc` 上创建，再 `item.itemLayer = layer`。
- **`doc.rectangles.add()` 落到跨页的第一页**。要精确落在某页必须 `page.rectangles.add()` / `page.polygons.add()`。
- **色板重名**：`doc.colors.add()` 同名会抛错或静默生成 `名称 2`。先 `doc.colors.itemByName(name)`，存在就复用。
- **隐藏图层要成对恢复**：分析用的隐藏/恢复必须 `try/finally`，中途抛错会让嵌字层一直不可见。
- **`itemLayer.name` 可能为空**：新建对象未指定图层时取不到名字，跳图层逻辑要先判空。

## 文本

- **`frame.contents` 只覆盖第一段**。要处理整段文字必须遍历 `frame.parentStory`，按 `story.paragraphs` / `characters` 走。
- **`frame.overflows` 对竖排 CJK 会说谎**：字已经挂在框外，标志仍是 `false`。判断是否溢出用实测墨迹 `inkBox`（逐字采样 `baseline`、`horizontalOffset`、`ascent`、`pointSize`），不要信 `overflows`。
- **`fits()` 要复核行数**：先 `recompose()`，若 `overflows` 为真再比较 `story.lines.length <= frame.lines.length`。
- **逐字采样有成本**：超过 300 字按步长抽样，否则一页几千字会拖到几秒。
- **CJK 字形是方的**：`inkBox` 在每个方向补一个 `em`，否则最后一个字的右/下边被切掉。
- **不存在的属性**（访问即抛）：`TextFrame.fitTextFrame`、`InsertionPoint.verticalOffset`、`Line.geometricBounds`、`app.pngExportPreferences.pngExportQuality`。
- **竖排多列时 `inkBox` 低估宽度**：按 `列数 × em × 1.15` 兜底，否则窄气泡会误判为"装得下"。
- **缩字号到下限仍溢出**：报告为「已放置但有警告」，不算失败——框确实移动了，只是需要人工断行。

## ExtendScript / ScriptUI

- **数组没有 `map` / `filter` / `forEach` / `indexOf`**：老引擎只保证 `for` 循环与 `push`。用 `for` 写，别用现代数组方法。
- **`#targetengine` 放在文件最前面**（`build.js` 固定成第一行），早于任何 `#include`；否则面板的常驻引擎不生效，回调在脚本结束后失效。
- **面板回调要有全局引用**：按钮的 `onClick` 闭包必须挂在 `$.global` 或引擎级对象上，脚本退出后局部变量会被回收。
- **ScriptUI 没有裁剪/滚动容器**：`panel` 不会滚动，`preferredSize` 会被内容实际尺寸覆盖，控件也没有 `remove()`。所以选项不能全堆进主面板，只能每个功能开独立窗口。
- **窗口尺寸上限**：主面板 `preferredSize` 取 `min(宽,460) × min(高,720)`，最小 300×240；超过屏幕的尺寸在某些 DPI 缩放下会跑出屏外。
- **UTF-8 BOM**：InDesign 读脚本要求带 BOM 的 UTF-8；`build.js` 写入时补 BOM，直接手写文件容易变乱码。
- **单文件打包**：`#include` 的相对路径在 Scripts Panel 里经常失效。所有模块编译进一个 IIFE，只暴露 `$.global.Balloonist`。
- **构建前预解析**：`build.js` 用 `new vm.Script` 检查语法，能提前发现 ExtendScript 不接受的写法（如箭头函数、模板字符串、`let`）。

## 外部进程与分析器

- **`File.execute()` 会闪黑框**：用 `.vbs` 包裹 `WScript.Shell.Run(..., 0, false)` 隐藏窗口。
- **结果轮询要限时**：分析器异常退出时 `res.json` 永远不出现，必须按 `rasterTimeoutMs` 超时并报错，不能让 InDesign 卡死。
- **请求文件用 `key=value` 行格式**，不要 JSON：ExtendScript 的 JSON 往返在大量矩形时会慢到不可接受。
- **缓存键要覆盖所有影响结果的参数**：页面 id、检测器、dpi、pad 与全部阈值。少一个就会出现"改了参数但气泡没变"。
- **分析图默认隐藏文字层、诊断层与 `SFX`/`Text`**，再叠加配置里的 `hideLayers`；`Balloonist Clean` 保留，让白块盖住原文。

## 调试

- 外部 COM 调脚本：`New-Object -ComObject 'InDesign.Application.2025'` + `DoScript`，脚本本身用 `try/catch` 返回 `OK` 或 `ERR 名称: 消息 @行号`，否则错误只会弹一个模态框。
- 脚本写到 `%TEMP%` 时保持 UTF-8 BOM；`-Fresh` 先关闭所有文档，避免在错误的文档上跑出"看起来对"的结果。
- `debugDump` 打开后 `tmp/` 留有请求、结果与中间图；排查阈值问题时先看这些图，比改参数猜快得多。
