# Balloonist · 气泡工作台

Balloonist 是 Adobe InDesign 的漫画嵌字插件：从页面图里检测气泡，按气泡的安全框铺文本框，让文字落在气泡重心，并用独立图层盖掉原文。文字始终是**活文本**，可以继续修改、搜索和导出 PDF，不需要转曲或回 Photoshop 拼图。

支持 Windows 与 macOS（Intel / Apple silicon），当前针对 **InDesign 2025** 开发和验证。

## 功能

| 功能 | 说明 |
|---|---|
| 气泡铺框 | 扫描当前页或整本，为每个气泡创建贴合安全框的空文本框，可选横排/竖排 |
| 检测气泡 | 不选中文本框也能检测，把轮廓、外接框、重心画到诊断图层供目检 |
| 居中对齐（EN） | 把当前页或选中的文本框移到气泡中心，可套安全框、清内边距，不改首行基线 |
| 气泡居中 | 对已经排好字的成品稿批量匹配气泡并平移，默认不改字号、行距与段落设置 |
| 适配气泡 | 在气泡安全框内搜索能放下的最大字号，同时检查框边界与实际墨迹 |
| 气泡涂白 | 只处理真正有文本框的气泡，按轮廓生成近白遮盖，放在独立图层，删层即还原 |

## 安装

### 系统要求

- Windows 10/11 或 macOS 12+。
- Adobe InDesign 2025。
- 运行时不需要 Node.js、.NET、Mono 或其他运行库。气泡分析器是纯 Go 静态二进制。
- 只有从源码重新编译分析器时才需要 Go 1.21+；只构建 JSX 时需要 Node.js 18+。

### 方式一：下载 Release（推荐）

1. 打开本仓库的 **Releases** 页面，下载最新的 `balloonist-<版本>.zip`。
2. 解压到一个固定目录，例如 `D:\Apps\Balloonist` 或 `~/Applications/Balloonist`。
3. 运行对应平台的安装脚本。

