# 使用手册

## 环境

- Windows 或 macOS + Adobe InDesign 2025（其他年份未验证）。
- 气泡分析器是纯 Go 静态二进制（`BalloonistRaster.exe` / `BalloonistRaster-osx-arm64` / `BalloonistRaster-osx-x64`），自带运行时，**不需要 .NET Framework、Mono 或任何第三方库**。
- Node.js 仅构建时用，装好后运行时不需要；从源码编译分析器另需 Go 1.21+。

## 安装

```powershell
npm run raster:build      # 编译分析器（首次或改了 .cs 之后）
npm run build             # 生成单文件 dist/Balloonist.jsx
npm run install:scripts   # 装进 InDesign 的 Scripts Panel
```

`install:scripts` 自动挑最新的 InDesign 安装目录；要装到指定年份用 `-Year`：

```powershell
pwsh tools/install-into-indesign.ps1 -Year 2025 -NoBuild
```

macOS 用 shell 脚本，它会在所有已装版本的用户脚本目录里装上插件，同时把分析器拷到 `~/Library/Application Support/Balloonist/tools/raster/`，去掉下载隔离属性并做 ad-hoc 签名：

```sh
sh tools/install-mac.sh              # 会先 node build.js
sh tools/install-mac.sh --no-build   # 只安装
```

无管理员权限时 Windows 脚本会退到 `%APPDATA%\Adobe\InDesign\Scripts Panel`，并在 InDesign 的「用户脚本」下出现（mac 脚本本来装的都是用户脚本目录，不存在权限问题）。

**手动安装**：把 `dist/Balloonist.jsx` 复制到

```
C:\Program Files\Adobe\Adobe InDesign 2025\Scripts\Scripts Panel\
```

或

```
%APPDATA%\Adobe\InDesign\Scripts Panel\
```

macOS 对应

```
~/Library/Application Support/Adobe/InDesign/2025/<语言>/Scripts/Scripts Panel/
```

再把分析器放到用户目录：Windows 是 `%APPDATA%\Balloonist\tools\raster\BalloonistRaster.exe`，macOS 是 `~/Library/Application Support/Balloonist/tools/raster/`（把 `BalloonistRaster`、`BalloonistRaster-osx-arm64`、`BalloonistRaster-osx-x64` 三个文件一起放，并 `chmod +x`）。仓库结构原样保留时脚本也能自己找到分析器；也可以在配置里写 `rasterExe` 绝对路径。

