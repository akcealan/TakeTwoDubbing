$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$UvExecutable = & (Join-Path $PSScriptRoot 'ai-uv.ps1')
$env:PYTHONPATH = Join-Path $ProjectRoot 'ai\src'
$env:UV_PROJECT_ENVIRONMENT = Join-Path $ProjectRoot 'ai\.venv-test'
$env:TEMP = Join-Path $ProjectRoot '.tools\tmp-ai'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
$PytestTemp = Join-Path $env:TEMP ("pytest-" + [guid]::NewGuid().ToString('N'))
Push-Location (Join-Path $ProjectRoot 'ai')
try {
  & $UvExecutable run --extra test pytest --basetemp $PytestTemp
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $UvExecutable run --extra test ruff check .
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $UvExecutable run --extra test ruff format --check .
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
