# Take Two

English: [README.md](README.md)

Take Two özgün, ücretsiz bir web dublaj parti oyunudur. Küçük bir özel grup
farklı evlerden bağlanır, kayıt olmadan kodlu bir odaya katılır, atanmış
replikleri tek tek kaydeder ve tek bir MP4 sonucu paylaşır. Kullanıcı arayüzü
Türkçedir. dublaj.io kodu, markası veya korumalı içeriği kullanılmamıştır.

**Bakım durumu: pasif.** Geliştirme artık aktif değildir. Bu depo, projenin
ileride geri yüklenebilmesi için kaynak kodu ve belgeleri korur. Bkz.
[docs/ARCHIVAL.md](docs/ARCHIVAL.md). Destek, yol haritası ve planlı yeni iş
yoktur.

## Özellikler

- Sahne kitaplığı, kodlu odalar, canlı lobi, çevrimiçi durumu, hazır durumu, yeniden bağlanma.
- Sunucu yetkili başlatma, deterministik karakter ataması, host geçişi.
- 3–2–1 geri sayımlı rehberli replik kaydı, onay öncesi inceleme, sunucu doğrulamalı yükleme.
- Dondurulmuş render manifesti, tarayıcıda H.264/AAC MP4 üretimi, paylaşımlı oynatma/indirme.
- Özel Sahne Stüdyosu: sahip olunan WebM/MP4 kliplerden karakter, milisaniyelik
  diyalog pencereleri, küçük görsel ve isteğe bağlı arka plan sesiyle canonical sahne hazırlama.
- İsteğe bağlı yerel AI yardımcısı: taslak transkript/diarization ve diyalogsuz
  arka plan adayları. İnsan düzeltmesi her zaman zorunludur.

## Mimari ve teknoloji

- Ön yüz: React 19, strict TypeScript 5, Vite 7, Tailwind 4, React Router 7, Zod 4.
- Arka uç: tek Cloudflare Worker (`worker/index.ts`), hibernatable WebSocket.
- Depolama: üç SQLite Durable Object — `ROOMS` (`GameRoom`),
  `SCENE_STUDIO` (`SceneStudio`), `MEDIA_STORE` (`MediaStore`).
- Paylaşılan sözleşmeler: `shared/schemas` (Zod), `shared/types`, `shared/scenes`.
- Render: tembel tek-iş parçacıklı ffmpeg.wasm (`@ffmpeg/ffmpeg` 0.12.15,
  `@ffmpeg/core` 0.12.10), WORKERFS, 48 kHz stereo miks, yalnızca kaynak video.
- AI yardımcısı (isteğe bağlı, Windows-yerel): loopback `127.0.0.1:8765` FastAPI,
  faster-whisper sözcük zamanları, pyannote diarization, yerel ayırma sağlayıcıları.
- Testler: Vitest/RTL/jsdom, Miniflare Worker entegrasyonu, Playwright Chromium/Firefox/WebKit.

Oda yaşam döngüsü ve güvenlik modeli için [docs/ROOM_PROTOCOL.md](docs/ROOM_PROTOCOL.md).

## R2'siz dağıtım mimarisi

Üretim ve geliştirme yapılandırmasında R2 binding yoktur.

- Uygulama medyası `MEDIA_STORE` içinde commit edilmiş metadata + sıralı 1 MiB
  SQLite parçaları olarak tutulur. Yüklemeler body okunmadan önce yetkilendirilir;
  okumalar özeldir ve HEAD/tek-range destekler. Oda süresi dolumu ve final
  sonrası temizlik kapsamla sınırlıdır.
- 32.232.419 baytlık ffmpeg core WASM, `npm run runtime:prepare` ile 25 MiB
  altındaki iki versiyonlu Workers Static Asset'e ayrılır
  (`ffmpeg-core.wasm.part-000` + `part-001`). Tarayıcı her parçayı ve yeniden
  kurulan SHA-256 değerini ffmpeg yüklenmeden önce doğrular. Runtime CDN yoktur.
- Final MP4 yüklemesi önce yetkilendirilir, MP4-`ftyp` doğrulanır, 1 MiB
  satırlara stream edilir ve bilinçli 64 MiB sınırı uygulanır. İlk dayanıklı
  commit kazanır.
- Tek Worker origin SPA (`dist/`, SPA fallback), `/api/*`, WebSocket, özel medya
  ve runtime dosyalarını sunar.

