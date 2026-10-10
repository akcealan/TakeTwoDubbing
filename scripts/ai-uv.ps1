$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ToolDirectory = Join-Path $ProjectRoot '.tools\uv'
$UvExecutable = Join-Path $ToolDirectory 'uv.exe'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $ProjectRoot '.tools\uv-python'
$env:UV_CACHE_DIR = Join-Path $ProjectRoot '.tools\uv-cache'

if (-not (Test-Path -LiteralPath $UvExecutable)) {
  $UvVersion = '0.12.10'
  $UvZipSha256 = 'f65744f94072152b1f86ba2aace4d01f1124d9a8ecb235805039e3718c36cac2'
  $Archive = Join-Path $ToolDirectory 'uv.zip'
  New-Item -ItemType Directory -Force -Path $ToolDirectory | Out-Null
  Write-Host "uv $UvVersion proje araçlarına indiriliyor..."
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip" -OutFile $Archive
  $Actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $UvZipSha256) {
    Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
    throw 'uv arşivinin SHA-256 değeri resmi beklenen değerle eşleşmedi. İndirilen dosya silindi; ağı kontrol edip tekrar deneyin.'
  }
  Expand-Archive -LiteralPath $Archive -DestinationPath $ToolDirectory -Force
  Remove-Item -LiteralPath $Archive
}

if (-not (Test-Path -LiteralPath $UvExecutable)) {
  throw 'uv kurulamadı. Ağ bağlantısını ve .tools klasörü yazma iznini kontrol et.'
}

$UvExecutable
