export { trace, type TraceOptions } from './trace.js';
export { narrate, narrateWhy } from './narrate.js';
export {
    synthesizeWhy,
    buildWhyPrompt,
    WHY_PROVIDERS,
    type WhyOptions,
    type WhyProvider,
} from './why.js';
export { parseLog } from './parse.js';
export { parseHunks, mapToHead, type Hunk, type Mapped } from './drift.js';
export type { Lineage, LineEvent, Drift } from './types.js';
