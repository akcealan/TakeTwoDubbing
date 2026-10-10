$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PythonExecutable = Join-Path $ProjectRoot 'ai\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $PythonExecutable)) {
  throw 'Yerel AI ortamı bulunamadı. Önce npm run ai:setup komutunu çalıştır.'
}
$env:PYANNOTE_METRICS_ENABLED = '0'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:HF_HUB_OFFLINE = '1'
$env:PYTHONPATH = Join-Path $ProjectRoot 'ai\src'
Push-Location (Join-Path $ProjectRoot 'ai')
try {
  & $PythonExecutable -m take_two_ai.app
  if ($LASTEXITCODE -ne 0) { throw 'Yerel AI servisi beklenmedik biçimde kapandı.' }
} finally {
  Pop-Location
}