Ayrıntı: [docs/R2_FREE_MEDIA_STORAGE.md](docs/R2_FREE_MEDIA_STORAGE.md),
[docs/R2_FREE_FFMPEG_RUNTIME.md](docs/R2_FREE_FFMPEG_RUNTIME.md),
[docs/PRODUCTION_HARDENING.md](docs/PRODUCTION_HARDENING.md).

## Yerel geliştirme

Gereksinim: Node.js 24 LTS (>= 24.15) ve npm. Sürüm aralıkları `package.json` içindedir.

```sh
npm ci
npm run dev:all
```

`http://127.0.0.1:5173` açılır. Yerel Worker `http://127.0.0.1:8787` dinler.
`runtime:prepare`, dev/build öncesinde otomatik çalışır ve yok sayılan
`public/runtime/` dosyalarını kurulu `@ffmpeg/core` paketinden yeniden üretir.
Yerelde Cloudflare hesabı gerekmez. Vite `/api` proxy'si için
`VITE_API_BASE_URL` boş bırakılır. Değişkenler için `.env.example` dosyasına bakılır.

### Windows hızlı kurulum

Depo kökündeki **`Kurulum.bat`** dosyasına çift tıklayın (veya terminalden
`Kurulum.bat web` çalıştırın). Yalnızca mevcut proje betikleri kullanılır:

- `PATH` üzerinde uyumlu bir Node.js varsa onu kullanır; yoksa sabitlenmiş
  taşınabilir Node 24.20.0 sürümünü resmi nodejs.org dağıtımından yok sayılan
  `.tools/` altına indirir ve SHA-256 değerini doğrular. Yönetici hakkı ve
  global kurulum gerekmez.
- Kilitli bağımlılıkları kurar (`npm ci`; zaten güncelse atlanır), ffmpeg
  runtime checksum değerlerini hazırlar ve doğrular, build ile doğrular.
- `Kurulum.bat full`, mevcut `ai-setup` CPU yoluyla Python/uv AI ortamını da
  kurar; `Kurulum.bat full-cuda` mevcut CUDA yolunu kullanır. Model ağırlıkları
  asla otomatik indirilmez: gated modeller (özellikle
  `pyannote/speaker-diarization-community-1`, CC BY 4.0) için Hugging Face koşul
  onayı, yalnızca terminalde `HF_TOKEN` olarak ayarlanan ücretsiz token ve
  `npm run ai:models` adımları manuel kalır. CDX23 checkpoint ağırlıkları lisans
  belirsizliği nedeniyle manuel ve yalnızca yereldir.

Kurulum tekrar güvenli çalışır: geçerli mevcut indirmeler yeniden indirilmez,
tamamlanmış adımlar atlanır.

Yararlı komutlar:

| Komut                      | Amaç                                                 |
| -------------------------- | ---------------------------------------------------- |
| `npm run typecheck`        | Strict TypeScript (uygulama + Worker)                |
| `npm run lint`             | ESLint, sıfır uyarı                                  |
| `npm test`                 | Vitest + Worker/Miniflare testleri                   |
| `npm run build`            | Typecheck + Vite build + Worker dry-run              |
| `npm run check`            | Typecheck, lint, test, build                         |
| `npm run runtime:verify`   | Hazırlanmış ffmpeg parçalarını doğrula (salt okunur) |
| `npm run production:audit` | `dist/` boyut ve dışlama denetimi                    |
| `npm run format:check`     | Prettier kontrolü                                    |

Tarayıcı testleri (`test:browser`, `test:render`, `test:production`,
`test:compat`) build ve Playwright tarayıcıları ister. Ekran görüntüleri/izler
yok sayılan `test-results/` altına gider.

## İsteğe bağlı AI yardımcısı

Oyun AI olmadan çalışır. Kurulum bilinçli ve çok GB'lık bir işlemdir:

```powershell
npm.cmd run ai:setup
$env:HF_TOKEN = 'hf_...'
npm.cmd run ai:models
npm.cmd run ai:dev
```

CPU varsaylandır. CUDA kurulumu (`ai:setup:cuda`) uyumlu CUDA 12
cuBLAS/cuDNN 9 kitaplıkları ister. Model ağırlıkları yok sayılan `ai/.cache/`
altına iner ve asla commit edilmez. Gizlilik, cache ve sorun giderme için
[`ai/README.md`](ai/README.md).

## AI modelleri ve üçüncü taraf lisanslar

[LICENSE](LICENSE) içindeki MIT yalnızca bu depodaki, lisanslamaya yetkili
olduğumuz özgün kodu kapsar. Üçüncü taraf paketler, modeller ve ağırlıklar kendi
lisanslarını korur. Model ağırlıkları bu depoya dahil değildir.

