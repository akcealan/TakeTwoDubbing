# Take Two yerel AI companion

Bu servis yalnızca Sahne Stüdyosu için ilk insan-düzeltilebilir taslağı üretir. Oda
mantığı içermez, Cloudflare/R2 kimliği veya oda sırrı almaz ve canonical sahne kaydetmez.
Tarayıcı, kullanıcının açıkça başlattığı analizde yetkili kaynak baytlarını indirip
`127.0.0.1:8765` adresine gönderir. Medya, transkript ve diarization sonucu bilgisayardan
bir AI API'sine gönderilmez.

## Tarayıcı ve origin güvenliği

Servis yalnız loopback'e bağlanır. `TAKETWO_AI_HOST=0.0.0.0` veya başka bir ağ arayüzü
başlangıçta reddedilir. Tarayıcı istekleri tam origin allowlist'i ve
`X-Take-Two-Companion: 1` başlığı olmadan işlenmez; wildcard CORS kullanılmaz. Origin
taşımayan istekler yalnız aynı makinedeki bilinçli CLI/test kullanımı için korunur.

Dağıtımdan sonra tam workers.dev adresini kod değiştirmeden ekle:

```powershell
$env:TAKETWO_AI_ALLOWED_ORIGINS = 'http://127.0.0.1:5173,http://localhost:5173,https://take-two-rooms.<hesap>.workers.dev'
npm.cmd run ai:dev
```

HTTPS sayfa Chromium'da yerel ağ/loopback izni isteyebilir. Yalnız doğru Take Two origin'i
için izin ver; tarayıcı güvenliğini kapatma veya güvensiz bayrak kullanma. Bu companion oda
oyuncuları için değil, yalnız Sahne Stüdyosu'nda yeni sahne hazırlayan bilgisayar içindir.

## Seçilen yığın

- `faster-whisper` `small`: çok dilli otomatik dil algılama, sözcük zamanları, VAD ve
  CPU `int8`; CUDA'da `int8_float16`.
- `pyannote.audio` `speaker-diarization-community-1`: yerel çok konuşmacılı diarization.
- PyAV: WebM/MP4 içindeki sesi 16 kHz mono PCM'e çıkarır. Windows tekerleği FFmpeg
  kitaplıklarını taşıdığı için sistem FFmpeg kurulumu gerekmez.
- FastAPI: yalnızca loopback'e bağlanan, izinli yerel geliştirme origin'lerine CORS
  açan sağlık ve iş yaşam döngüsü API'si.

WhisperX daha güçlü ayrı wav2vec2 hizalama sağlayabilir, ancak dil başına ek modeller,
daha ağır PyTorch bağımlılığı ve Windows kurulum yüzeyi bu aşama için gereksizdi.
Faster-whisper sözcük zamanları mevcut editörün milisaniyelik insan düzeltmesi için daha
pratik bir başlangıçtır. Pyannote güven skoru sağlamadığı yerlerde yüzdelik uydurulmaz.

## Sahne çapında konuşmacı kimliği

Kurulu Community-1 / pyannote.audio 4.0.7 API'si normal ve örtüşmesiz diarization'a ek
olarak etiket sırasıyla bir 256 boyutlu centroid verir. Pipeline içindeki aynı yerel
embedding modeli dönüş bazında da çalıştırılabilir. Community-1'in normal çıktısı bu
dönüş embeddinglerini doğrudan döndürmediği için adaptör, yüklü modeli tekrar
yüklemeden her temiz ve bitişik PCM aralığını kendi gerçek uzunluğunda gömer. Farklı
uzunluktaki dönüşler aynı tensörde sıfırla tamamlanmaz; örtüşme bir dönüşü ayırırsa
yeterli uzunluktaki temiz parçalar ayrı gömülüp süre ağırlıklı birleştirilir. Bu sürüme bağlı
erişim kullanılamazsa ham pyannote sonucu korunur ve taslak inceleme uyarısı alır.

