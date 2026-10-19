/**
 * A subagent's model chosen per call, on opencode 2 (h #g254).
 *
 * opencode 2's own `subagent` tool takes an optional `model`, written
 * `providerID/modelID` or `providerID/modelID#variant` (read out of 2.0.22 and
 * 2.0.31, beside its own instruction "NEVER set this unless the user explicitly
 * asks"), and resolves it against the models it has: the explicit model first,
 * then the agent's configured one, then the parent's. The proxied `task`
 * forwards it (PR #123, @taylormitchell). opencode 1's `task` has no such
 * field, so the field is stripped there (`applyTaskModelSupport`).
 *
 * Forwarding it is not the whole job, because three things in this plugin
 * decide a subagent's model or account after opencode has:
 *
 *   - `accountGroups` (h #g226). A model on another account's provider moves
 *     the subagent, and the task text it is handed, to that account. The
 *     dispatch form only offers accounts in the caller's group, and
 *     `subagentDispatchCrossGroup` is the only way past it; the same rule is
 *     applied to a per-call model before anything is queued
 *     (`taskModelAccountRefusal`).
 *   - `forceModel`, `defaultSubagentModel` and an agent's `reasoningEffort`
 *     (src/agent-models.ts) rewrite the model and effort inside the child's
 *     own turn, and from there an explicit request is indistinguishable from
 *     an inherited one. So the request is recorded where it is made and found
 *     again in the child's prologue, by the dispatch form's measured rule
 *     (parent session, agent type, first user message; h #g227, #g229). It
 *     beats those rewrites, which is opencode's own order, and it beats a
 *     dispatch-form choice the child held from an earlier dispatch, because it
 *     is the newer decision.
 *   - the dispatch form itself, which leaves a task that names a model out of
 *     its questions (`dispatchTasksFromCalls`).
 *
 * Every record applies only while the child still runs on exactly the model it
 * names (`explicitTaskModelApplies`): opencode resolves the reference by exact
 * id, so the child's model id IS the reference's model id, account marker
 * included, and a record whose model opencode did not pick changes nothing.
 * That is also what makes a stale record harmless.
 *
 * In memory only, bounded, and nothing reaches it unless a task names a model.
 */
import { accountsShareGroup, type AccountGroups } from "./account-groups.js"
import { log } from "./logger.js"
import { promptMatchesClaim } from "./subagent-dispatch.js"

/** One `providerID/modelID#variant` reference, split. */
export interface TaskModelReference {
  providerID: string
  modelID: string
  variant?: string
}

/**
 * opencode 2's own shape for a model reference, as its config schema writes it
 * (2.0.31): a provider without `/` or `#`, a model without `#`, and an
 * optional `#variant`.
 */
