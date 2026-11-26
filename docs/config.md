# 配置参考

配置文件：`%APPDATA%\Balloonist\balloonist.config.json`（可用全局变量 `BALLOONIST_HOME` 改目录）。
面板底部的「配置」按钮会直接用系统默认程序打开它；改完点「重载」生效（`feature` 开关需要重开脚本）。

合并规则：默认值 ← 配置文件 ← 单次运行传参。数组整体替换，对象逐键递归合并。

## 全局

| 键 | 默认 | 说明 |
|---|---|---|
| `showPanelOnLoad` | `true` | 双击脚本后是否自动开面板；`false` 只加载 API |
| `writeLastResult` | `true` | 每次运行写 `last-result.json`（`last-full.json` 存完整报告） |
| `confirmBeforeRun` | `false` | 预留；当前运行前不会弹确认 |
| `dpi` | `144` | 导出页面图的分析分辨率。越高越准，耗时近似平方增长 |
| `rasterExe` | `""` | 分析器路径；空则自动查找（Windows 找 `BalloonistRaster.exe`，macOS 找 `BalloonistRaster` 启动壳或 `BalloonistRaster-osx-*`），找到后回写 |
| `rasterTimeoutMs` | `20000` | 等分析结果的超时 |
| `pad` | `0.035` | 安全框从气泡轮廓向内收的比例（短边 3.5%，最少 2 px） |
| `thr` | `200` | 墨迹二值化亮度阈值 |
| `dil` | `1` | 掩膜膨胀像素 |
| `h` | `0.35` | 距离变换 h-maxima 的抑制深度，控制气泡被拆成几块 |
| `debugDump` | `false` | 保留每次分析请求/结果与中间图到 `tmp/` |
| `hideForExport` | `true` | 取图时隐藏文字层、诊断层、自定义 `hideLayers`、文本框实际所在图层，以及名称像译文层的图层（`Text`/`文字`/`中文`/`汉化`/`CN` 等，会排除 `art`/`image`/`图` 一类美术层词）；`skipLayer` 保持可见，`cleanLayer` 保留（白块用来盖住原文） |
| `maxPct` | `2` | 预留；各功能用自己选项里的 `maxPct` |
| `cleanFillCMYK` | `[0,0,0,2]` | 气泡涂白的近白色板；纯 0% 白会在 PNG 导出里透出底图 |
| `debugStrokeRGB` | `[255,0,0]` | 诊断线颜色 |

新文本默认：`fontFamily` = `MS Gothic`，`fontSize` = 24，`leading` = 0（0 表示自动行距）。

图层：`textLayer` = `Balloonist Text`，`cleanLayer` = `Balloonist Clean`，`debugLayer` = `Balloonist Debug`。改名后取图和清除仍按新名字工作。

## 气泡检测

| 键 | 默认 | 说明 |
|---|---|---|
| `detect` | `blobs` | `blobs` 亮区包围；`survey` 白纸分水岭；`auto` 先 blobs，空手再 survey |
| `minSide` | `0` | 气泡最小边（pt）。0 表示按页面百分比 |
| `minArea` | `0` | 气泡最小面积（pt²）。0 表示按页面百分比 |
| `minSidePct` | `3` | 短边的百分之几 |
| `minAreaPct` | `0.2` | 页面积的百分之几 |
| `maxAspect` | `3.5` | 长宽比上限，排除长条文字块 |
| `maxArea` | `0.09` | 单气泡面积上限（页面积占比），排除整片白底 |
| `minRingInk` | `0` | 描边墨量下限。0 接受被涂白、无描边的气泡；0.3 要求真黑边 |
| `minRectFill` | `0.72` | 气泡填充其外接框的比例。圆≈0.78，白方块≈1.0，脸/口袋更低 |
| `lightThr` | `205` | blobs 的内部亮度阈值。已嵌字扫描稿内部约 160–225，页边更亮 |
| `minFill` | `0.5` | 候选片必须占其外接框的比例 |
| `matchDist` | `24` | 文字框离气泡多远仍算匹配（pt） |

绝对阈值优先于百分比：`minSide`/`minArea` 大于 0 时直接生效，否则按页面尺寸换算——同一套配置可以同时服务小开本和周刊大页。

`detect` 选错的典型症状：`survey` 在已嵌字稿上会把字缝里的白块当成气泡；`blobs` 在纯线稿、气泡未涂白的稿上可能一个都找不到（此时把 `minRingInk` 降到 0 或改用 `survey`）。

## 功能开关

```json
{
  "features": { "alignAll": false },
  "options": {
    "centre": { "fitToBubble": true, "zeroInset": false },
    "alignAll": { "maxDist": 18, "snapNear": true }
  }
}
```

