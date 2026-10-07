#Requires -Version 5.1
<#
.SYNOPSIS
  scrader 国内网络一键安装/检测（China-network-friendly bootstrap）

.DESCRIPTION
  仓库内运行:  powershell -ExecutionPolicy Bypass -File scripts\cn-setup.ps1 [-DryRun] [-SkipCua] [-SkipEyes] [-SkipNode]
  独立运行:    irm https://gitee.com/yeuimu/scrader/raw/main/scripts/cn-setup.ps1 | iex
               （自动从 Gitee 下载源码包解压到 %LOCALAPPDATA%\scrader\src）

  换源策略（全部国内 CDN，不依赖 GitHub / cua.ai / pypi.org / npmjs.org）:
    Node/npm     npmmirror（registry.npmmirror.com + node 二进制镜像，装到用户目录免管理员）
    Python 依赖  清华 PyPI 镜像；有 uv 设 UV_DEFAULT_INDEX，无 uv 直接 venv+pip（不强装 uv）
    cua-driver   Gitee Release 镜像（官方 cua.ai 安装包的 MIT 原样转存）
    源码/扩展    Gitee（github.com/yeuimu/scrader 仅为海外备选）

.PARAMETER DryRun
  只打印将执行的动作，不下载、不写 PATH、不安装。

.PARAMETER SkipCua / SkipEyes / SkipNode
  跳过对应子系统。
#>
param([switch]$DryRun, [switch]$SkipCua, [switch]$SkipEyes, [switch]$SkipNode)

$ErrorActionPreference = 'Stop'
$GITEE_ARCHIVE = 'https://gitee.com/yeuimu/scrader/repository/archive/main.zip'
$CUA_MIRROR    = 'https://gitee.com/yeuimu/scrader/releases/download/v0.6.1/cua-driver-mirror-0.28.2-win-x64.zip'
$NODE_INDEX    = 'https://registry.npmmirror.com/-/binary/node/latest-v22.x/'
$NODE_FALLBACK = 'https://registry.npmmirror.com/-/binary/node/v22.14.0/node-v22.14.0-win-x64.zip'
$NPM_REGISTRY  = 'https://registry.npmmirror.com'
$TUNA_PYPI     = 'https://pypi.tuna.tsinghua.edu.cn/simple'
$PY_MIRROR_EXE = 'https://mirrors.huaweicloud.com/python/3.12.7/python-3.12.7-amd64.exe'

function Info($m) { Write-Host "[cn-setup] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[cn-setup] OK $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[cn-setup] !! $m" -ForegroundColor Yellow }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

function Download($url, $dst) {
  if ($DryRun) { Info "[dry] 下载 $url`n         -> $dst"; return }
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

# ── 0) 定位仓库根（仓库内运行 / 独立运行两种模式）─────────────────────
$Root = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '..\package.json'))) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  Ok "仓库模式: $Root"
} else {
  Info '独立运行模式: 从 Gitee 下载源码包（含扩展与全部感知权重，约 90MB）'
  $zip = Join-Path $env:TEMP 'scrader-src.zip'
  $dst = Join-Path $env:LOCALAPPDATA 'scrader\src'
  if (-not $DryRun) {
    Download $GITEE_ARCHIVE $zip
    $x = Join-Path $env:TEMP 'scrader-src-x'
    Remove-Item -Recurse -Force $x -ErrorAction SilentlyContinue
    Expand-Archive $zip $x
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    $found = Get-ChildItem $x -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } | Select-Object -First 1
    if (-not $found) { throw '源码包里找不到 package.json —— 请改用仓库模式运行' }
    $Root = Join-Path $dst 'repo'
    if (Test-Path $Root) { Remove-Item -Recurse -Force $Root }
    Move-Item $found.FullName $Root
    Remove-Item -Recurse -Force $x
  } else {
    Download $GITEE_ARCHIVE $zip
    $Root = Join-Path $dst 'repo'
  }
  Ok "源码就位: $Root"
}

