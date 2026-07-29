import { ImageResponse } from 'next/og';

export const alt = 'Cashu Fault Lab — make Cashu delivery fail safely';
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = 'image/png';

const stages = [
  ['01', 'RESERVE'],
  ['02', 'DELIVER'],
  ['03', 'LOST'],
  ['04', 'RETRY'],
  ['05', 'RECOVER'],
  ['06', 'CREDIT'],
] as const;

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        background: '#09070d',
        color: '#f6ebd6',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'monospace',
        height: '100%',
        justifyContent: 'space-between',
        padding: '64px',
        width: '100%',
      }}
    >
      <div style={{ color: '#a855f7', display: 'flex', fontSize: 24, letterSpacing: 3 }}>
        CASHU FAULT LAB / EXPERIMENTAL DEVELOPER PREVIEW
      </div>
      <div
        style={{
          display: 'flex',
          fontFamily: 'sans-serif',
          fontSize: 76,
          fontWeight: 900,
          letterSpacing: -5,
          lineHeight: 0.95,
          maxWidth: 920,
        }}
      >
        Make Cashu delivery fail safely.
      </div>
      <div style={{ alignItems: 'stretch', display: 'flex', gap: 10 }}>
        {stages.map(([number, label], index) => (
          <div
            key={number}
            style={{
              background: index === 2 ? '#7f38ca' : '#2b0c4a',
              border: `2px solid ${index === 2 ? '#dcc099' : '#7f38ca'}`,
              color: index === 2 ? '#f6ebd6' : '#e9d4ae',
              display: 'flex',
              flex: 1,
              flexDirection: 'column',
              gap: 10,
              minHeight: 126,
              padding: '16px',
            }}
          >
            <div style={{ color: '#dcc099', display: 'flex', fontSize: 17 }}>{number}</div>
            <div style={{ display: 'flex', fontSize: 31 }}>{index === 2 ? 'FAULT' : 'STEP'}</div>
            <div style={{ display: 'flex', fontSize: 16, fontWeight: 700 }}>{label}</div>
          </div>
        ))}
      </div>
    </div>,
    size,
  );
}
