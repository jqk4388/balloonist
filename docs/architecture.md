# 架构

```
src/
  core/       核心库（B.* 命名空间，全部是普通函数/对象，无单例状态）
    paths.jsx   路径解析（脚本目录、仓库根、%APPDATA% 家目录）
    json.jsx    JSON 读写（优先原生 JSON，降级到手写实现）
    log.jsx     日志（滚动、可打开、可 tail）
    config.jsx  默认配置、读、写、取某功能选项
    geom.jsx    矩形/坐标工具（bounds ↔ 对象 ↔ 扁平数组）
    id.jsx      InDesign DOM 原语（图层、颜色、文本框、排版、导出 PNG）
    raster.jsx  调用外挂分析器（写请求 → 隐藏 .vbs 启动 exe → 轮询结果 JSON）
    ops.jsx     业务层：气泡目标（每页导出一次 PNG、一次分析）、落位、白块覆盖
    engine.jsx  功能注册表 B.reg / B.feature / B.run
  features/   功能（一个文件一个功能，文件名排序即运行顺序）
  ui/panel.jsx 面板（按注册表自动生成）
  boot.jsx     启动（读配置、开面板）
build.js        源码 → dist/Balloonist.jsx（单文件包，带 BOM，构建前先 vm 解析校验）
tools/raster/   栅格分析器（Go，零第三方依赖；.cs 是旧版对照实现）
tools/          COM 调试脚手架（run-jsx.ps1、probe.jsx）
```

## 为什么是"单文件包"

InDesign 的脚本面板只吃一个 `.jsx`。`build.js` 把 `core → features → ui → boot` 依次拼接，外面套一层立即执行函数并导出到 `$.global.Balloonist`，首行是 `#targetengine "balloonist"`（常驻引擎，面板关掉后再点脚本不会丢状态）。

拼接结果写成 **UTF-8 带 BOM**：ExtendScript 按系统代码页解码无 BOM 的 UTF-8，日文会变乱码，GBK 首字节还会吞掉后面的引号，直接变成语法错误（表现为 COM 只回一个 `NullReferenceException`）。构建前用 `new vm.Script(body)` 预解析，语法错误在 `node build.js` 阶段就报出来。

## 功能注册

```jsx
B.feature({
    id: 'centre',                 // 唯一 id，也是配置里开关的键
    group: '气泡',                 // 面板分组（同名连续排在一起）
    title: '居中对齐（EN）',        // 按钮文字
    desc: '一句话说明',             // 按钮下方斜体说明
    order: 10,                     // 组内排序，同组按 order、再按 id
    options: [                     // 面板自动生成的选项
        { key: 'fitToBubble', label: '套用安全框', type: 'bool',   def: true },
        { key: 'minPct',      label: '最小字号比例', type: 'number', def: 0.75 },
        { key: 'fontFamily',  label: '字体',       type: 'text',   def: 'MS Gothic' }
    ],
    run: function (ctx) { /* ... */ return { ok: true, message: '...', items: [] }; }
});
```

- `type` 只支持 `bool` / `number` / `text`（面板按下表生成 checkbox / edittext / edittext）。
- 选项值不写在功能文件里，靠 `B.config.setOpt('centre','minPct',0.8)` 存进配置，运行时合并：`ctx.cfg.minPct`。
- 关掉某个功能：配置里 `features.centre = false`（面板里就不出现，`B.run` 也拒绝执行）；删功能：删文件 + 重新构建，**其它地方一行都不用改**。

## ctx（传给 run 的上下文）

| 字段 | 说明 |
|---|---|
| `ctx.doc` | 当前文档（`app.activeDocument`，没有则抛错） |
| `ctx.frames` | 当前选中的文本框（`B.id.frames(app.selection)`；没选中则取当前页所有文本框） |
| `ctx.cfg` | 默认配置 + 本功能选项合并后的对象 |
| `ctx.settings` | 分析器参数（dpi/pad/thr/dil/h/minSide/minArea/maxArea/maxAspect/ring） |
| `ctx.id` / `ctx.ops` | `B.id` / `B.ops` 的引用（方便功能文件单行调用） |
| `ctx.targets(force)` | `B.ops.targets(ctx.doc, ctx.frames, settings, force)`：按页分组的气泡分析结果，带缓存 |
| `ctx.info(msg)` | 往日志、面板状态栏和 `last-result.json` 写一行进度 |

