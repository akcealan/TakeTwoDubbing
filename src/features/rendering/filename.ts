export function safeRenderFilename(sceneTitle: string, roomCode: string) {
  const safeTitle = sceneTitle
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `take-two-${safeTitle || 'dublaj'}-${roomCode}.mp4`
}
