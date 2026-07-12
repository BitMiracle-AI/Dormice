/**
 * The mock gate for pages whose server side does not exist yet — today only
 * the doctor page (activity, settings and per-sandbox metrics graduated to
 * real endpoints 2026-07-11). In dev it renders typed sample data so the UI
 * can be designed first; a production build hides it entirely — a real
 * deployment must never show a fake all-green health report. The fixtures'
 * TYPES are the proposed wire shapes: when the server side lands, they
 * graduate into @dormice/shared and the page keeps working.
 */
export const MOCK_PAGES_ENABLED = import.meta.env.DEV;
