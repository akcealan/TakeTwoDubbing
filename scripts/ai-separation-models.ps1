param([switch]$Cuda)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvironmentName = if ($Cuda) { '.venv-separation-cuda' } else { '.venv-separation' }
$PythonExecutable = Join-Path $ProjectRoot "ai\$EnvironmentName\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $PythonExecutable)) {
  throw "Ayrıştırma ortamı bulunamadı. Önce npm run ai:separation:setup çalıştır."
}
$env:PYTHONPATH = Join-Path $ProjectRoot 'ai\src'
Push-Location (Join-Path $ProjectRoot 'ai')
try {
  & $PythonExecutable -m take_two_ai.download_separation_model
  if ($LASTEXITCODE -ne 0) { throw 'Bandit v2 Multi indirme/doğrulama tamamlanamadı.' }
} finally {
  Pop-Location
}
