import { createHash, randomUUID } from 'node:crypto'
import { officialPairingChecks } from './support/official-pairing.js'
import { officialPluginLayoutFixture } from './support/official-plugin-layout.js'
import { once } from 'node:events'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import WebSocket from 'ws'
import { expect, onTestFinished, test } from 'vitest'
import { clientFrameSchema } from '@dsh-mobile/protocol'
import { buildGateway } from '../packages/gateway/src/app.js'
import { Store } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'
import { clientKey, proof } from './support/proof.js'
import { officialHostLifecycle } from './support/official-host-lifecycle.js'
import { officialDesktopWindows } from './support/official-desktop-windows.js'
import { officialApprovalTransport } from './support/official-approval-transport.js'
import { officialTimedPreset, officialTimedQuestionChecks } from './support/official-timed-question.js'
import { officialTimedHostChecks } from './support/official-timed-host.js'
import { officialInteractionHostChecks } from './support/official-interaction-host.js'
import { officialInteractionRaceChecks } from './support/official-interaction-race.js'
import { officialTimedRaceChecks } from './support/official-timed-race.js'
import { officialGoalChecks } from './support/official-goals.js'
import { officialScheduleChecks } from './support/official-schedules.js'
import { officialDeepSeekModelChecks } from './support/official-deepseek-models.js'
import { officialPresetChecks } from './support/official-presets.js'
import { officialPresetCreatorChecks } from './support/official-preset-creator.js'
import { officialCreatorTaskChecks } from './support/official-creator-task.js'
import { officialPluginUpgradeFixture, officialPluginUpgradeChecks } from './support/official-plugin-upgrade.js'
import { officialPluginDownload } from './support/official-plugin-download.js'
import { officialPluginScripts } from './support/official-plugin-scripts.js'
import { officialPluginApplying } from './support/official-plugin-applying.js'
import { officialBackgroundControl } from './support/official-background-control.js'
import { officialBackgroundHost } from './support/official-background-host.js'
import { officialBackgroundStop } from './support/official-background-stop.js'
import { officialJobStopTransport } from './support/official-job-stop-transport.js'
import { officialSessionExportChecks } from './support/official-session-export.js'
import { officialFeedbackCollector, officialFeedbackChecks } from './support/official-feedback.js'
import { officialFeedbackHistoryChecks } from './support/official-feedback-history.js'
import { officialPromptTransport } from './support/official-prompt-transport.js'
import { officialPromptSendingChecks } from './support/official-prompt-sending.js'
import { officialPromptHostChecks } from './support/official-prompt-host.js'
import { officialAttachmentSendingChecks } from './support/official-attachment-sending.js'
import { officialProviderChecks } from './support/official-providers.js'
import { officialProviderKeyChecks } from './support/official-provider-keys.js'
import { officialEndpointChecks } from './support/official-endpoints.js'
import { officialEndpointTransport } from './support/official-endpoint-transport.js'
import { officialLongHistoryChecks } from './support/official-long-history.js'
import { officialHistoryTransport } from './support/official-history-transport.js'
import { officialHistoryInflightChecks } from './support/official-history-inflight.js'
import { officialPtcChecks } from './support/official-ptc.js'
import { officialSkillFixture, officialSkillChecks } from './support/official-skills.js'
import { officialChildStopChecks } from './support/official-child-stop.js'
import { officialExternalPreset, officialExternalChecks } from './support/official-external-subagent.js'
import { officialReferenceChecks } from './support/official-references.js'

