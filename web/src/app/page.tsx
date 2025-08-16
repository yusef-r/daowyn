"use client";
import { useAccount } from "wagmi";
import StatusCard from "@/components/StatusCard";
import WinnerCard from "@/components/WinnerCard";
import EnterCard from "@/components/EnterCard";
import AdminCard from "@/components/AdminCard";
import WheelPanel from "@/components/WheelPanel";

export default function Home() {
  const { address, isConnected } = useAccount();

  return (
    <main className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">daowyn</h1>
        {/* Reown/Web3Modal injects this element */}
      </div>

      <p className="text-sm text-muted-foreground">
        {isConnected ? `Connected: ${address}` : "Not connected"}
      </p>

      <div className="grid gap-6 md:grid-cols-2">
        <WheelPanel className="md:col-span-2" />
        <StatusCard />
        <WinnerCard />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <EnterCard />
        <AdminCard />
      </div>
    </main>
  );
}