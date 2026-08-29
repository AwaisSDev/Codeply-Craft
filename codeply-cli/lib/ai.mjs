import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ai = require('../lib/ai.js');
export default ai;
export const { chat, chatJson, isRateLimitError } = ai;