// 连接已由正常官方 CLI 启动的隔离 Host；不准备任何本体补丁或替换模块。
test.skipIf(process.env.DSHM_OFFICIAL_ANDROID_CHECK !== '1')('未修改官方 Host 经生产中转与真实 Android 的 Remote', async () => {
  expect(process.env.DSHM_OFFICIAL_ANDROID_CHECK).toBe('1')
  const inference = process.env.DSHM_OFFICIAL_INFERENCE_CHECK === '1'
  const extensions = process.env.DSHM_OFFICIAL_EXTENSION_CHECK === '1'
  const backgroundProcessCheck = process.env.DSHM_OFFICIAL_JOB_PROCESS_CHECK === '1'
  const backgroundHostCheck = process.env.DSHM_OFFICIAL_JOB_HOST_CHECK === '1'
  const backgroundStopCheck = process.env.DSHM_OFFICIAL_JOB_STOP_CHECK === '1'
  const backgroundControlCheck = process.env.DSHM_OFFICIAL_JOB_CONTROL_CHECK === '1' || backgroundProcessCheck
  expect(backgroundProcessCheck && process.env.DSHM_OFFICIAL_JOB_CONTROL_CHECK === '1').toBe(false)
  expect(backgroundHostCheck && (backgroundControlCheck || process.env.DSHM_OFFICIAL_JOB_CHECK === '1')).toBe(false)
  expect(backgroundStopCheck && (backgroundHostCheck || backgroundControlCheck || process.env.DSHM_OFFICIAL_JOB_CHECK === '1')).toBe(false)
  const background = process.env.DSHM_OFFICIAL_JOB_CHECK === '1' || backgroundControlCheck || backgroundHostCheck || backgroundStopCheck
  expect(backgroundControlCheck && process.env.DSHM_OFFICIAL_JOB_CHECK === '1').toBe(false)
  const files = process.env.DSHM_OFFICIAL_FILE_CHECK === '1'
  const fileShare = process.env.DSHM_OFFICIAL_FILE_SHARE_CHECK === '1'
  expect(fileShare && !files).toBe(false)
  const filePresented = process.env.DSHM_OFFICIAL_FILE_PRESENT_CHECK === '1'
  const fileDesktop = process.env.DSHM_OFFICIAL_FILE_DESKTOP_CHECK === '1' || filePresented
  expect(filePresented && process.env.DSHM_OFFICIAL_FILE_DESKTOP_CHECK === '1').toBe(false)
  expect(fileDesktop && (!files || fileShare || !inference)).toBe(false)
  const plugins = process.env.DSHM_OFFICIAL_PLUGIN_CHECK === '1'
  const pluginUpgrade = process.env.DSHM_OFFICIAL_PLUGIN_UPGRADE_CHECK === '1'
  const pluginLayout = process.env.DSHM_OFFICIAL_PLUGIN_LAYOUT_CHECK === '1'
  const pluginInterruption = process.env.DSHM_OFFICIAL_PLUGIN_INTERRUPTION_CHECK === '1'
  const pluginScripts = process.env.DSHM_OFFICIAL_PLUGIN_SCRIPT_CHECK === '1'
  const pluginAutoApplying = process.env.DSHM_OFFICIAL_PLUGIN_AUTO_APPLYING_CHECK === '1'
  const pluginApplying = process.env.DSHM_OFFICIAL_PLUGIN_APPLYING_CHECK === '1' || pluginAutoApplying
  expect(pluginAutoApplying && process.env.DSHM_OFFICIAL_PLUGIN_APPLYING_CHECK === '1').toBe(false)
  expect([pluginUpgrade, pluginLayout, pluginInterruption, pluginScripts, pluginApplying].filter(Boolean).length).toBeLessThanOrEqual(1)
  const office = process.env.DSHM_OFFICIAL_OFFICE_CHECK === '1'
  const workspaceManagement = process.env.DSHM_OFFICIAL_WORKSPACE_CHECK === '1'
  const credentialEndpoints = process.env.DSHM_OFFICIAL_KEY_ENDPOINT_CHECK === '1'
  const modelSettings = process.env.DSHM_OFFICIAL_MODEL_SETTINGS_CHECK === '1'
  const presetSettings = process.env.DSHM_OFFICIAL_PRESET_CHECK === '1'
  const presetCreator = process.env.DSHM_OFFICIAL_PRESET_CREATOR_CHECK === '1'
  const creatorTask = process.env.DSHM_OFFICIAL_CREATOR_TASK_CHECK === '1'
  const providerManagement = process.env.DSHM_OFFICIAL_PROVIDER_CHECK === '1'
  const providerKeys = process.env.DSHM_OFFICIAL_PROVIDER_KEY_CHECK === '1'
  const endpointPolicy = process.env.DSHM_OFFICIAL_ENDPOINT_POLICY_CHECK === '1'
  const endpointInterruption = process.env.DSHM_OFFICIAL_ENDPOINT_INTERRUPTION_CHECK === '1'
  const endpointRace = process.env.DSHM_OFFICIAL_ENDPOINT_RACE_CHECK === '1'
  const endpointProcess = process.env.DSHM_OFFICIAL_ENDPOINT_PROCESS_CHECK === "1"
  expect(endpointProcess && (endpointRace || endpointInterruption || endpointPolicy || process.env.DSHM_OFFICIAL_ENDPOINT_WRITE_CHECK === "1")).toBe(false)
  expect(endpointRace && (endpointInterruption || endpointPolicy || process.env.DSHM_OFFICIAL_ENDPOINT_WRITE_CHECK === '1')).toBe(false)
  expect(endpointInterruption && (endpointPolicy || process.env.DSHM_OFFICIAL_ENDPOINT_WRITE_CHECK === '1')).toBe(false)
  const endpointWrites = process.env.DSHM_OFFICIAL_ENDPOINT_WRITE_CHECK === '1' || endpointPolicy || endpointInterruption || endpointRace || endpointProcess
  expect([credentialEndpoints, modelSettings, presetSettings, presetCreator, providerManagement, providerKeys, endpointWrites, process.env.DSHM_OFFICIAL_SETTINGS_CHECK === '1'].filter(Boolean).length).toBeLessThanOrEqual(1)
  const settings = process.env.DSHM_OFFICIAL_SETTINGS_CHECK === '1' || credentialEndpoints || modelSettings || presetSettings || presetCreator || providerManagement || providerKeys || endpointWrites
  const isolatedSettings = providerKeys || endpointWrites
  const queue = process.env.DSHM_OFFICIAL_QUEUE_CHECK === '1'
  const navigation = process.env.DSHM_OFFICIAL_NAVIGATION_CHECK === '1'
  const promptProcess = process.env.DSHM_OFFICIAL_PROMPT_PROCESS_CHECK === '1'
  const promptHost = process.env.DSHM_OFFICIAL_PROMPT_HOST_CHECK === '1'
  expect([promptProcess, promptHost, process.env.DSHM_OFFICIAL_PROMPT_SENDING_CHECK === '1'].filter(Boolean).length).toBeLessThanOrEqual(1)
  const promptSending = process.env.DSHM_OFFICIAL_PROMPT_SENDING_CHECK === '1' || promptProcess || promptHost
  const attachmentProcess = process.env.DSHM_OFFICIAL_ATTACHMENT_PROCESS_CHECK === '1'
  const attachmentHost = process.env.DSHM_OFFICIAL_ATTACHMENT_HOST_CHECK === '1'
  expect([attachmentProcess, attachmentHost, process.env.DSHM_OFFICIAL_ATTACHMENT_SENDING_CHECK === '1'].filter(Boolean).length).toBeLessThanOrEqual(1)
  const attachmentSending = process.env.DSHM_OFFICIAL_ATTACHMENT_SENDING_CHECK === '1' || attachmentProcess || attachmentHost
  expect(promptSending && attachmentSending).toBe(false)
  const sessionExport = process.env.DSHM_OFFICIAL_SESSION_EXPORT_CHECK === '1'
  const feedbackHistory = process.env.DSHM_OFFICIAL_FEEDBACK_HISTORY_CHECK === '1'
  expect(feedbackHistory && process.env.DSHM_OFFICIAL_FEEDBACK_CHECK === '1').toBe(false)
  const feedback = process.env.DSHM_OFFICIAL_FEEDBACK_CHECK === '1' || feedbackHistory
  const childStop = process.env.DSHM_OFFICIAL_CHILD_STOP_CHECK === '1'
  const subagents = process.env.DSHM_OFFICIAL_SUBAGENT_CHECK === '1' || sessionExport || childStop
  const goals = process.env.DSHM_OFFICIAL_GOAL_CHECK === '1'
  const workflows = process.env.DSHM_OFFICIAL_WORKFLOW_CHECK === '1'
  const schedules = process.env.DSHM_OFFICIAL_SCHEDULE_CHECK === '1'
  const approvalProcess = process.env.DSHM_OFFICIAL_APPROVAL_PROCESS_CHECK === '1'
  const hostRestart = process.env.DSHM_OFFICIAL_HOST_RESTART_CHECK === '1'
  const approvalSending = process.env.DSHM_OFFICIAL_APPROVAL_SENDING_CHECK === '1'
  const questionProcess = process.env.DSHM_OFFICIAL_QUESTION_PROCESS_CHECK === '1'
  const interactionMode = process.env.DSHM_OFFICIAL_INTERACTION_HOST_CHECK
  if (interactionMode) expect(['legacy', 'plan']).toContain(interactionMode)
  const interactionHost = interactionMode === 'legacy' || interactionMode === 'plan'
  if (interactionHost) expect(process.env.DSHM_OFFICIAL_APP_CHECK).toBe('1')
  const raceMode = process.env.DSHM_OFFICIAL_INTERACTION_RACE_CHECK
  if (raceMode) expect(['legacy', 'plan', 'continued']).toContain(raceMode)
  const timedRace = raceMode === 'continued'
  const interactionRace = raceMode === 'legacy' || raceMode === 'plan' || timedRace
  if (interactionRace) expect(process.env.DSHM_OFFICIAL_APP_CHECK).toBe('1')
  const interactionSendingMode = process.env.DSHM_OFFICIAL_INTERACTION_SENDING_CHECK
  if (interactionSendingMode) expect(['legacy', 'plan']).toContain(interactionSendingMode)
  const interactionSending = interactionSendingMode === 'legacy' || interactionSendingMode === 'plan'
  if (interactionSending) expect(process.env.DSHM_OFFICIAL_APP_CHECK).toBe('1')
  const sendingInterruption = approvalSending || interactionSending
  const timedHost = process.env.DSHM_OFFICIAL_TIMED_HOST_CHECK === '1'
  expect(timedHost && process.env.DSHM_OFFICIAL_TIMED_QUESTION_CHECK === '1').toBe(false)
  const timedQuestion = process.env.DSHM_OFFICIAL_TIMED_QUESTION_CHECK === '1' || timedHost
  if (timedQuestion) expect(process.env.DSHM_OFFICIAL_APP_CHECK).toBe('1')
  const approvalLifecycle = approvalProcess || hostRestart || approvalSending
  const approvalRecovery = process.env.DSHM_OFFICIAL_APPROVAL_RECOVERY_CHECK === '1' || approvalLifecycle
  expect(approvalProcess && process.env.DSHM_OFFICIAL_APPROVAL_RECOVERY_CHECK === '1').toBe(false)
  expect(hostRestart && (approvalProcess || process.env.DSHM_OFFICIAL_APPROVAL_RECOVERY_CHECK === '1')).toBe(false)
  expect(approvalSending && (approvalProcess || hostRestart || process.env.DSHM_OFFICIAL_APPROVAL_RECOVERY_CHECK === '1')).toBe(false)
  const planProcess = process.env.DSHM_OFFICIAL_PLAN_PROCESS_CHECK === '1'
  const planReview = process.env.DSHM_OFFICIAL_PLAN_CHECK === '1' || planProcess
  expect(planProcess && process.env.DSHM_OFFICIAL_PLAN_CHECK === '1').toBe(false)
  if (planProcess) expect(process.env.DSHM_OFFICIAL_APP_CHECK).toBe('1')
  const notifications = process.env.DSHM_OFFICIAL_NOTICE_CHECK === '1'
  const fileRecovery = process.env.DSHM_OFFICIAL_FILE_RECOVERY_CHECK === '1'
  const fileSave = process.env.DSHM_OFFICIAL_FILE_SAVE_CHECK === '1'
  const attachments = process.env.DSHM_OFFICIAL_ATTACHMENT_CHECK === '1'
  const fileWriteDeath = process.env.DSHM_OFFICIAL_FILE_WRITE_DEATH_CHECK === '1'
  const fileWriteRevocation = process.env.DSHM_OFFICIAL_FILE_WRITE_REVOCATION_CHECK === '1'
  const fileWriteInterruption = process.env.DSHM_OFFICIAL_FILE_WRITE_INTERRUPTION_CHECK === '1' || fileWriteRevocation
  expect(fileWriteRevocation && process.env.DSHM_OFFICIAL_FILE_WRITE_INTERRUPTION_CHECK === '1').toBe(false)
  if (extensions || background || files || plugins || office || workspaceManagement || (settings && !isolatedSettings) || queue || navigation || approvalRecovery || questionProcess || timedQuestion || planReview || interactionHost || interactionRace || interactionSending || notifications || fileRecovery || fileSave || attachments || fileWriteDeath || fileWriteInterruption) expect(inference).toBe(true)
  expect([extensions, background, files, plugins, office, workspaceManagement, settings, creatorTask, queue, navigation, approvalRecovery, questionProcess, timedQuestion, planReview, interactionHost, interactionRace, interactionSending, notifications, fileRecovery, fileSave, attachments, fileWriteDeath, fileWriteInterruption].filter(Boolean).length).toBeLessThanOrEqual(1)
  const alpha2 = process.env.DSHM_OFFICIAL_ALPHA2_CHECK === '1'
  const reviewPreview = process.env.DSHM_OFFICIAL_REVIEW_CHECK === '1'
  const longHistory = process.env.DSHM_OFFICIAL_HISTORY_CHECK === '1'
  const historyInflight = process.env.DSHM_OFFICIAL_HISTORY_INFLIGHT_CHECK === '1'
  const ptc = process.env.DSHM_OFFICIAL_PTC_CHECK === '1'
  const skills = process.env.DSHM_OFFICIAL_SKILLS_CHECK === '1'
  const externalChild = process.env.DSHM_OFFICIAL_EXTERNAL_CHILD_CHECK === '1'
  const references = process.env.DSHM_OFFICIAL_REFERENCE_CHECK === '1'
  const pairingCheck = process.env.DSHM_OFFICIAL_PAIRING_CHECK === '1'
  expect([reviewPreview, longHistory, historyInflight, ptc, skills, externalChild, references, pairingCheck].filter(Boolean).length).toBeLessThanOrEqual(1)
  if (reviewPreview || longHistory || historyInflight || ptc || skills || externalChild || references || pairingCheck) {
    expect(inference && alpha2 && process.env.DSHM_OFFICIAL_APP_CHECK === '1').toBe(true)
    expect([extensions, background, files, plugins, office, workspaceManagement, settings, queue, navigation,
      subagents, goals, workflows, schedules, approvalRecovery, questionProcess, timedQuestion, planReview,
      interactionHost, interactionRace, interactionSending, notifications, fileRecovery, fileSave,
      attachments, fileWriteDeath, fileWriteInterruption, feedback, promptSending, attachmentSending].some(Boolean)).toBe(false)
  }
  if (promptSending || attachmentSending) {
    expect(inference && alpha2 && process.env.DSHM_OFFICIAL_APP_CHECK === '1').toBe(true)
    expect([feedback, extensions, background, files, plugins, office, workspaceManagement, settings, queue, navigation,
      subagents, goals, workflows, schedules, creatorTask, approvalRecovery, questionProcess, timedQuestion, planReview,
      interactionHost, interactionRace, interactionSending, notifications, fileRecovery, fileSave,
      attachments, fileWriteDeath, fileWriteInterruption].some(Boolean)).toBe(false)
  }
  if (feedback) {
    expect(inference && alpha2 && process.env.DSHM_OFFICIAL_APP_CHECK === '1').toBe(true)
    expect([extensions, background, files, plugins, office, workspaceManagement, settings, queue, navigation,
      subagents, goals, workflows, schedules, approvalRecovery, questionProcess, timedQuestion, planReview,
      interactionHost, interactionRace, interactionSending, notifications, fileRecovery, fileSave,
      attachments, fileWriteDeath, fileWriteInterruption].some(Boolean)).toBe(false)
    for (const key of ['DSH_TELEMETRY_OTLP_URL', 'DSH_TELEMETRY_MODE', 'DSH_TELEMETRY_DISABLED']) expect(process.env[key]).toBeUndefined()
  }
  if (backgroundControlCheck || backgroundHostCheck || backgroundStopCheck) expect(inference && alpha2 && process.env.DSHM_OFFICIAL_APP_CHECK === '1').toBe(true)
  if (creatorTask) expect(inference && alpha2 && process.env.DSHM_OFFICIAL_APP_CHECK === '1').toBe(true)
  if (pluginUpgrade) expect(plugins && alpha2 && process.env.DSHM_OFFICIAL_APP_CHECK === '1').toBe(true)
  if (pluginLayout) expect(plugins && alpha2 && process.env.DSHM_OFFICIAL_APP_CHECK === '1').toBe(true)
  if (pluginInterruption) expect(plugins && alpha2 && !pluginUpgrade && process.env.DSHM_OFFICIAL_APP_CHECK === '1').toBe(true)
  if (pluginScripts) expect(plugins && alpha2 && !pluginUpgrade && !pluginInterruption && process.env.DSHM_OFFICIAL_APP_CHECK === '1').toBe(true)
  if (pluginApplying) expect(plugins && alpha2 && process.env.DSHM_OFFICIAL_APP_CHECK === '1').toBe(true)
  if (credentialEndpoints || modelSettings || presetSettings || presetCreator || providerManagement || isolatedSettings) expect(alpha2 && process.env.DSHM_OFFICIAL_APP_CHECK === '1').toBe(true)
  // Key 专项使用独立空用户目录，不继承真实 Key；消息只验证官方缺少凭据的结果。
  if (isolatedSettings) expect(inference).toBe(false)
  if (subagents || goals || workflows || schedules) {
    expect([subagents, goals, workflows, schedules].filter(Boolean)).toHaveLength(1)
    expect(inference && alpha2 && process.env.DSHM_OFFICIAL_APP_CHECK === '1').toBe(true)
    expect([extensions, background, files, plugins, office, workspaceManagement, settings, queue, navigation,
      approvalRecovery, questionProcess, timedQuestion, planReview, interactionHost, interactionRace,
      interactionSending, notifications, fileRecovery, fileSave, attachments, fileWriteDeath,
      fileWriteInterruption].some(Boolean)).toBe(false)
  }
  const installation = resolve('../plugin/artifacts', alpha2 ? 'official-dsh-alpha2' : 'official-dsh-plugin-only')
  const root = endpointProcess ? resolve("../plugin/artifacts/official-dsh-alpha2-endpoint-process") : endpointRace ? resolve('../plugin/artifacts/official-dsh-alpha2-endpoint-race') : endpointInterruption ? resolve('../plugin/artifacts/official-dsh-alpha2-endpoint-interruption') : endpointPolicy ? resolve('../plugin/artifacts/official-dsh-alpha2-endpoint-policy') : endpointWrites ? resolve('../plugin/artifacts/official-dsh-alpha2-endpoint')
    : providerKeys ? resolve('../plugin/artifacts/official-dsh-alpha2-key') : installation
  const expectedVersion = alpha2 ? '0.2.1-alpha.2' : '0.2.1-alpha.1'
  const installed = JSON.parse(await readFile(resolve(installation, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  expect(installed.version).toBe(expectedVersion)
  if (alpha2) expect(process.env.DSHM_OFFICIAL_APP_CHECK).toBe('1')
  const port = endpointProcess ? 16965 : endpointRace ? 16964 : endpointInterruption ? 16963 : endpointPolicy ? 16962 : endpointWrites ? 16961 : providerKeys ? 16960 : alpha2 ? 16958 : 16955
  const hostOrigin = `http://127.0.0.1:${port}`
  const startup = JSON.parse(await readFile(resolve(root, 'official-web-receipt.json'), 'utf8'))
  expect(startup.stage).toBe('plugin-ready')
  expect(startup.port).toBe(port)
  if (isolatedSettings) {
    expect(startup.scope).toBe(endpointProcess ? "isolated-service-address-process" : endpointRace ? 'isolated-service-address-race' : endpointInterruption ? 'isolated-service-address-interruption' : endpointPolicy ? 'isolated-service-address-policy' : endpointWrites ? 'isolated-service-address' : 'isolated-synthetic-provider-key')
    expect(startup.home).toBe(resolve(root, 'home'))
  }
  process.kill(startup.pid, 0)
  const privateLog = await readFile(startup.privateLog, 'utf8')
  const loginURL = privateLog.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1]
  expect(loginURL).toBeTruthy()
  expect(new URL(loginURL!).origin).toBe(hostOrigin)
  const login = await fetch(loginURL!, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  expect(login.status).toBe(303)
  let cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const lifecycle = hostRestart || timedHost || interactionHost || pluginUpgrade || pluginInterruption || pluginScripts || pluginApplying || backgroundHostCheck || feedback || promptHost || attachmentHost ? officialHostLifecycle(root, startup) : undefined
  const restoreOfficialLogin = async (telemetry?: { endpoint: string }) => {
    const receipt = await lifecycle!.start(telemetry)
    const log = await readFile(receipt.privateLog, 'utf8')
    const url = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1]
    expect(url).toBeTruthy()
    expect(new URL(url!).origin).toBe(hostOrigin)
    const renewed = await fetch(url!, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
    expect(renewed.status).toBe(303)
    cookie = renewed.headers.get('set-cookie')!.split(';')[0]!
    return { run: receipt.run, launchPid: receipt.pid, entry: receipt.entry,
      loginStatus: renewed.status, pluginStatus: receipt.pluginStatus }
  }
  const manage = async (action?: unknown) => {
    const response = await fetch(hostOrigin + '/api/dsh-mobile', {
      method: action ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' },
      body: action ? JSON.stringify(action) : undefined, signal: AbortSignal.timeout(15000),
    })
    const value = await response.json()
    expect(response.status, JSON.stringify(value)).toBe(200)
    return value
  }
  const desktopRpc = async (method: string, args: unknown, allowRemovedWorkspace = false) => {
    const rpcId = randomUUID()
    const response = await fetch(hostOrigin + '/api/' + method, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      signal: AbortSignal.timeout(method.startsWith('pluginManager/') ? 120000 : 15000),
    })
    expect(response.status).toBe(200)
    const frame = await response.json()
    expect(frame.rpcId).toBe(rpcId)
    if (allowRemovedWorkspace) {
      expect(method).toBe('workspace/delete')
      if (frame.result.ok === false && frame.result.error.code === 'workspace/not-found') return frame.result
    }
    expect(frame.result.ok, JSON.stringify(frame.result)).toBe(true)
    return frame.result.value
  }
  const directory = resolve('artifacts/official-plugin-only')
  await mkdir(directory, { recursive: true })
  const run = randomUUID(), report: Record<string, any> = { run, version: installed.version,
    desktopPluginVersion: (await desktopRpc('pluginManager/listBundles', {}))
      .find((bundle: any) => bundle.name === '@dsh-mobile/plugin')?.version,
    officialLaunchPid: startup.pid, entry: startup.entry ?? 'official published CLI',
    scope: hostRestart ? 'official-host-restart-during-approval-and-after-settlement' : approvalProcess ? 'approval-waiting-app-process-death-and-recovery' : fileWriteRevocation ? 'default-system-destination-write-device-revocation' : fileWriteInterruption ? 'default-system-destination-write-cancel-disconnect-and-retry' : fileWriteDeath ? 'default-system-destination-write-process-death-and-retry' : attachments ? 'phone-upload-and-history-attachment-preview-download' : fileSave ? 'system-save-window-cancel-disconnect-and-retry' : fileRecovery ? 'file-transfer-cancel-disconnect-and-source-change' : notifications ? 'completion-notice-and-process-recovery' : planReview ? 'plan-approve-and-request-changes' : approvalRecovery ? 'approval-offline-and-competing-clients' : navigation ? 'session-search-fork-and-archive' : queue ? 'queue-steering-stop-and-reconnect' : settings ? 'computer-settings-and-restoration' : workspaceManagement ? 'workspace-registration-management' : office ? 'office-six-formats-preview' : plugins ? 'plugin-install-and-permission' : files ? 'workspace-files-and-transfers' : background ? 'background-job-output' : extensions ? 'question-and-command-results' : inference ? 'real-model-and-approvals' : 'basic-transport',
    coreInferenceVerified: false, passed: false, stages: [] }
  const reportPath = resolve(directory, `official-android-${run}.json`)
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  if (reviewPreview) report.scope = 'phone-planned-tool-diff-and-actual-turn-review'
  if (longHistory) report.scope = 'phone-long-session-history-pagination-and-reconnect'
  if (historyInflight) report.scope = 'phone-history-late-page-switch-and-disconnect'
  if (fileShare) report.scope = 'phone-complete-file-sharing-readonly-recipient'
  if (fileDesktop) report.scope = 'phone-workspace-file-default-native-open-confirmation'
  if (filePresented) report.scope = 'phone-presented-file-native-open-and-explorer-reveal'
  const db = new PGlite(resolve(directory, 'gateway-data'))
  const store = new Store(pgliteDatabase(db))
  await store.migrate()
  const origin = 'http://127.0.0.1:16956'
  const gateway = await buildGateway({ store, publicOrigin: origin, registrationMode: 'open', logger: false })
  await gateway.listen({ host: '127.0.0.1', port: historyInflight || promptSending || attachmentSending || sendingInterruption || endpointInterruption || endpointRace || endpointProcess || backgroundStopCheck ? 16957 : 16956 })
  let sendingProxy: Awaited<ReturnType<typeof officialApprovalTransport>> | undefined
  let endpointProxy: Awaited<ReturnType<typeof officialEndpointTransport>> | undefined
  let jobStopProxy: Awaited<ReturnType<typeof officialJobStopTransport>> | undefined
  let promptProxy: Awaited<ReturnType<typeof officialPromptTransport>> | undefined
  let historyProxy: Awaited<ReturnType<typeof officialHistoryTransport>> | undefined
  if (promptSending) report.scope = 'phone-plain-message-before-forward-and-receipt-loss-reconnect'
  if (promptProcess) report.scope = 'phone-plain-message-app-exit-before-forward-and-after-acceptance-recovery'
  if (promptHost) report.scope = 'phone-plain-message-host-exit-before-forward-and-after-acceptance-recovery'
  if (attachmentSending) report.scope = 'phone-file-upload-partial-before-forward-and-receipt-loss-reconnect'
  if (attachmentProcess) report.scope = 'phone-file-upload-and-submission-app-exit-original-blob-and-session-recovery'
  if (attachmentHost) report.scope = 'phone-file-upload-and-submission-host-exit-original-blob-and-session-recovery'
  if (approvalSending) report.scope = 'approval-answer-before-forward-and-receipt-loss'
  if (questionProcess) report.scope = 'legacy-question-waiting-app-process-death-and-recovery'
  if (timedQuestion) report.scope = 'timed-question-app-recovery-timeout-and-late-answer'
  if (timedHost) report.scope = 'timed-question-host-interruption-phone-late-answer-and-settled-restart'
  if (planProcess) report.scope = 'plan-review-waiting-app-process-death-and-recovery'
  if (interactionHost) report.scope = interactionMode + '-interaction-host-interruption-explicit-retry-and-settled-restart'
  if (interactionRace) report.scope = raceMode + '-interaction-two-real-connections-opposite-concurrent-decisions'
  if (interactionSending) report.scope = interactionSendingMode + '-interaction-phone-answer-before-forward-and-receipt-loss'
  if (subagents) report.scope = 'real-model-child-creation-phone-continuation-and-draft-isolation'
  if (childStop) report.scope = 'phone-real-continuable-child-readonly-tool-stop-and-continuation'
  if (sessionExport) report.scope = 'phone-session-log-zip-root-descendant-attachment-and-system-save-cancel'
  if (feedback) report.scope = 'phone-message-and-session-feedback-live-sync-reconnect-and-local-otlp'
  if (feedbackHistory) report.scope = 'phone-message-feedback-cold-archive-fork-isolation-and-two-host-restarts'
  if (goals) report.scope = 'phone-goal-controls-and-official-automatic-model-round'
  if (workflows) report.scope = 'real-workflow-members-phone-navigation-and-completion'
  if (schedules) report.scope = 'persistent-schedule-phone-catalog-real-delivery-and-reconnect'
  if (credentialEndpoints) report.scope = 'computer-key-status-native-cancel-and-endpoint-review-cancel'
  if (modelSettings) report.scope = 'phone-deepseek-model-catalog-write-live-directory-and-inheritance-restoration'
  if (presetSettings) report.scope = 'phone-preset-selection-declaration-default-inheritance-and-restoration'
  if (presetCreator) report.scope = 'phone-four-preset-declarations-selection-creator-new-and-reused-session'
  if (creatorTask) report.scope = 'creator-host-inspection-and-plugin-source-write-approvals'
  if (backgroundControlCheck) report.scope = 'phone-background-stop-large-ring-gap-disconnect-and-explicit-resume'
  if (backgroundProcessCheck) report.scope = 'phone-background-output-app-process-death-running-and-settled-recovery'
  if (backgroundHostCheck) report.scope = 'phone-background-host-exit-running-and-completed-output-loss-and-no-replay'
  if (backgroundStopCheck) report.scope = 'phone-background-stop-before-forward-receipt-loss-two-connections-and-settled-notice'
  if (pluginUpgrade) report.scope = 'phone-plugin-upgrade-official-restart-and-local-ui'
  if (pluginLayout) report.scope = 'phone-plugin-author-layout-user-overrides-and-persistence'
  if (pluginInterruption) report.scope = 'phone-plugin-download-cancellation-and-host-exit-outcome-unknown'
  if (pluginScripts) report.scope = 'phone-plugin-build-script-approval-cancellation-failure-success'
  if (pluginApplying) report.scope = pluginAutoApplying ? 'phone-plugin-install-auto-enable-applying-too-late-and-host-exit-outcome-unknown'
    : 'phone-plugin-activation-loading-and-host-exit-outcome-unknown'
  if (providerManagement) report.scope = 'phone-custom-provider-discovery-settings-protocol-and-removal'
  if (providerKeys) report.scope = 'isolated-synthetic-provider-native-key-write-use-remove-no-inference'
  if (endpointWrites) report.scope = 'isolated-service-address-write-restore-and-stale-review-no-inference'
  if (endpointPolicy) report.scope = 'isolated-service-address-reset-policy-and-catalog-default-no-inference'
  if (endpointInterruption) report.scope = 'isolated-service-address-phone-write-before-forward-and-receipt-loss-no-inference'
  if (endpointRace) report.scope = 'isolated-service-address-phone-and-other-real-connection-concurrent-writes-no-inference'
  if (endpointProcess) report.scope = "isolated-service-address-phone-write-app-process-death-and-recovery-no-inference"
  let socket: WebSocket | undefined
  const approvalSockets = new Set<WebSocket>()
  const devices = new Set<string>()
  const sessions = new Set<string>()
  const forkedSessions = new Set<string>()
  const jobs = new Map<string, string>()
  let backgroundControl: Awaited<ReturnType<typeof officialBackgroundControl>> | undefined
  let backgroundHostControl: Awaited<ReturnType<typeof officialBackgroundHost>> | undefined
  let backgroundStopControl: Awaited<ReturnType<typeof officialBackgroundStop>> | undefined
  let feedbackCollector: Awaited<ReturnType<typeof officialFeedbackCollector>> | undefined
  let feedbackHostConfigured = false
  let feedbackHistoryChecks: ReturnType<typeof officialFeedbackHistoryChecks> | undefined
  const testChildren = new Map<string, string>()
  let goalChecks: ReturnType<typeof officialGoalChecks> | undefined
  let scheduleChecks: ReturnType<typeof officialScheduleChecks> | undefined
  let deepSeekModelChecks: ReturnType<typeof officialDeepSeekModelChecks> | undefined
  let presetChecks: ReturnType<typeof officialPresetChecks> | undefined
  let presetCreatorChecks: ReturnType<typeof officialPresetCreatorChecks> | undefined
  let creatorTaskChecks: ReturnType<typeof officialCreatorTaskChecks> | undefined
  let ptcChecks: ReturnType<typeof officialPtcChecks> | undefined
  let skillChecks: ReturnType<typeof officialSkillChecks> | undefined
  let referenceChecks: Awaited<ReturnType<typeof officialReferenceChecks>> | undefined
  let providerChecks: Awaited<ReturnType<typeof officialProviderChecks>> | undefined
  let providerKeyChecks: Awaited<ReturnType<typeof officialProviderKeyChecks>> | undefined
  let endpointChecks: Awaited<ReturnType<typeof officialEndpointChecks>> | undefined
  const fixtures = new Map<string, Buffer>()
  const approvalFixtureChanges = new Map<string, string>()
  const ownBundle = '@dsh-mobile/panel-ui-verification'
  let pluginUpgradeChecks: ReturnType<typeof officialPluginUpgradeChecks> | undefined
  let pluginDownload: Awaited<ReturnType<typeof officialPluginDownload>> | undefined
  let pluginScriptControl: Awaited<ReturnType<typeof officialPluginScripts>> | undefined
  let pluginApplyingControl: Awaited<ReturnType<typeof officialPluginApplying>> | undefined
  let managedWorkspace: { id: string; path: string; keep: Buffer } | undefined
  const settingsKeys = ['thinking', 'reasoningEffort', 'maxTokens', 'defaultContextWindow', 'streamIdleTimeoutMs']
  const projectSettings = (view: any) => settingsKeys.map(key => ({ key, value: view.value[key],
    overridden: Object.hasOwn(view.user ?? {}, key) }))
  let settingsBackup: { documentId: string; fields: any[]; original: number; changed: number; overridden: boolean } | undefined
  const settingsView = async (documentId: string) => {
    // 官方接口保证秘密脱敏；测试仅保留明确五项公开标量，不记录其他配置。
    const view = (await desktopRpc('settings/describe', {})).namespaces.find((item: any) => item.ns === documentId)
    expect(view).toBeTruthy()
    return view
  }
  let phonePluginRemovalRequested = false
  const timedPreset = timedQuestion || timedRace ? officialTimedPreset(desktopRpc, directory, run) : undefined
  const externalPreset = externalChild ? officialExternalPreset(desktopRpc, directory, run, root) : undefined
  const waitBundleAbsent = async () => {
    // 官方包管理操作异步落盘；卡片消失不代表依赖与公开目录已经清理完毕。
    await expect.poll(async () => (await desktopRpc('pluginManager/listBundles', {}))
      .some((item: any) => item.name === ownBundle), { timeout: 120000 }).toBe(false)
  }
  onTestFinished(async () => {
    socket?.close()
    for (const reader of approvalSockets) reader.close()
    const failures: unknown[] = []
    if (scheduleChecks) try { report.testScheduleCleanup = await scheduleChecks.cleanup() }
    catch (error) { failures.push(error) }
    if (deepSeekModelChecks) try { report.testModelSettingsRestored = await deepSeekModelChecks.cleanup() }
    catch (error) { failures.push(error) }
    if (presetChecks) try { report.testPresetSettingsRestored = await presetChecks.cleanup() }
    catch (error) { failures.push(error) }
    if (presetCreatorChecks) try { report.testPresetCreatorUnchanged = await presetCreatorChecks.cleanup() }
    catch (error) { failures.push(error) }
    if (creatorTaskChecks) try { report.testCreatorTaskUnchanged = await creatorTaskChecks.cleanup() }
    catch (error) { failures.push(error) }
    if (providerChecks) try { report.testProviderSettingsRestored = await providerChecks.cleanup() }
    catch (error) { failures.push(error) }
    if (providerKeyChecks) try { report.testProviderKeysRestored = await providerKeyChecks.cleanup() }
    catch (error) { failures.push(error) }
    if (endpointChecks) try { report.testEndpointsRestored = await endpointChecks.cleanup() }
    catch (error) { failures.push(error) }
    if (goalChecks) try { report.testGoalCleanup = await goalChecks.cleanup() }
    catch (error) { failures.push(error) }
    if (pluginDownload) try {
      if (pluginDownload.active() && !lifecycle!.isStopped()) await lifecycle!.stop()
      report.pluginDownload = pluginDownload.snapshot(); await pluginDownload.close(); report.pluginDownloadClosed = true
    } catch (error) { failures.push(error) }
    if (pluginScriptControl) try {
      if (pluginScriptControl.active() && !lifecycle!.isStopped()) await lifecycle!.stop()
      report.pluginScripts = pluginScriptControl.snapshot(); await pluginScriptControl.close(); report.pluginScriptsClosed = true
      report.scriptPolicyRestored = await pluginScriptControl.restorePolicy()
    } catch (error) { failures.push(error) }
    if (pluginApplyingControl) try {
      // 先释放自有插件的等待，避免普通卸载被它的异步初始化阻塞。
      await pluginApplyingControl.close(); report.pluginApplyingClosed = true
      report.pluginApplying = pluginApplyingControl.snapshot()
      report.applyingPolicyUnchanged = await pluginApplyingControl.policyUnchanged()
    } catch (error) { failures.push(error) }
    if (lifecycle?.isStopped()) try { report.hostRestoredDuringCleanup = await restoreOfficialLogin() }
    catch (error) { failures.push(error) }
    if (feedbackHistoryChecks) try { report.feedbackHistoryCleanup = await feedbackHistoryChecks.cleanup() }
    catch (error) { failures.push(error) }
    try {
      for (const [jobId, sessionId] of jobs) await desktopRpc('job/kill', { request: { jobId, sessionId } })
      if (jobs.size) report.testJobsStopRequested = true
    } catch (error) { failures.push(error) }
    if (backgroundControl) try {
      report.backgroundControl = await backgroundControl.close(); report.backgroundControlClosed = true
    } catch (error) { failures.push(error) }
    if (backgroundHostControl) try {
      report.backgroundHostControl = await backgroundHostControl.close(); report.backgroundHostControlClosed = true
    } catch (error) { failures.push(error) }
    if (backgroundStopControl) try {
      report.backgroundStopControl = await backgroundStopControl.close(); report.backgroundStopControlClosed = true
    } catch (error) { failures.push(error) }
    try {
      for (const [childSessionId, parentSessionId] of testChildren)
        expect(await desktopRpc('subagents/interruptByParent', { childSessionId, parentSessionId, mode: 'continuable' }))
          .toEqual({ accepted: true })
      if (testChildren.size) report.testChildStopRequested = true
    } catch (error) { failures.push(error) }
    try {
      const rows = await desktopRpc('session/list', { _request: {} })
      for (const sessionId of sessions) {
        if (rows.items.some((item: { sessionId: string; running: boolean }) => item.sessionId === sessionId && item.running))
          await desktopRpc('session/cancel', { request: { sessionId } })
        if (ptc || queue || approvalRecovery || questionProcess || timedQuestion || planReview || interactionHost || interactionRace || interactionSending || notifications) {
          await expect.poll(async () => (await desktopRpc('session/list', { _request: {} })).items
            .find((item: any) => item.sessionId === sessionId)?.running, { timeout: 20000 }).toBe(false)
        }
        if (queue) {
          const inbox = (await desktopRpc('session/projections', { request: { sessionId } })).values.inbox
          for (const item of [...inbox['next-turn'], ...inbox['next-step']])
            await desktopRpc('session/updateQueue', { request: { sessionId, itemId: item.id, action: { kind: 'remove' } } })
        }
        if (inference) await desktopRpc('commands/execute', {
          agentId: sessionId, line: '/permission workspace-write', submittedAttachments: [],
        })
        if (planReview || interactionMode === 'plan' || raceMode === 'plan' || interactionSendingMode === 'plan') {
          await desktopRpc('commands/execute', { agentId: sessionId, line: '/plan off', submittedAttachments: [] })
          expect((await desktopRpc('session/projections', { request: { sessionId } })).values.plan)
            .toEqual({ active: false, pending: false })
          report.testPlanModeRestored = true
        }
      }
      report.testSessionsStopped = true
      for (const sessionId of forkedSessions)
        await desktopRpc('workspace/archiveSession', { request: { sessionId } })
      if (forkedSessions.size) report.testForksArchived = true
    } catch (error) { failures.push(error) }
    if (ptcChecks) try { report.testPtcUnchanged = await ptcChecks.unchanged() }
    catch (error) { failures.push(error) }
    try {
      const state = await manage()
      for (const deviceId of devices) {
        const device = state.devices.find((item: { id: string }) => item.id === deviceId)
        if (device?.management) await manage({ action: 'management', deviceId, enabled: false })
        if (device && device.status !== 'revoked')
          await manage({ action: 'revoke', deviceId })
      }
      report.testDevicesRevoked = true
    } catch (error) { failures.push(error) }
    if (timedPreset) try { report.testTimedPresetCleanup = await timedPreset.cleanup() }
    catch (error) { failures.push(error) }
    if (externalPreset) try { report.testExternalPresetCleanup = await externalPreset.cleanup() }
    catch (error) { failures.push(error) }
    if (plugins) try {
      if (phonePluginRemovalRequested) await waitBundleAbsent()
      if (pluginApplyingControl) for (const [mode, name] of Object.entries(pluginApplyingControl.names)) {
        const fixture = (await desktopRpc('pluginManager/listBundles', {})).find((item: any) => item.name === name)
        if (fixture) {
          expect(fixture.version).toBe(pluginApplyingControl.versions[mode as 'finish' | 'host' | 'controller'])
          expect(fixture.source).toContain(`${run}/${mode}.tgz`)
          expect((await desktopRpc('pluginManager/removeBundle', { name })).application).not.toBe('failed')
        }
        await expect.poll(async () => (await desktopRpc('pluginManager/listBundles', {})).some((item: any) => item.name === name), { timeout: 120000 }).toBe(false)
      }
      const bundle = (await desktopRpc('pluginManager/listBundles', {})).find((item: any) => item.name === ownBundle)
      if (bundle) {
        expect(pluginLayout ? ['0.0.12'] : pluginApplying ? ['0.0.5', '0.0.10', '0.0.11'] : pluginScripts ? ['0.0.5', '0.0.7', '0.0.8', '0.0.9'] : pluginUpgrade ? ['0.0.5', '0.0.6'] : ['0.0.5']).toContain(bundle.version)
        expect(bundle.source).toContain(pluginApplying && bundle.version !== '0.0.5' ? `${run}/` : 'official-plugin-fixtures')
        const removed = await desktopRpc('pluginManager/removeBundle', { name: ownBundle })
        expect(removed.application).not.toBe('failed')
      }
      await waitBundleAbsent()
      report.testBundleRemoved = true
    } catch (error) { failures.push(error) }
    if (managedWorkspace) try {
      // UUID和原件均来自本轮创建回执；只移除自己的注册，不删除目录或会话。
      expect(await readFile(managedWorkspace.path)).toEqual(managedWorkspace.keep)
      const removed = await desktopRpc('workspace/delete', { request: { workspaceId: managedWorkspace.id } }, true)
      report.testWorkspaceCleanup = removed
    } catch (error) { failures.push(error) }
    if (pluginUpgradeChecks) try { report.testPluginUpgradeUnchanged = await pluginUpgradeChecks.unchanged(true) }
    catch (error) { failures.push(error) }
    if (settingsBackup) try {
      const backup = settingsBackup, current = await settingsView(backup.documentId)
      const fields = projectSettings(current)
      if (JSON.stringify(fields) !== JSON.stringify(backup.fields)) {
        expect(fields.filter(item => item.key !== 'streamIdleTimeoutMs')).toEqual(backup.fields.filter(item => item.key !== 'streamIdleTimeoutMs'))
        expect(current.value.streamIdleTimeoutMs).toBe(backup.changed)
        await desktopRpc('settings/mutate', { ns: backup.documentId, expectedRevision: current.revision,
          ops: [backup.overridden ? { op: 'set', path: ['streamIdleTimeoutMs'], value: backup.original }
            : { op: 'unset', path: ['streamIdleTimeoutMs'] }] })
      }
      expect(projectSettings(await settingsView(backup.documentId))).toEqual(backup.fields)
      report.testSettingsRestored = true
    } catch (error) { failures.push(error) }
    try {
      // 只删除本轮创建且内容未变的测试文件；工作区注册与会话历史保留为验收证据。
      for (const [path, content] of fixtures) {
        const current = await readFile(path)
        if (approvalFixtureChanges.has(path) && !current.equals(content)) {
          expect(current.toString().trim()).toBe(approvalFixtureChanges.get(path))
          await writeFile(path, content)
        }
        expect((await readFile(path)).equals(content)).toBe(true)
        await unlink(path)
      }
      if (fixtures.size) report.testFilesRemoved = true
    } catch (error) { failures.push(error) }
    if (skillChecks) try { report.testSkillsRemoved = await skillChecks.removed() }
    catch (error) { failures.push(error) }
    try { await manage({ action: 'disable' }) } catch (error) { failures.push(error) }
    if (endpointProxy) try {
      report[endpointProcess ? "endpointProcessTransport" : endpointRace ? 'endpointRaceTransport' : 'endpointInterruptionTransport'] = endpointProxy.snapshot()
      await endpointProxy.close(); report.externalProxyClosed = true
    } catch (error) { failures.push(error) }
    if (sendingProxy) try {
      report[interactionSending ? 'interactionSendingTransport' : 'approvalSendingTransport'] = sendingProxy.snapshot()
      await sendingProxy.close(); report.externalProxyClosed = true
    } catch (error) { failures.push(error) }
    if (jobStopProxy) try {
      report.jobStopTransport = jobStopProxy.snapshot(); await jobStopProxy.close(); report.externalProxyClosed = true
    } catch (error) { failures.push(error) }
    if (promptProxy) try {
      report.promptSendingTransport = promptProxy.snapshot(); await promptProxy.close(); report.externalProxyClosed = true
    } catch (error) { failures.push(error) }
    if (historyProxy) try {
      report.historyTransport = historyProxy.snapshot(); await historyProxy.close(); report.externalProxyClosed = true
    } catch (error) { failures.push(error) }
    try { await gateway.close(); report.gatewayClosed = true } catch (error) { failures.push(error) }
    try { await db.close() } catch (error) { failures.push(error) }
    if (feedbackHostConfigured) try {
      if (!lifecycle!.isStopped()) report.feedbackLocalHostStopped = await lifecycle!.stop()
      report.feedbackDefaultHostRestored = await restoreOfficialLogin()
      report.feedbackTelemetryConfigRestored = true
    } catch (error) { failures.push(error) }
    if (feedbackCollector) try { report.feedbackCollector = await feedbackCollector.close(); report.feedbackCollectorClosed = true }
    catch (error) { failures.push(error) }
    report.cleanupCompleted = failures.length === 0
    report.cleanupFailures = failures.map(error => error instanceof Error ? error.message : String(error))
    await save()
    if (failures.length) throw new AggregateError(failures, 'official_test_cleanup_failed')
  })
  try {
    if (feedback) {
      expect((await desktopRpc('session/list', { _request: {} })).items.some((row: any) => row.running)).toBe(false)
      const profilePath = resolve(root, 'home/profiles/web/cordis.patch.yml')
      const profile = await readFile(profilePath)
      expect(profile.toString()).not.toContain('session-telemetry-otel')
      feedbackCollector = await officialFeedbackCollector(resolve(directory, `feedback-collector-${run}.json`))
      report.feedbackCollectorEndpoint = feedbackCollector.endpoint
      report.feedbackOriginalHostStopped = await lifecycle!.stop(); feedbackHostConfigured = true
      report.feedbackLocalHost = await restoreOfficialLogin({ endpoint: feedbackCollector.endpoint })
      expect(await readFile(profilePath)).toEqual(profile)
      report.feedbackLocalHostUsesOfficialEnvironment = true
    }
    if (sendingInterruption) sendingProxy = await officialApprovalTransport(16956, 16957)
    if (endpointInterruption || endpointRace || endpointProcess) endpointProxy = await officialEndpointTransport(16956, 16957)
    if (backgroundStopCheck) jobStopProxy = await officialJobStopTransport(16956, 16957)
    if (promptSending || attachmentSending) promptProxy = await officialPromptTransport(16956, 16957)
    if (historyInflight) historyProxy = await officialHistoryTransport(16956, 16957)
    const state = await manage()
    if (plugins) expect((await desktopRpc('pluginManager/listBundles', {})).some((item: any) => item.name === ownBundle)).toBe(false)
    if (pluginUpgrade) report.pluginUpgradeFixture = await officialPluginUpgradeFixture(resolve(directory, run))
    if (pluginLayout) report.pluginLayoutFixture = await officialPluginLayoutFixture(resolve(directory, run))
    if (pluginInterruption) pluginDownload = await officialPluginDownload(resolve(root, 'home/profiles/web'), run)
    if (pluginScripts) pluginScriptControl = await officialPluginScripts(resolve(root, 'home/profiles/web'), resolve(directory, run), run)
    if (pluginApplying) {
      pluginApplyingControl = await officialPluginApplying(resolve(root, 'home/profiles/web'), resolve(directory, run), run, pluginAutoApplying)
      report.pluginApplyingFixtures = pluginApplyingControl.fixtures
    }
    if (!state.configured) await manage({ action: 'setup', origin, name: 'DSHM 官方纯插件验收' })
    else expect(state.origin).toBe(origin)
    await manage({ action: 'enable' })
    await expect.poll(async () => (await manage()).connection, { timeout: 15000 }).toBe('online')
    const identity = await clientKey()
    const api = async (path: string, token?: string, body?: unknown) => fetch(origin + path, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { dpop: await proof(identity, origin + path, 'POST', token),
        ...(token ? { authorization: 'DPoP ' + token } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const pairing = await manage({ action: 'pair' })
    const key = new URLSearchParams(new URL(pairing.link).hash.slice(1)).get('key')
    const claimed = await api('/v1/pairings/claim', undefined, { key, name: '官方纯插件协议验收' })
    expect(claimed.status).toBe(201)
    const claim = await claimed.json()
    devices.add(claim.deviceId)
    expect((await api('/v1/device/ticket', claim.token)).status).toBe(403)
    expect((await api('/v1/pairings/claim', undefined, { key, name: '重复领取拒绝' })).status).toBe(409)
    await manage({ action: 'approve', deviceId: claim.deviceId })
    const ticketResponse = await api('/v1/device/ticket', claim.token)
    expect(ticketResponse.status).toBe(200)
    const { ticket } = await ticketResponse.json()
    const frames: Record<string, any>[] = []
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/v1/device/socket')
    socket.on('message', raw => frames.push(JSON.parse(raw.toString())))
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'authenticate', ticket }))
    const receive = async (match: (frame: Record<string, any>) => boolean) => {
      await expect.poll(() => frames.some(match), { timeout: 15000 }).toBe(true)
      return frames.splice(frames.findIndex(match), 1)[0]!
    }
    await receive(frame => frame.type === 'ready' && frame.hostOnline === true)
    const request = (operation: unknown) => {
      const id = randomUUID()
      socket!.send(JSON.stringify(clientFrameSchema.parse({ type: 'request', id, operation })))
      return id
    }
    const result = async (operation: unknown) => {
      const id = request(operation)
      return receive(frame => frame.id === id)
    }
    // 每个读者拥有独立的真实中转连接和官方事件 clientId；不冒用手机的事件归属。
    const observeInteraction = async (sessionId: string, callId: string,
      interaction?: { id: string; question: string; timed?: boolean } | { plan: string }) => {
      const plan = interaction && 'plan' in interaction ? interaction : undefined
      const question = interaction && 'id' in interaction ? interaction : undefined
      const ticketResponse = await api('/v1/device/ticket', claim.token)
      expect(ticketResponse.status).toBe(200)
      const { ticket } = await ticketResponse.json()
      const reader = new WebSocket(origin.replace('http:', 'ws:') + '/v1/device/socket')
      approvalSockets.add(reader)
      const inbox: any[] = []
      reader.on('message', raw => inbox.push(JSON.parse(raw.toString())))
      await once(reader, 'open')
      reader.send(JSON.stringify({ type: 'authenticate', ticket }))
      const take = async (match: (frame: any) => boolean) => {
        await expect.poll(() => inbox.some(match), { timeout: 15000 }).toBe(true)
        return inbox.splice(inbox.findIndex(match), 1)[0]
      }
      await take(frame => frame.type === 'ready' && frame.hostOnline === true)
      const send = (operation: unknown) => {
        const id = randomUUID()
        reader.send(JSON.stringify(clientFrameSchema.parse({ type: 'request', id, operation })))
        return id
      }
      const streamId = send({ method: 'remote.stream', endpoint: '$events', payload: { args: {} } })
      const opening = await take(frame => frame.id === streamId && frame.type === 'event' && frame.value?.type === 'ready')
      const event = (await take(frame => frame.id === streamId && frame.type === 'event'
        && frame.value?.type === 'waterfall'
        && frame.value.event === (interaction ? 'user-questions/request' : 'approval/request')
        && frame.value.agentId === sessionId && (plan
          ? frame.value.request?.questions?.length === 1
            && frame.value.request.questions[0].intent?.kind === 'plan-review'
            && frame.value.request.questions[0].intent.callId === callId
            && frame.value.request.questions[0].detail === plan.plan
          : question ? frame.value.request?.questions?.length === 1
            && frame.value.request.questions[0].id === question.id
            && frame.value.request.questions[0].question === question.question
          : frame.value.request?.callId === callId))).value
      if (question) {
        // legacy没有wait；timed必须以原callId关联，不让测试读者代持计时。
        if (question.timed) expect(event.request.wait).toEqual({ callId, timed: true })
        else expect(event.request.wait).toBeUndefined()
        expect(event.request.questions[0].options.map((option: any) => option.label)).toEqual(['蓝色', '绿色'])
      } else if (plan) {
        expect(event.request.questions[0]).toMatchObject({ id: 'plan-review',
          question: 'Approve this plan and leave plan mode?', detail: plan.plan,
          intent: { kind: 'plan-review', callId, approve: 'Approve' } })
        expect(event.request.questions[0].options.map((option: any) => option.label)).toEqual(['Approve', 'Keep planning'])
      } else expect(event.request.toolName).toBe('write')
      const clientId = opening.value.clientId
      const settleRaw = async (outcome: unknown) => {
        const id = send({ method: 'remote.rpc', endpoint: '$events/result', payload: {
          args: { clientId, eventId: event.eventId, outcome },
        } })
        return take(frame => frame.id === id)
      }
      const answerRaw = (decision: 'allowed-once' | 'rejected' | { answers: { id: string; selected: string[] }[] }) =>
        settleRaw({ kind: 'result', value: decision })
      return {
        summary: { clientId, eventId: event.eventId, callId, sessionId },
        cancellations: () => inbox.filter(frame => frame.id === streamId && frame.type === 'event'
          && frame.value?.type === 'cancel' && frame.value.eventId === event.eventId).map(frame => frame.value),
        answerRaw,
        planDecision: (outcome: 'approve' | 'modify') => {
          expect(plan).toBeTruthy()
          const question = event.request.questions[0]
          // 与官方计划面板相同：批准返回原选项；“要求修改”dismiss返回ASK_CANCELLED。
          return outcome === 'approve' ? answerRaw({ answers: [{ id: question.id, selected: [question.intent.approve] }] })
            : settleRaw({ kind: 'rejected', error: { name: 'UserQuestionError',
              message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED' } })
        },
        answer: async (decision: 'allowed-once' | 'rejected') => {
          const response = await answerRaw(decision)
          // 官方已结算事件的旧结果是成功的幂等空操作，不应误称为拒绝。
          expect(response).toMatchObject({ type: 'result', value: { ok: true } })
          return { decision, response: response.value }
        },
        close: () => { reader.close(); approvalSockets.delete(reader) },
      }
    }
    const approvalReaders = new Map<string, Awaited<ReturnType<typeof observeInteraction>>[]>()
    const openReplyConnection = async () => {
      const ticketResponse = await api('/v1/device/ticket', claim.token)
      expect(ticketResponse.status).toBe(200)
      const { ticket } = await ticketResponse.json()
      const reader = new WebSocket(origin.replace('http:', 'ws:') + '/v1/device/socket')
      approvalSockets.add(reader)
      const inbox: any[] = []
      reader.on('message', raw => inbox.push(JSON.parse(raw.toString())))
      const take = async (match: (frame: any) => boolean) => {
        await expect.poll(() => inbox.some(match), { timeout: 15000 }).toBe(true)
        return inbox.splice(inbox.findIndex(match), 1)[0]
      }
      await once(reader, 'open'); reader.send(JSON.stringify({ type: 'authenticate', ticket }))
      await take(frame => frame.type === 'ready' && frame.hostOnline === true)
      const send = (operation: unknown) => {
        const id = randomUUID()
        reader.send(JSON.stringify(clientFrameSchema.parse({ type: 'request', id, operation }))); return id
      }
      const streamId = send({ method: 'remote.stream', endpoint: '$events', payload: { args: {} } })
      const opening = await take(frame => frame.id === streamId && frame.type === 'event' && frame.value?.type === 'ready')
      return {
        summary: { clientId: opening.value.clientId, sessionId, noForegroundWaitClaim: true },
        request: async (operation: unknown) => { const id = send(operation); return take(frame => frame.id === id); },
        answer: async (callId: string, answer: unknown) => {
          const id = send({ method: 'remote.rpc', endpoint: 'userQuestions/answer', payload: {
            args: { agentId: sessionId, callId, answer },
          } })
          return take(frame => frame.id === id)
        },
        close: () => { reader.close(); approvalSockets.delete(reader) },
      }
    }
    const approvalHistory = new Map<string, any[]>()
    const questionHistory = new Map<string, any[]>()
    const planHistory = new Map<string, any[]>()
    const hostIdleHistory = new Map<string, any[]>()
    const workspaceBaseline = async () => {
      const id = request({ method: 'remote.stream', endpoint: 'workspace/follow', payload: { args: {} } })
      try {
        const frame = await receive(item => item.id === id && item.type === 'event' && item.value?.type === 'baseline')
        return frame.value.value
      } finally { socket!.send(JSON.stringify({ type: 'cancel', id })) }
    }
    const negotiation = await result({ method: 'remote.negotiate', version: 2 })
    expect(negotiation).toMatchObject({ type: 'result', value: { dshVersion: expectedVersion,
      management: false, presetProfileManagement: false, desktopApps: false, desktopAppIcons: false,
      taskPendingNotifications: false, providerModelProbe: false } })
    expect(negotiation.value.commandOutputGeneration).toBeUndefined()
    for (const endpoint of ['session/list', 'session/create', 'session/prompt', 'session/selectModel'])
      expect(negotiation.value.endpoints.calls).toContain(endpoint)
    report.capabilities = negotiation.value
    const list = await result({ method: 'remote.rpc', endpoint: 'session/list', payload: { args: { _request: {} } } })
    expect(list).toMatchObject({ type: 'result', value: { ok: true } })
    expect(await result({ method: 'remote.rpc', endpoint: 'workspace/create',
      payload: { args: { request: { path: root } } } })).toMatchObject({ type: 'error', code: 'remote_operation_denied' })
    report.stages.push('official-gateway-pairing-and-capabilities')
    await save()
    const workspacePath = resolve(root, 'home/official-remote-test-project', run.slice(0, 8))
    await mkdir(workspacePath, { recursive: true })
    if (skills) report.skillFixture = await officialSkillFixture(workspacePath, run, fixtures)
    const attachmentSeed: { name: string; path: string; bytes: number; sha256: string; extension: string }[] = []
    const attachmentMarker = 'DSHM_ATTACHMENT_CONTENT_' + run
    const attachmentText = [attachmentMarker, ...Array.from({ length: 5001 }, (_, i) => `附件行 ${i + 1} 中文 🙂 ${run.slice(0, 8)}`)].join('\n') + '\n'
    if (attachments) {
      // 原件放在测试目录，避免模型从工作区同名副本读取而掩盖附件归属错误。
      const inputDirectory = resolve(directory, 'attachment-inputs', run)
      await mkdir(inputDirectory, { recursive: true })
      for (const [extension, content] of [
        ['txt', Buffer.from(attachmentText)],
        ['pdf', await readFile(resolve('../dsh-mobile/artifacts/dshm-pdf-1790183840471.pdf'))],
        ['docx', await readFile(resolve('../dsh-mobile/artifacts/dshm-office-1790187656727.docx'))],
      ] as const) {
        const name = 'dshm-attachment-input-' + run.slice(0, 8) + '.' + extension, path = resolve(inputDirectory, name)
        await writeFile(path, content, { flag: 'wx' }); fixtures.set(path, content)
        attachmentSeed.push({ name, path, extension, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
      }
      report.attachmentFixtures = attachmentSeed
    }
    if (attachmentSending) {
      const inputDirectory = resolve(directory, 'attachment-inputs', run)
      await mkdir(inputDirectory, { recursive: true })
      for (const phase of ['before', 'after']) {
        const content = Buffer.from(['DSHM_ATTACHMENT_SENDING_' + phase + '_' + run,
          ...Array.from({ length: 5001 }, (_, i) => `附件原文 ${i + 1} 中文 🙂 ${run.slice(0, 8)}`)].join('\n') + '\n')
        expect(content.length).toBeGreaterThan(131072)
        const name = 'dshm-attachment-send-' + run.slice(0, 8) + '-' + phase + '.txt', path = resolve(inputDirectory, name)
        await writeFile(path, content, { flag: 'wx' }); fixtures.set(path, content)
        attachmentSeed.push({ name, path, extension: 'txt', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
      }
      report.attachmentFixtures = attachmentSeed
    }
    let fileTransferSeed: { root: string; filename: string; bytes: number; sha256: string } | undefined
    if (fileRecovery || fileSave || fileWriteDeath || fileWriteInterruption) {
      const filename = (fileWriteInterruption ? 'dshm-write-interrupt-' : fileWriteDeath ? 'dshm-write-death-' : fileSave ? 'dshm-save-window-' : 'dshm-interruption-')
        + run.slice(0, 8) + (fileWriteDeath || fileWriteInterruption ? '.bin' : '.txt')
      const line = Buffer.from('DSHM_FILE_INTERRUPTION_' + run + '\n')
      const content = Buffer.alloc(fileWriteDeath || fileWriteInterruption ? 64 * 1024 * 1024 : fileSave ? 256 * 1024 + 5 : 16 * 1024 * 1024)
      for (let offset = 0; offset < content.length; offset += line.length)
        line.copy(content, offset, 0, Math.min(line.length, content.length - offset))
      const path = resolve(workspacePath, filename)
      await writeFile(path, content, { flag: 'wx' }); fixtures.set(path, content)
      fileTransferSeed = { root: workspacePath, filename, bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex') }
      report[fileWriteInterruption ? 'fileWriteInterruptionFixture' : fileWriteDeath ? 'fileWriteDeathFixture' : fileSave ? 'fileSaveFixture' : 'fileRecoveryFixture'] = fileTransferSeed
    }
    let fileSeed: Record<string, any> | undefined
    const officeSeed: { name: string; extension: string; bytes: number; sha256: string }[] = []
    if (office) {
      for (const extension of ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt']) {
        // 复用已有真实 Office 原件的只读副本，不生成伪转换结果或修改官方转换器。
        const content = await readFile(resolve('../dsh-mobile/artifacts', 'dshm-office-1790187656727.' + extension))
        const name = 'dshm-official-' + run.slice(0, 8) + '.' + extension
        const path = resolve(workspacePath, name)
        await writeFile(path, content, { flag: 'wx' })
        fixtures.set(path, content)
        officeSeed.push({ name, extension, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
      }
      report.officeFixtures = officeSeed
    }
    if (files) {
      const filename = 'dshm-official-' + run.slice(0, 8) + '.txt'
      const text = Array.from({ length: 5002 }, (_, index) => `DSHM 文件行 ${index + 1} 🙂 ${run.slice(0, 8)}`).join('\n') + '\n'
      const contents: Record<string, string | Buffer> = {
        [filename]: text,
        'nested/readme.txt': 'DSHM_NESTED_FILE\n',
        'readme.md': '# DSHM 官方文件预览\n\n**Markdown 正文**\n',
        'image.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#376ee7"/></svg>',
        'page.html': '<!doctype html><html><body><h1>DSHM isolated HTML</h1><button onclick="this.textContent=\'COUNT_1\'">COUNT_0</button></body></html>',
        'document.pdf': await readFile(resolve('../dsh-mobile/artifacts/dshm-pdf-1790183840471.pdf')),
      }
      await mkdir(resolve(workspacePath, 'nested'))
      await mkdir(resolve(workspacePath, 'empty'))
      for (const [name, value] of Object.entries(contents)) {
        const path = resolve(workspacePath, name), content = Buffer.from(value)
        await writeFile(path, content, { flag: 'wx' })
        fixtures.set(path, content)
      }
      fileSeed = { root: workspacePath, filename, text, nestedText: contents['nested/readme.txt'],
        bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }
      report.fileFixture = { root: workspacePath, filename, bytes: fileSeed.bytes, sha256: fileSeed.sha256 }
      if (fileDesktop) {
        expect(alpha2 && process.env.DSHM_OFFICIAL_APP_CHECK === '1').toBe(true)
        const path = resolve(workspacePath, filename), windows = officialDesktopWindows(path)
        let changed = false, missing = false
        fileSeed.desktop = {
          ...windows,
          change: async (value: boolean) => {
            expect(missing).toBe(false)
            await writeFile(path, value ? text + 'DSHM_DESKTOP_CHANGED\n' : text)
            changed = value
          },
          missing: async (value: boolean) => {
            expect(changed).toBe(false)
            if (value === missing) return
            await rename(value ? path : path + '.parked', value ? path + '.parked' : path)
            missing = value
          },
        }
        onTestFinished(async () => {
          report.desktopWindowCleanup = await windows.cleanup()
          expect(report.desktopWindowCleanup.ownedExplorerWindows).toBe(0)
          expect(report.desktopWindowCleanup.ownedNotepadWindows).toBe(0)
          if (missing) await rename(path + '.parked', path)
          if (changed) await writeFile(path, text)
        })
      }
    }
    const workspace = await desktopRpc('workspace/create', { request: { path: workspacePath } })
    if (timedPreset) report.timedPreset = await timedPreset.install()
    if (externalPreset) {
      report.scope = 'phone-real-official-acp-external-task-result-and-no-local-child-entry'
      report.externalPreset = await externalPreset.install()
    }
    const created = await desktopRpc('session/create', { request: { workspaceId: workspace.workspace.workspaceId,
      ...(externalPreset ? { agentPreset: externalPreset.id } : timedPreset ? { agentPreset: timedPreset.id } : creatorTask ? { agentPreset: 'cordis' } : {}) } })
    const sessionId = created.sessionId
    sessions.add(sessionId)
    const title = 'DSHM 官方纯插件测试 ' + run.slice(0, 8)
    await desktopRpc('session/rename', { request: { sessionId, title } })
    const catalog = await desktopRpc('session/modelCatalog', {})
    const provider = catalog.groups.find((group: { id: string }) => group.id === 'deepseek-official')
    expect(provider.models.length).toBeGreaterThan(1)
    let workspaceSeed: Record<string, any> | undefined
    if (workspaceManagement) {
      const before = await workspaceBaseline()
      const secondaryPath = resolve(workspacePath, 'registration-test')
      await mkdir(secondaryPath)
      const keepPath = resolve(secondaryPath, 'keep.txt'), keep = Buffer.from('DSHM_WORKSPACE_KEEP_' + run + '\n')
      await writeFile(keepPath, keep, { flag: 'wx' }); fixtures.set(keepPath, keep)
      const secondary = await desktopRpc('workspace/create', { request: { path: secondaryPath } })
      expect(secondary.created).toBe(true)
      managedWorkspace = { id: secondary.workspace.workspaceId, path: keepPath, keep }
      const secondarySession = await desktopRpc('session/create', { request: { workspaceId: managedWorkspace.id } })
      sessions.add(secondarySession.sessionId)
      const secondaryTitle = 'DSHM 注册保留测试 ' + run.slice(0, 8), token = 'DSHM_WORKSPACE_KEPT_' + run
      await desktopRpc('session/rename', { request: { sessionId: secondarySession.sessionId, title: secondaryTitle } })
      await desktopRpc('session/selectModel', { request: { sessionId: secondarySession.sessionId, provider: provider.id, model: provider.models[0].id } })
      await desktopRpc('session/prompt', { request: { sessionId: secondarySession.sessionId, requestId: randomUUID(), mode: 'queue',
        content: [{ type: 'text', text: `这是工作区注册保留测试，只回复 ${token}，不要调用工具。` }] } })
      await expect.poll(async () => (await desktopRpc('session/list', { _request: {} })).items
        .find((item: any) => item.sessionId === secondarySession.sessionId)?.running, { timeout: 180000 }).toBe(false)
      const sessionHistory = async () => {
        const projection = await desktopRpc('session/projections', { request: { sessionId: secondarySession.sessionId } })
        return desktopRpc('session/page', { request: { address: { kind: 'session', sessionId: secondarySession.sessionId },
          throughSeq: projection.asOfSeq, maxMessages: 100 } })
      }
      const records = (await sessionHistory()).records
      expect(JSON.stringify(records)).toContain(token)
      const name = 'DSHM 工作区管理 ' + run.slice(0, 8)
      await desktopRpc('workspace/rename', { request: { workspaceId: managedWorkspace.id, title: name } })
      workspaceSeed = { name, renamed: name + ' 已改名', anchor: workspace.workspace.title, chat: secondaryTitle, token,
        verify: async (phase: string) => {
          const current = await workspaceBaseline(), own = current.items.find((item: any) => item.workspaceId === managedWorkspace!.id)
          expect(current.items.filter((item: any) => item.workspaceId !== managedWorkspace!.id)
            .map((item: any) => ({ id: item.workspaceId, title: item.title, path: item.path })))
            .toEqual(before.items.map((item: any) => ({ id: item.workspaceId, title: item.title, path: item.path })))
          if (phase === 'remove') {
            expect(own).toBeUndefined()
            expect(await readFile(keepPath)).toEqual(keep)
            expect((await sessionHistory()).records).toEqual(records)
            return { registrationAbsent: true, fileUnchanged: true, historyUnchanged: true, otherWorkspacesUnchanged: true }
          }
          expect(own.title).toBe(workspaceSeed!.renamed)
          if (phase === 'before') expect(current.items.findIndex((item: any) => item.workspaceId === own.workspaceId))
            .toBeLessThan(current.items.findIndex((item: any) => item.workspaceId === workspace.workspace.workspaceId))
          if (phase === 'last') expect(current.items.at(-1).workspaceId).toBe(own.workspaceId)
          return { phase, officialProjectionVerified: true, otherWorkspacesUnchanged: true }
        },
      }
    }
    await desktopRpc('session/selectModel', { request: { sessionId, provider: provider.id, model: provider.models[0].id } })
    const marker = 'DSHM_OFFICIAL_DESKTOP_' + run
    await desktopRpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: inference ? `请只回复 ${marker}，不要调用工具。` : marker }] } })
    await expect.poll(async () => (await desktopRpc('session/list', { _request: {} }))
      .items.find((item: { sessionId: string }) => item.sessionId === sessionId)?.running,
      { timeout: inference ? 180000 : 20000 }).toBe(false)
    const readSession = async () => {
      const snapshot = await desktopRpc('session/projections', { request: { sessionId } })
      const history = await desktopRpc('session/page', { request: { address: { kind: 'session', sessionId },
        throughSeq: snapshot.asOfSeq, maxMessages: longHistory ? 500 : 100 } })
      return { snapshot, records: history.records }
    }
    const trackApprovalFixture = async ({ fileName, before, after }: any) => {
      expect(['approval-allow.txt', 'approval-reject.txt']).toContain(fileName)
      const path = resolve(workspacePath, fileName), content = Buffer.from(before)
      expect(await readFile(path)).toEqual(content)
      expect(fixtures.has(path)).toBe(false)
      fixtures.set(path, content)
      approvalFixtureChanges.set(path, after)
    }
    const history = await readSession()
    expect(JSON.stringify(history)).toContain(marker)
    // 无测试模型 Key 时只验证真实消息日志和官方错误，不能记为推理/工具执行通过。
    if (!inference) expect(JSON.stringify(history)).toContain('MISSING_CREDENTIAL')
    const verifyReply = async (token: string) => {
      const current = await readSession()
      const replies = current.records.filter((record: any) => record.event.type === 'assistant/message'
        && (record.event.data.message.content ?? []).filter((part: any) => part.type === 'text')
          .map((part: any) => part.text).join('\n').trim() === token)
      expect(replies).toHaveLength(1)
      expect(replies[0].event.data.message.source.provider).toBe(provider.id)
      expect(current.records.some((record: any) => record.event.type === 'turn/end'
        && record.event.seq > replies[0].event.seq && record.event.data.reason.kind === 'completed')).toBe(true)
      return { assistantSeq: replies[0].event.seq, source: replies[0].event.data.message.source }
    }
    if (inference) {
      report.desktopInference = await verifyReply(marker)
      report.stages.push('official-desktop-real-model-reply')
      await save()
    }
    report.sessionId = sessionId
    report.workspaceId = workspace.workspace.workspaceId
    if (alpha2 && report.desktopPluginVersion === '0.1.80-latest.0') {
      // 只验修正后的候选；旧版本/独立凭据profile仍保留各自历史边界。
      // 普通与管理连接都不能把已移除的旧预设写入转发到官方Host。
      const retired = [
        ['agentPresets/copy', { from: 'standard', id: 'dshm-retired-interface-' + run }],
        ['agentPresets/deletePreset', { id: 'dshm-retired-interface-' + run }],
      ] as const
      const checks = []
      let reader: Awaited<ReturnType<typeof openReplyConnection>> | undefined
      try {
        for (const management of [false, true]) {
          if (management) {
            await manage({ action: 'management', deviceId: claim.deviceId, enabled: true })
            reader = await openReplyConnection()
          }
          const call = management ? reader!.request : result
          const negotiated = await call({ method: 'remote.negotiate', version: 2 })
          expect(negotiated).toMatchObject({ type: 'result', value: { management } })
          for (const [endpoint, args] of retired) {
            expect(negotiated.value.endpoints.calls).not.toContain(endpoint)
            const code = management ? 'remote_operation_denied' : 'management_required'
            expect(await call({ method: 'remote.rpc', endpoint, payload: { args } }))
              .toMatchObject({ type: 'error', code })
            checks.push({ endpoint, management, advertised: false, code })
          }
        }
      } finally {
        reader?.close()
        await manage({ action: 'management', deviceId: claim.deviceId, enabled: false })
      }
      // 收回权限会关闭旧票据连接；核心验收使用重新领取的生产票据继续。
      socket!.close(); frames.length = 0
      const ticketResponse = await api('/v1/device/ticket', claim.token)
      expect(ticketResponse.status).toBe(200)
      const { ticket } = await ticketResponse.json()
      socket = new WebSocket(origin.replace('http:', 'ws:') + '/v1/device/socket')
      socket.on('message', raw => frames.push(JSON.parse(raw.toString())))
      await once(socket, 'open'); socket.send(JSON.stringify({ type: 'authenticate', ticket }))
      await receive(frame => frame.type === 'ready' && frame.hostOnline === true && frame.management === false)
      report.retiredPresetInterfaces = { checks, productionRelayAndInstalledPlugin: true, managementRestored: true }
    }
    const pairingChecks = pairingCheck ? await officialPairingChecks({ manage, db, devices }) : undefined
    if (pairingCheck) report.scope = 'phone-native-qr-image-and-natural-pair-expiry-before-fresh-binding'
    const androidPair = pairingChecks?.expired ?? await manage({ action: 'pair' })
    const deviceForFingerprint = async (fingerprint: string) => {
      const device = (await manage()).devices.find((item: { fingerprint: string }) => item.fingerprint === fingerprint)
      expect(device).toBeTruthy()
      devices.add(device.id)
      return device
    }
    const { verifyOfficialRemoteAndroid } = await import(/* @vite-ignore */ pathToFileURL(
      resolve('../dsh-mobile/tests/support/official-remote-android.mjs')).href)
    const phoneMarker = 'DSHM_OFFICIAL_ANDROID_' + run
    const promptSendingChecks = promptHost ? officialPromptHostChecks({ run, sessionId, rpc: desktopRpc,
      readSession, verifyReply, profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), transport: promptProxy!,
      stopHost: async () => {
        const running = (await desktopRpc('session/list', { _request: {} })).items.filter((row: any) => row.running)
        expect(running.every((row: any) => row.sessionId === sessionId)).toBe(true)
        const stopped = await lifecycle!.stop(); (report.promptHostStops ??= []).push(stopped); await save(); return stopped
      },
      startHost: async () => {
        const started = await restoreOfficialLogin()
        await expect.poll(async () => (await manage()).connection, { timeout: 30000 }).toBe('online')
        const negotiated = await result({ method: 'remote.negotiate', version: 2 })
        expect(negotiated).toMatchObject({ type: 'result', value: { dshVersion: expectedVersion } })
        const value = { ...started, jobControlGeneration: negotiated.value.jobControlGeneration }
        ;(report.promptHostStarts ??= []).push(value); await save(); return value
      },
    }) : promptSending ? officialPromptSendingChecks({ run, sessionId, rpc: desktopRpc,
      readSession, verifyReply, profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), transport: promptProxy!, processExit: promptProcess }) : undefined
    const attachmentSendingChecks = attachmentSending ? officialAttachmentSendingChecks({ sessionId, files: attachmentSeed,
      rpc: desktopRpc, readSession, verifyReply, profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), transport: promptProxy!,
      request, receive, send: frame => socket!.send(JSON.stringify(frame)), adoptSession: id => sessions.add(id),
      workspaceId: workspace.workspace.workspaceId, processExit: attachmentProcess, hostExit: attachmentHost,
      stopHost: attachmentHost ? async () => {
        const running = (await desktopRpc('session/list', { _request: {} })).items.filter((row: any) => row.running)
        expect(running.every((row: any) => row.sessionId === sessionId)).toBe(true)
        const stopped = await lifecycle!.stop(); (report.attachmentHostStops ??= []).push(stopped); await save(); return stopped
      } : undefined,
      startHost: attachmentHost ? async () => {
        const started = await restoreOfficialLogin()
        await expect.poll(async () => (await manage()).connection, { timeout: 30000 }).toBe('online')
        const negotiated = await result({ method: 'remote.negotiate', version: 2 })
        expect(negotiated).toMatchObject({ type: 'result', value: { dshVersion: expectedVersion } })
        const value = { ...started, jobControlGeneration: negotiated.value.jobControlGeneration }
        ;(report.attachmentHostStarts ??= []).push(value); await save(); return value
      } : undefined }) : undefined
    const feedbackChecks = feedback && !feedbackHistory ? officialFeedbackChecks({ run, sessionId, rpc: desktopRpc, readSession,
      profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), collector: feedbackCollector! }) : undefined
    if (feedbackHistory) {
      feedbackHistoryChecks = officialFeedbackHistoryChecks({ run, sessionId, workspacePath, rpc: desktopRpc, readSession,
        profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), collector: feedbackCollector!, archiveState: workspaceBaseline,
        adoptFork: id => { sessions.add(id); forkedSessions.add(id) },
        stopHost: async () => {
          expect((await desktopRpc('session/list', { _request: {} })).items.some((row: any) => row.running)).toBe(false)
          const stopped = await lifecycle!.stop(); (report.feedbackHistoryHostStops ??= []).push(stopped); await save(); return stopped
        },
        startHost: async () => {
          const started = await restoreOfficialLogin({ endpoint: feedbackCollector!.endpoint })
          ;(report.feedbackHistoryHostStarts ??= []).push(started); await save(); return started
        },
      })
      report.feedbackHistoryPrepared = await feedbackHistoryChecks.prepareInherited(marker)
    }
    if (backgroundStopCheck) backgroundStopControl = await officialBackgroundStop({ run, sessionId, readSession, result, jobs,
      profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), generation: negotiation.value.jobControlGeneration,
      transport: jobStopProxy! })
    if (backgroundControlCheck) backgroundControl = await officialBackgroundControl({ run, sessionId,
      readSession, result, generation: negotiation.value.jobControlGeneration, jobs,
      profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), processLifecycle: backgroundProcessCheck })
    if (backgroundHostCheck) backgroundHostControl = await officialBackgroundHost({ run, sessionId, readSession, result, jobs,
      profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), generation: negotiation.value.jobControlGeneration,
      stopHost: async () => {
        const running = (await desktopRpc('session/list', { _request: {} })).items.filter((item: any) => item.running)
        expect(running.every((item: any) => item.sessionId === sessionId)).toBe(true)
        const stopped = await lifecycle!.stop(); (report.hostStops ??= []).push(stopped); await save(); return stopped
      },
      startHost: async () => {
        const started = await restoreOfficialLogin()
        await expect.poll(async () => (await manage()).connection, { timeout: 30000 }).toBe('online')
        const negotiated = await result({ method: 'remote.negotiate', version: 2 })
        expect(negotiated).toMatchObject({ type: 'result', value: { dshVersion: expectedVersion } })
        const evidence = { ...started, jobControlGeneration: negotiated.value.jobControlGeneration }
        ;(report.hostStarts ??= []).push(evidence); await save(); return evidence
      } })
    const childLabel = 'DSHM 官方子会话 ' + run.slice(0, 8)
    if (goals) goalChecks = officialGoalChecks({ rpc: desktopRpc, readSession, verifyReply,
      sessionId, marker: 'DSHM_GOAL_' + run.replaceAll('-', '') })
    if (schedules) scheduleChecks = officialScheduleChecks({ rpc: desktopRpc, readSession, verifyReply,
      sessionId, marker: 'DSHM_SCHEDULE_' + run.replaceAll('-', '') })
    let childAddress: { kind: 'subagent'; parentSessionId: string; childSessionId: string; mode: 'continuable' } | undefined
    const readChild = async () => {
      expect(childAddress).toBeTruthy()
      const parent = await readSession()
      expect(parent.snapshot.values.subagentCatalog.find((entry: any) => entry.id === childAddress!.childSessionId))
        .toMatchObject({ mode: 'continuable', label: childLabel })
      const snapshot = await desktopRpc('session/projections', { request: { sessionId: childAddress!.childSessionId } })
      expect(snapshot.kind).toBe('sequenced')
      const page = await desktopRpc('session/page', { request: { address: childAddress,
        throughSeq: snapshot.asOfSeq, maxMessages: 100 } })
      expect(page.hasMore).toBe(false)
      return { snapshot, records: page.records }
    }
    let navigationMessages: any[] | undefined
    const exportChecks = sessionExport ? await officialSessionExportChecks({ run, sessionId, readSession, readChild,
      childId: () => childAddress!.childSessionId, verifyReply, profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'),
      exportZip: async includeDescendants => {
        const query = new URLSearchParams({ sessionId, includeDescendants: String(includeDescendants) })
        const response = await fetch(hostOrigin + '/api/session.export?' + query, {
          headers: { cookie }, signal: AbortSignal.timeout(60000),
        })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')?.split(';')[0]).toBe('application/zip')
        return Buffer.from(await response.arrayBuffer())
      },
    }) : undefined
    if (modelSettings) deepSeekModelChecks = officialDeepSeekModelChecks({ rpc: desktopRpc,
      profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), readSession, marker: 'DSHM 手机模型 ' + run.slice(0, 8) })
    if (presetSettings) presetChecks = officialPresetChecks({ rpc: desktopRpc,
      profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), readSession, sessionId, workspacePath, sessions })
    if (presetCreator) presetCreatorChecks = officialPresetCreatorChecks({ rpc: desktopRpc,
      profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), readSession, sessionId, workspacePath, sessions })
    if (creatorTask) creatorTaskChecks = officialCreatorTaskChecks({ readSession,
      profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml') })
    if (ptc) {
      report.scope = 'phone-ptc-real-nested-command-result-and-stop'
      ptcChecks = officialPtcChecks({ rpc: desktopRpc, readParent: readSession, sessions, workspacePath,
        profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), provider: provider.id })
    }
    if (skills) {
      report.scope = 'phone-skill-catalog-source-and-real-manual-invocation'
      skillChecks = officialSkillChecks({ rpc: desktopRpc, readSession, sessionId, provider: provider.id,
        profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), fixture: report.skillFixture })
    }
    if (references) {
      report.scope = 'phone-file-and-chat-reference-at-menu-and-structured-reconnect'
      referenceChecks = await officialReferenceChecks({ rpc: desktopRpc, readSession, sessionId,
        workspaceId: workspace.workspace.workspaceId, workspacePath, provider: provider.id, model: provider.models[0].id,
        run, sessions, fixtures, profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml') })
    }
    if (pluginUpgrade || pluginLayout || pluginInterruption || pluginScripts || pluginApplying) pluginUpgradeChecks = officialPluginUpgradeChecks({ readSession,
      bundles: () => desktopRpc('pluginManager/listBundles', {}), profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml') })
    if (providerManagement) {
      expect(negotiation.value.providerModelProbe).toBe(false)
      providerChecks = await officialProviderChecks({ rpc: desktopRpc,
        profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), readSession,
        modelProbeAvailable: negotiation.value.providerModelProbe })
    }
    if (providerKeys) {
      expect(negotiation.value.providerModelProbe).toBe(false)
      providerKeyChecks = await officialProviderKeyChecks({ rpc: desktopRpc,
        profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), readSession })
    }
    if (endpointWrites) endpointChecks = await officialEndpointChecks({ rpc: desktopRpc,
      profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml'), readSession, policy: endpointPolicy,
      guard: async route => {
        await manage({ action: 'management', deviceId: claim.deviceId, enabled: true })
        let reader: Awaited<ReturnType<typeof openReplyConnection>> | undefined
        try {
          reader = await openReplyConnection()
          const caps = await reader.request({ method: 'remote.negotiate', version: 2 })
          expect(caps).toMatchObject({ type: 'result', value: { management: true, providerEndpointResetPolicy: true } })
          for (const resetPolicy of [undefined, true]) {
            const read = await reader.request({ method: 'remote.endpointRead', target: { provider: route },
              ...(resetPolicy ? { resetPolicy } : {}) })
            expect(read.type).toBe('result')
            if (resetPolicy) expect(read.value.resettable).toBe(false)
            else expect(read.value).not.toHaveProperty('resettable')
            const view = read.value
            const write = await reader.request({ method: 'remote.endpointWrite', target: { provider: route },
              ...(resetPolicy ? { resetPolicy } : {}), snapshot: view.snapshot, expectedRevision: view.revision,
              confirmed: true, change: { op: 'unset' } })
            expect(write).toMatchObject({ type: 'error', code: 'remote_endpoint_reset_unavailable' })
          }
          return { oldClientRefused: true, negotiatedClientRefused: true, code: 'remote_endpoint_reset_unavailable' }
        } finally {
          reader?.close(); await manage({ action: 'management', deviceId: claim.deviceId, enabled: false })
        }
      } })
    let endpointReader: Awaited<ReturnType<typeof openReplyConnection>> | undefined
    let competingWrite: Promise<any> | undefined, competingView: any, raceTarget: any, competingDestination: string
    const endpointRaceControl = endpointRace ? {
      verify: endpointChecks!.verify,
      arm: async (target: any, phoneDestination: string, otherDestination: string) => {
        if (!endpointReader) {
          await manage({ action: 'management', deviceId: claim.deviceId, enabled: true })
          endpointReader = await openReplyConnection()
          expect(await endpointReader.request({ method: 'remote.negotiate', version: 2 }))
            .toMatchObject({ type: 'result', value: { management: true, providerEndpointResetPolicy: true } })
        }
        raceTarget = target; competingDestination = otherDestination
        const reply = await endpointReader.request({ method: 'remote.endpointRead', ...(target ? { target } : {}),
          ...(typeof target === 'object' ? { resetPolicy: true } : {}) })
        expect(reply.type).toBe('result'); competingView = reply.value
        endpointProxy!.raceArm({ target, destinations: [phoneDestination, otherDestination] })
        return { revision: competingView.revision, clientId: endpointReader.summary.clientId }
      },
      compete: async (phoneDestination: string, otherDestination: string, order: string) => {
        competingWrite = endpointReader!.request({ method: 'remote.endpointWrite', ...(raceTarget ? { target: raceTarget } : {}),
          ...(typeof raceTarget === 'object' ? { resetPolicy: true } : {}), snapshot: competingView.snapshot,
          expectedRevision: competingView.revision, confirmed: true, change: { op: 'set', value: competingDestination } })
        // 先装错误处理，再等外部闸门收到两份真实报文，避免失败收尾时未处理的 Promise。
        void competingWrite.catch(() => {})
        const settled = await endpointProxy!.raceRelease(order === 'phone-first' ? phoneDestination : otherDestination)
        const other = await competingWrite
        expect(settled.receipts.find(frame => frame.id === other.id)).toEqual(other)
        expect(settled.receipts.filter(frame => frame.type === 'result')).toHaveLength(1)
        expect(settled.receipts.filter(frame => frame.type === 'error'))
          .toEqual([expect.objectContaining({ code: 'remote_endpoint_stale' })])
        expect(settled.writes.every(write => write.operation.expectedRevision === competingView.revision)).toBe(true)
        return settled
      },
      writes: async () => endpointProxy!.writes(),
      close: async () => {
        endpointReader?.close(); endpointReader = undefined
        await manage({ action: 'management', deviceId: claim.deviceId, enabled: false })
      },
    } : undefined
    let credentialBaseline: { configured: boolean; writable: boolean; endpoint: any; profileHash: string; records: any[] } | undefined
    const credentialView = async () => {
      const view = await settingsView('llm-deepseek')
      const ref = view.value.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
      expect(ref).toBe('DEEPSEEK_API_KEY')
      // 公共 describe 仅返回配置/可写状态；不调用 resolve 或读取凭据文件。
      const info = (await desktopRpc('credentials/describe', { refs: [ref] }))[ref]
      expect(info.configured).toBe(true)
      expect(info.writable).toBe(true)
      // 此隔离实例使用官方默认站点；若投影与已核验的默认值不同，直接失败。
      const endpoint = { origin: new URL(view.value.baseURL ?? 'https://api.deepseek.com/anthropic').origin,
        protocol: 'messages', revision: view.revision, overridden: Object.hasOwn(view.user ?? {}, 'baseURL') }
      const profileHash = createHash('sha256').update(await readFile(resolve(root, 'home/profiles/web/cordis.patch.yml'))).digest('hex')
      return { configured: info.configured, writable: info.writable, endpoint, profileHash,
        records: (await readSession()).records }
    }
    report.android = await verifyOfficialRemoteAndroid({ origin, pairLink: androidPair.link, title, marker,
      pairing: pairingChecks,
      evidence: resolve('../dsh-mobile/artifacts/official-plugin-only', run),
      nextModel: provider.models[1], workspaceTitle: workspace.workspace.title,
      approve: async (fingerprint: string) => {
        const device = await deviceForFingerprint(fingerprint)
        expect(device.status).toBe('pending')
        await manage({ action: 'approve', deviceId: device.id })
      },
      revoke: async (fingerprint: string) => {
        const device = await deviceForFingerprint(fingerprint)
        if (device.management) await manage({ action: 'management', deviceId: device.id, enabled: false })
        await manage({ action: 'revoke', deviceId: device.id })
      },
      plugins: plugins ? {
        packageName: ownBundle,
        spec: pluginLayout ? report.pluginLayoutFixture.spec : resolve('../dsh-mobile/artifacts/official-plugin-fixtures/dsh-mobile-panel-ui-verification-0.0.5.tgz'),
        layout: pluginLayout ? { prepare: pluginUpgradeChecks!.prepare, unchanged: pluginUpgradeChecks!.unchanged,
          disconnect: async () => { await manage({ action: 'disable' }) },
          reconnect: async () => {
            await manage({ action: 'enable' })
            await expect.poll(async () => (await manage()).connection, { timeout: 15000 }).toBe('online')
          } } : undefined,
        management: async (fingerprint: string, enabled: boolean) => {
          const device = await deviceForFingerprint(fingerprint)
          await manage({ action: 'management', deviceId: device.id, enabled })
          expect((await deviceForFingerprint(fingerprint)).management).toBe(enabled)
        },
        removing: () => { phonePluginRemovalRequested = true },
        removed: () => { phonePluginRemovalRequested = false },
        scripts: pluginScripts ? { specs: pluginScriptControl!.specs, versions: pluginScriptControl!.versions,
          blocked: pluginScriptControl!.blocked, started: pluginScriptControl!.started,
          finish: pluginScriptControl!.finish, settled: pluginScriptControl!.settled, restorePolicy: pluginScriptControl!.restorePolicy,
          prepare: pluginUpgradeChecks!.prepare, unchanged: pluginUpgradeChecks!.unchanged } : undefined,
        applying: pluginApplying ? { specs: pluginApplyingControl!.specs, versions: pluginApplyingControl!.versions, names: pluginApplyingControl!.names,
          automaticInstall: pluginAutoApplying, requestIds: pluginApplyingControl!.requestIds, title: pluginApplyingControl!.title,
          started: pluginApplyingControl!.started, finish: pluginApplyingControl!.finish,
          settled: pluginApplyingControl!.settled, policyUnchanged: pluginApplyingControl!.policyUnchanged,
          prepare: pluginUpgradeChecks!.prepare, unchanged: pluginUpgradeChecks!.unchanged,
          verify: async (mode: 'finish' | 'host' | 'controller', present: boolean) => {
            const name = pluginApplyingControl!.names[mode]
            if (!present) await expect.poll(async () => (await desktopRpc('pluginManager/listBundles', {}))
              .some((item: any) => item.name === name), { timeout: 120000 }).toBe(false)
            const bundle = (await desktopRpc('pluginManager/listBundles', {})).find((item: any) => item.name === name)
            expect(!!bundle).toBe(present)
            if (bundle) {
              expect(bundle.version).toBe(pluginApplyingControl!.versions[mode]); expect(bundle.installed).toBe(true)
              expect(bundle.source).toContain(`${run}/${mode}.tgz`)
            }
            return { officialInventoryVerified: true, packageName: name, present, version: bundle?.version, enabled: bundle?.enabled }
          },
          restart: async () => {
            const stopped = await lifecycle!.stop(), prior = await pluginApplyingControl!.prepareRestart()
            const started = await restoreOfficialLogin()
            await expect.poll(async () => (await manage()).connection, { timeout: 30000 }).toBe('online')
            pluginUpgradeChecks!.noteRestart()
            return { stopped, prior, started }
          } } : undefined,
        interruption: pluginInterruption ? { urls: pluginDownload!.urls,
          started: pluginDownload!.started, settled: pluginDownload!.settled,
          prepare: pluginUpgradeChecks!.prepare, unchanged: pluginUpgradeChecks!.unchanged,
          restart: async () => {
            const stopped = await lifecycle!.stop(), started = await restoreOfficialLogin()
            await expect.poll(async () => (await manage()).connection, { timeout: 30000 }).toBe('online')
            pluginUpgradeChecks!.noteRestart()
            return { stopped, started }
          } } : undefined,
        upgrade: pluginUpgrade ? { ...report.pluginUpgradeFixture, prepare: pluginUpgradeChecks!.prepare,
          unchanged: pluginUpgradeChecks!.unchanged, restart: async () => {
            const stopped = await lifecycle!.stop(), started = await restoreOfficialLogin()
            await expect.poll(async () => (await manage()).connection, { timeout: 30000 }).toBe('online')
            pluginUpgradeChecks!.noteRestart()
            return { stopped, started }
          } } : undefined,
        verify: async (present: boolean, version = pluginLayout ? '0.0.12' : '0.0.5') => {
          const started = Date.now()
          if (!present) await waitBundleAbsent()
          const bundle = (await desktopRpc('pluginManager/listBundles', {})).find((item: any) => item.name === ownBundle)
          expect(!!bundle).toBe(present)
          if (bundle) {
            expect(bundle.version).toBe(version)
            expect(bundle.installed).toBe(true)
            expect(bundle.source).toContain(pluginApplying && version !== '0.0.5' ? `${run}/` : 'official-plugin-fixtures')
          }
          return { officialInventoryVerified: true, present, version: bundle?.version,
            settlementWaitMs: Date.now() - started }
        },
      } : undefined,
      workspaceManagement: workspaceManagement ? {
        ...workspaceSeed,
        management: async (fingerprint: string, enabled: boolean) => {
          const device = await deviceForFingerprint(fingerprint)
          await manage({ action: 'management', deviceId: device.id, enabled })
          expect((await deviceForFingerprint(fingerprint)).management).toBe(enabled)
        },
      } : undefined,
      settings: settings ? {
        presets: presetSettings ? { verify: presetChecks!.verify } : undefined,
        presetCreator: presetCreator ? { verify: presetCreatorChecks!.verify } : undefined,
        endpointProcess: endpointProcess ? { verify: endpointChecks!.verify,
          arm: async (value: Parameters<NonNullable<typeof endpointProxy>['arm']>[0]) => endpointProxy!.arm({ ...value, holdUntilClientCloses: true }),
          held: async () => endpointProxy!.held(), cut: async () => endpointProxy!.cut(),
          resume: async () => endpointProxy!.resume(), writes: async () => endpointProxy!.writes() } : undefined,
        endpointRace: endpointRaceControl,
        endpointInterruption: endpointInterruption ? { verify: endpointChecks!.verify,
          arm: async (value: Parameters<NonNullable<typeof endpointProxy>['arm']>[0]) => endpointProxy!.arm(value),
          cut: async () => endpointProxy!.cut(), resume: async () => endpointProxy!.resume(),
          writes: async () => endpointProxy!.writes() } : undefined,
        endpoints: endpointWrites && !endpointInterruption && !endpointRace && !endpointProcess ? { verify: endpointChecks!.verify, policy: endpointPolicy } : undefined,
        providerKeys: providerKeys ? { verify: providerKeyChecks!.verify } : undefined,
        providers: providerManagement ? { verify: providerChecks!.verify } : undefined,
        models: modelSettings ? { verify: deepSeekModelChecks!.verify } : undefined,
        credentials: credentialEndpoints ? {
          verify: async (phase: string, phoneView: any) => {
            const current = await credentialView()
            expect(phoneView.key).toEqual({ configured: current.configured, writable: current.writable })
            expect(phoneView.endpoint).toEqual(current.endpoint)
            if (phase === 'initial') credentialBaseline = current
            else expect(current).toEqual(credentialBaseline)
            return { phase, keyStatus: phoneView.key, endpoint: current.endpoint,
              publicProjectionVerified: true, profileUnchanged: phase !== 'initial',
              historyUnchanged: phase !== 'initial', credentialContentsRead: false }
          },
        } : undefined,
        management: async (fingerprint: string, enabled: boolean) => {
          const device = await deviceForFingerprint(fingerprint)
          await manage({ action: 'management', deviceId: device.id, enabled })
          expect((await deviceForFingerprint(fingerprint)).management).toBe(enabled)
        },
        verify: async (phase: string, phoneView: any) => {
          expect(phoneView.documentId).toBeTypeOf('string')
          const view = await settingsView(phoneView.documentId), fields = projectSettings(view)
          expect(phoneView.fields).toEqual(fields)
          if (phase === 'initial') {
            const field = fields.find(item => item.key === 'streamIdleTimeoutMs')!
            expect(Number.isSafeInteger(field.value)).toBe(true)
            if (field.overridden) expect(view.user.streamIdleTimeoutMs).toBe(field.value)
            settingsBackup = { documentId: phoneView.documentId, fields, original: field.value, overridden: field.overridden,
              changed: field.value <= 2147482647 ? field.value + 1000 : field.value - 1000 }
            report.settingsOriginal = fields
            return { original: settingsBackup.original, changed: settingsBackup.changed, overridden: settingsBackup.overridden }
          }
          const expected = settingsBackup!.fields.map(field => phase === 'change' && field.key === 'streamIdleTimeoutMs'
            ? { ...field, value: settingsBackup!.changed, overridden: true } : field)
          expect(fields).toEqual(expected)
          return { officialProjectionVerified: true, fields, inheritanceRestored: phase === 'restore' }
        },
      } : undefined,
      navigation: navigation ? {
        search: async (query: string) => {
          expect(query).toBe(phoneMarker)
          const found = await desktopRpc('session/search', { request: { query } })
          const match = found.items.filter((item: any) => item.sessionId === sessionId)
          expect(match).toHaveLength(1)
          expect(match[0].snippet).toContain(phoneMarker)
          return { officialContentSearchVerified: true, snippet: match[0].snippet }
        },
        verify: async ({ phase, selected, title: expectedTitle }: any) => {
          const current = await readSession()
          const messages = current.records.filter((record: any) => ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(record.event.type))
          if (phase === 'initial') navigationMessages = messages
          else expect(messages).toEqual(navigationMessages)
          if (phase === 'renamed' || phase === 'restored') {
            expect(selected).toBe(sessionId)
            expect(current.snapshot.values.title).toBe(expectedTitle)
            const event = current.records.findLast((record: any) => record.event.type === 'session/title')
            expect(event.event.data.source.kind).toBe('user')
          }
          if (phase === 'forked') {
            expect(selected).not.toBe(sessionId)
            // 子身份来自真实手机公开快照，先核对官方父身份，再纳入本轮清理。
            const rows = await desktopRpc('session/list', { _request: {} })
            const fork = rows.items.find((item: any) => item.sessionId === selected)
            expect(fork).toMatchObject({ parentSessionId: sessionId, cwd: workspacePath, running: false })
            sessions.add(selected); forkedSessions.add(selected)
            const snapshot = await desktopRpc('session/projections', { request: { sessionId: selected } })
            expect(snapshot.values.title).toBe(expectedTitle)
            const history = await desktopRpc('session/page', { request: { address: { kind: 'session', sessionId: selected },
              throughSeq: snapshot.asOfSeq, maxMessages: 100 } })
            expect(history.records.filter((record: any) => ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(record.event.type))
              .map((record: any) => record.event)).toEqual(messages.map((record: any) => record.event))
          }
          if (phase === 'archived' || phase === 'unarchived') {
            expect(forkedSessions.has(selected)).toBe(true)
            expect((await workspaceBaseline()).archivedSessionIds.includes(selected)).toBe(phase === 'archived')
          }
          return { officialStateVerified: true, originalMessagesUnchanged: true, phase }
        },
      } : undefined,
      verifyModel: async () => {
        await expect.poll(async () => (await desktopRpc('session/projections', { request: { sessionId } }))
          .values.modelSelection.next.model).toBe(provider.models[1].id)
      },
      phoneMarker, phonePrompt: inference ? `请只回复 ${phoneMarker}，不要调用工具。` : phoneMarker,
      inference: inference ? {
        workspacePath,
        verifyApprovals: !skills && !ptc && !attachmentSending && !promptSending && !feedback && !schedules && !workflows && !goals && !subagents && !extensions && !background && !files && !plugins && !office && !workspaceManagement && !settings && !queue && !navigation && !approvalRecovery && !questionProcess && !timedQuestion && !planReview && !interactionHost && !interactionRace && !interactionSending && !notifications && !fileRecovery && !fileSave && !attachments && !fileWriteDeath && !fileWriteInterruption,
        verifyReply,
        ptc: ptcChecks ? { ...ptcChecks, marker: 'DSHM_PTC_' + run.replaceAll('-', '') } : undefined,
        skills: skillChecks,
        references: referenceChecks,
        externalChild: externalChild ? officialExternalChecks({ rpc: desktopRpc, readSession, sessionId,
          marker: 'DSHM_EXTERNAL_' + run.replaceAll('-', '') }) : undefined,
        longHistory: longHistory ? officialLongHistoryChecks({ run, sessionId, provider: provider.id,
          rpc: desktopRpc, readSession }) : undefined,
        historyInflight: historyInflight ? await officialHistoryInflightChecks({ rpc: desktopRpc,
          transport: historyProxy!, readCurrent: readSession }) : undefined,
        goals: goalChecks,
        sessionExport: exportChecks,
        feedback: feedbackChecks,
        feedbackHistory: feedbackHistoryChecks,
        promptSending: promptSendingChecks,
        attachmentSending: attachmentSendingChecks,
        schedules: scheduleChecks,
        workflows: workflows ? {
          marker: 'DSHM_WORKFLOW_' + run.replaceAll('-', ''), sessionId, history: readSession,
          initial: async () => {
            await desktopRpc('commands/execute', { agentId: sessionId,
              line: '/permission read-only', submittedAttachments: [] })
            expect((await readSession()).snapshot.values.permissions.currentValue).toBe('read-only')
          },
          child: async (target: any, completedMarker?: string) => {
            expect(target).toMatchObject({ parentSessionId: sessionId, mode: 'continuable' })
            const parent = await readSession()
            expect(parent.records.some((row: any) => row.event.type === 'tool-workflow/agent-start'
              && row.event.data.childId === target.childSessionId && row.event.data.label === '手机核对成员')).toBe(true)
            const readChild = async () => {
              const snapshot = await desktopRpc('session/projections', { request: { sessionId: target.childSessionId } })
              expect(snapshot.values.subagent.mode).toBe(target.mode)
              return desktopRpc('session/page', { request: { address: { kind: 'subagent', ...target },
                throughSeq: snapshot.asOfSeq, maxMessages: 100 } })
            }
            if (completedMarker) await expect.poll(async () => {
              const records = (await readChild()).records
              const reply = records.find((row: any) => row.event.type === 'assistant/message'
                && row.event.data.message.content.some((part: any) => part.type === 'text' && part.text.includes(completedMarker)))
              return !!reply && records.some((row: any) => row.event.type === 'turn/end'
                && row.event.seq > reply.event.seq && row.event.data.reason.kind === 'completed')
            }, { timeout: 180000 }).toBe(true)
            const child = await readChild()
            expect(child.records.some((row: any) => row.event.type === 'user/message')).toBe(true)
            if (completedMarker) {
              // 原DSH也以user/message记录指令、环境、技能及时间上下文；只统计实际任务消息。
              expect(child.records.filter((row: any) => row.event.type === 'user/message'
                && row.event.data.source.kind === 'user')).toHaveLength(1)
              expect(child.records.filter((row: any) => row.event.type === 'tool/call')).toHaveLength(0)
              expect(child.records.filter((row: any) => row.event.type === 'assistant/message'
                && row.event.data.message.source.provider === provider.id
                && row.event.data.message.content.some((part: any) => part.type === 'text' && part.text.includes(completedMarker)))).toHaveLength(1)
            }
            return { address: target, officialChildRecords: child.records.length, officialIdentityVerified: true,
              completedReplyVerified: !!completedMarker }
          },
          verify: async ({ phase, nodes, beforeSeq, script, member, other }: any) => {
            const current = await readSession(), added = current.records.filter((row: any) => row.event.seq > beforeSeq)
            const calls = added.filter((row: any) => row.event.type === 'tool/call')
            expect(calls).toHaveLength(1)
            expect(calls[0].event.data.name).toBe('workflow')
            const args = JSON.parse(calls[0].event.data.arguments)
            expect(args.script).toBe(script)
            expect(args.meta).toEqual({ name: 'DSHM_WORKFLOW_' + run.replaceAll('-', ''), description: '只读手机工作流验证' })
            expect([false, undefined]).toContain(args.run_in_background)
            const starts = added.filter((row: any) => row.event.type === 'tool-workflow/run-start')
            expect(starts).toHaveLength(1)
            expect(nodes).toHaveLength(1)
            expect(nodes[0].name).toBe(args.meta.name)
            const started = added.filter((row: any) => row.event.type === 'tool-workflow/agent-start')
            expect(new Set(started.map((row: any) => row.event.data.childId)).size).toBe(started.length)
            for (const row of started) expect(row.event.data.runId).toBe(starts[0].event.data.runId)
            const members = nodes[0].phases.flatMap((item: any) => item.members)
            for (const item of members) expect(started.some((row: any) => row.event.data.childId === item.childId
              && row.event.data.seq === item.seq && row.event.data.label === item.label)).toBe(true)
            if (phase === 'completed') {
              expect(started).toHaveLength(2)
              const ended = added.filter((row: any) => row.event.type === 'tool-workflow/agent-end')
              expect(ended).toHaveLength(2)
              expect(ended.every((row: any) => row.event.data.outcome === 'completed')).toBe(true)
              const finish = added.filter((row: any) => row.event.type === 'tool-workflow/run-end')
              expect(finish).toHaveLength(1); expect(finish[0].event.data.stopReason).toBe('completed')
              const results = added.filter((row: any) => row.event.type === 'tool/result'
                && row.event.data.message.toolCallId === calls[0].event.data.callId)
              expect(results).toHaveLength(1); expect(results[0].event.data.message.isError).toBe(false)
              expect(JSON.stringify(results[0].event.data.message.content)).toContain(member)
              expect(JSON.stringify(results[0].event.data.message.content)).toContain(other)
              expect(nodes[0].status).toBe('completed'); expect(members).toHaveLength(2)
              expect(members.every((item: any) => item.status === 'completed')).toBe(true)
              // 回复可先于最终turn/end到达；等待原日志结算，不把渲染完成当作执行结束。
              await expect.poll(async () => (await readSession()).records.some((row: any) =>
                row.event.type === 'turn/end' && row.event.seq > beforeSeq
                && row.event.data.reason.kind === 'completed'), { timeout: 20000 }).toBe(true)
              await verifyReply(args.meta.name)
            } else expect(nodes[0].status).toBe('running')
            return { nodes, callId: calls[0].event.data.callId, runId: starts[0].event.data.runId,
              publicOriginalEventsVerified: true, members: members.length }
          },
        } : undefined,
        subagents: subagents ? {
          label: childLabel, parentId: sessionId, marker: 'DSHM_CHILD_' + run.replaceAll('-', ''),
          stop: childStop ? officialChildStopChecks({ readChild, readParent: readSession,
            profilePath: resolve(root, 'home/profiles/web/cordis.patch.yml') }) : undefined,
          before: async () => {
            if (childStop) {
              await desktopRpc('commands/execute', { agentId: sessionId,
                line: '/permission read-only', submittedAttachments: [] })
              expect((await readSession()).snapshot.values.permissions.currentValue).toBe('read-only')
            }
            return (await readSession()).snapshot.asOfSeq
          },
          created: async (initialSeq: number, reply: string) => {
            await expect.poll(async () => (await readSession()).snapshot.values.subagentCatalog
              .filter((entry: any) => entry.label === childLabel).length, { timeout: 180000 }).toBe(1)
            const parent = await readSession()
            const entry = parent.snapshot.values.subagentCatalog.find((item: any) => item.label === childLabel)
            expect(entry.mode).toBe('continuable')
            childAddress = { kind: 'subagent', parentSessionId: sessionId, childSessionId: entry.id, mode: 'continuable' }
            testChildren.set(entry.id, sessionId)
            const calls = parent.records.filter((row: any) => row.event.seq > initialSeq && row.event.type === 'tool/call')
            expect(calls).toHaveLength(1)
            expect(calls[0].event.data.name).toBe('subagent')
            const args = JSON.parse(calls[0].event.data.arguments)
            expect(args.description).toBe(childLabel)
            expect(Object.hasOwn(args, 'run_in_background')).toBe(false)
            await expect.poll(async () => (await readChild()).records.some((row: any) =>
              row.event.type === 'assistant/message' && JSON.stringify(row.event.data.message.content).includes(reply)),
            { timeout: 180000 }).toBe(true)
            await expect.poll(async () => (await readChild()).records.at(-1)?.event.type,
              { timeout: 20000 }).toBe('turn/end')
            const child = await readChild()
            expect(child.records.filter((row: any) => row.event.type === 'tool/call')
              .every((row: any) => row.event.data.name === 'send_message')).toBe(true)
            expect(child.records.filter((row: any) => row.event.type === 'tool/result')
              .every((row: any) => row.event.data.message.isError !== true)).toBe(true)
            return { address: childAddress, callId: calls[0].event.data.callId, initialSeq: child.snapshot.asOfSeq }
          },
          read: readChild,
          verifyContinuation: async (initialSeq: number, prompt: string, reply: string) => {
            const current = await readChild(), rows = current.records.filter((row: any) => row.event.seq > initialSeq)
            const users = rows.filter((row: any) => row.event.type === 'user/message'
              && row.event.data.content.some((part: any) => part.type === 'text' && part.text === prompt))
            expect(users).toHaveLength(1)
            expect(rows.some((row: any) => row.event.type === 'assistant/message'
              && JSON.stringify(row.event.data.message.content).includes(reply))).toBe(true)
            expect(rows.some((row: any) => row.event.type === 'turn/end' && row.event.data.reason.kind === 'completed')).toBe(true)
            expect(rows.filter((row: any) => row.event.type === 'tool/call')).toHaveLength(0)
            return { userSeq: users[0].event.seq, asOfSeq: current.snapshot.asOfSeq, officialResultVerified: true }
          },
          parent: readSession,
          parentSettled: async (reply: string) => {
            await expect.poll(async () => {
              const current = await readSession()
              return current.records.at(-1)?.event.type === 'turn/end' && current.records.some((row: any) =>
                row.event.type === 'user/message' && row.event.data.source?.kind === 'subagent-settled'
                && row.event.data.source.senderSessionId === childAddress!.childSessionId
                && JSON.stringify(row.event.data.content).includes(reply))
            }, { timeout: 180000 }).toBe(true)
            return readSession()
          },
        } : undefined,
        attachments: attachments ? {
          files: attachmentSeed, text: attachmentText, marker: attachmentMarker, sessionId,
          source: async (name: string) => {
            const file = attachmentSeed.find(item => item.name === name)!
            expect(file).toBeTruthy()
            const content = await readFile(file.path)
            expect(content.equals(fixtures.get(file.path)!)).toBe(true)
            return content
          },
          verifySent: async (prompt: string) => {
            await expect.poll(async () => (await desktopRpc('session/list', { _request: {} })).items
              .find((item: any) => item.sessionId === sessionId)?.running, { timeout: 180000 }).toBe(false)
            const reply = await verifyReply(attachmentMarker), current = await readSession()
            const sent = current.records.filter((item: any) => item.event.type === 'user/message'
              && item.event.data.content.some((part: any) => part.type === 'text' && part.text === prompt))
            expect(sent).toHaveLength(1)
            const refs = sent[0].event.data.content.filter((part: any) => part.type === 'file').map((part: any) => part.attachment)
            expect(refs).toHaveLength(attachmentSeed.length)
            expect(new Set(refs.map((ref: any) => ref.attachmentId)).size).toBe(refs.length)
            const sources = []
            for (const file of attachmentSeed) {
              const ref = refs.find((value: any) => value.name === file.name)
              expect(ref).toMatchObject({ name: file.name, bytes: file.bytes })
              const id = request({ method: 'remote.attachment', sessionId, kind: 'file', name: ref.name, attachmentId: ref.attachmentId })
              let metadata = false, offset = 0, chunks = 0; const parts: Buffer[] = []
              try {
                for (;;) {
                  const frame = await receive(item => item.id === id)
                  if (frame.type === 'end') break
                  expect(frame.type, JSON.stringify(frame)).toBe('event')
                  if (frame.value.type === 'metadata') {
                    expect(metadata).toBe(false); expect(frame.value.attachment).toEqual(ref); metadata = true
                  } else {
                    expect(metadata).toBe(true); expect(frame.value).toMatchObject({ type: 'chunk', offset })
                    const bytes = Buffer.from(frame.value.data, 'base64')
                    expect(bytes.toString('base64')).toBe(frame.value.data)
                    expect(bytes.length).toBeGreaterThan(0); expect(bytes.length).toBeLessThanOrEqual(65536)
                    parts.push(bytes); offset += bytes.length; chunks++
                    socket!.send(JSON.stringify({ type: 'ack', id, count: 1 }))
                  }
                }
                expect(metadata).toBe(true); expect(offset).toBe(file.bytes)
                expect(Buffer.concat(parts).equals(fixtures.get(file.path)!)).toBe(true)
              } finally { socket!.send(JSON.stringify({ type: 'cancel', id })) }
              // 真实新空会话不含该引用；不能只凭附件ID跨会话读取。
              const other = await desktopRpc('session/create', { request: { workspaceId: workspace.workspace.workspaceId } })
              sessions.add(other.sessionId)
              expect(await result({ method: 'remote.attachment', sessionId: other.sessionId, kind: 'file', name: ref.name,
                attachmentId: ref.attachmentId })).toMatchObject({ type: 'error', code: 'remote_attachment_not_referenced' })
              sources.push({ ...file, attachmentId: ref.attachmentId, chunks, originalBytesVerified: true, wrongSessionDenied: true })
            }
            return { userSeq: sent[0].event.seq, uniqueUserMessage: true, reply, sources }
          },
        } : undefined,
        fileRecovery: fileRecovery ? {
          ...fileTransferSeed,
          verifySource: async () => {
            const path = resolve(workspacePath, fileTransferSeed!.filename), expected = fixtures.get(path)!
            const actual = await readFile(path)
            expect(actual.equals(expected)).toBe(true)
            return { bytes: actual.length, sha256: createHash('sha256').update(actual).digest('hex') }
          },
          changeSource: async () => {
            const path = resolve(workspacePath, fileTransferSeed!.filename), before = fixtures.get(path)!
            expect(before.length).toBe(fileTransferSeed!.bytes)
            expect((await readFile(path)).equals(before)).toBe(true)
            // 只改变自己创建的原件；尺寸变化不依赖官方同大小mtime监听的未保证行为。
            const next = Buffer.concat([before, Buffer.from('\nDSHM_LATEST_VERSION_' + run + '\n')])
            await writeFile(path, next); fixtures.set(path, next)
            expect((await readFile(path)).equals(next)).toBe(true)
            return { bytes: next.length, sha256: createHash('sha256').update(next).digest('hex') }
          },
        } : undefined,
        ...(fileWriteDeath || fileWriteInterruption ? { [fileWriteDeath ? 'fileWriteDeath' : 'fileWriteInterruption']: {
          ...fileTransferSeed,
          revocationOnly: fileWriteRevocation,
          verifySource: async (bytes = fileTransferSeed!.bytes, sha256 = fileTransferSeed!.sha256) => {
            expect(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= fileTransferSeed!.bytes).toBe(true)
            const path = resolve(workspacePath, fileTransferSeed!.filename), expected = fixtures.get(path)!
            expect((await readFile(path)).equals(expected)).toBe(true)
            expect(createHash('sha256').update(expected.subarray(0, bytes)).digest('hex')).toBe(sha256)
            return { bytes, sha256 }
          },
          historyDigest: async () => {
            const current = await readSession()
            expect((await desktopRpc('session/list', { _request: {} })).items
              .find((item: any) => item.sessionId === sessionId)?.running).toBe(false)
            return { records: current.records.length,
              sha256: createHash('sha256').update(JSON.stringify(current.records)).digest('hex') }
          },
          hostOffline: async () => {
            await expect.poll(async () => (await result({ method: 'remote.negotiate', version: 2 }))
              .code, { timeout: 15000 }).toBe('host_offline')
            return { actualProductionReaderRejected: true, code: 'host_offline' }
          },
        } } : {}),
        fileSave: fileSave ? {
          ...fileTransferSeed,
          verifySource: async () => {
            const path = resolve(workspacePath, fileTransferSeed!.filename), expected = fixtures.get(path)!
            const actual = await readFile(path)
            expect(actual.equals(expected)).toBe(true)
            return { bytes: actual.length, sha256: createHash('sha256').update(actual).digest('hex') }
          },
        } : undefined,
        notifications: notifications ? {
          sessionId,
          title,
          running: async ({ initialSeq, command }: any) => {
            let call: any
            await expect.poll(async () => {
              const current = await readSession()
              call = current.records.find((item: any) => item.event.type === 'tool/call'
                && item.event.seq > initialSeq && item.event.data.name === 'pwsh'
                && JSON.parse(item.event.data.arguments).command === command)?.event
              if (call) {
                const args = JSON.parse(call.data.arguments)
                expect(args).toMatchObject({ command, timeoutMs: 120000 })
                // 官方pwsh仅在true时走后台分支；省略与false均为前台，仍拒绝其他类型。
                expect([false, undefined]).toContain(args.run_in_background)
              }
              expect(current.snapshot.values.permissions.currentValue).toBe('read-only')
              return !!call && (await desktopRpc('session/list', { _request: {} })).items
                .find((item: any) => item.sessionId === sessionId)?.running === true
                && !current.records.some((item: any) => item.event.type === 'tool/result'
                  && item.event.data.message.toolCallId === call.data.callId)
            }, { timeout: 60000 }).toBe(true)
            return { callId: call.data.callId, turn: call.data.turn }
          },
          isRunning: async () => (await desktopRpc('session/list', { _request: {} })).items
            .find((item: any) => item.sessionId === sessionId)?.running === true,
          settled: async ({ initialSeq, token, command }: any) => {
            await expect.poll(async () => (await desktopRpc('session/list', { _request: {} })).items
              .find((item: any) => item.sessionId === sessionId)?.running, { timeout: 180000 }).toBe(false)
            const reply = await verifyReply(token), current = await readSession()
            const events = current.records.filter((item: any) => item.event.seq > initialSeq).map((item: any) => item.event)
            const messages = events.filter((event: any) => event.type === 'user/message'
              && event.data.content.some((part: any) => part.type === 'text' && part.text.includes(token)))
            expect(messages).toHaveLength(1)
            const calls = events.filter((event: any) => event.type === 'tool/call')
            expect(calls).toHaveLength(command ? 1 : 0)
            if (command) {
              expect(calls[0].data.name).toBe('pwsh')
              expect(JSON.parse(calls[0].data.arguments).command).toBe(command)
              const results = events.filter((event: any) => event.type === 'tool/result'
                && event.data.message.toolCallId === calls[0].data.callId)
              expect(results).toHaveLength(1)
              expect(results[0].data.message.isError === true).toBe(false)
            }
            const end = events.filter((event: any) => event.type === 'turn/end' && event.seq > reply.assistantSeq)
            expect(end).toHaveLength(1)
            expect(end[0].data.reason.kind).toBe('completed')
            return { ...reply, outcomeSeq: end[0].seq, userSeq: messages[0].seq,
              callId: calls[0]?.data.callId, completedAt: end[0].time }
          },
        } : undefined,
        timedRace: timedRace ? officialTimedRaceChecks({ rpc: desktopRpc, sessionId, readSession,
          verifyReply, observeInteraction, openReplyConnection }) : undefined,
        interactionSending: interactionSending ? {
          ...officialInteractionRaceChecks({ mode: interactionSendingMode, rpc: desktopRpc,
            sessionId, readSession, verifyReply, observeInteraction }),
          transport: {
            arm: async (value: Parameters<NonNullable<typeof sendingProxy>['arm']>[0]) => sendingProxy!.arm(value),
            cut: async () => sendingProxy!.cut(),
            resume: async () => sendingProxy!.resume(),
            answers: async (eventId: string) => sendingProxy!.answers(eventId),
          },
        } : undefined,
        interactionRace: interactionRace && !timedRace ? officialInteractionRaceChecks({ mode: raceMode,
          rpc: desktopRpc, sessionId, readSession, verifyReply, observeInteraction }) : undefined,
        interactionHost: interactionHost ? officialInteractionHostChecks({ mode: interactionMode,
          rpc: desktopRpc, sessionId, readSession, verifyReply, observeInteraction,
          stop: async () => {
            const running = (await desktopRpc('session/list', { _request: {} })).items.filter((item: any) => item.running)
            expect(running.every((item: any) => item.sessionId === sessionId)).toBe(true)
            const stopped = await lifecycle!.stop()
            ;(report.hostStops ??= []).push(stopped)
            await save(); return stopped
          },
          start: async () => {
            const started = await restoreOfficialLogin()
            await expect.poll(async () => (await manage()).connection, { timeout: 30000 }).toBe('online')
            const negotiated = await result({ method: 'remote.negotiate', version: 2 })
            expect(negotiated).toMatchObject({ type: 'result', value: { dshVersion: expectedVersion } })
            const evidence = { ...started, jobControlGeneration: negotiated.value.jobControlGeneration }
            ;(report.hostStarts ??= []).push(evidence)
            await save(); return evidence
          },
        }) : undefined,
        timedQuestion: timedHost ? officialTimedHostChecks({ rpc: desktopRpc, sessionId,
          readSession, verifyReply, observeInteraction,
          stop: async () => {
            const running = (await desktopRpc('session/list', { _request: {} })).items.filter((item: any) => item.running)
            expect(running.every((item: any) => item.sessionId === sessionId)).toBe(true)
            const stopped = await lifecycle!.stop()
            ;(report.hostStops ??= []).push(stopped)
            await save(); return stopped
          },
          start: async () => {
            const started = await restoreOfficialLogin()
            await expect.poll(async () => (await manage()).connection, { timeout: 30000 }).toBe('online')
            const negotiated = await result({ method: 'remote.negotiate', version: 2 })
            expect(negotiated).toMatchObject({ type: 'result', value: { dshVersion: expectedVersion } })
            const evidence = { ...started, jobControlGeneration: negotiated.value.jobControlGeneration }
            ;(report.hostStarts ??= []).push(evidence)
            await save(); return evidence
          },
        }) : timedQuestion ? officialTimedQuestionChecks({ rpc: desktopRpc, sessionId,
          readSession, verifyReply, observeInteraction }) : undefined,
        questionProcess: questionProcess ? {
          start: async (prompt: string) => {
            const requestId = randomUUID()
            await desktopRpc('session/prompt', { request: { sessionId, requestId, mode: 'queue',
              content: [{ type: 'text', text: prompt }] } })
            return { origin: 'official-desktop-public-session-prompt', requestId }
          },
          verify: async (seed: any) => {
            const current = await readSession()
            const calls = current.records.filter((item: any) => item.event.type === 'tool/call'
              && item.event.seq > seed.initialSeq)
            expect(calls).toHaveLength(1)
            const call = calls[0].event.data
            expect(call.name).toBe('ask_user_question')
            expect(call.callId).toBe(seed.callId)
            const args = JSON.parse(call.arguments)
            expect(args.questions).toHaveLength(1)
            expect(args.questions[0]).toMatchObject({ id: seed.questionId, question: seed.question })
            expect(args.questions[0].options.map((option: any) => option.label)).toEqual(['蓝色', '绿色'])
            expect(args.questions[0].multi_select === true).toBe(false)
            const messages = current.records.filter((item: any) => item.event.type === 'user/message'
              && item.event.data.content.some((part: any) => part.type === 'text' && part.text === seed.prompt))
            expect(messages).toHaveLength(1)
            const results = current.records.filter((item: any) => item.event.type === 'tool/result'
              && item.event.data.message.toolCallId === seed.callId)
            expect(results).toHaveLength(seed.pending ? 0 : 1)
            // 默认 legacy 工具不进入 timed 投影；实际待办来自原公开 waterfall。
            expect(current.snapshot.values.userQuestions.active).toHaveLength(0)
            if (!seed.pending) {
              const message = results[0].event.data.message
              expect(message.role).toBe('tool')
              expect(message.isError === true).toBe(false)
              const text = message.content.filter((part: any) => part.type === 'text')
                .map((part: any) => part.text).join('\n')
              expect(JSON.parse(text)).toEqual({ answers: [{ id: seed.questionId, selected: [seed.selected] }] })
            }
            const before = questionHistory.get(seed.callId)
            if (before) expect(current.records.slice(0, before.length)).toEqual(before)
            else {
              expect(seed.pending).toBe(true)
              questionHistory.set(seed.callId, current.records)
            }
            const running = (await desktopRpc('session/list', { _request: {} })).items
              .find((item: any) => item.sessionId === sessionId)?.running
            expect(running).toBe(seed.pending)
            const prefix = before ?? current.records
            return { callId: seed.callId, messages: messages.length, toolCalls: calls.length,
              toolResults: results.length, resultSeq: results[0]?.event.seq, running,
              originalRecords: prefix.length, currentRecords: current.records.length,
              originalPrefixSha256: createHash('sha256').update(JSON.stringify(prefix)).digest('hex') }
          },
          observe: async (seed: any) => {
            expect(approvalReaders.has(seed.callId)).toBe(false)
            const reader = await observeInteraction(sessionId, seed.callId, { id: seed.questionId, question: seed.question })
            approvalReaders.set(seed.callId, [reader])
            return reader.summary
          },
          answer: async (seed: any, selected: string) => {
            expect(['蓝色', '绿色']).toContain(selected)
            const readers = approvalReaders.get(seed.callId)!
            expect(readers).toHaveLength(1)
            const response = await readers[0]!.answerRaw({ answers: [{ id: seed.questionId, selected: [selected] }] })
            expect(response).toMatchObject({ type: 'result', value: { ok: true } })
            return { selected, response: response.value }
          },
          settled: async (token: string) => {
            await expect.poll(async () => {
              const current = await readSession()
              const reply = current.records.find((record: any) => record.event.type === 'assistant/message'
                && (record.event.data.message.content ?? []).filter((part: any) => part.type === 'text')
                  .map((part: any) => part.text).join('\n').trim() === token)
              return !!reply && current.records.some((record: any) => record.event.type === 'turn/end'
                && record.event.seq > reply.event.seq && record.event.data.reason.kind === 'completed')
            }, { timeout: 180000 }).toBe(true)
            await expect.poll(async () => (await desktopRpc('session/list', { _request: {} })).items
              .find((item: any) => item.sessionId === sessionId)?.running, { timeout: 180000 }).toBe(false)
            return verifyReply(token)
          },
          duplicate: async (seed: any) => {
            const before = (await readSession()).records
            const readers = approvalReaders.get(seed.callId)!
            const response = await readers[0]!.answerRaw({ answers: [{ id: seed.questionId,
              selected: [seed.selected === '绿色' ? '蓝色' : '绿色'] }] })
            expect(response).toMatchObject({ type: 'result', value: { ok: true } })
            expect((await readSession()).records).toEqual(before)
            return { response: response.value, oppositeOldAnswerIsNoop: true, officialRecordsUnchanged: true }
          },
          release: async (callId: string) => {
            for (const reader of approvalReaders.get(callId) ?? []) reader.close()
            approvalReaders.delete(callId)
          },
        } : undefined,
        planReview: planReview ? {
          processOnly: planProcess,
          start: async (prompt: string) => {
            expect(planProcess).toBe(true)
            const requestId = randomUUID()
            await desktopRpc('session/prompt', { request: { sessionId, requestId, mode: 'queue',
              content: [{ type: 'text', text: prompt }] } })
            return { origin: 'official-desktop-public-session-prompt', requestId }
          },
          checkpoint: async (seed: any) => {
            expect(planProcess).toBe(true)
            const current = await readSession()
            expect(current.records.filter((item: any) => item.event.type === 'tool/result'
              && item.event.data.message.toolCallId === seed.callId)).toHaveLength(0)
            expect(planHistory.has(seed.callId)).toBe(false)
            planHistory.set(seed.callId, current.records)
            return { records: current.records.length,
              sha256: createHash('sha256').update(JSON.stringify(current.records)).digest('hex') }
          },
          verifyCheckpoint: async (seed: any) => {
            expect(planProcess).toBe(true)
            const before = planHistory.get(seed.callId)!
            expect(before).toBeTruthy()
            const current = await readSession()
            expect(current.records.slice(0, before.length)).toEqual(before)
            const messages = current.records.filter((item: any) => item.event.type === 'user/message'
              && item.event.data.content.some((part: any) => part.type === 'text' && part.text === seed.prompt))
            expect(messages).toHaveLength(1)
            const calls = current.records.filter((item: any) => item.event.type === 'tool/call'
              && item.event.seq > seed.initialSeq)
            expect(calls).toHaveLength(1)
            expect(calls[0].event.data).toMatchObject({ name: 'exit_plan_mode', callId: seed.callId })
            expect(JSON.parse(calls[0].event.data.arguments)).toEqual({ plan: seed.plan })
            const results = current.records.filter((item: any) => item.event.type === 'tool/result'
              && item.event.data.message.toolCallId === seed.callId)
            expect(results).toHaveLength(seed.pending ? 0 : 1)
            const running = (await desktopRpc('session/list', { _request: {} })).items
              .find((item: any) => item.sessionId === sessionId)?.running
            expect(running).toBe(seed.pending)
            expect(current.snapshot.values.plan).toEqual({ active: seed.pending || seed.outcome === 'modify', pending: false })
            return { callId: seed.callId, messages: messages.length, toolCalls: calls.length,
              toolResults: results.length, resultSeq: results[0]?.event.seq, running,
              plan: current.snapshot.values.plan, originalRecords: before.length, currentRecords: current.records.length,
              originalPrefixSha256: createHash('sha256').update(JSON.stringify(before)).digest('hex') }
          },
          observe: async (seed: any) => {
            expect(planProcess).toBe(true)
            expect(approvalReaders.has(seed.callId)).toBe(false)
            const reader = await observeInteraction(sessionId, seed.callId, { plan: seed.plan })
            approvalReaders.set(seed.callId, [reader])
            return reader.summary
          },
          answer: async (seed: any) => {
            expect(planProcess).toBe(true)
            const readers = approvalReaders.get(seed.callId)!
            expect(readers).toHaveLength(1)
            const response = await readers[0]!.planDecision(seed.outcome)
            expect(response).toMatchObject({ type: 'result', value: { ok: true } })
            return { outcome: seed.outcome, response: response.value }
          },
          settled: async (token: string) => {
            expect(planProcess).toBe(true)
            await expect.poll(async () => {
              const current = await readSession()
              const reply = current.records.find((record: any) => record.event.type === 'assistant/message'
                && (record.event.data.message.content ?? []).filter((part: any) => part.type === 'text')
                  .map((part: any) => part.text).join('\n').trim() === token)
              return !!reply && current.records.some((record: any) => record.event.type === 'turn/end'
                && record.event.seq > reply.event.seq && record.event.data.reason.kind === 'completed')
            }, { timeout: 180000 }).toBe(true)
            await expect.poll(async () => (await desktopRpc('session/list', { _request: {} })).items
              .find((item: any) => item.sessionId === sessionId)?.running, { timeout: 180000 }).toBe(false)
            return verifyReply(token)
          },
          duplicate: async (seed: any) => {
            expect(planProcess).toBe(true)
            const before = (await readSession()).records
            const readers = approvalReaders.get(seed.callId)!
            expect(readers).toHaveLength(1)
            const response = await readers[0]!.planDecision(seed.outcome === 'approve' ? 'modify' : 'approve')
            expect(response).toMatchObject({ type: 'result', value: { ok: true } })
            expect((await readSession()).records).toEqual(before)
            return { response: response.value, oppositeOldDecisionIsNoop: true, officialRecordsUnchanged: true }
          },
          release: async (callId: string) => {
            expect(planProcess).toBe(true)
            for (const reader of approvalReaders.get(callId) ?? []) reader.close()
            approvalReaders.delete(callId)
          },
          state: async (active: boolean) => {
            const plan = (await readSession()).snapshot.values.plan
            expect(plan).toEqual({ active, pending: false })
            return plan
          },
          verify: async ({ initialSeq, plan, outcome, pending, callId }: any) => {
            const current = await readSession()
            expect(current.snapshot.values.plan).toEqual({ active: pending === true || outcome === 'modify', pending: false })
            const calls = current.records.filter((item: any) => item.event.type === 'tool/call' && item.event.seq > initialSeq)
            expect(calls).toHaveLength(1)
            const call = calls[0].event.data
            if (callId) expect(call.callId).toBe(callId)
            expect(call.name).toBe('exit_plan_mode')
            expect(JSON.parse(call.arguments)).toEqual({ plan })
            if (pending) {
              expect(current.records.filter((item: any) => item.event.type === 'tool/result'
                && item.event.data.message.toolCallId === call.callId)).toHaveLength(0)
              return { callId: call.callId, officialPendingPlanVerified: true }
            }
            const results = current.records.filter((item: any) => item.event.type === 'tool/result'
              && item.event.data.message.toolCallId === call.callId)
            expect(results).toHaveLength(1)
            const message = results[0].event.data.message
            expect(message.isError === true).toBe(outcome === 'modify')
            const text = JSON.stringify(message.content)
            expect(text).toContain(outcome === 'modify' ? 'dismissed the plan review' : 'Plan approved')
            expect(current.snapshot.values.userQuestions.active).toHaveLength(0)
            return { callId: call.callId, resultSeq: results[0].event.seq, outcome,
              officialResultVerified: true, plan: current.snapshot.values.plan }
          },
        } : undefined,
        approvalRecovery: approvalRecovery ? {
          processOnly: approvalProcess,
          sending: approvalSending ? {
            arm: async (value: Parameters<NonNullable<typeof sendingProxy>['arm']>[0]) => sendingProxy!.arm(value),
            cut: async () => sendingProxy!.cut(),
            resume: async () => sendingProxy!.resume(),
            answers: async (eventId: string) => sendingProxy!.answers(eventId),
          } : undefined,
          hostRestart: hostRestart ? {
            stop: async () => {
              const running = (await desktopRpc('session/list', { _request: {} })).items.filter((item: any) => item.running)
              expect(running.every((item: any) => item.sessionId === sessionId)).toBe(true)
              const stopped = await lifecycle!.stop()
              ;(report.hostStops ??= []).push(stopped)
              await save(); return stopped
            },
            start: async () => {
              const started = await restoreOfficialLogin()
              await expect.poll(async () => (await manage()).connection, { timeout: 30000 }).toBe('online')
              const negotiated = await result({ method: 'remote.negotiate', version: 2 })
              expect(negotiated).toMatchObject({ type: 'result', value: { dshVersion: expectedVersion } })
              const evidence = { ...started, jobControlGeneration: negotiated.value.jobControlGeneration }
              ;(report.hostStarts ??= []).push(evidence)
              await save(); return evidence
            },
            recovered: async (seed: any) => {
              await expect.poll(async () => (await readSession()).records.some((item: any) =>
                item.event.seq > seed.checkpoint.messageSeq && item.event.type === 'turn/end'
                  && item.event.data.reason.kind === 'interrupted'), { timeout: 45000 }).toBe(true)
              const current = await readSession(), before = approvalHistory.get(seed.callId)!
              expect(current.records.slice(0, before.length)).toEqual(before)
              const results = current.records.filter((item: any) => item.event.type === 'tool/result'
                && item.event.data.message.source?.callId === seed.callId)
              expect(results).toHaveLength(1)
              expect(results[0].event.data.message.isError).toBe(true)
              expect(results[0].event.data.error.code).toBe('TOOL_OUTCOME_UNKNOWN')
              const end = current.records.find((item: any) => item.event.type === 'turn/end'
                && item.event.seq > seed.checkpoint.messageSeq && item.event.data.reason.kind === 'interrupted')
              return { resultSeq: results[0].event.seq, errorCode: results[0].event.data.error.code,
                turnEndSeq: end.event.seq, reason: end.event.data.reason,
                prefixSha256: createHash('sha256').update(JSON.stringify(before)).digest('hex') }
            },
            staleDecision: async (callId: string) => {
              const before = (await readSession()).records, readers = approvalReaders.get(callId)!
              expect(readers).toHaveLength(1)
              const response = await readers[0]!.answerRaw('allowed-once')
              expect(['result', 'error']).toContain(response.type)
              expect((await readSession()).records).toEqual(before)
              return { response, officialRecordsUnchanged: true }
            },
            idleCheckpoint: async (callId: string) => {
              const current = await readSession()
              hostIdleHistory.set(callId, current.records)
              return { records: current.records.length,
                sha256: createHash('sha256').update(JSON.stringify(current.records)).digest('hex') }
            },
            verifyIdle: async (callId: string) => {
              const before = hostIdleHistory.get(callId)!, current = await readSession()
              expect(before).toBeTruthy(); expect(current.records.slice(0, before.length)).toEqual(before)
              for (const type of ['user/message', 'assistant/message', 'tool/call', 'tool/result'])
                expect(current.records.filter((item: any) => item.event.type === type))
                  .toEqual(before.filter((item: any) => item.event.type === type))
              expect((await desktopRpc('session/list', { _request: {} })).items
                .find((item: any) => item.sessionId === sessionId)?.running).toBe(false)
              return { originalRecords: before.length, currentRecords: current.records.length,
                originalPrefixSha256: createHash('sha256').update(JSON.stringify(before)).digest('hex'),
                appendedTypes: current.records.slice(before.length).map((item: any) => item.event.type),
                messagesAndCallsAndResultsUnchanged: true }
            },
          } : undefined,
          prepare: async (fileName: string, before: string, after: string) => {
            expect(fileName).toMatch(/^approval-(offline|other-client|race|process-pending|process-settled|host-restart|send-before-forward|send-after-receipt)\.txt$/)
            const path = resolve(workspacePath, fileName)
            const content = Buffer.from(before)
            await writeFile(path, content, { flag: 'wx' })
            fixtures.set(path, content)
            approvalFixtureChanges.set(path, after)
          },
          start: async (prompt: string) => {
            expect(approvalLifecycle).toBe(true)
            const requestId = randomUUID()
            await desktopRpc('session/prompt', { request: { sessionId, requestId, mode: 'queue',
              content: [{ type: 'text', text: prompt }] } })
            return { origin: 'official-desktop-public-session-prompt', requestId }
          },
          checkpoint: async ({ callId, prompt }: any) => {
            expect(approvalLifecycle).toBe(true)
            const current = await readSession()
            const messages = current.records.filter((item: any) => item.event.type === 'user/message'
              && item.event.data.content.some((part: any) => part.type === 'text' && part.text === prompt))
            expect(messages).toHaveLength(1)
            expect(current.records.filter((item: any) => item.event.type === 'tool/result'
              && item.event.data.message.source?.callId === callId)).toHaveLength(0)
            approvalHistory.set(callId, current.records)
            return { records: current.records.length, messageSeq: messages[0].event.seq,
              sha256: createHash('sha256').update(JSON.stringify(current.records)).digest('hex') }
          },
          settled: async (token: string) => {
            expect(approvalLifecycle).toBe(true)
            // 审批插件接管输入时停止按钮本来就隐藏；等官方持久化结算，不把UI隐藏当作完成。
            await expect.poll(async () => {
              const current = await readSession()
              const reply = current.records.find((record: any) => record.event.type === 'assistant/message'
                && (record.event.data.message.content ?? []).filter((part: any) => part.type === 'text')
                  .map((part: any) => part.text).join('\n').trim() === token)
              return !!reply && current.records.some((record: any) => record.event.type === 'turn/end'
                && record.event.seq > reply.event.seq && record.event.data.reason.kind === 'completed')
            }, { timeout: 180000 }).toBe(true)
            await expect.poll(async () => (await desktopRpc('session/list', { _request: {} })).items
              .find((item: any) => item.sessionId === sessionId)?.running, { timeout: 180000 }).toBe(false)
            return verifyReply(token)
          },
          verifyCheckpoint: async ({ callId, prompt, pending }: any) => {
            expect(approvalLifecycle).toBe(true)
            const before = approvalHistory.get(callId)!
            expect(before).toBeTruthy()
            const current = await readSession()
            expect(current.records.slice(0, before.length)).toEqual(before)
            const messages = current.records.filter((item: any) => item.event.type === 'user/message'
              && item.event.data.content.some((part: any) => part.type === 'text' && part.text === prompt))
            expect(messages).toHaveLength(1)
            const results = current.records.filter((item: any) => item.event.type === 'tool/result'
              && item.event.data.message.source?.callId === callId)
            expect(results).toHaveLength(pending ? 0 : 1)
            const running = (await desktopRpc('session/list', { _request: {} })).items
              .find((item: any) => item.sessionId === sessionId)?.running
            expect(running).toBe(pending)
            return { originalRecords: before.length, currentRecords: current.records.length,
              originalPrefixSha256: createHash('sha256').update(JSON.stringify(before)).digest('hex'),
              messageSeq: messages[0].event.seq, messages: messages.length, toolResults: results.length, running }
          },
          observe: async (callId: string, count = 1) => {
            expect([1, 2]).toContain(count)
            expect(approvalReaders.has(callId)).toBe(false)
            const readers = []
            for (let index = 0; index < count; index++) readers.push(await observeInteraction(sessionId, callId))
            approvalReaders.set(callId, readers)
            expect(new Set(readers.map(reader => reader.summary.eventId)).size).toBe(1)
            expect(new Set(readers.map(reader => reader.summary.clientId)).size).toBe(count)
            return readers.map(reader => reader.summary)
          },
          release: async (callId: string) => {
            for (const reader of approvalReaders.get(callId) ?? []) reader.close()
            approvalReaders.delete(callId)
          },
          answer: async (callId: string) => {
            const readers = approvalReaders.get(callId)!
            expect(readers).toHaveLength(1)
            return readers[0]!.answer('rejected')
          },
          compete: async (callId: string) => {
            const readers = approvalReaders.get(callId)!
            expect(readers).toHaveLength(2)
            return Promise.all([readers[0]!.answer('allowed-once'), readers[1]!.answer('rejected')])
          },
          duplicate: async (callId: string, outcome: string) => {
            const before = (await readSession()).records
            const readers = approvalReaders.get(callId)!
            const replies = await Promise.all(readers.map(reader => reader.answer(outcome === 'allow' ? 'rejected' : 'allowed-once')))
            expect((await readSession()).records).toEqual(before)
            return { replies, officialRecordsUnchanged: true }
          },
        } : undefined,
        beforeTool: async () => (await readSession()).snapshot.asOfSeq,
        trackApprovalFixture: longHistory || historyInflight ? trackApprovalFixture : undefined,
        reviewPreview: reviewPreview ? {
          trackFixture: trackApprovalFixture,
          verify: async ({ initialSeq, fileName, before, after }: any) => {
            let announcement: any
            await expect.poll(async () => {
              const current = await readSession()
              const records = current.records.filter((item: any) => item.event.type === 'workspace/changes'
                && item.event.seq > initialSeq)
              if (!records.length) return false
              expect(records).toHaveLength(1)
              announcement = records[0].event
              return true
            }, { timeout: 20000 }).toBe(true)
            const fetchRecord = async (path: string, index?: number) => {
              const url = new URL(path, hostOrigin)
              url.searchParams.set('sessionId', sessionId)
              url.searchParams.set('seq', String(announcement.seq))
              if (index !== undefined) url.searchParams.set('index', String(index))
              const response = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(15000) })
              expect(response.status).toBe(200)
              expect(response.headers.get('content-type')).toContain('application/json')
              return response.json()
            }
            const summary = await fetchRecord('/api/changes.summary')
            expect(summary.turn).toBe(announcement.data.turn)
            expect(summary.total).toBe(1)
            expect(summary.files).toHaveLength(1)
            expect(resolve(workspacePath, summary.files[0].path)).toBe(resolve(workspacePath, fileName))
            const diff = await fetchRecord('/api/changes.diff', 0)
            expect(diff).toMatchObject({ kind: 'text', before: true, after: true, path: summary.files[0].path })
            const lines = diff.hunks.flatMap((hunk: any) => hunk.lines)
            expect(lines.filter((line: string) => line.startsWith('-'))).toEqual(['-' + before])
            expect(lines.filter((line: string) => line.startsWith('+'))).toEqual(['+' + after])
            expect((await readFile(resolve(workspacePath, fileName), 'utf8')).trim()).toBe(after)
            return { sessionId, seq: announcement.seq, turn: summary.turn, path: diff.path,
              summary, diff, officialRoutesVerified: true, originalFileVerified: true }
          },
        } : undefined,
        pluginSourceWrite: creatorTask,
        creatorTask: creatorTask ? { marker: 'DSHM_CREATOR_INSPECT_' + run.replaceAll('-', ''), verify: creatorTaskChecks!.verify } : undefined,
        queue: queue ? {
          running: async ({ initialSeq, command }: any) => {
            let call: any
            await expect.poll(async () => {
              const current = await readSession()
              const calls = current.records.filter((record: any) => record.event.type === 'tool/call' && record.event.seq > initialSeq)
              if (!calls.length) return false
              expect(calls).toHaveLength(1)
              call = calls[0].event.data
              expect(call.name).toBe('pwsh')
              const args = JSON.parse(call.arguments)
              expect(args).toMatchObject({ command, timeoutMs: 120000 })
              expect([false, undefined]).toContain(args.run_in_background)
              expect(current.records.some((record: any) => record.event.type === 'tool/result'
                && record.event.data.message.toolCallId === call.callId)).toBe(false)
              expect(current.snapshot.values.permissions.currentValue).toBe('read-only')
              return (await desktopRpc('session/list', { _request: {} })).items.find((item: any) => item.sessionId === sessionId)?.running
            }, { timeout: 45000 }).toBe(true)
            return { callId: call.callId, officialRunningVerified: true }
          },
          verify: async ({ phase, phone, markers }: any) => {
            const current = await readSession(), inbox = current.snapshot.values.inbox
            expect(phone.inbox).toEqual(inbox)
            const pending = [...inbox['next-turn'], ...inbox['next-step']]
            const text = (item: any) => item.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
            const name = phase.includes('original') ? 'original' : phase === 'edited' ? 'edited'
              : phase.includes('cancelled') ? 'cancelled' : phase.includes('steer') ? 'steered' : 'retained'
            const matches = pending.filter((item: any) => text(item).includes(markers[name]))
            if (phase.startsWith('removed')) expect(matches).toHaveLength(0)
            else {
              expect(matches).toHaveLength(1)
              const target = phase === 'steered-next-step' ? 'next-step' : 'next-turn'
              expect(inbox[target].some((item: any) => item.id === matches[0].id)).toBe(true)
            }
            return { officialProjectionVerified: true, itemId: matches[0]?.id,
              counts: { nextTurn: inbox['next-turn'].length, nextStep: inbox['next-step'].length } }
          },
          settled: async ({ initialSeq, callId, markers, editedId, cancelledId, steeredId }: any) => {
            const current = await readSession(), records = current.records.filter((item: any) => item.event.seq > initialSeq)
            const result = records.filter((item: any) => item.event.type === 'tool/result' && item.event.data.message.toolCallId === callId)
            expect(result).toHaveLength(1)
            expect(result[0].event.data.message.isError).toBe(false)
            expect(current.snapshot.values.inbox).toEqual({ 'next-turn': [], 'next-step': [] })
            const users = records.filter((item: any) => item.event.type === 'user/message')
            const userFor = (id: string) => users.filter((item: any) => item.event.data.id === id)
            expect(userFor(editedId)).toHaveLength(1)
            expect(userFor(steeredId)).toHaveLength(1)
            expect(userFor(cancelledId)).toHaveLength(0)
            expect(JSON.stringify(userFor(editedId)[0])).toContain(markers.edited)
            expect(JSON.stringify(userFor(editedId)[0])).not.toContain(markers.original)
            const firstEnd = records.find((item: any) => item.event.type === 'turn/end')
            expect(firstEnd.event.data.reason.kind).toBe('completed')
            expect(userFor(steeredId)[0].event.seq).toBeLessThan(firstEnd.event.seq)
            expect(userFor(editedId)[0].event.seq).toBeGreaterThan(firstEnd.event.seq)
            return { editedReply: await verifyReply(markers.edited), steeredReply: await verifyReply(markers.steered),
              editedMessageIdentityPreserved: true, steeringEnteredActiveTurn: true, removedMessageNotConsumed: true }
          },
          stopped: async ({ initialSeq, callId, retainedId }: any) => {
            await expect.poll(async () => (await desktopRpc('session/list', { _request: {} })).items
              .find((item: any) => item.sessionId === sessionId)?.running, { timeout: 30000 }).toBe(false)
            const current = await readSession(), records = current.records.filter((item: any) => item.event.seq > initialSeq)
            const end = records.filter((item: any) => item.event.type === 'turn/end')
            expect(end).toHaveLength(1)
            expect(end[0].event.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
            const results = records.filter((item: any) => item.event.type === 'tool/result' && item.event.data.message.toolCallId === callId)
            expect(results).toHaveLength(1)
            expect(results[0].event.data.message.isError).toBe(true)
            expect(current.snapshot.values.inbox['next-turn'].map((item: any) => item.id)).toEqual([retainedId])
            expect(records.some((item: any) => item.event.type === 'user/message' && item.event.data.id === retainedId)).toBe(false)
            return { turnEndSeq: end[0].event.seq, reason: end[0].event.data.reason,
              toolResultSeq: results[0].event.seq, pendingMessageNotConsumed: true }
          },
        } : undefined,
        office: office ? {
          root: workspacePath, files: officeSeed,
          verify: async (name: string) => {
            const seed = officeSeed.find(item => item.name === name)
            expect(seed).toBeTruthy()
            const parts: Buffer[] = []
            for (let offset = 0; offset < seed!.bytes; offset += 65536) {
              const frame = await result({ method: 'remote.rpc', endpoint: 'workspaceFiles/readBytes', payload: {
                args: { workspaceFileScopeId: sessionId, path: name,
                  range: { offset, length: Math.min(65536, seed!.bytes - offset) } } } })
              expect(frame).toMatchObject({ type: 'result', value: { ok: true } })
              expect(frame.value.value.offset).toBe(offset)
              parts.push(Buffer.from(frame.value.value.data, 'base64'))
            }
            const content = Buffer.concat(parts)
            expect(content.length).toBe(seed!.bytes)
            expect(createHash('sha256').update(content).digest('hex')).toBe(seed!.sha256)
            return { bytes: content.length, sha256: seed!.sha256, chunks: parts.length }
          },
        } : undefined,
        files: files ? {
          ...fileSeed,
          desktop: fileDesktop ? {
            ...fileSeed!.desktop,
            presented: filePresented,
            verifyPresented: async (marker: string) => {
              const current = await readSession()
              const path = resolve(fileSeed!.root, fileSeed!.filename).replaceAll('\\', '/')
              const matches = current.records.filter((item: any) => item.event.type === 'deliverables/presented'
                && item.event.data.files.some((file: any) => file.path.replaceAll('\\', '/') === path))
              expect(matches).toHaveLength(1)
              expect(matches[0].event.data.files).toHaveLength(1)
              const reply = await verifyReply(marker)
              return { seq: matches[0].event.seq, callId: matches[0].event.data.callId,
                originalFile: true, uniqueActualEvent: true, actualModelReply: reply }
            },
          } : undefined,
          verifyShareRecipient: fileShare,
          verify: async () => {
            const read = async (endpoint: string, args: unknown) => {
              const frame = await result({ method: 'remote.rpc', endpoint: 'workspaceFiles/' + endpoint,
                payload: { args } })
              expect(frame).toMatchObject({ type: 'result', value: { ok: true } })
              return frame.value.value
            }
            const scope = { workspaceFileScopeId: sessionId }
            const listing = await read('list', { ...scope, path: '.' })
            expect(listing.entries.map((entry: any) => entry.name)).toContain(fileSeed!.filename)
            const parts: Buffer[] = []
            for (let offset = 0; offset < fileSeed!.bytes; offset += 65536) {
              const part = await read('readBytes', { ...scope, path: fileSeed!.filename,
                range: { offset, length: 65536 } })
              expect(part.offset).toBe(offset)
              parts.push(Buffer.from(part.data, 'base64'))
            }
            const content = Buffer.concat(parts)
            expect(content.length).toBe(fileSeed!.bytes)
            expect(createHash('sha256').update(content).digest('hex')).toBe(fileSeed!.sha256)
            return { independentRelayReadVerified: true, chunks: parts.length,
              bytes: content.length, sha256: fileSeed!.sha256 }
          },
        } : undefined,
        jobs: background ? {
          stop: backgroundStopControl,
          control: backgroundControl,
          host: backgroundHostControl,
          started: async ({ jobId, startedAt, initialSeq, command }: any) => {
            jobs.set(jobId, sessionId)
            const current = await readSession()
            const calls = current.records.filter((item: any) => item.event.type === 'tool/call' && item.event.seq > initialSeq)
            expect(calls).toHaveLength(1)
            const call = calls[0].event.data
            expect(call.name).toBe('pwsh')
            expect(JSON.parse(call.arguments)).toMatchObject({ command, run_in_background: true })
            const completed = current.records.filter((item: any) => item.event.type === 'tool/result'
              && item.event.data.message.toolCallId === call.callId)
            expect(completed).toHaveLength(1)
            expect(completed[0].event.data.message.isError).toBe(false)
            expect(JSON.stringify(completed[0].event.data.message.content)).toContain(jobId)
            expect(Number.isSafeInteger(startedAt)).toBe(true)
            expect(current.snapshot.values.permissions.currentValue).toBe('read-only')
          },
          output: async ({ jobId, startedAt, status, raw }: any) => {
            const streams = { stdout: '', stderr: '' }
            for (const stream of ['stdout', 'stderr'] as const) {
              const frame = await result({ method: 'remote.jobOutput', sessionId, jobId, startedAt,
                generation: negotiation.value.jobControlGeneration, stream, fromByte: 0, maxBytes: 65536 })
              expect(frame.type).toBe('result')
              expect(frame.value).toMatchObject({ state: 'available', coordinate: 'ring', status, lossy: false })
              streams[stream] = Buffer.from(frame.value.data, 'base64').toString('utf8')
            }
            expect(streams.stdout).toContain('DSHM_BG_BEGIN')
            expect(streams.stdout).not.toContain('DSHM_BG_STDERR')
            expect(streams.stderr).toContain('DSHM_BG_STDERR')
            expect(streams.stderr).not.toContain('DSHM_BG_BEGIN')
            if (status === 'completed') {
              expect(streams.stdout).toContain('DSHM_BG_END')
              // 页面会规范化换行并呈现 ANSI 样式；字节内容应与手机 reader 的原始缓冲比较。
              expect(raw.stdout).toBe(streams.stdout)
              expect(raw.stderr).toBe(streams.stderr)
            }
            expect((await readSession()).snapshot.values.permissions.currentValue).toBe('read-only')
            return { status, channelsVerified: true, phoneReadBufferMatched: status === 'completed' }
          },
        } : undefined,
        extensions: extensions ? {
          verify: async ({ initialSeq, kind, question, command }: any) => {
            const current = await readSession()
            const calls = current.records.filter((item: any) => item.event.type === 'tool/call' && item.event.seq > initialSeq)
            expect(calls).toHaveLength(1)
            const call = calls[0].event.data
            expect(call.name).toBe(kind === 'question' ? 'ask_user_question' : 'pwsh')
            const args = JSON.parse(call.arguments)
            if (kind === 'question') expect(args.questions[0].question).toBe(question)
            else expect(args.command).toBe(command)
            const results = current.records.filter((item: any) => item.event.type === 'tool/result'
              && item.event.data.message.toolCallId === call.callId)
            expect(results).toHaveLength(1)
            const message = results[0].event.data.message
            expect(message.isError).toBe(false)
            const text = message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
            if (kind === 'question') {
              expect(JSON.parse(text)).toEqual({ answers: [{ id: 'color_check', selected: ['绿色'] }] })
              expect(current.snapshot.values.userQuestions.active).toHaveLength(0)
            } else {
              expect(text).toContain('DSHM_STDOUT_OK')
              expect(text).toContain('DSHM_STDERR_OK')
              expect(current.snapshot.values.permissions.currentValue).toBe('read-only')
            }
            return { kind, callId: call.callId, resultSeq: results[0].event.seq, officialResultVerified: true }
          },
        } : undefined,
        verifyTool: async ({ initialSeq, fileName, after, outcome, callId, pending }: any) => {
          const current = await readSession()
          expect(current.snapshot.values.permissions.currentValue).toBe('read-only')
          const calls = current.records.filter((item: any) => item.event.type === 'tool/call' && item.event.seq > initialSeq)
          expect(calls.length).toBeGreaterThan(0)
          for (const { event } of calls) {
            expect(['read', 'write']).toContain(event.data.name)
            const args = JSON.parse(event.data.arguments)
            expect(resolve(workspacePath, args.file_path)).toBe(resolve(workspacePath, fileName))
            if (event.data.name === 'write') expect(args.content.trim()).toBe(after)
          }
          const escalated = calls.filter((item: any) => item.event.data.name === 'write'
            && JSON.parse(item.event.data.arguments).sandbox_permissions === 'workspace-write')
          expect(escalated).toHaveLength(1)
          expect(escalated[0].event.data.callId).toBe(callId)
          if (pending) return { callId, pendingTargetVerified: true,
            argumentPath: JSON.parse(escalated[0].event.data.arguments).file_path }
          const results = current.records.filter((item: any) => item.event.type === 'tool/result'
            && item.event.data.message.source?.callId === callId)
          expect(results).toHaveLength(1)
          const message = results[0].event.data.message
          expect(message.toolCallId).toBe(callId)
          expect(message.role).toBe('tool')
          expect(message.isError === true).toBe(outcome === 'reject')
          if (outcome === 'reject') expect(JSON.stringify(message.content)).toContain('user rejected escalating')
          return { callId, resultSeq: results[0].event.seq, outcome, officialDecisionVerified: true }
        },
      } : undefined,
      verifyMessage: async () => {
        await expect.poll(async () => {
          const current = await desktopRpc('session/projections', { request: { sessionId } })
          const page = await desktopRpc('session/page', { request: { address: { kind: 'session', sessionId },
            throughSeq: current.asOfSeq, maxMessages: 60 } })
          return JSON.stringify(page.records).includes(phoneMarker)
        }, { timeout: 20000 }).toBe(true)
      },
      verifyCreated: async (selected: string) => {
        expect(selected).not.toBe(sessionId)
        sessions.add(selected)
        const entries = await desktopRpc('session/list', { _request: {} })
        expect(entries.items.find((item: { sessionId: string }) => item.sessionId === selected)?.cwd).toBe(workspacePath)
      },
      disconnect: async () => { await manage({ action: 'disable' }) },
      reconnect: async () => {
        await manage({ action: 'enable' })
        await expect.poll(async () => (await manage()).connection, { timeout: 15000 }).toBe('online')
      },
    })
    report.coreInferenceVerified = !skills && !ptc && !attachmentSending && !promptSending && !feedback && !schedules && !workflows && !goals && !subagents && !extensions && !background && !files && !plugins && !office && !workspaceManagement && !settings && !queue && !navigation && !approvalRecovery && !questionProcess && !timedQuestion && !planReview && !interactionHost && !interactionRace && !interactionSending && !notifications && !fileRecovery && !fileSave && !attachments && !fileWriteDeath && !fileWriteInterruption && report.android.inferenceVerified === true
    if (skills) {
      expect(report.android.skillsVerified).toBe(true)
      expect(report.android.skills.execution.officialBodyInjected).toBe(true)
      report.skillsVerified = true
    }
    if (references) {
      expect(report.android.referencesVerified).toBe(true)
      expect(report.android.references.entrances.map((item: any) => item.mode)).toEqual(['at', 'menu'])
      report.referencesVerified = true
    }
    if (pairingCheck) {
      expect(report.android.pairingVerified).toBe(true)
      expect(report.android.pairing.pending.onlyOnePendingDevice).toBe(true)
      report.pairingVerified = true
    }
    if (ptc) {
      expect(report.android.ptcVerified).toBe(true)
      expect(report.android.ptc.completed).toBe(true)
      expect(report.android.ptc.original.unchanged).toBe(true)
      report.ptcVerified = true
    }
    if (reviewPreview) {
      expect(report.android.approvals).toHaveLength(2)
      expect(report.android.approvals.every((approval: any) => approval.plannedPreview?.passed === true)).toBe(true)
      expect(report.android.approvals[0].turnReview.passed).toBe(true)
      report.reviewPreviewVerified = true
    }
    if (longHistory) {
      expect(report.android.longHistory.passed).toBe(true)
      expect(report.android.longHistoryReconnect.passed).toBe(true)
      expect(report.android.approvals).toHaveLength(2)
      report.longHistoryVerified = true
    }
    if (historyInflight) {
      expect(report.android.historyInflight.passed).toBe(true)
      expect(report.android.historyInflight.seed.originalHistoryUnchanged).toBe(true)
      report.historyInflightVerified = true
    }
    if (promptSending) report.promptSendingVerified = report.android.promptSendingVerified === true
    if (promptProcess) report.promptProcessVerified = report.android.promptProcessVerified === true
    if (promptHost) report.promptHostVerified = report.android.promptHostVerified === true
    if (attachmentSending) report.attachmentSendingVerified = report.android.attachmentSendingVerified === true
    if (attachmentProcess) report.attachmentProcessVerified = report.android.attachmentProcessVerified === true
    if (attachmentHost) report.attachmentHostVerified = report.android.attachmentHostVerified === true
    if (schedules) report.schedulesVerified = report.android.schedulesVerified === true
    if (creatorTask) report.creatorTaskVerified = report.android.creatorTaskVerified === true
    if (workflows) report.workflowsVerified = report.android.workflowsVerified === true
    if (goals) report.goalsVerified = report.android.goalsVerified === true
    if (subagents) report.subagentsVerified = report.android.subagentsVerified === true
    if (childStop) {
      expect(report.android.subagents.stop.completed).toBe(true)
      report.childStopVerified = true
    }
    if (extensions) report.extensionsVerified = report.android.extensionsVerified === true
    if (background) report.backgroundVerified = report.android.backgroundVerified === true
    if (backgroundControlCheck) report.backgroundControlVerified = report.android.background.control?.passed === true
    if (backgroundProcessCheck) report.backgroundProcessVerified = report.android.background.control?.process?.passed === true
    if (backgroundHostCheck) report.backgroundHostVerified = report.android.background.host?.passed === true
    if (backgroundStopCheck) report.backgroundStopVerified = report.android.background.stop?.passed === true
    if (files) report.filesVerified = report.android.filesVerified === true
    if (fileDesktop) {
      expect(report.android.files.desktop.passed).toBe(true)
      report.fileDesktopVerified = true
    }
    if (filePresented) {
      expect(report.android.files.desktop.presented.passed).toBe(true)
      report.filePresentedVerified = true
    }
    if (fileShare) {
      expect(report.android.files.share.recipientDeliveryVerified).toBe(true)
      expect(report.android.files.shareReceiverRemoved).toBe(true)
      expect(report.android.files.share.ownSnapshotRemoved).toBe(true)
      report.fileShareVerified = true
    }
    if (plugins) report.pluginsVerified = report.android.pluginsVerified === true
    if (pluginLayout) {
      expect(report.android.plugins.layout.passed).toBe(true)
      expect(report.android.plugins.layout.authorDeclarationDisposed).toBe(true)
      expect(report.android.plugins.layout.userPreferencesRestored).toBe(true)
      report.pluginLayoutVerified = true
    }
    if (pluginUpgrade) report.pluginUpgradeVerified = report.android.plugins.upgrade?.newVersionRendered === true
    if (pluginInterruption) report.pluginInterruptionVerified = report.android.plugins.interruption?.passed === true
    if (pluginScripts) report.pluginScriptsVerified = report.android.plugins.scripts?.passed === true
    if (pluginApplying) report.pluginApplyingVerified = report.android.plugins.applying?.passed === true
    if (office) report.officeVerified = report.android.officeVerified === true
    if (workspaceManagement) report.workspaceManagementVerified = report.android.workspaceManagementVerified === true
    if (credentialEndpoints) report.credentialEndpointsVerified = report.android.credentialEndpointsVerified === true
    else if (modelSettings) report.modelSettingsVerified = report.android.modelSettingsVerified === true
    else if (presetSettings) report.presetSettingsVerified = report.android.presetSettingsVerified === true
    else if (presetCreator) report.presetCreatorVerified = report.android.presetCreatorVerified === true
    else if (providerManagement) report.providerManagementVerified = report.android.providerManagementVerified === true
    else if (providerKeys) report.providerKeysVerified = report.android.providerKeysVerified === true
    else if (endpointProcess) report.endpointProcessVerified = report.android.endpointProcessVerified === true
    else if (endpointRace) report.endpointRaceVerified = report.android.endpointRaceVerified === true
    else if (endpointInterruption) report.endpointInterruptionVerified = report.android.endpointInterruptionVerified === true
    else if (endpointWrites) report.endpointWritesVerified = report.android.endpointWritesVerified === true
    else if (settings) report.settingsVerified = report.android.settingsVerified === true
    if (queue) report.queueVerified = report.android.queueVerified === true
    if (externalChild) report.externalChildVerified = report.android.externalChildVerified === true
    if (navigation) report.navigationVerified = report.android.navigationVerified === true
    if (approvalSending) report.approvalSendingVerified = report.android.approvalSendingVerified === true
    else if (hostRestart) report.hostRestartVerified = report.android.hostRestartVerified === true
    else if (approvalProcess) report.approvalProcessVerified = report.android.approvalProcessVerified === true
    else if (approvalRecovery) report.approvalRecoveryVerified = report.android.approvalRecoveryVerified === true
    if (planProcess) report.planProcessVerified = report.android.planProcessVerified === true
    else if (planReview) report.planReviewVerified = report.android.planReviewVerified === true
    if (questionProcess) report.questionProcessVerified = report.android.questionProcessVerified === true
    if (interactionHost) report.interactionHostVerified = report.android.interactionHostVerified === true
    if (interactionRace) report.interactionRaceVerified = report.android.interactionRaceVerified === true
    if (interactionSending) report.interactionSendingVerified = report.android.interactionSendingVerified === true
    if (timedHost) report.timedHostVerified = report.android.timedHostVerified === true
    else if (timedQuestion) report.timedQuestionVerified = report.android.timedQuestionVerified === true
    if (notifications) report.notificationsVerified = report.android.notificationsVerified === true
    if (fileRecovery) report.fileRecoveryVerified = report.android.fileRecoveryVerified === true
    if (fileSave) report.fileSaveVerified = report.android.fileSaveVerified === true
    if (attachments) report.attachmentsVerified = report.android.attachmentsVerified === true
    if (sessionExport) report.sessionExportVerified = report.android.sessionExportVerified === true
    if (feedback && !feedbackHistory) report.feedbackVerified = report.android.feedbackVerified === true
    if (feedbackHistory) report.feedbackHistoryVerified = report.android.feedbackHistoryVerified === true
    if (fileWriteDeath) report.fileWriteDeathVerified = report.android.fileWriteDeathVerified === true
    if (fileWriteRevocation) report.fileWriteRevocationVerified = report.android.fileWriteRevocationVerified === true
    else if (fileWriteInterruption) report.fileWriteInterruptionVerified = report.android.fileWriteInterruptionVerified === true
    report.stages.push('android-own-page-history-model-message-create-reconnect-revoke')
    expect((await api('/v1/device/ticket', claim.token)).status).toBe(200)
    await manage({ action: 'revoke', deviceId: claim.deviceId })
    expect((await api('/v1/device/ticket', claim.token)).status).toBe(401)
    report.passed = true
    await save()
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error)
    await save()
    throw error
  }
}, 660000)
