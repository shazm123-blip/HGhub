import { useSyncExternalStore } from "react";

export type ProgressSnapshot = {
  time: number;
  duration: number;
  buffered: number;
};

export type PlaybackProgressBus = {
  get: () => ProgressSnapshot;
  update: (patch: Partial<ProgressSnapshot>) => void;
  reset: () => void;
  subscribe: (fn: () => void) => () => void;
};

const ZERO: ProgressSnapshot = { time: 0, duration: 0, buffered: 0 };

/** 独立进度总线：隔离高频 timeupdate / progress 通知，避免整棵 Feed 组件树每秒重渲染 */
export function createProgressBus(): PlaybackProgressBus {
  let snap: ProgressSnapshot = ZERO;
  const listeners = new Set<() => void>();
  const notify = () => {
    listeners.forEach((fn) => fn());
  };
  return {
    get: () => snap,
    update: (patch) => {
      const nextTime = patch.time !== undefined ? patch.time : snap.time;
      const nextDur = patch.duration !== undefined ? patch.duration : snap.duration;
      const nextBuf = patch.buffered !== undefined ? patch.buffered : snap.buffered;
      const timeChanged =
        patch.time !== undefined &&
        (nextTime === 0 ? snap.time !== 0 : Math.abs(nextTime - snap.time) >= 0.05);
      const bufChanged =
        patch.buffered !== undefined &&
        (nextBuf === 0 || nextBuf === 1
          ? snap.buffered !== nextBuf
          : Math.abs(nextBuf - snap.buffered) >= 0.005);
      const durChanged = patch.duration !== undefined && nextDur !== snap.duration;
      if (!timeChanged && !bufChanged && !durChanged) return;
      snap = { time: nextTime, duration: nextDur, buffered: nextBuf };
      notify();
    },
    reset: () => {
      if (snap === ZERO) return;
      snap = ZERO;
      notify();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

const noopSubscribe = () => () => {};
const getNull = () => null;

export function useProgress(bus?: PlaybackProgressBus): ProgressSnapshot | null {
  return useSyncExternalStore(
    bus ? bus.subscribe : noopSubscribe,
    bus ? bus.get : getNull,
  );
}
