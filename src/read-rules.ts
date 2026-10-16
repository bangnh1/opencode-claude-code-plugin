/**
 * opencode's own `read` permission rules, translated into Claude Code deny
 * rules for the Read the CLI runs itself.
 *
 * ## The hole this closes (measured 2026-10-16, h #g241 item 5, h #g243)
 *
 * `DEFAULT_PROXY_TOOL_NAMES` is Bash, Edit, Write, WebFetch and Task, so the
 * file READER is CLI-native on a default install and opencode's `read` rules
 * never see it. Through the plugin with opencode's default permissions, "read
 * .env with your Read tool" returned a planted `SECRET_CODEWORD`: opencode
 * would have stopped for its own `read` tool and Claude's Read answered
 * without a prompt. Translating the rules onto the spawn is what makes one
 * configured posture mean one thing on both execution paths.
 *
 * ## What opencode's rules actually are (read at tag v1.19.0, not assumed)
 *
 * The defaults live in `packages/opencode/src/agent/agent.ts` (V1) and
 * `packages/core/src/plugin/agent.ts` (V2), and both spell the same four
 * rules: `*` allow, `*.env` **ask**, `*.env.*` **ask**, `*.env.example`
 * allow. So the widely-quoted "default `*.env` deny" is an `ask`, and
 * `mapReadRules` reports it rather than denying it: see `MappedReadRules.ask`.
 *
 * A rule's pattern is matched by `packages/core/src/util/wildcard.ts`, where
 * `*` becomes `.*` and `?` becomes `.` in an anchored regex, so an opencode
 * `*` CROSSES directory separators, which gitignore's does not. The resource
 * it is matched against is the worktree-relative path (`path.relative(
 * instance.worktree, filepath)` in V1's read tool; V2's `LocationMutation`
 * uses the same for anything inside the worktree and the canonical absolute
 * path for anything outside it). Precedence is `findLast` over
 * `[defaults, agent extras, config]`, and no match at all is `ask`.
 *
 * ## What Claude Code accepts (measured on 2.1.293, headless `--print`)
 *
 * `--disallowedTools 'Read(<pattern>)'` is enough: a parenthesised path rule
 * is accepted on the flag the plugin already passes, so no `--settings`
 * `permissions.deny` layer is needed. Measured behaviour of the forms this
 * module emits:
 *
 *   - `Read(**)` refuses every read.
 *   - `Read(*.env)`, the exact slash-free form this module emits for
 *     opencode's own `*.env`, refuses `.env`, `sub/.env`,
 *     `nested/deep/.env` and `app.env`, and leaves `notes.txt` and
 *     `.env.example` readable. `Read(*.env.*)` refuses `.env.production`
 *     and `sub/.env.local` and leaves `.env` readable. Both measured on
 *     2.1.293 and again on 2.1.300, so a slash-free pattern matches at ANY
 *     depth, which is gitignore's own rule and is exactly what opencode's
 *     separator-crossing `*` means. That is why a slash-free pattern is
 *     emitted as-is and never given a `**` + slash prefix.
 *   - `Read(secrets/**)` refuses `secrets/key.txt` and `secrets/inner/key.txt`.
 *   - `Read(//<abs>/nested/**)` refuses an absolute subtree, through a
 *     symlinked prefix as well (the CLI resolves a rule prefix's physical
 *     twin itself).
 *   - An absolute pattern ending in a slash-free `**.env` refuses only
 *     `<abs>/.env`, NOT `<abs>/sub/.env`: once a pattern contains a slash it
 *     is anchored and a mid-segment `**` stops crossing directories. That is
 *     the second reason a slash-free pattern is never anchored here.
 *
 * Read rules are also the only file rules that matter: the CLI's own rule
 * validator rejects a `Glob(path)` rule with "only Read(path) rules are
 * [matched by file permission checks] ... Read rules cover all file-reading
 * tools", and on 2.1.293 and 2.1.300 a `--print` spawn's built-in tool set has
 * no Glob and no Grep at all.
 */
import * as path from "node:path"
import * as os from "node:os"

import { log } from "./logger.js"
import { type McpHostApi } from "./mcp-bridge.js"

/** The three effects an opencode permission rule can carry. */
export type ReadRuleEffect = "allow" | "ask" | "deny"

/** One resolved opencode `read` rule, in opencode's own evaluation order. */
export interface ReadRule {
  /** opencode's pattern, after `~` / `$HOME` expansion. */
  pattern: string
  effect: ReadRuleEffect
  /** `default` for opencode's built-ins, `config` for the operator's own. */
  source: "default" | "config"
}