`run` 的返回值约定：`{ ok: boolean, message: string, items: [], report: {} }`。`B.run` 统一补上 `feature / title / ms`，并把结果写到 `%APPDATA%\Balloonist\last-result.json`（调试和外部工具都读这个）。

## 新增一个功能

1. 新建 `src/features/70_mything.jsx`（数字前缀决定默认顺序）：

```jsx
B.feature({
    id: 'mything',
    group: '实验',
    title: '我的功能 · My Thing',
    desc: '把选中文本框的字距改成 -10。',
    order: 99,
    options: [{ key: 'tracking', label: '字距', type: 'number', def: -10 }],
    run: function (ctx) {
        var n = 0;
        for (var i = 0; i < ctx.frames.length; i++) {
            try {
                B.id.story(ctx.frames[i]).characters.everyItem().tracking = ctx.cfg.tracking;
                n++;
            } catch (e) { B.log.warn('tracking: ' + e.message); }
        }
        ctx.info('已处理 ' + n);
        return { ok: n > 0, message: '已处理 ' + n + ' 个文本框' };
    }
});
```

2. `node build.js` → 面板里自动多出一个「实验 / 我的功能」卡片，选项自动持久化。
3. 需要新的 DOM 能力时，往 `src/core/id.jsx` 加一个原语（不要写在功能文件里），这样所有功能都能复用。

## 取图与坐标（2025 版实测）

- 位图分析必须拿到"整页渲染"。`B.id.exportPagesPng(doc, pages, dir, base, dpi)` 一次 `EXPORT_ALL` 出齐所有页（文件名 `<base>.png`、`<base>2.png`…，`B.id.pngForPage` 负责映射，先按 `page.name` 再按序号）；`B.ops.bubbleTargets` 因此只隐藏/恢复图层各一次。
- 页码：`Page.pageNumber`、`Document.documentOffset` 都不存在；用 `page.name`（`B.id.pageLabel`），否则会得到第 0 页并触发「导出的页码设置无效」。
- 单位：`app.scriptPreferences.measurementUnit` 跟随文档标尺单位。毫米稿会让所有几何值变成毫米，页面看似 128×182 pt，位图坐标直接错位。`B.run()` 开场调用 `B.id.forcePoints()`。
- `doc.exportFile(PNG_FORMAT, Folder)` 在 2025 上产出 0 个文件；必须给 `File` 基名。

## 关键实现坑

平台层面踩过的坑统一整理在 [indesign-limits](indesign-limits.md)，这里只保留三条最容易写错新功能的：

- **故事 vs 框**：`frame.contents`、`frame.texts[0].characters` 只暴露**已排版**的那一段；全文和全字号必须走 `frame.parentStory`。曾经的"字消失 / 只改了前几个字"就是踩这个。
- **溢出判定**：`frame.overflows` 会滞后，竖排 CJK 甚至会一直报 `false`。用 `B.id.inkBox` 实测墨迹，或 `B.id.fits(frame)`（先 `recompose()`，再用行数复核）。
- **图层子集合**：`layer.polygons.add()` 在 2025 上直接报错。一律 `doc.polygons.add()` + `shape.itemLayer = layer`；还要落到指定页时用 `page.polygons.add()`。

## 相关文档

| 主题 | 文档 |
|---|---|
| 配置项、阈值与功能选项 | [config](config.md) |
| 气泡检测算法与调参 | [raster-engine](raster-engine.md) |
| 气泡居中的匹配与分派 | [align-all](align-all.md) |
| 单位、页码、导出、ScriptUI 坑位 | [indesign-limits](indesign-limits.md) |
| 构建、COM 调试、测试规范 | [development](development.md) |

## 调试

```powershell
.\tools\run-jsx.ps1 -Jsx tools\probe.jsx          # 通用诊断：文档、页面、文本框、图层
.\tools\run-jsx.ps1 -Jsx path\to\your-script.jsx  # 任意本地脚本进真 InDesign
```

`run-jsx.ps1` 的返回值是脚本的 `OK` 或 `ERR <name>: <message> @line N`。脚本先复制到 `%TEMP%` 并以 BOM 重写，避免代码页问题；完整用法见 [development](development.md)。