# ── 1) Node / npm（npmmirror，装到用户目录免管理员）──────────────────
if (-not $SkipNode) {
  $nvOk = $false
  if (Have node) {
    $nv = (node -v) -replace '^v', ''
    $major = ($nv -split '\.')[0] -as [int]
    if ($major -ge 18) { Ok "node $nv 已安装 (>=18)"; $nvOk = $true }
    else { Warn "node $nv 低于 18 —— 从 npmmirror 升级到 node 22" }
  }
  if (-not $nvOk) {
    Info '缺 Node —— 从 npmmirror 二进制镜像安装 node 22（win-x64 zip）'
    $url = $NODE_FALLBACK
    try {
      $idx = Invoke-RestMethod $NODE_INDEX
      $f = $idx | Where-Object { $_.name -match 'win-x64\.zip$' } | Select-Object -First 1
      if ($f) { $url = $f.url; if ($url -notmatch '^https') { $url = "https:$url" } }
    } catch { Warn "镜像索引不可达，退回固定版本 $NODE_FALLBACK" }
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
    if (-not $DryRun) { Ok "node 就绪: $(node -v)" }
  }
  if (Have npm) {
    if ($DryRun) { Info "[dry] npm registry -> $NPM_REGISTRY" }
    else { npm config set registry $NPM_REGISTRY | Out-Null }
    Ok "npm registry = $NPM_REGISTRY"
  }
}

# ── 2) 眼层 Python 依赖（清华 PyPI；无 uv 不强装，走 venv+pip）────────
if (-not $SkipEyes) {
  $gazePy = Join-Path $Root 'eyes\gaze\gaze.py'
  $pkgs = 'rapidocr-onnxruntime', 'onnxruntime', 'opencv-python-headless', 'numpy'
  if (Have uv) {
    Ok 'uv 已安装 —— 设 UV_DEFAULT_INDEX 指向清华源（用户级）'
    if ($DryRun) { Info "[dry] UV_DEFAULT_INDEX = $TUNA_PYPI" }
    else {
      [Environment]::SetEnvironmentVariable('UV_DEFAULT_INDEX', $TUNA_PYPI, 'User')
      $env:UV_DEFAULT_INDEX = $TUNA_PYPI
    }
    Info "用法: uv run --with $($pkgs -join ' --with ') python $gazePy --help"
  } elseif (Have python) {
    $venv = Join-Path $Root 'eyes\gaze\.venv'
    $vp = Join-Path $venv 'Scripts\python.exe'
    if (Test-Path $vp) {
      Ok "gaze venv 已就绪: $vp"
    } else {
      Info '无 uv、有 python —— 建 venv 并从清华源装依赖（不强装 uv）'
      if (-not $DryRun) {
        python -m venv $venv
        & $vp -m pip install -i $TUNA_PYPI @pkgs | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'pip 安装失败 —— 检查网络后重跑' }
      }
      Ok "用法: $vp $gazePy --help"
    }
  } else {
    Info '无 uv、无 python —— 从华为云镜像静默安装 Python 3.12 到用户目录'
    $exe = Join-Path $env:TEMP 'python-3.12.7-amd64.exe'
    Download $PY_MIRROR_EXE $exe
    if (-not $DryRun) {
      Start-Process $exe -ArgumentList '/quiet', 'InstallAllUsers=0', "TargetDir=$env:LOCALAPPDATA\scrader\python312", 'PrependPath=1' -Wait
      AddUserPath "$env:LOCALAPPDATA\scrader\python312"
      Warn 'Python 装好后请重跑本脚本（或新开终端）以完成 gaze 依赖安装'
    }
  }
}

# ── 3) cua-driver 桌面子系统（Gitee 镜像；官方 cua.ai 的 MIT 转存）────
if (-not $SkipCua) {
  $fb = Join-Path $env:LOCALAPPDATA 'Programs\Cua\cua-driver\bin\cua-driver.exe'
  if ((Have cua-driver) -or (Test-Path $fb)) {
    Ok 'cua-driver 已安装'
  } else {
    Info '从 Gitee Release 镜像安装 cua-driver 0.28.2（官方安装包原样转存，MIT）'
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
      # current 是指向 release 目录的 junction（与官方安装一致）；只删链接本身，不动目标内容
      $cur = Join-Path $env:USERPROFILE '.cua-driver\packages\current'
      if (Test-Path $cur) { cmd /c rmdir "$cur" }
      New-Item -ItemType Junction -Path $cur -Target $rel | Out-Null
      $cfg = Join-Path $env:USERPROFILE '.cua-driver\config.json'
      if (-not (Test-Path $cfg)) { '{"telemetry_enabled":false}' | Set-Content $cfg }
      AddUserPath $bin
      & (Join-Path $bin 'cua-driver.exe') autostart kick | Out-Null
      Ok "cua-driver 就绪: $bin"
    }
  }
}

