param([switch]$Cuda)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$UvExecutable = & (Join-Path $PSScriptRoot 'ai-uv.ps1')

& $UvExecutable sync --project (Join-Path $ProjectRoot 'ai') --extra models --extra test
if ($LASTEXITCODE -ne 0) { throw 'Yerel AI bağımlılık kurulumu tamamlanamadı.' }

if ($Cuda) {
  $PythonExecutable = Join-Path $ProjectRoot 'ai\.venv\Scripts\python.exe'
  & $UvExecutable pip install --python $PythonExecutable --reinstall torch torchaudio --index-url https://download.pytorch.org/whl/cu128
  if ($LASTEXITCODE -ne 0) { throw 'CUDA PyTorch kurulumu tamamlanamadı.' }
  Write-Host 'CUDA paketleri kuruldu. Servisi TAKETWO_AI_DEVICE=cuda ile başlat.'
} else {
  Write-Host 'Güvenli CPU kurulumu tamamlandı. Model ağırlıkları için sıradaki açık adım: npm run ai:models'
}
