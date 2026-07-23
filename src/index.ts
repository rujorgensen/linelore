export { trace, traceFunc, type TraceOptions } from './trace.js';
export { findFunction, isFuncName, type FuncSpan } from './func.js';
export { narrate, narratePulls, narrateWhy } from './narrate.js';
export {
    synthesizeWhy,
    buildWhyPrompt,
    WHY_PROVIDERS,
    type WhyOptions,
    type WhyProvider,
} from './why.js';
export {
    withPullDiscussions,
    parseGitHubRemote,
    type PrOptions,
    type GitHubRepo,
} from './pr.js';
export {
    parseTarget,
    type Target,
    type TargetCandidate,
} from './permalink.js';
export { loreFor, serve, DEFAULT_PORT, type Resolved } from './serve.js';
export { parseLog } from './parse.js';
export { parseHunks, mapToHead, type Hunk, type Mapped } from './drift.js';
export type {
    Lineage,
    LineEvent,
    Drift,
    PullDiscussion,
    PullComment,
} from './types.js';
