// Settings you may need to edit.

/** Address of your creao-proxy (see the README step). Leave '' to use only the built-in exercise generator. */
export const PROXY_URL = ''

/** DIRECT MODE (no server): the key comes from tuner/.env (VITE_CREAO_KEY=capi_...), which is NOT uploaded to GitHub.
 *  It is still baked into the built app, so anyone who unzips it can read it. Use a throwaway, usage-capped key. */
export const CREAO_KEY: string = import.meta.env.VITE_CREAO_KEY ?? ''
export const CREAO_APP_ID = '285982da-0286-40e9-90b4-0b877daa723c'

/** Instrument used until the speech step saves one (voice, violin, flute, clarinet, trumpet, altosax, guitar, piano). */
export const DEFAULT_INSTRUMENT = 'voice'

/** How long the "getting your music ready" screen may wait for the agent. */
export const BUFFER_MAX_MS = 20_000

/** Test buttons on the phone screen: skip ahead without playing, and see whether exercises came from Creao.
 *  Set to false before you submit. */
export const DEMO_TOOLS = true


export const VOICE_SERVER_URL = import.meta.env.VITE_VOICE_SERVER_URL ?? ''

