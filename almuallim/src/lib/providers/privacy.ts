/**
 * Every model call asks the provider NOT to store the request/response objects (OpenAI Responses `store:false`).
 * This reduces provider-side retention but does not by itself prove "no training / no retention": that depends on
 * the school's agreement with the provider (API data is not used for training by default under OpenAI's API terms —
 * verify in your DPA, and prefer a zero-data-retention arrangement for production).
 */
export const NO_STORE = { openai: { store: false } } as const;
