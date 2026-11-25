# 开发与调试

## 仓库结构

```
build.js             把 src/ 合成单文件
dist/Balloonist.jsx  可再生的构建产物
src/
  boot.jsx           启动：读配置、开面板
  core/
    paths.jsx        配置/日志/临时目录
    json.jsx         读写 JSON
    log.jsx          日志与滚动
    config.jsx       默认值、合并、保存
    geom.jsx         矩形运算、四舍五入
    id.jsx           InDesign 原语（页面、墨迹、导出、几何）
    raster.jsx       调用外部栅格分析器
    ops.jsx          气泡目标、匹配分派、落位、清除
    engine.jsx       功能注册表与运行入口
  features/          按文件名排序，编号决定面板顺序
  ui/panel.jsx       主面板与选项窗
docs/                架构、配置、平台坑位、对齐细节
tools/
  raster/            分析器源码与构建脚本
  run-jsx.ps1        用 COM 在真实 InDesign 里跑脚本
  install-into-indesign.ps1
```

## 构建

```powershell
npm run build
```

`build.js` 的拼装顺序固定：`paths → json → log → config → geom → id → raster → ops → engine`，再 `ui/panel.jsx`，最后 `boot.jsx`；`features/` 按文件名排序插入。输出：

- 首行 `#targetengine "balloonist"`；
- 整包 IIFE，只挂 `$.global.Balloonist`；
- UTF-8 BOM；
- 头部注释写版本号、构建时间、仓库地址；
- 写入前用 `new vm.Script` 预解析，语法错误在这里就失败，不会等到 InDesign 里才炸。

改了 `src/` 里任何文件都要重新 `npm run build`；Scripts Panel 读的是 `dist/Balloonist.jsx`，不是 `src/`。

分析器（`tools/raster/`）是纯 Go 实现（`core.go` 取图与度量、`modes.go` 四种检测模式、`main.go` 请求/JSON、`dump.go` 调试图），零第三方依赖。`npm run raster:build` 一条命令交叉编译三份产物：`BalloonistRaster.exe`（windows/amd64）、`BalloonistRaster-osx-arm64`、`BalloonistRaster-osx-x64`。插件侧通过 `raster.jsx` 调用，按平台挑文件。同目录的 `BalloonistRaster.cs` 是移植前的 C# 对照实现，不再参与构建。

改了 Go 代码后的回归办法：`node tools/raster/compare.js` 会拿当前 `BalloonistRaster.exe` 跑 `tools/raster/req-*.txt`，与记录的 `res-*.json` 逐字段比对（数值容差 1e-6，`dbg` 字符串要求逐字节相同）；加 `--old` 时先把旧 .NET 二进制（`BalloonistRaster-dotnet.exe`，从 git 历史取）跑一遍对齐。数值输出必须能复刻 .NET 的 `ToString("0.###")`：先折到 15 位有效数字，再对第三位小数 half-away-from-zero，`main.go` 里的 `N()` 用 `math/big.Rat` 做的就是这个。

## 开发循环

1. 改 `src/`。
2. `npm run build`。
3. InDesign 里关掉面板，重新双击脚本；或点面板「重载」重新执行 `$.evalFile`。
4. 需要隔离环境时设 `$.global.BALLOONIST_HOME`，别污染 `%APPDATA%`。

`dist/` 是产物，允许提交，方便不装 Node 的人直接用；但它随时可被 `npm run build` 覆盖，改动只应发生在 `src/`。

## 在真实 InDesign 里跑脚本

```powershell
pwsh tools/run-jsx.ps1 -Jsx tools/probe.jsx -Fresh
```

- 脚本会被写成 UTF-8 BOM 的临时文件再 `DoScript`；
- `-Fresh` 先关掉所有文档；
- `-Keep` 保留临时文件便于复查；
- 返回值约定为 `OK`，或 `ERR 名称: 消息 @行号`——用 `try/catch` 包住整个脚本，否则错误会变成模态框卡住自动化。

分析器单独调试时可以直接跑（macOS 上用启动壳或直接跑对应架构的二进制）：

```powershell
tools\raster\BalloonistRaster.exe req.txt res.json
```

```sh
tools/raster/BalloonistRaster req.txt res.json      # 壳按 uname -m 选架构
tools/raster/BalloonistRaster-osx-arm64 req.txt res.json
```

`req.txt` 是 `key=value` 行格式，结果 JSON 写到第二个参数给的路径。

## 加一个功能

1. 在 `src/features/` 新建 `NN_name.jsx`，编号决定顺序与分组。
2. 调用 `B.feature({ id, title, desc, group, order, options, run })`。
3. 需要在面板出现的选项全部写进 `options`，默认值也写在这里。
4. `run(ctx)` 里用 `ctx.doc`、`ctx.frames`、`ctx.settings`、`ctx.ops`、`ctx.id`；不要自己 `app.activeDocument`，否则批量运行时拿错文档。
5. 返回 `{ ok, message, report }`，`B.run` 会统一写 `last-result.json`。
6. 构建后在面板「重载」检查外观与默认值。

`B.run` 每次都会先 `B.id.forcePoints()`，新功能不必自己处理单位。

## 测试脚本与隐私

- 通用诊断脚本是 `tools/probe.jsx`：只读取当前文档的页面、文本框、图层、选中项和配置状态，不修改任何内容。改完环境后先用它确认 InDesign 侧正常。
- 需要端到端验证时，在本地另写脚本，放在 `tools/probe.local-*.jsx`（已被 `.gitignore` 排除），用 `BALLOONIST_HEADLESS` 加载 `dist`，依次跑铺框、填字、清除、居中和检测。样稿路径从 `BALLOONIST_SAMPLE` 读（默认 `tools/sample/page.png`），仓库根从 `BALLOONIST_ROOT` 读（默认当前目录）；因为 `$.getenv` 读的是 InDesign 进程的环境变量，要在启动 InDesign 之前设好。
- 样稿本身**不进仓库**：`.gitignore` 已排除本地素材目录与 `tools/**/*.txt|png|json`。
- 提交测试脚本前把绝对路径、作品名、话数、页号、台词全部换成占位符（`sample/`、`page.png`、`SAMPLE_TEXT`）。文档、提交信息、截图里同样不要出现真实作品信息。
- 需要展示效果时用抽象图形或合成页面，不要截真实稿件。
- 一次性探针只在本地用，命名成 `tools/probe.local-*.jsx`，不要提交。

## 发布检查

- [ ] `npm run build` 通过，`dist/Balloonist.jsx` 版本号正确
- [ ] `npm run raster:build` 可复现分析器
- [ ] 全新 `%APPDATA%\Balloonist` 下首跑不报错
- [ ] 毫米单位稿、对开页稿各跑一次
- [ ] README 与 `docs/` 中没有真实作品名、路径、台词
- [ ] `git status` 里没有样稿、导出图、日志
