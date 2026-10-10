import { z } from 'zod'

export const sceneEntityIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const mediaPath = z
  .string()
  .regex(
    /^\/(?:scenes\/[a-z0-9/-]+\.(?:mp4|webm|wav|mp3|ogg|m4a|svg|png|jpg|webp)|api\/rooms\/\d{6}\/(?:source-video|render-background)|api\/private-scenes\/private-[a-f0-9]{12}\/(?:source|background|thumbnail))$/,
  )

export const characterSchema = z.object({
  id: sceneEntityIdSchema,
  name: z.string().trim().min(1).max(60),
})

export const dialogueLineSchema = z
  .object({
    id: sceneEntityIdSchema,
    characterId: sceneEntityIdSchema,
    startMs: milliseconds,
    endMs: milliseconds,
    text: z.string().trim().min(1).max(1000),
  })
  .refine((line) => line.endMs > line.startMs, {
    message: 'A dialogue line must end after it starts.',
    path: ['endMs'],
  })

export const sceneSchema = z
  .object({
    id: sceneEntityIdSchema,
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000),
    durationMs: milliseconds.refine((value) => value > 0),
    videoUrl: mediaPath,
    backgroundAudioUrl: mediaPath.optional(),
    thumbnailUrl: mediaPath.optional(),
    genre: z.enum(['Sci-fi', 'Comedy', 'Custom']),
    difficulty: z.enum(['Easy', 'Medium', 'Prepared']),
    accent: z.enum(['violet', 'amber']),
    mediaStatus: z.enum(['placeholder', 'available']),
    sourceAudioStatus: z.enum(['present', 'silent', 'unknown']).default('unknown'),
    contentCredit: z.string().trim().min(1),
    origin: z
      .strictObject({
        kind: z.enum(['built-in', 'private']),
        version: z.number().int().positive(),
        sourceFileName: z.string().trim().min(1).max(255).optional(),
      })
      .default({ kind: 'built-in', version: 1 }),
    characters: z.array(characterSchema).min(1).max(20),
    lines: z.array(dialogueLineSchema).min(1),
  })
  .superRefine((scene, context) => {
    const characterIds = new Set(scene.characters.map((character) => character.id))
    if (characterIds.size !== scene.characters.length) {
      context.addIssue({
        code: 'custom',
        path: ['characters'],
        message: 'Character IDs must be unique.',
      })
    }
    if (new Set(scene.lines.map((line) => line.id)).size !== scene.lines.length) {
      context.addIssue({ code: 'custom', path: ['lines'], message: 'Line IDs must be unique.' })
    }
    scene.lines.forEach((line, index) => {
      if (!characterIds.has(line.characterId)) {
        context.addIssue({
          code: 'custom',
          path: ['lines', index, 'characterId'],
          message: 'Unknown character.',
        })
      }
      if (line.endMs > scene.durationMs) {
        context.addIssue({
          code: 'custom',
          path: ['lines', index, 'endMs'],
          message: 'Line exceeds scene duration.',
        })
      }
    })
  })

export const sceneCatalogSchema = z
  .array(sceneSchema)
  .min(1)
  .refine((scenes) => new Set(scenes.map((scene) => scene.id)).size === scenes.length, {
    message: 'Scene IDs must be unique.',
  })
