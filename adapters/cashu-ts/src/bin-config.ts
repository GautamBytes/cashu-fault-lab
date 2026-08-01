export function adapterListenHost(value: string | undefined): string {
  const host = value ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new Error('CFL_CASHU_TS_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  return host;
}

export function lifecycleListenHost(value: string | undefined, lifecycleEnabled: boolean): string {
  const host = adapterListenHost(value);
  if (lifecycleEnabled && host !== '127.0.0.1') {
    throw new Error('CFL_CASHU_TS_HOST must be 127.0.0.1 when lifecycle mode is enabled');
  }
  return host;
}
