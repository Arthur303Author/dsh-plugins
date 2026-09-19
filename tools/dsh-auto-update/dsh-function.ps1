# dsh-auto-update — 由 install.ps1 生成。dsh 函数在启动前自动执行更新检查。
function dsh {
  $node = (Get-Command node -ErrorAction Stop).Source
  & $node 'C:\Users\<user>\.dsh\tools\dsh-auto-update\updater.mjs' @args
  $global:LASTEXITCODE = $LASTEXITCODE
}