Stabilizasyon zaman aralıklarını değiştirmez. En az 1,2 saniyelik, en az 1 saniye temiz
ses taşıyan ve yüksek oranda örtüşmesiz dönüşler önce güvenilir anchor kimliklerini
kurar. Ham konuşmacı sayısı keşfi sınırlamaz. Her kimlik için süre ağırlıklı prototipin
yanında en fazla dört temiz temsilci korunur. Zayıf dönüşler prototip, temsilci ve ikinci
aday farkıyla `attached`, bütün anchor'lardan tutarlı biçimde ayrıysa `novel`, kanıt
yetersizse `uncertain` olur. Örtüşen farklı ham konuşmacılar her yeniden atamadan sonra
cannot-link kalır. Ham partition, desteklenmeyen yıkıcı birleşmelere karşı fallback'tir;
hiçbir benzerlik yüzdelik güven olarak sunulmaz.

Otomatik mod anchor kanıtından bağımsız sayıda kimlik keşfedebilir. Kesin mod aynı
algoritmaya kullanıcı sayısını bir kısıt olarak verir, fakat akustik açıdan uyumsuz
kimlikleri yalnızca sayıya ulaşmak için birleştirmez; uyuşmazlık tanıda ve
`uncertain_speaker` incelemesinde açık kalır. Kurulu pyannote kaynağında
`num_speakers`, `min_speakers` ve `max_speakers` kümeleme sınırlarıdır; kesin sayı
verildiğinde min/max etkisizdir ve yetersiz embedding varsa pyannote yine daha az küme
döndürebilir.

## Windows kurulumu

Normal oyun geliştirme akışı değişmedi: `npm run dev:all` AI olmadan çalışır. AI kurulumu
bilinçli ve ayrıdır:

```powershell
npm.cmd run ai:setup
```

Bu komut yönetici izni istemeden sabitlenmiş `uv` aracını `.tools/uv` altına indirir,
uv'nin `.tools/uv-python` altında yönettiği Python 3.11 ile `ai/.venv` oluşturur ve CPU
paketlerini kurar. Model
ağırlıkları bu adımda indirilmez.

Community-1 ücretsiz/açık modelinin Hugging Face sayfasında kullanım koşullarını kabul
et, ücretsiz salt-okunur token oluştur ve yalnızca geçerli terminalde ayarla:

```powershell
$env:HF_TOKEN = 'hf_...'
npm.cmd run ai:models
npm.cmd run ai:dev
```

Token commit edilmez ve tarayıcıya verilmez. Tam model indirme başarılı olunca işaret
dosyası yazılır; normal servis `HF_HUB_OFFLINE=1` ile başlar. Cache `ai/.cache` altındadır,
Git tarafından yok sayılır ve R2'ye yüklenmez. İlk indirme ile Python/ML ortamı birkaç GB
disk kullanabilir; kesin miktar paket/model sürümüne göre değişir. `small` yerine başka
faster-whisper modeli `TAKETWO_WHISPER_MODEL` ile seçilebilir, fakat hız/bellek ihtiyacı
değişir.

## CPU ve isteğe bağlı CUDA

CPU güvenli varsayılandır ve GPU gerektirmez. NVIDIA kullanmak için ayrıca:

```powershell
npm.cmd run ai:setup:cuda
$env:TAKETWO_AI_DEVICE = 'cuda'
npm.cmd run ai:dev
```

CUDA kurulumu büyük ek paketler indirir. Güncel faster-whisper/CTranslate2, Windows'ta
CUDA 12 cuBLAS ve cuDNN 9 çalışma kitaplıklarını gerektirir. GPU sürücüsünün görünmesi tek
başına yeterli olmayabilir. 4 GB VRAM gibi sınırlı kartlarda CPU daha güvenlidir; CUDA
başlatılamazsa servis bunu açıkça bildirir, ücretli/uzak bir yedeğe geçmez.

## API ve iptal sınırı

