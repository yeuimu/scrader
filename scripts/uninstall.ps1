#Requires -Version 5.1
<#
.SYNOPSIS
  scrader 卸载器：清掉引导脚本与 runbook 装到本机的所有东西。
.DESCRIPTION
  用法:  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 [-RemoveData] [-DryRun]
  -RemoveData  连用户数据一起删（%APPDATA%\scrader_mcp：密钥/站点笔记/采集台账——默认保留）
  -DryRun      只打印将执行的动作
  手工两步（脚本无法代劳，见输出提示）：浏览器扩展移除 + 宿主 mcp.json 里删 scrader 条目。
#>
param([switch]$RemoveData, [switch]$DryRun)

function Info($m) { Write-Host "[uninstall] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[uninstall] OK $m" -ForegroundColor Green }

function Remove-PathSafe($p, $label) {
  if (-not (Test-Path $p)) { Info "跳过（不存在）: $label"; return }
  if ($DryRun) { Info "[dry] 删除 $p"; return }
  Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue
  Ok "已删 $label -> $p"
}
function Remove-FromUserPath($dir) {
  $p = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($p -split ';' | Where-Object { $_ -eq $dir })) { return }
  if ($DryRun) { Info "[dry] 用户 PATH 移除 $dir"; return }
  $np = ($p -split ';' | Where-Object { $_ -and $_ -ne $dir }) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $np, 'User')
  Ok "用户 PATH 已移除 $dir"
}

# 1) 停 bridge / cua-driver 进程（都不常驻安装，杀掉即可）
foreach ($proc in @('bridge')) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -match 'scrader.*bridge\.js'
  } | ForEach-Object {
    if ($DryRun) { Info "[dry] 结束进程 $($_.ProcessId) (bridge)" } else { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Ok "已结束 bridge 进程 $($_.ProcessId)" }
  }
}
if (Get-Command cua-driver -ErrorAction SilentlyContinue) {
  if ($DryRun) { Info "[dry] 停止 cua-driver" } else { cua-driver stop 2>$null | Out-Null; Ok "cua-driver 已停止" }
}

# 2) 技能三副本
foreach ($d in @(
  (Join-Path $env:USERPROFILE '.agents\skills\scrader'),
  (Join-Path $env:USERPROFILE '.zcode\skills\scrader'),
  (Join-Path $env:USERPROFILE '.pi\agent\skills\scrader')
)) { Remove-PathSafe $d "技能副本" }

# 3) cua-driver（目录 + junction + 配置）
Remove-PathSafe (Join-Path $env:LOCALAPPDATA 'Programs\Cua') 'cua-driver 程序'
Remove-PathSafe (Join-Path $env:USERPROFILE '.cua-driver') 'cua-driver 数据/junction/自启配置'
Remove-FromUserPath (Join-Path $env:LOCALAPPDATA 'Programs\Cua\cua-driver\bin')

# 4) 引导脚本装的 Node 与源码
Remove-PathSafe (Join-Path $env:LOCALAPPDATA 'scrader') '源码/node（引导脚本安装位）'

# 5) 用户数据（默认保留）
if ($RemoveData) {
  Remove-PathSafe (Join-Path $env:APPDATA 'scrader_mcp') '用户数据（密钥/笔记/台账）'
} else {
  $cfg = Join-Path $env:APPDATA 'scrader_mcp'
  if (Test-Path $cfg) { Info "保留用户数据: $cfg（加 -RemoveData 一并删除）" }
}

Write-Host ''
Info '还需手工两步：'
Info '  1) 浏览器 chrome://extensions（edge://extensions）→ 移除 scrader 扩展'
Info '  2) 宿主 MCP 配置（如 ~/.pi/agent/mcp.json）删除 "scrader" 条目，重启会话'
if ($DryRun) { Info 'DryRun 演练结束，未做任何更改。' }
