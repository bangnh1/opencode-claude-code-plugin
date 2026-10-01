import { randomInt } from "node:crypto"

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const ID_LENGTH = 16

/**
 * A stream-part id: 16 characters from `[0-9A-Za-z]`, the shape
 * `@ai-sdk/provider-utils`' `generateId` produced.
 *
 * It replaced that import, which was the plugin's only use of the package.
 * Its AI SDK v5 line (`^3.0.8`) pulled `undici ^5.29.0` into every install,
 * which `npm audit` flagged with thirteen advisories, plus a second copy of
 * `@ai-sdk/provider` and a `zod` peer dependency (measured 2026-10-01). These
 * ids only have to be unique within a stream, so a local generator is the
 * whole requirement.
 */
export function generateId(): string {
  let id = ""
  for (let index = 0; index < ID_LENGTH; index++) {
    id += ID_ALPHABET[randomInt(ID_ALPHABET.length)]
  }
  return id
}
