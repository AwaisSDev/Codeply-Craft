import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const auth = require('./auth.js');
export default auth;
export const { SUPABASE_URL, SUPABASE_ANON_KEY, getClient, login, logout, getSession, getAccessToken } = auth;