/**
 * opencode's built-in `read` rules, in its own order, read out of v1.19.0's
 * `packages/opencode/src/agent/agent.ts` (the V2 copy in
 * `packages/core/src/plugin/agent.ts` is rule-for-rule identical). The
 * comment opencode keeps above them says they mirror github/gitignore's
 * Node.gitignore `.env` patterns.
 *
 * They are included so the mapping describes the posture a turn really runs
 * under rather than only the operator's additions, and so the `*.env` ask
 * can be reported as unenforced instead of silently missing.
 */
export const OPENCODE_DEFAULT_READ_RULES: readonly ReadRule[] = [
  { pattern: "*", effect: "allow", source: "default" },
  { pattern: "*.env", effect: "ask", source: "default" },
  { pattern: "*.env.*", effect: "ask", source: "default" },
  { pattern: "*.env.example", effect: "allow", source: "default" },
]

/** The permission key this module reads. */
const READ_PERMISSION = "read"

/**
 * opencode's own matcher, `packages/core/src/util/wildcard.ts`, copied rather
 * than approximated: `*` to `.*` (so it crosses separators), `?` to `.`,
 * every other regex metacharacter escaped, anchored, and the trailing `" *"`
 * special case it carries for bash prefixes. Used here for two things only,
 * both of which have to agree with opencode exactly: deciding which
 * permission KEYS apply to `read` (`*`, `read`, `re*` all do), and deciding
 * whether a later rule supersedes an earlier deny.
 */
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized)
}

/** opencode's `expand()` / `expandHome()`, which run on path-shaped rules. */
function expandHome(pattern: string, home: string): string {
  if (pattern === "~" || pattern === "$HOME") return home
  if (pattern.startsWith("~/")) return home + pattern.slice(1)
  if (pattern.startsWith("$HOME/") || pattern.startsWith("$HOME\\")) return home + pattern.slice(5)
  return pattern
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isEffect(value: unknown): value is ReadRuleEffect {
  return value === "allow" || value === "ask" || value === "deny"
}

/**
 * opencode's config merge for the `permission` block: remeda's `mergeDeep`,
 * which merges two plain objects key-wise (the accumulated key order is kept
 * and new keys are appended) and otherwise lets the later value replace the
 * earlier one. Key order is load-bearing, because opencode parses the block
 * with `propertyOrder: "original"` precisely so it can resolve rules by
 * position.
 */
function mergePermissionBlock(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(incoming)) {
    const existing = out[key]
    out[key] = isPlainObject(existing) && isPlainObject(value)
      ? mergePermissionBlock(existing, value)
      : value
  }
  return out
}

/**
 * The V1 `permission` block a turn runs under, assembled the way
 * `packages/opencode/src/config/config.ts` assembles it: the layers deep-merged
 * in precedence order, then `OPENCODE_PERMISSION`'s JSON merged on top, then
 * the `tools` booleans folded UNDER it (`mergeDeep(perms, result.permission)`,
 * so an explicit `permission` entry wins over `tools: { read: false }`).
 */
function v1PermissionBlock(layers: readonly Record<string, unknown>[]): Record<string, unknown> {
  let permission: Record<string, unknown> = {}
  let tools: Record<string, unknown> = {}
  for (const layer of layers) {
    const block = layer.permission
    if (typeof block === "string") permission = mergePermissionBlock(permission, { "*": block })
    else if (isPlainObject(block)) permission = mergePermissionBlock(permission, block)
    if (isPlainObject(layer.tools)) tools = { ...tools, ...layer.tools }
  }

  const fromEnv = process.env.OPENCODE_PERMISSION
  if (fromEnv) {
    try {
      const parsed: unknown = JSON.parse(fromEnv)
      if (isPlainObject(parsed)) permission = mergePermissionBlock(permission, parsed)
    } catch {
      // opencode logs and skips invalid JSON here; so do we.
    }
  }

  // `tools: { read: false }` is opencode's older spelling of "deny reads", and
  // it is the base rather than an override: opencode merges the derived
  // permissions FIRST and lets the `permission` block win.
  const derived: Record<string, unknown> = {}
  if (tools.read === false) derived[READ_PERMISSION] = "deny"
  else if (tools.read === true) derived[READ_PERMISSION] = "allow"
  return mergePermissionBlock(derived, permission)
}