- `GET /v1/health`: paket/model/hazır olma durumu
- `POST /v1/jobs`: açıkça sağlanan WebM/MP4, canonical süre ve isteğe bağlı
  `expectedSpeakerCount` (1–12; yalnızca AI taslağı)
- `GET /v1/jobs/{id}`: aşama tabanlı durum ve sonuç
- `DELETE /v1/jobs/{id}`: iptal isteği

Tek ağır iş aynı anda çalışır. İptal aşamalar arasında ve faster-whisper segmentleri
arasında hızlıdır; devam eden tek bir pyannote çağrısı güvenle kesilemediği için o çağrı
bittikten sonra uygulanabilir. Geçici medya iş sonunda silinir.

Geliştirme sırasında tek bir işin bütün ara çıktılarını yerel JSON olarak görmek için
servisi şu opt-in değişkenle başlat:

```powershell
$env:TAKETWO_AI_DIAGNOSTICS = '1'
npm.cmd run ai:dev
```

Dosyalar ignore edilen `ai/.cache/diagnostics/` altında kalır. PCM özellikleri, algılanan
dil, Whisper segment/sözcükleri, ham ve normalize pyannote dönüşleri, benzersiz etiketler,
ham/sabitlenmiş atamalar, dönüş süreleri, anchor kararları, yerel embeddingler, sınırlı
pairwise/prototip benzerlikleri, otomatik/kısıtlı sayılar, örtüşmeler,
sözcük-konuşmacı atamaları ve üretilen replikler yazılır; medya baytları
yazılmaz ve hiçbir veri dış servise gönderilmez. Değişkene özel bir klasör yolu da
verilebilir. Normal servis/UI bu tanıyı üretmez veya göstermez.

Karışık kaynak ses doğrudan analiz edilir. Yüksek müzik/SFX kaliteyi azaltabilir. Diyalog,
müzik ve SFX ayrımı ile hazırlanmış arka plan sesi yalnızca Faz 11B2 kapsamıdır.

## Phase 11B2A ayrıştırma doğrulaması

Bu checkpoint, kalıcı Sahne Stüdyosu/Worker/R2 entegrasyonu değildir. Bandit v2 Multi'yi
özel gerçek kliplerde sınamak için ayrı ve opsiyonel bir inference katmanı sağlar. Ana
Whisper/pyannote ortamını değiştirmemek için CPU ve CUDA ortamları ayrıdır:

```powershell
npm.cmd run ai:separation:setup
npm.cmd run ai:separation:setup:cuda
npm.cmd run ai:separation:models
```

`ai:separation:models`, resmi Zenodo `12701995` kaydındaki `checkpoint-multi.ckpt`
dosyasını `ai/.cache/models/bandit-v2/` altına indirir. Yarım indirme `.part` olarak kalır,
HTTP Range destekleniyorsa sonraki deneme devam eder; 446.680.129 bayt ve SHA-256
`abcfccf65446752a057f4a302c941479a54b7560ebf8d7bca039d2ea98e64cfc` doğrulanmadan
kalıcı model adına geçilmez. Ağırlık repo'ya eklenmez veya yeniden barındırılmaz.

Zenodo'nun resmi uçları Phase 11B2A gerçek-klip koşusunda tekrarlanan HTTP 504 verdiği
için tek izinli fallback olarak CDX23 DnR checkpoint B de ayrı komutlarla yeniden
üretilebilir. Yalnızca resmi GitHub release dosyası kullanılır ve tam SHA-256 doğrulanır:

```powershell
npm.cmd run ai:separation:fallback-model
npm.cmd run ai:separation:evaluate:fallback
npm.cmd run ai:separation:evaluate:fallback:cpu
```

