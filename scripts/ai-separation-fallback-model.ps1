$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$CacheDirectory = Join-Path $ProjectRoot 'ai\.cache\models\cdx23'
$Checkpoint = Join-Path $CacheDirectory '97d170e1-dbb4db15.th'
$Partial = "$Checkpoint.part"
$ExpectedSha256 = 'dbb4db154df7e45a5cb72d1659c48937e757f6d6b0eef8ca4199e6e38f8d8f37'
$Url = 'https://github.com/ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing/releases/download/v.1.0.0/97d170e1-dbb4db15.th'

New-Item -ItemType Directory -Force -Path $CacheDirectory | Out-Null
if (Test-Path -LiteralPath $Checkpoint) {
  $ExistingHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Checkpoint).Hash.ToLowerInvariant()
  if ($ExistingHash -eq $ExpectedSha256) {
    Write-Host "CDX23 fallback checkpoint hazır ve doğrulandı: $Checkpoint"
    exit 0
  }
  throw "Mevcut CDX23 checkpoint checksum geçersiz: $ExistingHash"
}

curl.exe -L --fail --retry 3 --retry-delay 2 -o $Partial $Url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$ActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Partial).Hash.ToLowerInvariant()
if ($ActualHash -ne $ExpectedSha256) {
  Remove-Item -LiteralPath $Partial -ErrorAction SilentlyContinue
  throw "CDX23 checkpoint checksum geçersiz: $ActualHash"
}
Move-Item -LiteralPath $Partial -Destination $Checkpoint
Write-Host "CDX23 fallback checkpoint indirildi ve doğrulandı: $Checkpoint"
