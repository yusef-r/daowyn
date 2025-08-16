'use client'

import { APPKIT_READY } from '@/lib/appkit-init.client'
void APPKIT_READY
import "./globals.css";
import dynamic from 'next/dynamic';
import { Toaster } from "sonner";
import NetworkBadge from "@/components/NetworkBadge";
import WalletButton from "@/components/WalletButton";
import Link from "next/link";
import { EventsProvider } from "./providers/events";

const Providers = dynamic(() => import('./providers'), { ssr: false })

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <EventsProvider>
            <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
              <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
                <Link href="/" className="text-sm font-semibold">
                  daowyn
                </Link>
                <div className="flex items-center gap-2">
                  <NetworkBadge />
                  <WalletButton variant="primary" size="md" />
                </div>
              </div>
            </header>
            <main className="mx-auto w-full max-w-6xl px-4 py-6">{children}</main>
          </EventsProvider>
        </Providers>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}