Fallback, üreticinin normal tek-checkpoint ayarlarını kullanır: 44.1 kHz stereo,
`shifts=1`, `overlap=0.8`. CUDA dinleme çıktısı
`local-test-media/separation-eval/clip1-speaker-regression-cdx23/` altındadır. 42.121 s
gerçek klipte CUDA inference 6.436 s (RTF 0.153), CPU 60.009 s (RTF 1.425) sürdü.
Background dosyası decode sonrası `music + effects` ile tam eşleşti. CDX23 kodu MIT'tir;
upstream release checkpoint ağırlıkları için ayrı bir lisans belirtmez. Bu nedenle sonuç
yalnızca dinleme adayıdır ve kalıcı entegrasyon için kullanıcı onayı gerekir.

Inference-only `bandit-infer` paketi henüz PyPI sürümü olmadığı için commit
`d45cdec634bf1ee01cdd2acea74a2d100e639c8a` ile kilitlidir. Paket resmi Bandit v2
grafiğini taşır ve resmi checkpoint'e karşı parity fixture'ı sunar; kodu Apache-2.0'dır.
Resmi Bandit v2 kodu da Apache-2.0, resmi Zenodo ağırlıkları CC-BY-SA-4.0'dır. Kod ve
ağırlık lisansları birbirinden ayrıdır.

Özel klibi CUDA/otomatik seçimle değerlendirmek için:

```powershell
npm.cmd run ai:separation:evaluate
```

CPU karşılaştırması için `npm.cmd run ai:separation:evaluate:cpu` kullanılır. Girdi ve
çıktı yolları `local-test-media/` altında kalmak zorundadır. Çıktılar 48 kHz stereo
IEEE-float WAV'dır; stemlere bağımsız normalizasyon uygulanmaz. Her değerlendirme şu
dinlenebilir dosyaları atomik olarak üretir:

- `original-reference.wav`
- `speech.wav`
- `music.wav`
- `effects.wav`
- `background-music-plus-effects.wav`
- `diagnostics.json`

Bandit'in doğrulanmış iç inference yolu 8 saniyelik pencere, 1 saniyelik hop ve batch 1
kullanır. Adaptör uzun klipleri ayrıca 24 saniyelik sınırlı dış pencerelerde işler ve
2 saniyelik cosine crossfade ile birleştirir. İptal hazırlıkta, dış pencereler arasında ve
yazımda uygulanır; tek bir model forward çağrısı güvenle ortadan kesilmez. `auto` CUDA
OOM görürse bunu tanıya yazar, GPU belleğini bırakır ve işi CPU'da baştan yürütür; açık
`cuda` seçiminin başka bir nedenden başarısızlığı sessizce saklanmaz.

Deterministik testler model indirmez:

```powershell
npm.cmd run ai:test
```

Test komutu ayrı `ai/.venv-test` ortamını kullanır; kurulu ağır model ortamını değiştirmez.

Ignore edilen `local-test-media/clip1-speaker-regression.mp4` mevcut ve modeller yerelde
hazırsa embedding invariance ile automatic/exact-3 gerçek-klip regresyonu açıkça opt-in
çalıştırılabilir. Test ağ bağlantılarını engeller ve medya/çıktı yüklemez:

```powershell
$env:TAKETWO_REAL_SPEAKER_REGRESSION = '1'
$env:PYTHONPATH = (Resolve-Path 'ai/src').Path
& 'ai/.venv/Scripts/python.exe' -m pytest ai/tests/test_real_speaker_regression.py
```

Gerçek smoke testi için modeller hazırken küçük ve kullanım izni olan çok konuşmacılı bir
WebM/MP4'ü Sahne Stüdyosu'nda yükle, `AI ile Taslak Oluştur` eylemini başlat ve oluşan
taslağın mevcut editörde açıldığını doğrula.

## Phase 11B2B ürün arka planı

Ana loopback FastAPI companion artık aynı portta ayrı bir cinematic-separation job API'si
sunar. Ana `.venv` işi yönetir; ağır CDX23 inference, doğrulanmış `.venv-separation-cuda`
veya CPU ortamında alt süreç olarak çalışır. İkinci sunucu ve bulut API yoktur. Studio
yetkili kaynak Blob'unu doğrudan localhost'a yollar; Studio/R2/oda anahtarı veya başka
kimlik bilgisi companion'a gönderilmez.