# ── 4) MCP 自动注册 + 技能自动安装（检测到 pi / ZCode 就自动配，幂等）──
$entryArgs = @((Join-Path $Root 'core\index.js'))
function Install-McpSkill($agentDir, $label, $withMcp) {
  if (-not (Test-Path $agentDir)) { return }
  if ($withMcp) {
    $mcpFile = Join-Path $agentDir 'mcp.json'
    if ($DryRun) { Info "[dry] $label MCP 注册 -> $mcpFile" }
    else {
      $scrader = '{"command":"node","args":' + ($entryArgs | ConvertTo-Json -Compress) + '}'
      $raw = ''
      if (Test-Path $mcpFile) { $raw = Get-Content $mcpFile -Raw }
      if ($raw -match '"scrader"') { Ok "$label MCP 已注册（跳过，幂等）" }
      elseif ($raw -match '\S') {
        try {
          $o = ConvertFrom-Json $raw
          if (-not $o.mcpServers) { $o | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }
          $o.mcpServers | Add-Member -NotePropertyName scrader -NotePropertyValue (ConvertFrom-Json $scrader) -Force
          ConvertTo-Json -InputObject $o -Depth 8 | Set-Content $mcpFile -Encoding utf8
          Ok "$label MCP 注册（合并进现有配置）: $mcpFile"
        } catch {
          Copy-Item $mcpFile "$mcpFile.bak" -Force
          Set-Content $mcpFile ('{"mcpServers":{"scrader":' + $scrader + '}}') -Encoding utf8
          Warn "$label mcp.json 解析失败，已备份为 .bak 并写入全新配置"
        }
      } else {
        Set-Content $mcpFile ('{"mcpServers":{"scrader":' + $scrader + '}}') -Encoding utf8
        Ok "$label MCP 注册: $mcpFile"
      }
    }
  }
  $skillDir = Join-Path $agentDir 'skills\scrader'
  if ($DryRun) { Info "[dry] $label 技能安装 -> $skillDir" }
  else {
    New-Item -ItemType Directory -Force -Path (Split-Path $skillDir) | Out-Null
    Copy-Item (Join-Path $Root 'skills\scrader') $skillDir -Recurse -Force
    Ok "$label 技能安装: $skillDir"
  }
}
Install-McpSkill (Join-Path $env:USERPROFILE '.pi\agent') 'pi' $true
Install-McpSkill (Join-Path $env:USERPROFILE '.zcode') 'ZCode' $false  # ZCode 只装技能；MCP 配置位置随宿主版本而异，不盲写

# ── 5) 自检（服务端语法 + 桥接拉起）──────────────────────────────────
if (-not $DryRun) {
  Info '自检: node core/index.js --check'
  & node (Join-Path $Root 'core\index.js') --check
  if ($LASTEXITCODE -eq 0) { Ok '自检通过（bridge OK）' } else { Warn '自检未通过 —— 检查上方输出' }
}

# ── 6) 收尾指引 ──────────────────────────────────────────────────────
$ext = Join-Path $Root 'hands\browser\extension'
Write-Host ''
Info '唯一手工步骤（浏览器策略限制，无法自动）:'
Info "  扩展: chrome://extensions -> 开发者模式 -> 加载已解压 -> $ext"
Info '其他 MCP 客户端（未被自动注册的）手工加: command=node, args=["<源码>/core/index.js"]'
Info '  （免克隆: command=cmd, args=["/c","npx","-y","git+https://gitee.com/yeuimu/scrader.git"]）'
Info 'decide 密钥(可选): 复制 core\providers.example.json 到 %APPDATA%\scrader_mcp\config.json'
Info '  llm 兜底支持任意 OpenAI 兼容端点 —— 国内可填 DeepSeek/GLM 的 baseUrl+apiKey'
if ($DryRun) { Warn 'DryRun 演练结束，未做任何更改。去掉 -DryRun 实际执行。' }
else { Ok '完成。重启 MCP 客户端会话后工具以 mcp__scrader__* 出现。' }