- `faster-whisper` (varsayılan `small`, ~486 MB): upstream dağıtımıyla
  MIT-lisanslı kod/model paketlemesi; yerelde indirilir, commit edilmez.
- `pyannote/speaker-diarization-community-1`: resmi model sayfası güncel olarak
  **CC BY 4.0** belirtir. Erişim gated'dir; Hugging Face koşul onayı ve ücretsiz
  `HF_TOKEN` gerekir. Ağırlıklar yalnızca yereldir.
- Bandit v2 ayırma: inference kodu Apache-2.0, resmi Zenodo v2 Multi ağırlıkları
  CC-BY-SA-4.0. Ağırlıklar yerelde checksum ile doğrulanır; commit edilmez veya
  yeniden barındırılmaz.
- CDX23 DnR checkpoint B (geçici fallback): ayırma kodu MIT'tir, ancak upstream
  release checkpoint ağırlıkları için ayrı bir lisans belirtmez. Ağırlıklar
  yalnızca yok sayılan yerel cache'te kalır; commit edilmez, dağıtılmaz ve
  MIT-lisanslı olduğu ima edilmez.
- `@ffmpeg/ffmpeg` 0.12.15 / `@ffmpeg/core` 0.12.10: upstream npm lisanslarıyla
  kullanılır; WASM SHA-256 ile doğrulanır ve `node_modules` içinden yeniden
  üretilir, commit edilmez.
- Diğer npm bağımlılıkları: sürüm ve upstream lisanslar için `package.json` /
  `package-lock.json` dosyalarına bakılır.

Yalnızca sahip olduğunuz, ürettiğiniz, lisansladığınız veya kullanmaya yetkili
olduğunuz sahne ve medyayı kullanın. Yetkisiz film, dizi, oyun veya üçüncü
taraf klip eklemeyin. `public/scenes/` altındaki demolar özgündür: `a-small-step`
için sessiz 30 saniyelik geliştirme animasyonu, özgün SVG posterler ve Türkçe
demo replikler. Bkz. [public/scenes/README.md](public/scenes/README.md).

## Geçmiş dağıtım ve kapatma planı

2026-09-13 tarihinde `take-two-rooms` Worker'ı kartsız Workers yoluyla
`https://take-two-rooms.take-two.workers.dev` adresine dağıtıldı; R2 binding
yoktur. Uzak smoke, güvenli-fixture render/paylaşım ve aynı makinede Chrome
kabulü geçti. Farklı-ev çok oyunculu kabul testi hiç çalışmadı.

Dağıtımın GitHub yayını doğrulandıktan sonra kapatılması planlanır. Kapatma bu
değişiklikte uygulanmamıştır. Bkz. [docs/ARCHIVAL.md](docs/ARCHIVAL.md) ve
[docs/SHUTDOWN_CHECKLIST.md](docs/SHUTDOWN_CHECKLIST.md). Durable Object veri
silme (`ROOMS`, `SCENE_STUDIO`, `MEDIA_STORE`) güncel Cloudflare belgelerine
karşı ayrıca doğrulanmalıdır; Worker silmenin tüm DO verisini kalıcı sildiği
varsayılmamalıdır.

## Depo içeriği

Takip edilen: `src/`, `shared/`, `worker/`, `tests/`, `docs/`, `scripts/`,
`ai/src/`, `ai/tests/`, `ai/scripts/`, `ai/README.md`, `public/scenes/`,
yapılandırmalar (`package.json`, `package-lock.json`, `tsconfig.json`,
`vite.config.ts`, `wrangler.jsonc`, `wrangler.dev.jsonc`, Playwright
yapılandırmaları), `.env.example`, `index.html`, `LICENSE`, `README.md`,
`README.tr.md`, `AGENTS.md`, `Kurulum.bat` (Windows tek tık kurulum;
uygulama `scripts/kurulum.ps1` içindedir).

`.gitignore` ile dışlanan: `node_modules/`, `dist/`, `.tools/`, `.wrangler/`,
`.worker-build/`, `ai/.venv*/`, `ai/.cache/`, `local-test-media/`,
`test-results/`, `public/runtime/` (yeniden üretilir), `.ruff_cache/`,
`memory-bank/` (yalnızca yerel iç notlar), kimlik bilgileri (`.env`, `.dev.vars`).

## Lisans

MIT © 2026 akcealan. Bkz. [LICENSE](LICENSE). Lisans yalnızca depodaki özgün
içeriği kapsar. Üçüncü taraf bileşenler yukarıda belirtildiği gibi kendi
lisans ve koşullarını korur. Hiçbir garanti verilmez.
