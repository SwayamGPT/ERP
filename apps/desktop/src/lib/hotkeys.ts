import { useEffect, useRef } from 'react';

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
};

export function keyName(e: KeyboardEvent) {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey && e.key.length > 1) parts.push('shift');
  parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  return parts.join('+');
}

/**
 * Global shortcuts. Function keys always fire and always preventDefault (so F3 doesn't open
 * browser find, F5 doesn't reload). Plain character keys ("?", "n") are ignored while typing.
 */
export function useHotkeys(map: HotkeyMap, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const isF = /^F\d{1,2}$/.test(e.key);
      const name = keyName(e);
      const fn = ref.current[name] ?? (e.key === '?' ? ref.current['?'] : undefined);
      if (isF) e.preventDefault();
      if (!fn) return;
      const hasMod = e.ctrlKey || e.metaKey || e.altKey;
      if (!isF && !hasMod && e.key !== 'Escape' && isTyping(e.target)) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}
