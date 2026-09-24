import type {Metadata} from 'next';
import './globals.css'; // Global styles

export const metadata: Metadata = {
  title: 'Cryptorium // Automated Futures Engine',
  description: 'Automated Binance USDT-M Futures trading platform UI shell and dark-mode dashboard.',
  openGraph: {
    title: 'Cryptorium // Automated Futures Engine',
    description: 'Automated Binance USDT-M Futures trading platform UI shell and dark-mode dashboard.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Cryptorium // Automated Futures Engine',
    description: 'Automated Binance USDT-M Futures trading platform UI shell and dark-mode dashboard.',
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
