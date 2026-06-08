// Gemini image input (D53) — the lean, request-time variant. An `@image.png` in a prompt makes the bytes
// ride on the OUTGOING Gemini request only (as `inlineData`); the session keeps a `[image: name]` placeholder,
// so the kernel `Message` type stays a plain string and nothing binary is persisted. Gemini-only — DeepSeek
// (text) ignores it. These helpers are pure (path → mime, prompt → refs); app.ts does the file I/O + base64.
import { basename } from "node:path";

// Gemini-supported still-image MIME types (§6). No GIF — Gemini doesn't take it.
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

/** The Gemini-supported MIME for a path's extension, or null if it isn't a supported image. */
export function imageMime(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? null : (MIME[path.slice(dot + 1).toLowerCase()] ?? null);
}

// `@<path>` where the path ends in a supported image extension, bounded by end/space/closing punctuation.
const REF = /@(\S+\.(?:png|jpe?g|webp|heic|heif))(?=$|[\s).,;:!?])/gi;

/** Find `@<path>` image references in a prompt (pure). Each result is the matched token + its path, in order. */
export function imageRefs(text: string): { token: string; path: string }[] {
  return [...text.matchAll(REF)].map((m) => ({ token: m[0], path: m[1]! }));
}

/** The placeholder that replaces an image ref in the persisted/model text (the bytes go on the request). */
export function imagePlaceholder(path: string): string {
  return `[image: ${basename(path)}]`;
}
