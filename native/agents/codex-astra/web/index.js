import { registerPlugin } from '@capacitor/core';

const unavailable = async () => {
  throw Object.assign(new Error('Native player is unavailable'), { code: 'unavailable' });
};

const NativePlayer = registerPlugin('NativePlayer', {
  web: async () => ({
    isAvailable: async () => ({ available: false, containers: [] }),
    hasRom: unavailable,
    start: unavailable,
    pause: unavailable,
    resume: unavailable,
    reset: unavailable,
    stop: unavailable,
    saveState: unavailable,
    loadState: unavailable,
    listStates: unavailable,
    getStateBase64: unavailable,
    loadStateBase64: unavailable,
    setPadVisible: unavailable,
    setPadEnabled: unavailable,
    setScaling: unavailable,
    setOption: unavailable,
    setStatsVisible: unavailable,
    getStats: unavailable,
    deleteGame: unavailable,
    addListener: unavailable,
    removeAllListeners: unavailable,
  }),
});

export { NativePlayer };
