// Release switches only affect presentation; server authentication never falls back.
export const featureFlags = {
  collaboration: import.meta.env.VITE_CODE_TAPE_COLLABORATION_ENABLED !== "false",
  eventTimeline: import.meta.env.VITE_CODE_TAPE_EVENT_TIMELINE_ENABLED !== "false",
  subtitleAnchors: import.meta.env.VITE_CODE_TAPE_SUBTITLE_ANCHORS_ENABLED !== "false",
};