- `features.<id>: false` 从面板隐藏该功能（脚本仍可被 `B.run` 调用）。
- `options.<id>` 记住上一次在选项窗点的值；优先级低于单次运行传参。

## 各功能选项

### 气泡铺框 `autoframes`

| 选项 | 默认 | 说明 |
|---|---|---|
| `allPages` | `false` | 整本；关则当前页 |
| `fitToBubble` | `true` | 新框直接取安全框尺寸 |
| `vertical` | `false` | `true` 时建直排（竖排）框：StoryOrientation VERTICAL + 方向 RTL；不碰首行基线 |
| `inset` | `0` | 安全框再内缩的百分比（按短边算，`deflatePct`） |
| `autoSize` | `true` | 按 `min(安全框宽,高) × 0.22` 估起始字号，限制在 8–48 pt |
| `size` | `24` | `autoSize` 关时的固定字号 |
| `rescan` | `true` | 重新检测，不复用缓存 |

实现上只完整新建并设置第一个文本框，其余框从它 `duplicate` 到各自页面，只改位置和大小/字号；不再每个框都重设一遍字体、对齐和内边距。

### 检测气泡 `inspect`

不需要选中文本框，直接导出页面图检测。`allPages`（默认开）、`drawPoly`（轮廓）、`drawBox`（外接框）、`drawCentre`（重心十字）、`clear`（先清旧标记）。

### 居中对齐（EN）`centre`

| 选项 | 默认 | 说明 |
|---|---|---|
| `fitToBubble` | `true` | 框改成安全框大小 |
| `forceJustify` | `true` | 居中/强制对齐；**不改首行基线** |
| `zeroInset` | `true` | 内边距归零 |
| `shrink` | `false` | 溢出时缩字号 |
| `minPct` | `0.75` | 缩字号下限（相对原字号） |
| `onlyText` | `true` | 只处理有文字的框，避免把铺框后的空框当成成品稿来居中 |

### 气泡居中 `alignAll`

见 [align-all.md](align-all.md)。选项：`allPages`、`onlyText`、`skipLayer`（默认 `SFX`）、`moveOnly`（默认开）、`byInk`、`resizeToBox`（仅在关闭 `moveOnly` 时生效）、`fitSize`（预留，当前一律不缩字号）、`snapNear`（默认开）、`maxDist`（默认 48）、`minOverlap`（默认 0.25）、`bubblePad`（描边容差，默认 -1 自动约 6–20 pt）、`autoShift`（自动补偿整批偏移，默认开）、`shiftX`/`shiftY`（手动整批偏移，正值右/下）、`offsetY`（默认 2 pt）、`maxWeakShift`（默认 60 pt）、`detect`、`lightThr`、`minFill`、`dpi`（默认 150，0 沿用全局）、`dryRun`、`minPct`/`maxPct`（预留）。

### 适配气泡 `fit`

| 选项 | 默认 | 说明 |
|---|---|---|
| `minPct` | `0.75` | 最小缩到原字号 75% |
| `maxPct` | `6` | 最多放大到 600%；`0` = 不设倍数上限，由气泡安全框决定（内部仍有 20× 保护） |
| `step` | `0.5` | 兼容旧配置；新的气泡适配用二分搜索，步长只影响提示文案 |
| `forceJustify` | `true` | 对齐 |
| `zeroInset` | `true` | 内边距归零 |
| `onlyText` | `true` | 只处理有文字的框 |

适配不再只信 `overflows`，也不只放大到 2×：先把框的 `autoSizingType` 关掉（否则 InDesign 会把刚设好的安全框撑大），每次试字号都重置一次安全框，再用“框边界 + 实测墨迹”同时检查；二分搜索最大的可放字号。首行基线不动。

### 气泡涂白 `clean`

| 选项 | 默认 | 说明 |
|---|---|---|
| `allPages` | `false` | 整本；关则当前页 |
| `onlyMatched` | `true` | 只清除真正匹配到文本框的气泡，避免把脸/空白误当气泡涂白 |
| `removeOld` | `true` | 先清空 `Balloonist Clean` 图层里的旧遮盖 |

遮盖色由全局 `cleanFillCMYK` 控制，默认 `[0,0,0,2]`（2% K 的近白）。纯 0% 白在 InDesign 里是“纸白”，导出 PNG 时不会盖住底图，所以默认保留 2% 黑。

智能粘贴与样式重排已移除；字体只保留全局 `fontFamily` / `fontSize` / `leading`，不按 `REG:` / `SFX:` 前缀自动套样式。

## 文件位置

```
%APPDATA%\Balloonist\
  balloonist.config.json
  balloonist.log          运行日志，512 KB 滚动
  last-result.json        最近一次运行
  last-full.json          最近一次完整报告
  tmp\                    页面图、分析请求/结果
  tools\raster\           安装脚本复制来的分析器
```
