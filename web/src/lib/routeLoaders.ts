/** Shared dynamic-import functions let the router and navigation warm the exact same chunk. */
export const loadAgenda = () => import('@/pages/Agenda')
export const loadApiDocs = () => import('@/pages/ApiDocs')
export const loadChooseWorkspace = () => import('@/pages/ChooseWorkspace')
export const loadComms = () => import('@/pages/Comms')
export const loadContentLibrary = () => import('@/pages/ContentLibrary')
export const loadDashboard = () => import('@/pages/Dashboard')
export const loadDevLogin = () => import('@/pages/DevLogin')
export const loadDirectory = () => import('@/pages/Directory')
export const loadEvaluation = () => import('@/pages/Evaluation')
export const loadFormEditor = () => import('@/pages/FormEditor')
export const loadForms = () => import('@/pages/Forms')
export const loadInbox = () => import('@/pages/Inbox')
export const loadOnboarding = () => import('@/pages/Onboarding')
export const loadPipeline = () => import('@/pages/Pipeline')
export const loadPortal = () => import('@/pages/Portal')
export const loadPortalChoose = () => import('@/pages/PortalChoose')
export const loadPublicForm = () => import('@/pages/PublicForm')
export const loadPublicSchedule = () => import('@/pages/PublicSchedule')
export const loadPublicSpeakers = () => import('@/pages/PublicSpeakers')
export const loadReview = () => import('@/pages/Review')
export const loadSettings = () => import('@/pages/SettingsPage')
export const loadSpeakerSignin = () => import('@/pages/SpeakerSignin')
export const loadSpeakers = () => import('@/pages/Speakers')
export const loadSubmitterDashboard = () => import('@/pages/SubmitterDashboard')

const organizerRouteLoaders: Record<string, () => Promise<unknown>> = {
  '/agenda': loadAgenda,
  '/comms': loadComms,
  '/content': loadContentLibrary,
  '/dashboard': loadDashboard,
  '/directory': loadDirectory,
  '/evaluation': loadEvaluation,
  '/forms': loadForms,
  '/pipeline': loadPipeline,
  '/settings': loadSettings,
  '/speakers': loadSpeakers,
  '/submissions': loadInbox,
}

export function preloadOrganizerRoute(path: string): void {
  void organizerRouteLoaders[path]?.()
}
export const loadKillMySaas = () => import('@/pages/KillMySaas')
export const loadJudge = () => import('@/pages/Judge')
export const loadManifesto = () => import('@/pages/Manifesto')
export const loadOpenSource = () => import('@/pages/OpenSource')
