'use client';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Callout } from '@radix-ui/themes';

type ToastTone = 'ok' | 'error' | 'info';
type ToastItem = { id: number; tone: ToastTone; title: string; detail?: string };
type ToastOptions = { tone?: ToastTone; title: string; detail?: string };

const ToastContext = createContext<{ toast: (options: ToastOptions) => void }>({ toast: () => undefined });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);
  const toast = useCallback((options: ToastOptions) => {
    const id = nextId.current;
    nextId.current += 1;
    setItems((current) => [...current.slice(-2), { id, tone: options.tone ?? 'info', title: options.title, detail: options.detail }]);
    window.setTimeout(() => dismiss(id), 5000);
  }, [dismiss]);
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className='forja-toasts' role='region' aria-label='Notificaciones' aria-live='polite'>
        {items.map((item) => (
          <div key={item.id} className='forja-toast' data-tone={item.tone}>
            <Callout.Root color={item.tone === 'error' ? 'red' : item.tone === 'ok' ? 'green' : 'blue'} role='status'>
              <Callout.Text>{item.title}</Callout.Text>
              {item.detail ? <Callout.Text>{item.detail}</Callout.Text> : null}
            </Callout.Root>
            <button type='button' className='forja-toast-close' onClick={() => dismiss(item.id)} aria-label='Descartar notificación'>×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
