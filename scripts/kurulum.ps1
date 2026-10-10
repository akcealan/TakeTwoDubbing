#Requires -Version 5.1
<#
  Take Two Windows kurulum betiği.
  Modlar: web (varsayılan), full (web + AI CPU ortamı), full-cuda (web + AI CUDA ortamı).
  Yalnızca mevcut proje betiklerini kullanır; yeni bağımlılık çerçevesi kurmaz.
#>
param([string]$Mod = '')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ToolsRoot = Join-Path $ProjectRoot '.tools'
$NodeVersion = '24.20.0'
$NodeDirectoryName = "node-v$NodeVersion-win-x64"
$NodeDirectory = Join-Path $ToolsRoot $NodeDirectoryName
$NodeDownloadUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeDirectoryName.zip"
$NodeZipSha256 = '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba'

function Write-Step([string]$Message) {
  Write-Host ''
  Write-Host "==> $Message" -ForegroundColor Green
}

function Fail([string]$Message) {
  Write-Host ''
  Write-Host "HATA: $Message" -ForegroundColor Red
  exit 1
}

function Test-NodeVersion([string]$Version) {
  $m = [regex]::Match($Version.Trim(), '^v?(\d+)\.(\d+)\.(\d+)')
  if (-not $m.Success) { return $false }
  $major = [int]$m.Groups[1].Value
  $minor = [int]$m.Groups[2].Value
  if ($major -eq 22) { return $minor -ge 22 }
  if ($major -eq 24) { return $minor -ge 15 }
  return $major -ge 26
}

function Find-UsableNode {
  $command = Get-Command 'node' -ErrorAction SilentlyContinue
  if ($null -eq $command) { return $null }
  try {
    $version = & $command.Source --version 2>$null
  } catch {
    return $null
  }
  if (Test-NodeVersion $version) { return $command.Source }
  Write-Host "Bulunan Node sürümü ($version) proje aralığına uymuyor; taşınabilir Node kullanılacak."
  return $null
}

function Install-PortableNode {
  $nodeExe = Join-Path $NodeDirectory 'node.exe'
  if (Test-Path -LiteralPath $nodeExe) {
    Write-Host "Taşınabilir Node zaten mevcut: $NodeDirectory"
    return
  }
  Write-Host "Node $NodeVersion indiriliyor (yalnızca resmi nodejs.org kaynağından)..."
  New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
  $archive = Join-Path $ToolsRoot 'kurulum-node.zip'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $NodeDownloadUrl -OutFile $archive
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $NodeZipSha256) {
      Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
      throw "SHA-256 doğrulanamadı. İndirilen dosya silindi; ağınızı kontrol edip tekrar deneyin."
    }
    if (Test-Path -LiteralPath $NodeDirectory) {
      Remove-Item -LiteralPath $NodeDirectory -Recurse -Force
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $ToolsRoot -Force
  } finally {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    throw 'Taşınabilir Node açılamadı.'
  }
  Write-Host 'Node doğrulandı ve kuruldu.'
}

