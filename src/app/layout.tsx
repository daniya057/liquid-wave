import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Liquid Wave',
  description: 'Музыкальный плеер',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body>
        {children}
        <div
          id="yt-global-player"
          aria-hidden="true"
          style={{
            position: 'fixed',
            bottom: 0,
            right: 0,
            width: '1px',
            height: '1px',
            opacity: 0.01,
            pointerEvents: 'none',
            zIndex: -1,
          }}
        />
      </body>
    </html>
  );
}