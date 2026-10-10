# Cloudflare Free dağıtımı — R2 olmadan hazır

> Tarihsel not (2026-09-13): Bu rehberdeki adımlarla `take-two-rooms` Worker'ı
> `https://take-two-rooms.take-two.workers.dev` adresine dağıtıldı; sıfır R2
> binding ile 14 statik asset ve 3 SQLite Durable Object doğrulandı. Aşağıdaki
> "henüz çalıştırılmamıştır" ifadesi 2026-09-13 öncesi checkpoint durumunu
> anlatır. Güncel durum için `docs/ARCHIVAL.md` ve
> `docs/SHUTDOWN_CHECKLIST.md` dosyalarına bakın.

Bu rehber henüz çalıştırılmamıştır. Mimari Cloudflare Workers Static Assets ve SQLite Durable
Objects kullanır; R2 aboneliği, R2 kovası, kredi kartı veya ücretli servis gerektirmez. Cloudflare
ürün koşulları zamanla değişebilir.

Uygulama medyası `MEDIA_STORE` SQLite Durable Object içinde 1 MiB parçalar halinde saklanır.
`@ffmpeg/core` 0.12.10 runtime'ı ise `npm run runtime:prepare` ile yerelde doğrulanıp
`/runtime/ffmpeg/0.12.10/` altında iki normal statik WASM parçasına ayrılır. Her dosya Cloudflare'ın
mevcut 25 MiB tekil statik dosya sınırının altındadır. R2 binding veya bucket yoktur.

## Dağıtımdan önce

- Node ve npm proje sürüm koşullarını sağlamalıdır.
- `wrangler.jsonc` içindeki Worker adı ve `ALLOWED_ORIGINS` gerçek hedef için gözden geçirilmelidir.
- Cloudflare hesabında Workers Free ve SQLite Durable Objects kullanılabilir olmalıdır.
- Özel medya, yerel AI modeli veya token yüklenmemelidir.

## Kartsız dağıtım sırası

PowerShell'de proje kökünden:

```powershell
npx wrangler login
npm run runtime:prepare
npm run build
npm run production:audit
npm run deploy:cloudflare
```

`deploy:cloudflare` güvenlik amacıyla build ve production audit'i yeniden çalıştırır, sonra
`wrangler deploy` çağırır. Başarılı dağıtımdan sonra yalnızca salt-okunur uzak smoke çalıştırılır:

```powershell
$env:TAKETWO_PRODUCTION_URL = 'https://take-two-rooms.<hesap>.workers.dev'
npm run smoke:cloudflare
```

Smoke; SPA kökünü ve deep link'i, API'yi, statik ffmpeg JavaScript dosyasını, iki WASM parçasının
tam boyut/hash bütünlüğünü ve orijinal WASM'in yeniden kurulmuş SHA-256 değerini doğrular. Normal
ürün kabulü ayrıca oda oluşturma, Durable Object, WebSocket ve gerçek yerel tarayıcı render akışını
yerel production-like testlerde kapsar.

## Kesin durma kuralı

Cloudflare giriş, kaynak oluşturma veya dağıtım sırasında beklenmedik biçimde ödeme, kredi kartı,
billing subscription ya da ücretli yükseltme isterse **DUR**. Kart girme, R2'yi etkinleştirme, bucket
oluşturma veya ücretli plana geçme. Koşulu kaydet ve mimari/hesap seçeneklerini yeniden değerlendir.

Bu checkpoint sırasında Cloudflare login, uzak kaynak oluşturma ve dağıtım yapılmadı. Bir sonraki
eylem **CLOUDFLARE FREE DEPLOYMENT — NO R2**'dir; dağıtım ancak kullanıcı açıkça istediğinde
başlatılmalıdır.

> Tarihsel not (2026-09-13 sonrası): Dağıtım daha sonra tamamlandı —
> `take-two-rooms`, `https://take-two-rooms.take-two.workers.dev` adresinde
> yayına alındı. Uzak smoke ve aynı-makine Chrome kabulü geçti. Kapatma planı
> için `docs/ARCHIVAL.md` ve `docs/SHUTDOWN_CHECKLIST.md` dosyalarına bakın.
