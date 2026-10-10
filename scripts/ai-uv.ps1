$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ToolDirectory = Join-Path $ProjectRoot '.tools\uv'
$UvExecutable = Join-Path $ToolDirectory 'uv.exe'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $ProjectRoot '.tools\uv-python'
$env:UV_CACHE_DIR = Join-Path $ProjectRoot '.tools\uv-cache'

if (-not (Test-Path -LiteralPath $UvExecutable)) {
  $UvVersion = '0.12.10'
  $Archive = Join-Path $ToolDirectory 'uv.zip'
  New-Item -ItemType Directory -Force -Path $ToolDirectory | Out-Null
  Write-Host "uv $UvVersion proje araçlarına indiriliyor..."
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip" -OutFile $Archive
  Expand-Archive -LiteralPath $Archive -DestinationPath $ToolDirectory -Force
  Remove-Item -LiteralPath $Archive
}

if (-not (Test-Path -LiteralPath $UvExecutable)) {
  throw 'uv kurulamadı. Ağ bağlantısını ve .tools klasörü yazma iznini kontrol et.'
}

$UvExecutable
