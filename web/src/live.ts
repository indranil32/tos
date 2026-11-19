import { useEffect, useRef, useState } from 'react';
import { currentFacility } from './api';
import { currentUser } from './auth';

export interface LiveEvent {
  id: number;
  type: string;
  aggregateType: string;
  aggregateId: string;
  facility: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

type Listener = (e: LiveEvent) => void;
export type LiveState = 'connecting' | 'live' | 'offline';

/**
 * One shared Server-Sent Events connection for the whole app (fetch-based, so the token goes in the
 * Authorization header and never in a URL). Reconnects with Last-Event-ID, so nothing is missed.
 */
class LiveStream {
  private listeners = new Set<Listener>();
  private stateListeners = new Set<(s: LiveState) => void>();
  private ctrl?: AbortController;
  private lastId?: number;
  private facility?: string | null;
  private retry = 0;
  state: LiveState = 'offline';

  subscribe(l: Listener) {
    this.listeners.add(l);
    this.ensure();
    return () => {
      this.listeners.delete(l);
    };
  }

  onState(l: (s: LiveState) => void) {
    this.stateListeners.add(l);
    l(this.state);
    this.ensure();
    return () => {
      this.stateListeners.delete(l);
    };
  }

  private setState(s: LiveState) {
    this.state = s;
    for (const l of this.stateListeners) l(s);
  }

  private ensure() {
    const facility = currentFacility();
    if (this.ctrl && this.facility === facility) return;
    this.ctrl?.abort();
    this.facility = facility;
    this.lastId = undefined;
    void this.run();
  }

  private async run() {
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.setState('connecting');
    try {
      const user = await currentUser();
      if (!user) throw new Error('signed out');
      const q = this.facility ? `?facility=${encodeURIComponent(this.facility)}` : '';
      const headers: Record<string, string> = { Authorization: `Bearer ${user.access_token}`, Accept: 'text/event-stream' };
      if (this.lastId !== undefined) headers['Last-Event-ID'] = String(this.lastId);
      const res = await fetch(`/v1/stream${q}`, { headers, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      this.retry = 0;
      this.setState('live');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          this.handle(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
        }
      }
    } catch {
      if (ctrl.signal.aborted) return;
    }
    if (ctrl.signal.aborted) return;
    this.setState('offline');
    this.ctrl = undefined;
    const wait = Math.min(30_000, 1000 * 2 ** this.retry++);
    setTimeout(() => {
      if (!this.ctrl && (this.listeners.size || this.stateListeners.size)) void this.run();
    }, wait);
  }

  private handle(block: string) {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
      else if (line.startsWith('id: ')) this.lastId = Number(line.slice(4));
    }
    if (!data || event === 'ready') return;
    try {
      const e = JSON.parse(data) as LiveEvent;
      for (const l of this.listeners) l(e);
    } catch {
      /* ignore malformed */
    }
  }
}

export const live = new LiveStream();

/**
 * Call onEvent for live events whose type starts with one of the prefixes (e.g. 'work.', 'equipment.').
 * Calls are debounced so a burst of events triggers one refresh.
 */
export function useLive(prefixes: string[], onEvent: (e: LiveEvent) => void, debounceMs = 300) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const key = prefixes.join('|');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: LiveEvent | undefined;
    const off = live.subscribe((e) => {
      if (!key.split('|').some((p) => e.type.startsWith(p))) return;
      last = e;
      clearTimeout(timer);
      timer = setTimeout(() => last && cb.current(last), debounceMs);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [key, debounceMs]);
}

export function useLiveState(): LiveState {
  const [s, setS] = useState<LiveState>(live.state);
  useEffect(() => live.onState(setS), []);
  return s;
}
