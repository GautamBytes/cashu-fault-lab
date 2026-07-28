'use client';

import type { ButtonHTMLAttributes } from 'react';

export function OpenSearchButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        window.dispatchEvent(new Event('cashu-fault-lab:open-search'));
      }}
      type="button"
    />
  );
}
