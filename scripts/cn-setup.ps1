#Requires -Version 5.1
<#
.SYNOPSIS
  scrader 极简引导（国内网络）：只装三样 —— Node / 技能 / cua-driver。
  其余全部由 agent 按 scrader 技能自主完成（注册 MCP、重连、自动加载浏览器扩展、验证）。

.DESCRIPTION
  用法:  irm https://gitee.com/yeuimu/scrader/raw/main/scripts/cn-setup.ps1 | iex
  仓库内: powershell -ExecutionPolicy Bypass -File scripts\cn-setup.ps1 [-DryRun] [-SkipCua]
  设计原则: 安装器零框架知识、零步骤指导——引导词只说"去问你的 agent"。Python/gaze 依赖、
  npm 源、MCP 注册、扩展加载全部是技能里 agent 自己执行的知识。
#>
param([switch]$DryRun, [switch]$SkipCua)

$ErrorActionPreference = 'Stop'
$GITEE_ARCHIVE = 'https://gitee.com/yeuimu/scrader/repository/archive/main.zip'
$CUA_MIRROR    = 'https://gitee.com/yeuimu/scrader/releases/download/v0.6.1/cua-driver-mirror-0.28.2-win-x64.zip'
$NODE_INDEX    = 'https://registry.npmmirror.com/-/binary/node/latest-v22.x/'
$NODE_FALLBACK = 'https://registry.npmmirror.com/-/binary/node/v22.14.0/node-v22.14.0-win-x64.zip'

function Info($m) { Write-Host "[bootstrap] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[bootstrap] OK $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[bootstrap] !! $m" -ForegroundColor Yellow }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Download($url, $dst) {
  if ($DryRun) { Info "[dry] 下载 $url"; return }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing
}
function AddUserPath($dir) {
  $p = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($p -and $p.Contains($dir)) { return }
  if ($DryRun) { Info "[dry] 用户 PATH += $dir"; return }
  [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $dir), 'User')
  if (-not $env:Path.Contains($dir)) { $env:Path += ";$dir" }
}

# ── 0) 定位源码（仓库内 / 独立运行自动拉取）────────────────────────────
$Root = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '..\package.json'))) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
} else {
  Info '独立运行: 从 Gitee 下载源码包（约 90MB，含扩展与全部感知权重）'
  $zip = Join-Path $env:TEMP 'scrader-src.zip'
  $dst = Join-Path $env:LOCALAPPDATA 'scrader\src'
  if (-not $DryRun) {
    Download $GITEE_ARCHIVE $zip
    $x = Join-Path $env:TEMP 'scrader-src-x'
    Remove-Item -Recurse -Force $x -ErrorAction SilentlyContinue
    Expand-Archive $zip $x
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    $found = Get-ChildItem $x -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } | Select-Object -First 1
    if (-not $found) { throw '源码包里找不到 package.json' }
    $Root = Join-Path $dst 'repo'
    if (Test-Path $Root) { Remove-Item -Recurse -Force $Root }
    Move-Item $found.FullName $Root
    Remove-Item -Recurse -Force $x
  } else { $Root = Join-Path $dst 'repo' }
}

# ── 1) Node ≥18（MCP 服务端运行时，唯一硬前置）────────────────────────
$nvOk = $false
if (Have node) {
  $nv = (node -v) -replace '^v', ''
  if ((($nv -split '\.')[0] -as [int]) -ge 18) { Ok "node $nv (>=18)"; $nvOk = $true }
  else { Warn "node $nv < 18 —— 升级" }
}
if (-not $nvOk) {
  $url = $NODE_FALLBACK
  try {
    $f = (Invoke-RestMethod $NODE_INDEX) | Where-Object { $_.name -match 'win-x64\.zip$' } | Select-Object -First 1
    if ($f) { $url = $f.url; if ($url -notmatch '^https') { $url = "https:$url" } }
  } catch {}
  $name = Split-Path $url -Leaf
  $dst = Join-Path $env:LOCALAPPDATA ("scrader\node\" + ($name -replace '\.zip$', ''))
  Download $url (Join-Path $env:TEMP $name)
  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Expand-Archive (Join-Path $env:TEMP $name) (Split-Path $dst)
    $inner = Get-ChildItem $dst -Directory | Select-Object -First 1
    if ($inner -and (Test-Path (Join-Path $inner.FullName 'node.exe'))) { $dst = $inner.FullName }
  }
  AddUserPath $dst
}

# ── 2) 技能安装（~/.agents/skills = 跨工具标准位，零框架知识）──────────
$skillDir = Join-Path $env:USERPROFILE '.agents\skills\scrader'
if ($DryRun) { Info "[dry] 技能 -> $skillDir" }
else {
  New-Item -ItemType Directory -Force -Path (Split-Path $skillDir) | Out-Null
  Copy-Item (Join-Path $Root 'skills\scrader') $skillDir -Recurse -Force
  Ok "技能 -> $skillDir"
}

# ── 3) cua-driver（Gitee 镜像；装完 agent 即可操作电脑，进而自动装其余）──
if (-not $SkipCua) {
  $fb = Join-Path $env:LOCALAPPDATA 'Programs\Cua\cua-driver\bin\cua-driver.exe'
  if ((Have cua-driver) -or (Test-Path $fb)) { Ok 'cua-driver 已安装' }
  else {
    $zip = Join-Path $env:TEMP 'cua-driver-mirror.zip'
    Download $CUA_MIRROR $zip
    if (-not $DryRun) {
      $x = Join-Path $env:TEMP 'cua-mirror-x'
      Remove-Item -Recurse -Force $x -ErrorAction SilentlyContinue
      Expand-Archive $zip $x
      $bin = Join-Path $env:LOCALAPPDATA 'Programs\Cua\cua-driver\bin'
      New-Item -ItemType Directory -Force -Path $bin | Out-Null
      Copy-Item "$x\*.exe" $bin -Force
      $rel = Join-Path $env:USERPROFILE '.cua-driver\packages\releases\0.28.2-x86_64-pc-windows-msvc'
      New-Item -ItemType Directory -Force -Path $rel | Out-Null
      Copy-Item "$x\*.exe" $rel -Force
      $cur = Join-Path $env:USERPROFILE '.cua-driver\packages\current'
      if (Test-Path $cur) { cmd /c rmdir "$cur" }
      New-Item -ItemType Junction -Path $cur -Target $rel | Out-Null
      $cfg = Join-Path $env:USERPROFILE '.cua-driver\config.json'
      if (-not (Test-Path $cfg)) { '{"telemetry_enabled":false}' | Set-Content $cfg }
      AddUserPath $bin
      & (Join-Path $bin 'cua-driver.exe') autostart kick | Out-Null
      Ok "cua-driver -> $bin"
    }
  }
}

# ── 4) 自检 + 引导词（就这几行）────────────────────────────────────────
if (-not $DryRun) {
  & node (Join-Path $Root 'core\index.js') --check
  if ($LASTEXITCODE -eq 0) { Ok '自检 bridge OK' } else { Warn '自检未通过 —— 检查上方输出' }
}
Write-Host ''
Info "源码: $Root"
Info '下一步 —— 对你的 agent 说:「按 scrader 技能完成安装」'
Info '  （它会: 注册 MCP 到本宿主 → 重连 → 用 cua 自动加载浏览器扩展 → 验证全链路）'
if ($DryRun) { Warn 'DryRun 演练结束，未做任何更改。' }
