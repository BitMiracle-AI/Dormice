/**
 * The mock gate for pages whose server side does not exist yet (activity,
 * doctor, settings, per-sandbox metrics). In dev they render typed sample
 * data so the UI can be designed first; a production build hides them
 * entirely — a real deployment must never show a fake all-green health
 * report. The fixtures' TYPES are the proposed wire shapes: when the server
 * side lands, they graduate into @dormice/shared and the pages keep working.
 */
export const MOCK_PAGES_ENABLED = import.meta.env.DEV;