启动：InDesign → 窗口 → 实用程序 → 脚本 → 双击 **Balloonist.jsx**。首次运行创建 `%APPDATA%\Balloonist\`（macOS 是 `~/Library/Application Support/Balloonist/`），存配置、日志和临时图。

## 面板

主面板：

- **功能列表**（原生滚动列表）：按「生成 / 诊断 / 气泡 / 文字」分组。
- **运行选中功能**：执行，结果写在状态栏。
- **选项…**：打开该功能自己的选项窗，勾完点「保存并运行」或「保存」。
- 底部：**重新检测**（清空气泡缓存）、**清临时**（清空 `tmp` 文件夹）、**日志**、**配置**、**重载**。

选项窗是独立窗口：ScriptUI 没有滚动容器，把几十个选项塞进一个面板会撑破布局，所以每个功能单开一页。文字类选项一行一个（标签 + 输入框），开关两列排。窗口关掉不保存；「保存」只写配置不动文档。

## 从零嵌字（通用流程）

1. 置入原图（扫描稿或修好的图都行），页面尺寸按**点**设好，例如 1403×2048 pt。别用毫米建页——脚本运行时会强制切换成点，但页面本身建错就救不回来。
2. 运行 **气泡铺框**：勾「整本」扫全书，否则只扫当前页；需要直排就勾「竖排」。每个气泡得到贴合安全框的空文本框；生成后自动选中第一页/当前页的新框（InDesign 不允许一次跨页全选）。
3. 直接在框里打字；复制译文粘进空框即可，不需要智能粘贴。
4. 运行 **适配气泡**：文本框铺到气泡安全框，实时检查框与墨迹都不超出气泡，按气泡搜最大字号（默认上限 600%）。想保留原字号就用 **居中对齐（EN）**；两者都不改首行基线。
5. 运行 **气泡涂白**：只清除有文本框的气泡，按轮廓生成近白遮盖，全部落在 `Balloonist Clean` 图层，删层即可还原。
6. 需要目检就运行 **检测气泡**：不用选中文本框，直接导出页面图检测，红圈/红框/十字画在 `Balloonist Debug` 图层。

欧美漫（横排、矩形框）同样适用：铺框 → 粘贴 → 居中，不需要缩字号时可全程不碰字号。

## 成品稿批量对齐

已经有字的稿子不要重新铺框。全选文本框（或直接对整本）运行 **气泡居中**：只平移，不改字号与排版。先勾「只试算」看命中情况，再正式跑。细节与阈值见 [align-all.md](align-all.md)。

## 图层

| 图层 | 内容 |
|---|---|
| `Balloonist Text` | 铺框产生的文本框 |
| `Balloonist Clean` | 气泡涂白的近白多边形 |
| `Balloonist Debug` | 诊断线，可整层删除 |

名字都能在配置里改。取图分析时会临时隐藏文字层与诊断层（以及 `SFX`/`Text` 和自定义 `hideLayers`），`Balloonist Clean` 保留——白块正好盖住原文，分析器看到的是干净气泡；结束后恢复。

## 常见问题

**提示找不到分析器**
把分析器放到 `%APPDATA%\Balloonist\tools\raster\`（macOS：`~/Library/Application Support/Balloonist/tools/raster/`），或在配置里填 `rasterExe`。安装脚本会替你复制；直接拷 `dist` 到别处而不带 `tools` 时最容易踩到。

**只有前几个字变了字体**
`contents` 只覆盖第一段。字号调整走 story 级遍历，遇到只改首段的旧代码请重新构建 `dist`。

**页面尺寸/位置整体偏小**
文档标尺是毫米。脚本每次运行会强制 `POINTS`，但页面本身必须按点建。

**面板一开就占满屏幕**
InDesign 的 ScriptUI 不支持滚动容器，选项全部塞进主面板会撑破 `preferredSize`。现在拆成主面板 + 每功能选项窗，窗口尺寸也有上限。

**气泡检测结果不对**
先看 `detect` 选对没有：`blobs` 适合已涂白/已嵌字的稿，`survey` 适合干净线稿。再调 `minRectFill`、`minRingInk`、`lightThr`。勾 `debugDump` 后到 `tmp/` 看中间图。

**找不到日志**
`%APPDATA%\Balloonist\balloonist.log`（macOS：`~/Library/Application Support/Balloonist/balloonist.log`），或面板「日志」按钮直接打开。

**macOS 上提示「无法验证开发者」/分析器一闪就退出**
`sh tools/install-mac.sh` 已经做了 `xattr -dr com.apple.quarantine` 和 `codesign --sign -`。手动拷贝的话自己补这两步：

```sh
xattr -dr com.apple.quarantine ~/Library/Application\ Support/Balloonist/tools/raster
codesign --force --sign - ~/Library/Application\ Support/Balloonist/tools/raster/BalloonistRaster-osx-arm64
```

## 调试入口

ExtendScript 控制台里可直接调 API：

```javascript
B.run('inspect', { drawPoly: true });        // 跑功能
B.ops.bubbleTargets(app.activeDocument, [app.activeDocument.pages[0]], B.cfg, true);
B.cfg.debugDump = true; B.config.save();     // 保留中间图
```

无面板启动：设置 `$.global.BALLOONIST_HEADLESS = true` 后再 `$.evalFile`，只加载 API 与配置。
