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
            top: '0px',
            left: '-9999px',
            width: '320px',
            height: '180px',
            pointerEvents: 'none',
          }}
        />
      </body>
    </html>
  );
}