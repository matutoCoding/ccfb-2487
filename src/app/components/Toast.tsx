import { useEffect, useState } from 'react';

type Toast = { id: number; message: string; kind: 'error' | 'info' };

let pushExternal: ((message: string, kind?: 'error' | 'info') => void) | null = null;

export function toast(message: string, kind: 'error' | 'info' = 'error'): void {
  pushExternal?.(message, kind);
}

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    pushExternal = (message, kind = 'error') => {
      const id = Date.now() + Math.random();
      setItems((prev) => [...prev, { id, message, kind }]);
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 5000);
    };
    return () => {
      pushExternal = null;
    };
  }, []);
  return (
    <>
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'info' ? 'info' : ''}`}>
          {t.message}
        </div>
      ))}
    </>
  );
}
