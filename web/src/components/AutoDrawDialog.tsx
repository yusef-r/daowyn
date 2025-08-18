'use client'
import React, { useEffect, useRef, useState } from 'react';
import useLotteryReads from '@/hooks/useLotteryReads';
import type { FeedEntry } from '@/types/feed';
import { useLotteryEvents } from '@/hooks/useLotteryEvents';
import { getExplorerTxUrl } from '@/lib/mirror';

export default function AutoDrawDialog() {
  const { willTriggerAt, isDrawing, roundId } = useLotteryReads();
  const { events } = useLotteryEvents();

  const [open, setOpen] = useState(false);
  const [countdownSec, setCountdownSec] = useState<number | null>(null);
  const [winner, setWinner] = useState<{ addr?: string; tx?: string; prize?: unknown } | null>(null);

  const openedRoundRef = useRef<number | undefined>(undefined);
  const dismissedRoundRef = useRef<number | undefined>(undefined);
  const wasDrawingRef = useRef<boolean>(false);

  useEffect(() => {
    // If already dismissed for this round, do not reopen
    if (willTriggerAt && !isDrawing && roundId !== undefined && dismissedRoundRef.current === roundId) {
      return;
    }
    if (willTriggerAt && !isDrawing) {
      setOpen(true);
      openedRoundRef.current = roundId;
    }
  }, [willTriggerAt, isDrawing, roundId]);

  // Listen for WinnerPicked events (client-only watcher)
  useEffect(() => {
    if (!events || events.length === 0) return;
    const ev = events.find((e: FeedEntry) => e.type === 'WinnerPicked');
    if (ev) {
      setWinner({ addr: ev.winner, tx: ev.txHash, prize: ev.prize });
      // Ensure dialog is open to show winner
      setOpen(true);
    }
  }, [events]);

  // Countdown based on server-supplied epoch ms
  useEffect(() => {
    if (!open || !willTriggerAt) {
      setCountdownSec(null);
      return;
    }
    if (willTriggerAt <= Date.now()) {
      setCountdownSec(0);
      return;
    }
    const tick = () => {
      const s = Math.max(0, Math.ceil((willTriggerAt - Date.now()) / 1000));
      setCountdownSec(s > 0 ? s : null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [open, willTriggerAt]);

  // Auto-close when the draw completes (round changes or drawing->not-drawing)
  useEffect(() => {
    if (!open) {
      wasDrawingRef.current = isDrawing;
      return;
    }
    if (openedRoundRef.current !== undefined && roundId !== undefined && roundId !== openedRoundRef.current) {
      setOpen(false);
      setWinner(null);
      dismissedRoundRef.current = undefined;
      return;
    }
    if (wasDrawingRef.current && !isDrawing) {
      setOpen(false);
      setWinner(null);
      dismissedRoundRef.current = undefined;
      return;
    }
    wasDrawingRef.current = isDrawing;
  }, [roundId, isDrawing, open]);

  const shortAddr = (a?: string) => {
    if (!a || a.length < 10) return a ?? '';
    return `${a.slice(0, 6)}…${a.slice(-4)}`;
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="relative w-full max-w-md rounded-lg bg-card p-6 shadow-lg dark:rounded-xl dark:shadow-[0_-10px_30px_rgba(255,255,255,0.10),0_14px_42px_rgba(0,0,0,0.6)] border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        {winner ? (
          <div>
            <h3 className="text-2xl font-extrabold">🎉 WE HAVE A WINNER!</h3>
            <p className="mt-2 text-lg font-semibold">{shortAddr(winner.addr)} — Congrats!</p>
            {winner.tx ? (
              <a
                href={getExplorerTxUrl(String(winner.tx))}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-block text-sm underline"
              >
                View transaction
              </a>
            ) : null}
          </div>
        ) : (
          <div>
            <h3 className="text-lg font-semibold">
              Get ready — Winner will be announced in {countdownSec !== null ? `${countdownSec}s!` : '…'}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">Pool locked — drawing will run automatically.</p>
            <div className="mt-4 text-3xl font-mono">{countdownSec !== null ? `${countdownSec}s` : 'Starting…'}</div>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button
            onClick={() => {
              // Dismiss for this round so it doesn't immediately reopen
              if (roundId !== undefined) dismissedRoundRef.current = roundId;
              setWinner(null);
              setOpen(false);
            }}
            className="text-sm underline"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}