/** Turn one V1-shaped `permission` block into `read` rules, in key order. */
function rulesFromV1Block(block: Record<string, unknown>, home: string): ReadRule[] {
  const rules: ReadRule[] = []
  for (const [key, value] of Object.entries(block)) {
    // A key is a permission NAME and may itself be a wildcard: `permission:
    // "deny"` normalises to `{"*": "deny"}` in opencode's own schema, and that
    // catch-all governs `read` like every other action.
    if (!wildcardMatch(READ_PERMISSION, key)) continue
    if (isEffect(value)) {
      rules.push({ pattern: "*", effect: value, source: "config" })
      continue
    }
    if (!isPlainObject(value)) continue
    for (const [pattern, effect] of Object.entries(value)) {
      if (!isEffect(effect)) continue
      rules.push({ pattern: expandHome(String(pattern), home), effect, source: "config" })
    }
  }
  return rules
}

/**
 * Turn V2's `permissions` array into `read` rules. V2 concatenates every
 * document's array in document order and appends it after the defaults
 * (`packages/core/src/config/plugin/agent.ts`), so no merge is involved: the
 * layers are simply read in order.
 */
function rulesFromV2Array(value: unknown, home: string): ReadRule[] {
  if (!Array.isArray(value)) return []
  const rules: ReadRule[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)) continue
    const { action, resource, effect } = entry
    if (typeof action !== "string" || !wildcardMatch(READ_PERMISSION, action)) continue
    if (!isEffect(effect)) continue
    const pattern = typeof resource === "string" && resource.length > 0 ? resource : "*"
    rules.push({ pattern: expandHome(pattern, home), effect, source: "config" })
  }
  return rules
}

export interface ResolveReadRulesOptions {
  /** Defaults to `process.env.HOME`, for `~` / `$HOME` expansion. */
  home?: string
  /** Omit opencode's built-in rules. For tests; production always wants them. */
  includeDefaults?: boolean
}

/**
 * The `read` ruleset a turn runs under, in opencode's own evaluation order:
 * its built-in rules first, the operator's config after, so a later rule wins
 * exactly as `findLast` makes it win inside opencode.
 *
 * Both config shapes are read on both majors, because either can reach either
 * host: opencode 2 migrates a document that carries V1 keys (`ConfigMigrateV1.
 * isV1`) into its own `permissions` array, and a V1 host simply ignores a
 * `permissions` array it does not know. Reading both is what keeps the mapping
 * from going quiet on an upgrade.
 */
export function resolveReadRules(
  layers: readonly Record<string, unknown>[],
  hostApi: McpHostApi = "v1",
  options: ResolveReadRulesOptions = {},
): ReadRule[] {
  const home = options.home ?? os.homedir()
  const rules: ReadRule[] =
    options.includeDefaults === false ? [] : [...OPENCODE_DEFAULT_READ_RULES]

  if (hostApi === "v2") {
    // Per document, in layer order: V1-shaped keys first (that is what
    // migration produces for that document) then the native array.
    for (const layer of layers) {
      const block = typeof layer.permission === "string"
        ? { "*": layer.permission }
        : isPlainObject(layer.permission)
          ? layer.permission
          : null
      if (block) rules.push(...rulesFromV1Block(block, home))
      rules.push(...rulesFromV2Array(layer.permissions, home))
    }
    return rules
  }

  rules.push(...rulesFromV1Block(v1PermissionBlock(layers), home))
  for (const layer of layers) rules.push(...rulesFromV2Array(layer.permissions, home))
  return rules
}

/**
 * Why a pattern was refused, as a kebab TOKEN rather than a sentence.
 *
 * `/claude-code-doctor bundle` allowlists `reason` as an `enum` and
 * `SAFE_ENUM` forbids spaces (h #g215), so a sentence logged here would reach
 * a bundle redacted. The prose lives in `describeReadPatternRefusal`, which
 * only the plain doctor report reads.
 */
export type ReadPatternRefusal = "empty-pattern" | "contains-dotdot"

/** A pattern the translator refused, and why. */
export interface RefusedReadPattern {
  pattern: string
  reason: ReadPatternRefusal
}

/** The operator-facing sentence for a refusal. Never logged, never bundled. */
export function describeReadPatternRefusal(reason: ReadPatternRefusal): string {
  switch (reason) {
    case "empty-pattern":
      return "the pattern is empty"
    case "contains-dotdot":
      return "it contains `..`, which leaves the worktree the two matchers agree on"
  }
}

