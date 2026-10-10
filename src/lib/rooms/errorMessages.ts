import type { ErrorCode } from '../../../shared/schemas/protocol'

// Localize stable protocol codes; server diagnostics are not presentation text.
export const roomErrorMessages: Record<ErrorCode, string> = {
  INVALID_INPUT: 'Oda bilgilerini ve takma adını kontrol edip tekrar dene.',
  INVALID_MESSAGE: 'İşlem anlaşılamadı. Lütfen yeniden bağlan.',
  ROOM_NOT_FOUND: 'Oda bulunamadı veya süresi doldu. Oda kodunu kontrol et.',
  ROOM_FULL: 'Oda dolu. En fazla 12 oyuncu katılabilir.',
  NICKNAME_TAKEN: 'Bu takma ad odada zaten kullanılıyor. Başka bir ad seç.',
  UNAUTHORIZED: 'Oturumun geçersiz veya süresi dolmuş. Odaya yeniden katıl.',
  RATE_LIMITED: 'Çok fazla işlem yaptın. Bir dakika bekleyip tekrar dene.',
  ORIGIN_DENIED: 'Bu adresten oda servisine bağlanılamıyor.',
  SESSION_REPLACED: 'Oturumun başka bir bağlantıda açıldı. Devam etmek için yeniden katıl.',
  SERVER_ERROR: 'Oda servisinde bir sorun oluştu. Lütfen tekrar dene.',
  ROOM_UNAVAILABLE: 'Oda şu anda bu işleme uygun değil. Lütfen tekrar dene.',
  FORBIDDEN: 'Bu işlemi yalnızca odanın kurucusu yapabilir.',
  UNSUPPORTED_MEDIA: 'Bu ses biçimi desteklenmiyor. Repliği tarayıcıda yeniden kaydet.',
  UPLOAD_TOO_LARGE: 'Ses kaydı yükleme sınırını aşıyor. Daha kısa bir kayıt oluştur.',
  UPLOAD_FAILED: 'Ses kaydı geçici depoya kaydedilemedi. Yerel kayıt duruyor; tekrar dene.',
  LINE_NOT_OWNED: 'Bu replik sana atanmadığı için ses kaydı yükleyemezsin.',
  RECORDINGS_INCOMPLETE: 'Son hazırlık için zorunlu replik kayıtları henüz tamamlanmadı.',
  FINALIZATION_STARTED: 'Son hazırlık başladı; kayıtlar artık değiştirilemez.',
  RECORDING_NOT_FOUND:
    'Dondurulmuş listedeki ses kayıtlarından biri bulunamadı. Bir süre sonra tekrar dene.',
  RESULT_NOT_FOUND: 'Odanın paylaşılan final videosu bulunamadı. Bir süre sonra tekrar dene.',
  RESULT_ALREADY_COMMITTED: 'Bu oda için final video zaten kaydedildi.',
}
