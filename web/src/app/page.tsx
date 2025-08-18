"use client";
import { useAccount } from "wagmi";
import StatusCard from "@/components/StatusCard";
import LivePanel from "@/components/LivePanel";
import EnterCard from "@/components/EnterCard";
import WalletStatsCard from "@/components/WalletStatsCard";
import AdminCard from "@/components/AdminCard";

export default function Home() {
  const { address, isConnected } = useAccount();

  return (
    <main className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex-1 text-center">
          <h1 className="site-title">DAOwyn</h1>
          <p className="site-subtitle">Provably fair decentralized lottery on Hedera</p>
        </div>
        {/* Reown/Web3Modal injects this element */}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <StatusCard />
        <LivePanel />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <EnterCard />
        <WalletStatsCard />
      </div>

      {/* Admin moved to its own full-width row (double-wide on md+) */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="md:col-span-2">
          <AdminCard />
        </div>
      </div>
    </main>
  );
}