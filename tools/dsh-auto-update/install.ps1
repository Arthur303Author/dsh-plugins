<#
dsh-auto-update 安装脚本（在无沙箱限制的普通 PowerShell 中运行）

用法：
  powershell -ExecutionPolicy Bypass -File .\install.ps1                # 安装/更新
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall     # 卸载（只移除注入，保留文件）

做什么：
  1) 把 updater.mjs 复制到 %USERPROFILE%\.dsh\tools\dsh-auto-update\
  2) 生成 dsh-function.ps1（其中 dsh 函数指向部署后的 updater.mjs）
  3) 注入 PowerShell $PROFILE（Windows PowerShell 5.1 与 PowerShell 7 都处理，谁存在注入谁）
     之后新开的 PowerShell 里输入 dsh web / dsh --profile xxx 即自动进入检查流程；
     非启动类命令（dsh --help、dsh plugin ...）直接原样透传。
#>
[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$homeDest = Join-Path $env:USERPROFILE '.dsh\tools\dsh-auto-update'
$markerStart = '# >>> dsh-auto-update >>>'
$markerEnd = '# <<< dsh-auto-update <<<'
$profilePaths = @(
  (Join-Path $env:USERPROFILE 'Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1'),
  (Join-Path $env:USERPROFILE 'Documents\PowerShell\Microsoft.PowerShell_profile.ps1')
)

function Write-Utf8File([string]$path, [string]$content) {
  $utf8Bom = [System.Text.UTF8Encoding]::new($true)
  [System.IO.File]::WriteAllText($path, $content, $utf8Bom)
}
function Get-Block([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  $text = [System.IO.File]::ReadAllText($path)
  $start = $text.IndexOf($markerStart)
  if ($start -lt 0) { return $null }
  $end = $text.IndexOf($markerEnd, $start)
  if ($end -lt 0) { $end = $text.Length }
  return $text.Substring($start, $end - $start + $markerEnd.Length)
}

if ($Uninstall) {
  $removed = @()
  foreach ($p in $profilePaths) {
    if (Test-Path $p) {
      $text = [System.IO.File]::ReadAllText($p)
      $start = $text.IndexOf($markerStart)
      if ($start -ge 0) {
        $end = $text.IndexOf($markerEnd, $start)
        if ($end -ge 0) { $end += $markerEnd.Length } else { $end = $text.Length }
        $before = ''
        if ($start -gt 0) { $before = $text.Substring(0, $start) }
        $after = ''
        if ($end -lt $text.Length) { $after = $text.Substring($end) }
        $newText = ($before + $after).TrimStart("`r`n") + "`r`n"
        [System.IO.File]::WriteAllText($p, $newText, [System.Text.UTF8Encoding]::new($true))
        $removed += $p
      }
    }
  }
  $removedLines = $removed -join "`n  "
  Write-Host "已从以下 profile 移除 dsh 函数注入：`n  $removedLines" -ForegroundColor Green
  Write-Host "工具文件保留在 $homeDest（要彻底删除可手动移入回收站）。" -ForegroundColor Yellow
  return
}

# 1) 部署文件
New-Item -ItemType Directory -Force -Path $homeDest, (Join-Path $homeDest 'logs') | Out-Null
Copy-Item -Force (Join-Path $src 'updater.mjs') (Join-Path $homeDest 'updater.mjs')
$escapedDest = $homeDest.Replace("'", "''")

# 2) 生成 dsh-function.ps1（双引号 here-string，内部变量用反引号转义延迟求值）
$funcLines = @()
$funcLines += '# dsh-auto-update — 由 install.ps1 生成。dsh 函数在启动前自动执行更新检查。'
$funcLines += 'function dsh {'
$funcLines += '  $node = (Get-Command node -ErrorAction Stop).Source'
$funcLines += "  & `$node '$escapedDest\updater.mjs' @args"
$funcLines += '  $global:LASTEXITCODE = $LASTEXITCODE'
$funcLines += '}'
$func = $funcLines -join "`r`n"
Write-Utf8File (Join-Path $homeDest 'dsh-function.ps1') $func

# 3) 注入 profile
$injected = @()
foreach ($p in $profilePaths) {
  $dir = Split-Path $p
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $text = ''
  if (Test-Path $p) { $text = [System.IO.File]::ReadAllText($p) }
  $block = "`r`n$markerStart`r`n. '$escapedDest\dsh-function.ps1'`r`n$markerEnd`r`n"
  $start = $text.IndexOf($markerStart)
  if ($start -ge 0) {
    $end = $text.IndexOf($markerEnd, $start)
    if ($end -ge 0) { $end += $markerEnd.Length } else { $end = $text.Length }
    $text = $text.Substring(0, $start) + $block + $text.Substring($end)
  } else {
    $text = $text.TrimEnd("`r`n") + $block
  }
  Write-Utf8File $p $text
  $injected += $p
}

$injectedLines = $injected -join "`n    "
Write-Host 'dsh-auto-update 安装完成：' -ForegroundColor Green
Write-Host "  工具目录：$homeDest"
Write-Host "  已注入 PowerShell profile：`n    $injectedLines" -ForegroundColor Cyan
Write-Host ''
Write-Host '下一步：' -ForegroundColor Yellow
Write-Host '  1) 新开一个 PowerShell（或在当前会话执行  . $PROFILE）'
Write-Host '  2) 输入 dsh web 即可：启动前自动检查 dsh 本体（npmmirror）并询问升级，'
Write-Host '     启动时打印插件更新清单，正常退出后询问是否安装插件更新。'
Write-Host '  3) 卸载：重新运行本脚本加 -Uninstall'
