import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './styles.css';

export const metadata: Metadata = {
  title: 'Agora',
  description: 'A group-chat workspace for human-led multi-agent software development.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
