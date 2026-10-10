param(
  [ValidateSet('auto', 'cpu', 'cuda')]
  [string]$Device = 'auto',
  [string]$Source = 'local-test-media\clip1-speaker-regression.mp4',
  [string]$Output = 'local-test-media\separation-eval\clip1-speaker-regression'
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvironmentName = if ($Device -eq 'cpu') { '.venv-separation' } else { '.venv-separation-cuda' }
$PythonExecutable = Join-Path $ProjectRoot "ai\$EnvironmentName\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $PythonExecutable)) {
  throw "Ayrıştırma ortamı bulunamadı: $EnvironmentName"
}
$env:PYTHONPATH = Join-Path $ProjectRoot 'ai\src'
Push-Location $ProjectRoot
try {
  & $PythonExecutable 'ai\scripts\evaluate_separation.py' $Source $Output --private-root 'local-test-media' --device $Device
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