const TASK_MODEL_REFERENCE = /^([^/#]+)\/([^#]+)(?:#([^#]+))?$/

/**
 * The reference split into its parts, or null for anything that is not one.
 * Null is not a refusal: opencode validates the reference itself and answers a
 * bad one with its own error, which is the error the model should read.
 */
export function parseTaskModelReference(value: unknown): TaskModelReference | null {
  if (typeof value !== "string") return null
  const match = TASK_MODEL_REFERENCE.exec(value.trim())
  if (!match) return null
  const [, providerID, modelID, variant] = match
  return variant ? { providerID, modelID, variant } : { providerID, modelID }
}

/**
 * Why a per-call model may not be used from this conversation, or null.
 *
 * Only the plugin's own account providers are checked, because those are what
 * `accountGroups` describes; a model on any other provider is opencode's own
 * routing and its own permissions. With no groups set, or with
 * `subagentDispatchCrossGroup`, nothing is refused, exactly as the dispatch
 * form offers every account then.
 */
export function taskModelAccountRefusal(input: {
  model: unknown
  /** The account the dispatching conversation runs on. */
  sourceAccount: string
  /** `accountProviderMap(accounts)`: provider id to account name. */
  providers: ReadonlyMap<string, string>
  groups: AccountGroups | null
  crossGroup: boolean
}): string | null {
  if (!input.groups || input.crossGroup) return null
  const reference = parseTaskModelReference(input.model)
  if (!reference) return null
  const target = input.providers.get(reference.providerID)
  if (target === undefined) return null
  if (accountsShareGroup(input.sourceAccount, target, input.groups)) return null
  log.notice("task model refused: its account is in another account group", {
    account: target,
    reason: "another-account-group",
  })
  return (
    `The model "${input.model}" runs on the Claude account "${target}", which is` +
    " outside this conversation's account group, so no tasks were started. A" +
    " subagent is handed task text that can quote this conversation, and" +
    " accountGroups keeps that text inside one group. Omit `model`, or name a" +
    " model on an account in this conversation's group."
  )
}

/** What a child was explicitly asked to run as. */
export interface ExplicitTaskModel {
  providerID: string
  modelID: string
  variant?: string
}

interface ExplicitTaskModelClaim {
  parentSessionId: string
  agent: string
  prompt: string
  model: ExplicitTaskModel
  createdAt: number
}

/** Same reasoning and the same numbers as the dispatch form's claims. */
const CLAIM_TTL_MS = 15 * 60_000
const MAX_CLAIMS = 512
const MAX_SESSION_MODELS = 512

const claims: ExplicitTaskModelClaim[] = []
/** By child session id, for a child's later turns and for a resumed child. */
const sessionModels = new Map<string, ExplicitTaskModel>()

export function _resetTaskModelForTests(): void {
  claims.length = 0
  sessionModels.clear()
}

function pruneClaims(now: number): void {
  for (let i = claims.length - 1; i >= 0; i--) {
    if (now - claims[i].createdAt > CLAIM_TTL_MS) claims.splice(i, 1)
  }
  while (claims.length > MAX_CLAIMS) claims.shift()
}

function holdSessionModel(sessionId: string, model: ExplicitTaskModel): void {
  // Re-inserted, so the bound drops the session that has gone longest
  // without an explicit choice rather than the one that was just given one.
  sessionModels.delete(sessionId)
  sessionModels.set(sessionId, model)
  while (sessionModels.size > MAX_SESSION_MODELS) {
    const oldest = sessionModels.keys().next().value
    if (oldest === undefined) break
    sessionModels.delete(oldest)
  }
}

/**
 * Note the tasks of a forwarded `task` / `task_batch` call that name a model.
 *
 * A fresh child cannot be named yet, so it is found later by its parent, agent
 * type and first message. A resumed one names itself (`task_id`, the child's
 * own session id), so its record is set at once: opencode switches a resumed
 * child to the model it was asked for, and the record has to say so before
 * that child's next turn starts.
 *
 * Returns how many tasks were noted.
 */
export function noteExplicitTaskModels(
  parentSessionId: string | undefined,
  tasks: ReadonlyArray<Record<string, unknown>>,
  now = Date.now(),
): number {
  let noted = 0
  for (const task of tasks) {
    const reference = parseTaskModelReference(task.model)
    if (!reference) continue
    const resumed = typeof task.task_id === "string" ? task.task_id.trim() : ""
    if (resumed) {
      holdSessionModel(resumed, reference)
      noted++
      continue
    }
    if (!parentSessionId || parentSessionId === "default") continue
    pruneClaims(now)
    claims.push({
      parentSessionId,
      agent: typeof task.subagent_type === "string" ? task.subagent_type : "general",
      prompt: typeof task.prompt === "string" ? task.prompt : "",
      model: reference,
      createdAt: now,
    })
    noted++
  }
  return noted
}

/** The record a child session already holds, for its second turn onwards. */
export function explicitTaskModelFor(sessionId: string): ExplicitTaskModel | undefined {
  return sessionModels.get(sessionId)
}

/**
 * Whether a recorded claim could belong to a session with this agent and first
 * message. Synchronous, and what keeps the parent lookup off every turn: only a
 * child that looks like an explicitly-modelled dispatch pays for it.
 */
export function hasExplicitTaskModelCandidate(
  agent: string | undefined,
  prompt: string | undefined,
  now = Date.now(),
): boolean {
  if (!agent || prompt === undefined || claims.length === 0) return false
  pruneClaims(now)
  return claims.some(
    (claim) => claim.agent === agent && promptMatchesClaim(claim.prompt, prompt),
  )
}

/**
 * Take the claim for a child session, or undefined. The same rules as
 * `claimDispatchChoice`: the parent must match, and an exact prompt beats a
 * wrapped one.
 */
export function claimExplicitTaskModel(input: {
  sessionId: string
  agent: string | undefined
  prompt: string | undefined
  parentSessionId: string | undefined
  now?: number
}): ExplicitTaskModel | undefined {
  const held = sessionModels.get(input.sessionId)
  if (held) return held
  if (!input.agent || input.prompt === undefined || !input.parentSessionId) return undefined
  pruneClaims(input.now ?? Date.now())
  const belongsHere = (claim: ExplicitTaskModelClaim) =>
    claim.parentSessionId === input.parentSessionId && claim.agent === input.agent
  const childPrompt = input.prompt
  let index = claims.findIndex((claim) => belongsHere(claim) && claim.prompt === childPrompt)
  if (index === -1) {
    index = claims.findIndex(
      (claim) => belongsHere(claim) && promptMatchesClaim(claim.prompt, childPrompt),
    )
  }
  if (index === -1) return undefined
  const [claim] = claims.splice(index, 1)
  holdSessionModel(input.sessionId, claim.model)
  log.info("explicit task model claimed by its child session", {
    sessionId: input.sessionId,
    agent: input.agent,
    model: claim.model.modelID,
  })
  return claim.model
}

/**
 * Whether the record still describes the model this child runs on. opencode
 * resolves a reference by exact id (`T.id === q.id`, 2.0.31), so the child's
 * model id is the reference's, account marker included.
 */
export function explicitTaskModelApplies(
  record: ExplicitTaskModel | undefined,
  modelId: string,
): boolean {
  return record !== undefined && record.modelID === modelId
}

/** Drop a child session's record, from `session.deleted`. */
export function forgetExplicitTaskModel(sessionId: string): void {
  sessionModels.delete(sessionId)
}