Sağlık, oluşturma, durum, sonuç ve iptal/temizlik yolları:

- `GET /v1/separation/health`
- `POST /v1/separation/jobs`
- `GET /v1/separation/jobs/{jobId}`
- `GET /v1/separation/jobs/{jobId}/background`
- `DELETE /v1/separation/jobs/{jobId}`

Ürün provider sınırı `local-cinematic-separator` sürüm 1'dir. Şimdiki provider, Phase
11B2A'da dinlenip onaylanan resmi CDX23 DnR checkpoint B'yi kullanır; checkpoint boyutu
53.916.935 bayt ve SHA-256 değeri
`dbb4db154df7e45a5cb72d1659c48937e757f6d6b0eef8ca4199e6e38f8d8f37` olmalıdır.
CDX23 kodu MIT olsa da release checkpoint ağırlıkları için ayrı lisans belirtilmemiştir.
Bu nedenle ağırlıklar yalnız yerel/ignore edilen cache'te kalır; repo'ya eklenmez,
dağıtılmaz veya yeniden barındırılmaz. Provider sınırı, resmi ağırlıkları kullanılabilir
olursa Bandit v2'ye geçişi ürün veri sözleşmesini değiştirmeden mümkün kılar.

Başarılı ürün işi `music + effects` toplamını bağımsız normalizasyon uygulamadan AAC-LC/
M4A, yaklaşık 192 kbps, 44.1 kHz stereo olarak kodlar. İlk PTS ve decode edilmiş örnek
sayısı sahne süresine karşı doğrulanır. Kaynak/temp çalışma dosyaları ve stemler başarı,
hata veya iptal sonunda temizlenir; yalnız indirilecek M4A adayı en fazla 30 dakika veya
istemci `DELETE` çağrısına kadar tutulur. Daemon TTL zamanlayıcısı takip isteği olmasa da
süresi dolan adayı siler; yeni manager başlangıcı yalnız aynı güvenli prefix'e sahip süresi
geçmiş crash artıklarını süpürür. Studio yükleme hatasında aday Blob tarayıcıda
kalır ve yeniden denenebilir; önceki kabul edilmiş R2 arka planı değişmez. Phase 11B2A'nın
bilinçli `local-test-media/separation-eval/**` dinleme çıktıları bu lifecycle'ın dışındadır.

Günlük manuel akışta önce companion'ı, sonra uygulamayı aç:

```powershell
npm.cmd run ai:dev
npm.cmd run dev:all
```

Ardından Sahne Stüdyosu'nda gerçek sahneyi aç, **Konuşmaları Ayır** ile üret, yerel ses
oynatıcısında dinle, **Arka Planı Kullan** ile kabul et ve normal kaydet/oda/dublaj/final
video akışına devam et. Kullanıcının WAV, checkpoint, Python, R2 anahtarı, JSON veya ffmpeg
komutu kullanması gerekmez.

Geliştiriciye ait WAV parçalarıyla aynı gerçek modelleri otomatik ve kısıtlı modda
karşılaştırmak için `ai/scripts/real_smoke.py` kullanılabilir. Bu yardımcı gerçek model
ortamını ve opt-in tanıyı kullanır; sıradan testlere model yüklemez.

Bilinen konuşmacı etiketleri ve kullanım izni olan ayrı WAV parçalarıyla ham/stabilize
kimlik metriklerini karşılaştırmak için `ai/scripts/evaluate_speakers.py` kullanılır.
Doğruluk optimal etiket permütasyonundan sonra hesaplanır; `SPEAKER_01` adının gerçek
bir kişi veya referans `A` etiketiyle aynı olması beklenmez. Sıradan testler bu scripti
çalıştırmaz ve gerçek modelleri yüklemez.
