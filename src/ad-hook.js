// Ad break hook. This default does nothing, so the player runs ad-free on its own (web build,
// Android EmulatorJS tests). A host app can supply a real implementation by aliasing this module
// at build time. Contract: gate(trigger, opts) always resolves { shown, reason } and never throws;
// trigger is "start" | "exit" | "pause" | "link-start".
export const adHook = {
  gate: async () => ({ shown: false, reason: "none" }),
  supported: false,
};
