# 编译栅格分析器（纯 Go，零第三方依赖）：Windows + macOS(arm64/x64)
#
# 产物（同名协议，插件侧 src/core/raster.jsx 按平台自动挑一个）：
#   BalloonistRaster.exe          Windows x64（桌面插件实际只需要这一份）
#   BalloonistRaster-osx-arm64    Apple silicon
#   BalloonistRaster-osx-x64      Intel Mac
#   BalloonistRaster              macOS 启动壳（按 CPU 选上面两份之一）
#
# 用法：npm run raster:build   （或 pwsh -NoProfile -File tools/raster/build-raster.ps1）

$ErrorActionPreference = 'Stop'

$go = (Get-Command go -ErrorAction SilentlyContinue).Source
if (-not $go -and $env:GO) { $go = $env:GO }
if (-not $go) {
  throw '未找到 Go 工具链：装一个 Go 1.21+（https://go.dev/dl/）或把 go 放进 PATH，再跑 npm run raster:build'
}

Push-Location $PSScriptRoot
try {
  $env:CGO_ENABLED = '0'                     # 纯标准库，不需要 C 编译器
  $flags = @('-trimpath', '-ldflags=-s -w')  # 去掉路径与符号，三份加起来 ~8 MB

  Write-Host "go: $(& $go version)"

  $env:GOOS = 'windows'; $env:GOARCH = 'amd64'
  & $go build @flags -o (Join-Path $PSScriptRoot 'BalloonistRaster.exe') .
  if ($LASTEXITCODE -ne 0) { throw 'Windows 构建失败' }

  $env:GOOS = 'darwin'; $env:GOARCH = 'arm64'
  & $go build @flags -o (Join-Path $PSScriptRoot 'BalloonistRaster-osx-arm64') .
  if ($LASTEXITCODE -ne 0) { throw 'macOS arm64 构建失败' }

  $env:GOOS = 'darwin'; $env:GOARCH = 'amd64'
  & $go build @flags -o (Join-Path $PSScriptRoot 'BalloonistRaster-osx-x64') .
  if ($LASTEXITCODE -ne 0) { throw 'macOS x64 构建失败' }
}
finally {
  Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue
  Pop-Location
}

Get-ChildItem (Join-Path $PSScriptRoot 'BalloonistRaster*') |
  Where-Object { -not $_.PSIsContainer -and $_.Extension -ne '.ps1' } |
  Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } } |
  Format-Table -AutoSize | Out-String -Width 100 | Write-Host
