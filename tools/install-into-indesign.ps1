# 把 dist/Balloonist.jsx 装进 InDesign 的「脚本面板」目录
#   pwsh -File tools/install-into-indesign.ps1 [-Year 2025] [-NoBuild]
param(
  [int]$Year = 0,
  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $NoBuild) {
  Push-Location $root
  try { node build.js } finally { Pop-Location }
}

$dist = Join-Path $root 'dist\Balloonist.jsx'
if (-not (Test-Path $dist)) { throw "build output missing: $dist" }

$candidates = @()
if ($Year -gt 0) {
  $candidates += "C:\Program Files\Adobe\Adobe InDesign $Year\Scripts\Scripts Panel"
} else {
  $candidates += Get-ChildItem 'C:\Program Files\Adobe' -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'Adobe InDesign *' } |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'Scripts\Scripts Panel' }
}

$target = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $target) { throw 'InDesign Scripts Panel 目录没找到，用 -Year 2024 之类手动指定' }

$dest = Join-Path $target 'Balloonist.jsx'
$needsAdmin = $false
try {
  Copy-Item $dist $dest -Force
} catch {
  $needsAdmin = $true
}

if ($needsAdmin) {
  # Program Files 需要管理员：改用用户脚本目录（InDesign 同样会扫描）
  $userDir = Join-Path $env:APPDATA 'Adobe\InDesign\Scripts Panel'
  New-Item -ItemType Directory -Force -Path $userDir | Out-Null
  Copy-Item $dist (Join-Path $userDir 'Balloonist.jsx') -Force
  "已装到用户脚本目录: $userDir\Balloonist.jsx"
} else {
  "已装到: $dest"
}

$raster = Join-Path $root 'tools\raster\BalloonistRaster.exe'   # Go 静态二进制，无需 .NET
if (Test-Path $raster) {
  # 插件按「配置 → 仓库/tools/raster → %APPDATA%/Balloonist/tools/raster」顺序找分析器，
  # 装到 Scripts Panel 之后插件已经不在仓库里，所以这里必须再放一份到家目录。
  $homeRasterDir = Join-Path $env:APPDATA 'Balloonist\tools\raster'
  New-Item -ItemType Directory -Force -Path $homeRasterDir | Out-Null
  Copy-Item $raster (Join-Path $homeRasterDir 'BalloonistRaster.exe') -Force
  "分析器副本: $homeRasterDir\BalloonistRaster.exe"
} else {
  '分析器缺失，先跑 npm run raster:build'
}
