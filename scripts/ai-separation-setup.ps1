param([switch]$Cuda)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$UvExecutable = & (Join-Path $PSScriptRoot 'ai-uv.ps1')
$EnvironmentName = if ($Cuda) { '.venv-separation-cuda' } else { '.venv-separation' }
$EnvironmentPath = Join-Path $ProjectRoot "ai\$EnvironmentName"
$env:UV_PROJECT_ENVIRONMENT = $EnvironmentPath

& $UvExecutable sync --project (Join-Path $ProjectRoot 'ai') --extra separation --extra separation-fallback
if ($LASTEXITCODE -ne 0) { throw 'Ayrıştırma ortamı kurulamadı.' }

if ($Cuda) {
  $PythonExecutable = Join-Path $EnvironmentPath 'Scripts\python.exe'
  & $UvExecutable pip install --python $PythonExecutable --reinstall torch --index-url https://download.pytorch.org/whl/cu128
  if ($LASTEXITCODE -ne 0) { throw 'Ayrıştırma CUDA PyTorch kurulumu tamamlanamadı.' }
  Write-Host "İzole CUDA ayrıştırma ortamı hazır: $EnvironmentPath"
} else {
  Write-Host "İzole CPU ayrıştırma ortamı hazır: $EnvironmentPath"
}