function Install-NpmDependencies {
  $lock = Join-Path $ProjectRoot 'package-lock.json'
  $stamp = Join-Path $ToolsRoot 'kurulum-npm.sha256'
  $lockHash = (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash.ToLowerInvariant()
  if ((Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules')) -and (Test-Path -LiteralPath $stamp)) {
    $stamped = (Get-Content -LiteralPath $stamp -Raw -Encoding ASCII).Trim().ToLowerInvariant()
    if ($stamped -eq $lockHash) {
      Write-Host 'npm bağımlılıkları güncel; yeniden indirme atlanıyor.'
      return
    }
  }
  Write-Host 'npm bağımlılıkları kuruluyor (npm ci)...'
  & npm.cmd ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci başarısız oldu. Ağ bağlantısını kontrol edip tekrar çalıştırın.' }
  New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
  Set-Content -LiteralPath $stamp -Value $lockHash -Encoding ASCII -NoNewline
}

function Prepare-Runtime {
  Write-Host 'ffmpeg runtime hazırlanıyor...'
  & npm.cmd run runtime:prepare
  if ($LASTEXITCODE -ne 0) { throw 'runtime:prepare başarısız oldu.' }
  Write-Host 'ffmpeg runtime doğrulanıyor...'
  & npm.cmd run runtime:verify
  if ($LASTEXITCODE -ne 0) { throw 'runtime:verify başarısız oldu (SHA-256 uyuşmazlığı).' }
}

function Build-Project {
  Write-Host 'Proje derleniyor (typecheck + Vite + Worker dry-run)...'
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Build başarısız oldu. Yukarıdaki ilk hatayı inceleyin.' }
}

function Install-AiEnvironment([bool]$Cuda) {
  $setup = Join-Path $PSScriptRoot 'ai-setup.ps1'
  if ($Cuda) {
    Write-Host 'AI ortamı kuruluyor (CUDA yolu)...'
    & $setup -Cuda
  } else {
    Write-Host 'AI ortamı kuruluyor (güvenli CPU yolu)...'
    & $setup
  }
  if ($LASTEXITCODE -ne 0) { throw 'AI ortam kurulumu tamamlanamadı.' }
}

function Show-FinalNotes([bool]$Full) {
  Write-Host ''
  Write-Host 'Kurulum tamamlandı.' -ForegroundColor Green
  Write-Host 'Başlatmak için: npm.cmd run dev:all  (ardından http://127.0.0.1:5173)'
  if ($Full) {
    Write-Host ''
    Write-Host 'AI modelleri için kalan MANUEL adımlar (otomatik yapılmaz):'
    Write-Host '  1. Hugging Face üzerinde pyannote/speaker-diarization-community-1'
    Write-Host '     koşullarını kabul edin (CC BY 4.0, gated erişim).'
    Write-Host '  2. Ücretsiz read token üretin; HERHANGİ bir dosyaya yazmayın.'
    Write-Host '  3. Aynı terminalde $env:HF_TOKEN ayarlayıp npm.cmd run ai:models çalıştırın.'
    Write-Host '  4. Gerekirse ayırma ortamı: npm.cmd run ai:separation:setup'
    Write-Host '     (CDX23 checkpoint ağırlık lisansı belirsizdir; ağırlıklar'
    Write-Host '      depoya eklenmez ve otomatik indirilmez.)'
    if ([string]::IsNullOrWhiteSpace($env:HF_TOKEN)) {
      Write-Host '  Not: bu terminalde HF_TOKEN ayarlı değil; model indirme atlandı.'
    } else {
      Write-Host '  Not: bu terminalde HF_TOKEN bulunuyor; yine de indirme otomatik'
      Write-Host '  başlatılmadı. Lisansı kabul ettiyseniz 3. adımı çalıştırın.'
    }
  }
}

# --- Ana akış ---
Write-Host 'Take Two kurulumu başlıyor.'
Write-Host "Proje dizini: $ProjectRoot"

$mode = $Mod.Trim().ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($mode)) {
  Write-Host ''
  Write-Host 'Kurulum modu seçin:'
  Write-Host '  [1] Web uygulaması (önerilen)'
  Write-Host '  [2] Tam kurulum - AI (CPU)'
  Write-Host '  [3] Tam kurulum - AI (CUDA)'
  $choice = Read-Host 'Seçim (1/2/3)'
  switch ($choice.Trim()) {
    '2' { $mode = 'full' }
    '3' { $mode = 'full-cuda' }
    default { $mode = 'web' }
  }
}
if ($mode -notin @('web', 'full', 'full-cuda')) {
  Fail "Bilinmeyen mod: '$Mod'. Geçerli değerler: web, full, full-cuda."
}
$wantAi = $mode -ne 'web'
$wantCuda = $mode -eq 'full-cuda'

try {
  Write-Step '1/4 Node kontrol ediliyor'
  $node = Find-UsableNode
  if ($null -eq $node) {
    Install-PortableNode
    $env:PATH = "$NodeDirectory;$env:PATH"
    $node = Join-Path $NodeDirectory 'node.exe'
  } else {
    Write-Host "Kullanılabilir Node bulundu: $node"
    $portable = Join-Path $NodeDirectory 'node.exe'
    if ((Test-Path -LiteralPath $portable) -and ($node -ne $portable)) {
      $env:PATH = "$NodeDirectory;$env:PATH"
    }
  }
  & npm.cmd --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'npm çalışmıyor.' }

  Write-Step '2/4 npm bağımlılıkları'
  Push-Location -LiteralPath $ProjectRoot
  try {
    Install-NpmDependencies

    Write-Step '3/4 ffmpeg runtime'
    Prepare-Runtime

    Write-Step '4/4 build doğrulaması'
    Build-Project

    if ($wantAi) {
      Write-Step 'AI ortamı (mevcut proje betiği kullanılıyor)'
      Install-AiEnvironment $wantCuda
    }
  } finally {
    Pop-Location
  }

  Show-FinalNotes $wantAi
} catch {
  Fail $_.Exception.Message
}