export interface TranslateReadPatternOptions {
  /**
   * The worktree opencode matches its patterns against. Passed only when it
   * differs from the spawn cwd, which is the anchor a relative Claude rule
   * gets: a slash-bearing pattern is then emitted in the absolute `//<abs>`
   * form so it keeps pointing at the same files.
   */
  worktree?: string
  /** The spawn cwd, for the comparison above. */
  cwd?: string
}

/**
 * One opencode pattern as a Claude rule body, or the reason it was refused.
 *
 * Three shapes, each of them a measurement rather than a guess (see the file
 * header): a catch-all becomes `**`; a slash-free pattern is emitted as-is,
 * because gitignore matches a slash-free pattern at any depth and that is
 * exactly what opencode's directory-crossing `*` means; a slash-bearing
 * pattern stays anchored, with a trailing `/*` widened to `/**` so a subtree
 * rule stays a subtree rule.
 *
 * `..` is refused rather than normalised: it escapes the worktree, where the
 * two matchers no longer describe the same paths, and a security rule guessed
 * at is worse than one reported as unmapped.
 */
export function translateReadPattern(
  pattern: string,
  options: TranslateReadPatternOptions = {},
): { rule: string } | { refused: ReadPatternRefusal } {
  const raw = pattern.replaceAll("\\", "/").trim()
  if (raw.length === 0) return { refused: "empty-pattern" }
  if (raw.split("/").includes("..")) return { refused: "contains-dotdot" }
  // A catch-all in any of its spellings. Measured: `Read(**)` refuses every
  // read, including one in a subdirectory.
  if (/^\*+$/.test(raw)) return { rule: "**" }

  // opencode's `*` crosses directory separators and Claude's does not, so a
  // subtree rule has to be widened or it would stop denying at one level.
  // Measured: `Read(secrets/**)` refuses `secrets/key.txt` AND
  // `secrets/inner/key.txt`. Only a TRAILING `/*` can be fixed this way; a
  // mid-segment `*` in a slash-bearing pattern stays one segment wide on
  // Claude's side, which is narrower than opencode and is documented as a
  // limitation rather than guessed at.
  const widenSubtree = (value: string) => (value.endsWith("/*") ? `${value}*` : value)

  if (path.posix.isAbsolute(raw)) {
    // Claude's own absolute form: a leading `//` is what sets the rule's root
    // to the filesystem root instead of the rule source's directory.
    return { rule: `/${widenSubtree(raw)}` }
  }

  if (!raw.includes("/")) return { rule: raw }

  const { worktree, cwd } = options
  if (worktree && cwd && path.resolve(worktree) !== path.resolve(cwd)) {
    const anchored = path.posix.join(path.resolve(worktree).replaceAll("\\", "/"), widenSubtree(raw))
    return { rule: `/${anchored}` }
  }
  return { rule: widenSubtree(raw) }
}

/** What the spawn, the doctor and the startup block each read. */
export interface MappedReadRules {
  /** `Read(<pattern>)` entries for `--disallowedTools`, in opencode's order. */
  deny: string[]
  /**
   * opencode patterns whose effect is `ask`, including its own `*.env`
   * default. A headless spawn runs with `--dangerously-skip-permissions` and
   * has nobody to ask, and turning an `ask` into a deny would refuse reads
   * the operator expects to be able to approve, so these are reported and not
   * enforced.
   */
  ask: string[]
  /** Deny patterns the translator would not guess at. */
  unmapped: RefusedReadPattern[]
  /**
   * `allow` patterns that sit AFTER a deny this mapping emitted. In opencode
   * they carve an exception out of the deny; in Claude Code a deny beats every
   * allow, so the exception cannot be expressed and the emitted rule is wider
   * than opencode's. Reported so a surprising refusal has an explanation.
   */
  shadowedAllows: string[]
}

/**
 * A mapping as a spawn recorded it, with the option's own state beside it so
 * `/claude-code-doctor` can tell "off" from "nothing to map".
 */
export interface ReadRuleMapping extends MappedReadRules {
  /** False when `mapReadRules: false` turned the whole mapping off. */
  enabled: boolean
}

function emptyMapping(enabled: boolean): ReadRuleMapping {
  return { enabled, deny: [], ask: [], unmapped: [], shadowedAllows: [] }
}

/**
 * Translate a resolved ruleset.
 *
 * A deny is skipped when a LATER rule matches the deny's own pattern and is
 * not itself a deny: opencode resolves by `findLast`, so such a deny is
 * already dead there and emitting it would make Claude stricter than the host
 * it is mirroring.
 */
