# 把 dist/Balloonist.jsx 装进 InDesign 的「脚本面板」目录
#   pwsh -File tools/install-into-indesign.ps1 [-Year 2025] [-NoBuild] [-TargetDir <目录>]
#
# InDesign 的脚本目录分两种，不能混用：
#   中文版（版本/语言目录）：%APPDATA%\Adobe\InDesign\Version 20.0-J\zh_CN\Scripts\Scripts Panel
#   英文版（共享目录）    ：%APPDATA%\Adobe\InDesign\Scripts Panel
# 脚本会先找已存在的版本/语言目录，再找英文版共享目录；找到哪个就装哪个。
param(
  [int]$Year = 0,
  [string]$TargetDir = '',
  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $NoBuild) {
  Push-Location $root
  try { node build.js } finally { Pop-Location }
}

$dist = Join-Path $root 'dist\Balloonist.jsx'
if (-not (Test-Path -LiteralPath $dist)) { throw "build output missing: $dist" }

function Test-Panel([string]$path) {
  return (Test-Path -LiteralPath $path -PathType Container)
}

# 当前界面语言对应的 InDesign 语言目录名（用于多个语言目录并存时优先选择）
$prefLocale = switch -Regex ($PSUICulture) {
  '^zh-(CN|Hans)' { 'zh_CN'; break }
  '^zh-(TW|HK|MO|Hant)' { 'zh_TW'; break }
  default { '' }
}

$target = $null
$targetKind = ''
$targetVersion = ''

if ($TargetDir) {
  if (-not (Test-Panel $TargetDir)) { throw "指定的脚本目录不存在: $TargetDir" }
  $target = (Resolve-Path -LiteralPath $TargetDir).Path
  $targetKind = '手动指定'
} else {
  $userRoot = Join-Path $env:APPDATA 'Adobe\InDesign'
  $userCandidates = @()

  if (Test-Path -LiteralPath $userRoot) {
    # 1) 中文版/其他本地化版本：Version 20.0-J\zh_CN\Scripts\Scripts Panel
    $versionDirs = @(Get-ChildItem -LiteralPath $userRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^Version\s+[0-9.]+' } |
      Sort-Object { if ($_.Name -match '([0-9.]+)') { [double]$matches[1] } else { 0 } } -Descending)

    foreach ($vd in $versionDirs) {
      $localeDirs = @(Get-ChildItem -LiteralPath $vd.FullName -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^[a-z]{2}_[A-Z]{2}$' } |
        Sort-Object @{ Expression = { if ($_.Name -eq $prefLocale) { 0 } else { 1 } } }, Name)

      foreach ($ld in $localeDirs) {
        $panel = Join-Path $ld.FullName 'Scripts\Scripts Panel'
        if (Test-Panel $panel) {
          $userCandidates += [pscustomobject]@{
            Path = $panel
            Kind = '版本/语言目录'
            Version = $vd.Name
            Locale = $ld.Name
          }
        }
      }
    }

    # 2) 英文版共享目录：%APPDATA%\Adobe\InDesign\Scripts Panel
    $englishPanel = Join-Path $userRoot 'Scripts Panel'
    if (Test-Panel $englishPanel) {
      $userCandidates += [pscustomobject]@{
        Path = $englishPanel
        Kind = '英文版共享目录'
        Version = ''
        Locale = 'en_US'
      }
    }
  }

  if ($userCandidates.Count -gt 0) {
    $c = $userCandidates[0]
    $target = $c.Path
    $targetKind = $c.Kind
    $targetVersion = $c.Version
  }
}

# 3) 用户目录都没有时，退回 Program Files（可能需要管理员权限）
if (-not $target) {
  $appCandidates = @()
  if ($Year -gt 0) {
    $appCandidates += "C:\Program Files\Adobe\Adobe InDesign $Year\Scripts\Scripts Panel"
  } else {
    $appCandidates += Get-ChildItem 'C:\Program Files\Adobe' -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like 'Adobe InDesign *' } |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'Scripts\Scripts Panel' }
  }
  $target = $appCandidates | Where-Object { Test-Panel $_ } | Select-Object -First 1
  $targetKind = 'Program Files（需管理员）'
}

if (-not $target) {
  throw '没有找到可用的 InDesign 脚本目录。请运行一次 InDesign，或用 -TargetDir 手动指定 Scripts Panel 目录。'
}

$dest = Join-Path $target 'Balloonist.jsx'
$needsAdmin = $false
try {
  Copy-Item -LiteralPath $dist -Destination $dest -Force
} catch {
  $needsAdmin = $true
}

if ($needsAdmin) {
  # Program Files 需要管理员：改装到用户目录，且按中文版/英文版的位置分开。
  $userRoot = Join-Path $env:APPDATA 'Adobe\InDesign'
  $newestVersion = @(Get-ChildItem -LiteralPath $userRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^Version\s+[0-9.]+' } |
    Sort-Object { if ($_.Name -match '([0-9.]+)') { [double]$matches[1] } else { 0 } } -Descending |
    Select-Object -First 1)

  if ($newestVersion.Count -gt 0 -and $prefLocale) {
    $userDir = Join-Path $newestVersion[0].FullName "$prefLocale\Scripts\Scripts Panel"
  } else {
    $userDir = Join-Path $userRoot 'Scripts Panel'
  }
  New-Item -ItemType Directory -Force -Path $userDir | Out-Null
  Copy-Item -LiteralPath $dist -Destination (Join-Path $userDir 'Balloonist.jsx') -Force
  "已装到用户脚本目录: $userDir\Balloonist.jsx"
} else {
  $where = if ($targetVersion) { "$targetKind · $targetVersion" } else { $targetKind }
  "已装到: $dest"
  "目录类型: $where"
}

$raster = Join-Path $root 'tools\raster\BalloonistRaster.exe'   # Go 静态二进制，无需 .NET
if (Test-Path -LiteralPath $raster) {
  # 插件按「配置 → 仓库/tools/raster → %APPDATA%/Balloonist/tools/raster」顺序找分析器，
  # 装到 Scripts Panel 之后插件已经不在仓库里，所以这里必须再放一份到家目录。
  $homeRasterDir = Join-Path $env:APPDATA 'Balloonist\tools\raster'
  New-Item -ItemType Directory -Force -Path $homeRasterDir | Out-Null
  Copy-Item -LiteralPath $raster -Destination (Join-Path $homeRasterDir 'BalloonistRaster.exe') -Force
  "分析器副本: $homeRasterDir\BalloonistRaster.exe"
} else {
  '分析器缺失，先跑 npm run raster:build'
}
