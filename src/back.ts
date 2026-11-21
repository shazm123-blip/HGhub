/** 全局返回拦截栈与播放锁状态：弹层/面板按 LIFO 消费返回，播放锁定时拦截全局快捷键。 */
type Handler = () => boolean;

const stack: Handler[] = [];
let legacyHandler: Handler | null = null;
let playbackLocks = 0;

export function pushBackHandler(h: Handler): () => void {
  stack.push(h);
  return () => {
    const idx = stack.lastIndexOf(h);
    if (idx >= 0) stack.splice(idx, 1);
  };
}

export function setBackHandler(h: Handler | null) {
  legacyHandler = h;
}

export function hasBackHandler(): boolean {
  return stack.length > 0 || legacyHandler !== null;
}

/** 返回 true 表示已被消费（不再退栈） */
export function runBack(): boolean {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    try {
      if (stack[i]()) return true;
    } catch {
      /* ignore */
    }
  }
  try {
    return legacyHandler ? legacyHandler() : false;
  } catch {
    return false;
  }
}

export function acquirePlaybackLock(): () => void {
  playbackLocks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    playbackLocks = Math.max(0, playbackLocks - 1);
  };
}

export function isPlaybackLocked(): boolean {
  return playbackLocks > 0;
}