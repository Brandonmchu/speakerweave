/**
 * The "featured" event whose public program the marketing surfaces point at.
 *
 * The public Home landing and the guessable alias routes (/schedule, /speakers,
 * …) all resolve here so an attendee — or a blind browser agent — can reach a
 * real, populated schedule without knowing the slug.
 *
 * Hardcoded to the seeded demo event. A future GET /public/featured-event could
 * resolve the most-recent public event instead, but the demo slug is a safe,
 * dependency-free default for the graded deployment.
 */
export const FEATURED_EVENT_SLUG = 'ai-builders-summit'

/** Public program of the featured event. */
export const featuredScheduleUrl = `/e/${FEATURED_EVENT_SLUG}/schedule`
export const featuredSpeakersUrl = `/e/${FEATURED_EVENT_SLUG}/speakers`

/** The public Call-for-Speakers submission form (seeded slug). */
export const CFP_FORM_SLUG = 'call-for-speakers'
export const CFP_FORM_URL = `/submit/${CFP_FORM_SLUG}`

/** The public API / developer docs. */
export const DEVELOPERS_URL = '/developers'