Windows（PowerShell）：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\install-into-indesign.ps1 -NoBuild
```

macOS（终端）：

```sh
sh tools/install-mac.sh --no-build
```

安装脚本会完成两件事：

- 把 `dist/Balloonist.jsx` 放进 InDesign 的 Scripts Panel；没有管理员权限时自动改用当前用户的脚本目录。
- 把气泡分析器复制到 `%APPDATA%\Balloonist\tools\raster\`（macOS 为 `~/Library/Application Support/Balloonist/tools/raster/`），macOS 还会去掉隔离属性并做 ad-hoc 签名。

重启 InDesign，或在「窗口 → 实用程序 / 工具 → 脚本」面板里刷新，即可看到 **Balloonist.jsx**。

### 方式二：手动安装

如果不想运行脚本，可以只复制两个部分。

**1. 插件 JSX**

中文版 InDesign 放到版本/语言目录（`20.0-J` 会随 InDesign 版本变化）：

```text
%APPDATA%\Adobe\InDesign\Version 20.0-J\zh_CN\Scripts\Scripts Panel\
```

英文版 InDesign 放到共享目录：

```text
%APPDATA%\Adobe\InDesign\Scripts Panel\
```

这两个位置不能混用。安装脚本会自动识别已存在的版本/语言目录，并优先装到中文版目录。

macOS 放到（`<语言>` 可能是 `zh_CN`、`en_US` 等）：

```text
~/Library/Application Support/Adobe/InDesign/2025/<语言>/Scripts/Scripts Panel/
```

**2. 气泡分析器**

Windows 把 `BalloonistRaster.exe` 放到：

```text
%APPDATA%\Balloonist\tools\raster\BalloonistRaster.exe
```

macOS 把 `BalloonistRaster`、`BalloonistRaster-osx-arm64`、`BalloonistRaster-osx-x64` 三个文件一起放到：

```text
~/Library/Application Support/Balloonist/tools/raster/
```

然后给它们执行权限并去掉隔离属性：

```sh
chmod +x ~/Library/Application\ Support/Balloonist/tools/raster/BalloonistRaster*
xattr -dr com.apple.quarantine ~/Library/Application\ Support/Balloonist/tools/raster
codesign --force --sign - ~/Library/Application\ Support/Balloonist/tools/raster/BalloonistRaster-osx-arm64
codesign --force --sign - ~/Library/Application\ Support/Balloonist/tools/raster/BalloonistRaster-osx-x64
```

也可以在面板的「配置」里把 `rasterExe` 直接写成分析器的绝对路径。

### 方式三：从源码安装

```sh
git clone https://github.com/jqk4388/balloonist.git
cd balloonist
npm run build
```

Windows：

```powershell
npm run install:scripts
```

macOS：

```sh
sh tools/install-mac.sh
```

仓库已经包含三份编译好的分析器，正常安装不需要 Go。只有修改了 `tools/raster/*.go` 才需要重新编译：

```powershell
npm run raster:build
```

## 第一次启动

1. 打开 InDesign，新建或打开文档。
2. 在「窗口 → 实用程序 / 工具 → 脚本」里双击 **Balloonist.jsx**。
3. 首次运行会在用户目录创建配置、日志和临时目录：
   - Windows：`%APPDATA%\Balloonist\`
   - macOS：`~/Library/Application Support/Balloonist/`
4. 主面板出现后，先选中一个功能，再点「运行选中功能」。需要调参数时点「选项…」。

## 使用

### 新稿：从零开始嵌字

1. **准备页面**：置入原图。页面尺寸请用**点（pt）**设置，不要用毫米；脚本运行时会把计量单位强制切到点，但页面本身建错后无法自动修正。
2. **气泡铺框**：选中该功能。勾「整本」扫描全部页面，否则只处理当前页；需要竖排就勾「竖排」。脚本会为检测到的气泡建立空文本框，并自动选中第一页或当前页的新框。
3. **输入文字**：直接在文本框里打字，或把译文粘贴进去。
4. **落位与字号**：
   - 想保留原字号：运行 **居中对齐（EN）**。
   - 想让文字填满气泡：运行 **适配气泡**，它会在安全框内搜索最大可放字号。
   - 两者都不会改动首行基线。
5. **盖掉原文**：运行 **气泡涂白**。默认只涂真正有文本框的气泡，不会把脸、空白或拟声字误当气泡。遮盖在 `Balloonist Clean` 图层，删除该层即可还原。
6. **检查**：运行 **检测气泡**，轮廓、安全框和重心会画在 `Balloonist Debug` 图层；检查完可整层删除。

### 成品稿：只做位置校正

已经有文字、字号和断行的稿子，不要重新铺框。

1. 选中需要处理的文本框；或者不选，勾「整本」处理全部页面。
2. 运行 **气泡居中**。
3. 先勾「只试算」跑一次，查看命中、贴靠和未匹配数量。
4. 确认无误后取消「只试算」，正式执行。

默认的「只移动」只改文本框位置，不改字号、行距、对齐、内边距、首行基线和框尺寸。若文字比气泡大，脚本仍会把它移到气泡中心，但是否断行由你决定。

### 面板按钮

- **运行选中功能**：执行当前功能，结果显示在底部状态栏。
- **选项…**：打开当前功能的独立选项窗；点「保存并运行」立即执行，点「保存」只写配置。
- **重新检测**：清空气泡缓存，下次运行重新导出并分析页面。
- **清临时**：清空临时图片与分析结果。
- **日志 / 配置**：用系统默认程序打开日志或配置文件。
- **重载**：重新加载插件，改了 `dist/Balloonist.jsx` 后使用。

### 图层

| 图层 | 内容 | 是否可以删除 |
|---|---|---|
| `Balloonist Text` | 铺框生成的文本框 | 删除前确认文字已处理完 |
| `Balloonist Clean` | 气泡涂白的近白遮盖 | 可整层删除，立即还原原文 |
| `Balloonist Debug` | 检测轮廓、安全框、重心标记 | 可整层删除 |

图层名可以在配置里修改。取图分析时，文字层、诊断层以及 `SFX`、`Text` 和自定义 `hideLayers` 会临时隐藏，`Balloonist Clean` 会保留，让分析器看到干净气泡；分析结束后自动恢复。

## 配置

配置文件位置：

- Windows：`%APPDATA%\Balloonist\balloonist.config.json`
- macOS：`~/Library/Application Support/Balloonist/balloonist.config.json`

面板底部「配置」可直接打开。修改后点「重载」生效；功能开关的改动需要重新打开脚本。常用项包括检测器、dpi、安全框内边距、亮度阈值、图层名、字体与字号。完整清单见 [配置参考](docs/config.md)。

## 更新

1. 下载新版本的 Release 压缩包。
2. 关闭 InDesign。
3. 用新包里的 `dist/Balloonist.jsx` 覆盖 Scripts Panel 里的旧文件；分析器有更新时一并覆盖。
4. 重新打开 InDesign。配置和日志保存在用户目录，不会被覆盖。

## 常见问题

**提示找不到气泡分析器**

确认分析器已放到用户目录，或在配置里填写 `rasterExe`。只把 `Balloonist.jsx` 复制到 Scripts Panel、没有复制分析器时最容易出现。

**页面尺寸或坐标整体偏小**

文档标尺用的是毫米。脚本会把计量单位切到点，但页面本身必须按点创建；已经按毫米建好的页面无法靠脚本修正。

**面板一打开就占满屏幕**

InDesign 的 ScriptUI 没有滚动容器，所以选项被拆到每个功能自己的窗口。若窗口仍然过大，缩小系统缩放或降低 InDesign 的界面缩放。

**气泡检测结果不准**

先在配置里切换 `detect`：`blobs` 适合已涂白或已嵌字的稿，`survey` 适合干净线稿。再调 `minRectFill`、`minRingInk`、`lightThr` 等阈值。勾选 `debugDump` 后可在临时目录查看中间图。

**macOS 提示无法验证开发者**

用 `tools/install-mac.sh` 安装会自动处理隔离属性与签名。手动安装时按上面的命令补 `xattr` 和 `codesign`。

**日志在哪里**

- Windows：`%APPDATA%\Balloonist\balloonist.log`
- macOS：`~/Library/Application Support/Balloonist/balloonist.log`

也可以点面板的「日志」直接打开。

## 文档

| 文档 | 内容 |
|---|---|
| [使用手册](docs/usage.md) | 环境、安装细节、面板、完整流程、图层、FAQ |
| [配置参考](docs/config.md) | 全部配置项、功能选项、默认值、检测器选择 |
| [气泡居中](docs/align-all.md) | 匹配打分、空间门槛、分派、批量取图、边界情况 |
| [架构](docs/architecture.md) | 模块划分、单文件打包、功能注册、坐标与取图 |
| [栅格引擎](docs/raster-engine.md) | 请求/结果协议、检测流水线、调参、性能 |
| [与 TypeR 对照](docs/typesr-parity.md) | 机制差异与有意保留的不同做法 |
| [InDesign 坑位](docs/indesign-limits.md) | 单位、页码、导出、图层、文本、ScriptUI 限制 |
| [开发与调试](docs/development.md) | 构建、开发循环、COM 调试、测试与隐私规则 |

## 开发与发布

构建单文件插件：

```powershell
npm run build
```

输出为 `dist/Balloonist.jsx`，构建前会用 Node 的 `vm` 预解析语法。修改 `src/` 后必须重新构建，Scripts Panel 读取的是 `dist/`。

发布由 GitHub Actions 自动完成，工作流文件为 [`.github/workflows/release.yml`](.github/workflows/release.yml)：

```powershell
# 版本号与 package.json 一致后打 tag
git tag v1.0.0
git push origin v1.0.0
```

推送 `v*` 标签后，工作流会：

1. 校验 tag 与 `package.json` 的版本号一致；
2. 运行 `npm run build`；
3. 打包插件、分析器、安装脚本与文档；
4. 创建 GitHub Release，并上传 `balloonist-<版本>.zip`、独立 JSX 与校验和。

## 隐私与素材

仓库不包含任何真实稿件、漫画页面截图、作品名、台词或本地绝对路径。文档中的页面、路径和文字均为占位符；开发时请使用合成样稿或抽象图形，不要把实际工作稿提交进仓库。

## 许可

MIT，详见 [LICENSE](LICENSE)。