export function mapReadRules(
  rules: readonly ReadRule[],
  options: TranslateReadPatternOptions = {},
): MappedReadRules {
  const deny: string[] = []
  const ask: string[] = []
  const unmapped: RefusedReadPattern[] = []
  const shadowedAllows: string[] = []
  const seen = new Set<string>()

  rules.forEach((rule, index) => {
    if (rule.effect === "ask") {
      if (!ask.includes(rule.pattern)) ask.push(rule.pattern)
      return
    }
    if (rule.effect !== "deny") return

    const superseded = rules
      .slice(index + 1)
      .some((later) => later.effect !== "deny" && wildcardMatch(rule.pattern, later.pattern))
    if (superseded) return

    const translated = translateReadPattern(rule.pattern, options)
    if ("refused" in translated) {
      unmapped.push({ pattern: rule.pattern, reason: translated.refused })
      return
    }
    const entry = `Read(${translated.rule})`
    if (!seen.has(entry)) {
      seen.add(entry)
      deny.push(entry)
    }
    for (const later of rules.slice(index + 1)) {
      if (later.effect !== "allow") continue
      if (!wildcardMatch(later.pattern, rule.pattern)) continue
      if (!shadowedAllows.includes(later.pattern)) shadowedAllows.push(later.pattern)
    }
  })

  return { deny, ask, unmapped, shadowedAllows }
}

export interface ReadRuleMappingInput {
  /** Config layers, lowest precedence first (`opencodeConfigLayers`). */
  layers: readonly Record<string, unknown>[]
  hostApi?: McpHostApi
  /** `false` turns the whole mapping off (`mapReadRules: false`). */
  enabled?: boolean
  worktree?: string
  cwd?: string
  home?: string
}

/**
 * The one entry point a spawn calls: resolve opencode's read rules from the
 * config layers and translate them.
 *
 * Returns an empty mapping when the option is off, and never throws: a
 * malformed config layer must not be able to fail a turn, so a throw here is
 * logged and read as "nothing to map", exactly as the MCP bridge treats an
 * unreadable layer.
 */
export function resolveReadRuleMapping(input: ReadRuleMappingInput): ReadRuleMapping {
  if (input.enabled === false) return emptyMapping(false)
  try {
    const rules = resolveReadRules(input.layers, input.hostApi ?? "v1", { home: input.home })
    const mapped = mapReadRules(rules, { worktree: input.worktree, cwd: input.cwd })
    for (const refused of mapped.unmapped) {
      // The message is a literal and the only data is a kebab token: the
      // pattern itself is operator config rather than a secret, but it is not
      // safe BY TYPE under any kind in `BUNDLE_DATA_ALLOWLIST` (a glob starts
      // with `*`, which `SAFE_NAME` refuses), so it is deliberately left out
      // of the WARN and printed by the doctor instead.
      log.warn(
        "an opencode read deny rule could not be mapped onto Claude's own Read; that path stays readable by the CLI's own file tools",
        { reason: refused.reason },
      )
    }
    if (mapped.deny.length > 0) {
      log.info("mapped opencode read deny rules onto the claude spawn", {
        rules: mapped.deny,
        askNotEnforced: mapped.ask.length,
      })
    }
    return { enabled: true, ...mapped }
  } catch (err) {
    log.debug("could not resolve opencode read rules", {
      error: err instanceof Error ? err.message : String(err),
    })
    return emptyMapping(true)
  }
}

/** The empty mapping, for callers that need a value with the option off. */
export function emptyReadRuleMapping(): ReadRuleMapping {
  return emptyMapping(false)
}

/**
 * What the last spawn mapped, for `/claude-code-doctor`.
 *
 * A recorded read, never a recompute, for the reason the background-subagent
 * gate is one (h #g177): the mapping needs a spawn's cwd, worktree and host
 * dialect, and the doctor has none of them. "No spawn has run yet" is a real
 * answer and must never print as "nothing is denied".
 */
let lastReadRuleMapping: ReadRuleMapping | undefined

export function recordReadRuleMapping(mapping: ReadRuleMapping): void {
  lastReadRuleMapping = mapping
}

/** Read-only view for the doctor. */
export function snapshotReadRuleMapping(): ReadRuleMapping | undefined {
  return lastReadRuleMapping
}

/** Test-only. */
export function _resetReadRuleMapping(): void {
  lastReadRuleMapping = undefined
}
