#!/usr/bin/env node
;(async () => {
  try {
    const HEDERA_RPC_URL = process.env.HEDERA_RPC_URL || 'https://testnet.hashio.io/api';
    const MIRROR_BASE = process.env.MIRROR_BASE || 'https://testnet.mirrornode.hedera.com';
    const ADDR = '0x3cc8b5b306931a48e55c0835ff39fba61052824f'.toLowerCase();

    const { keccak256, toBytes } = await import('viem');
    const fetch = globalThis.fetch || (await import('node-fetch')).default;

    function sel(sig) {
      const h = keccak256(toBytes(sig));
      return '0x' + h.slice(2, 10);
    }
    function topic(sig) {
      const h = keccak256(toBytes(sig));
      return h.toLowerCase();
    }

    const ownerSel = sel('owner()');
    const participantSel = sel('participantCount()');
    const debugSel = sel('debugUnits()');
    const poolTargetSel = sel('POOL_TARGET()');
    const enteredTopic = topic('EnteredPool(address,uint256)');
    const winnerTopic = topic('WinnerPicked(address,uint256)');

    async function rpc(method, params) {
      const res = await fetch(HEDERA_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await res.json().catch(() => ({}));
      return j;
    }

    const chainJ = await rpc('eth_chainId', []);
    const rpcChainId = chainJ && chainJ.result ? parseInt(chainJ.result, 16) : null;

    const ownerJ = await rpc('eth_call', [{ to: ADDR, data: ownerSel }, 'latest']);
    const ownerOnchain = ownerJ && ownerJ.result ? '0x' + ownerJ.result.replace(/^0x/, '').slice(-40).toLowerCase() : null;

    const participantJ = await rpc('eth_call', [{ to: ADDR, data: participantSel }, 'latest']);
    const participantCountOnchain = participantJ && participantJ.result ? Number(BigInt(participantJ.result)) : null;

    const balanceJ = await rpc('eth_getBalance', [ADDR, 'latest']);
    const balanceHex = balanceJ && balanceJ.result ? balanceJ.result : null;
    const balanceDec = balanceHex ? BigInt(balanceHex).toString() : null;

    // Mirror queries: timestamps
    const nowMs = Date.now();
    const endSecs = Math.floor(nowMs / 1000);
    const start24Secs = endSecs - 24 * 60 * 60;
    const start7Secs = endSecs - 7 * 24 * 60 * 60;

    const mirrorBaseClean = MIRROR_BASE.replace(/\/$/, '');

    const globalUrl = `${mirrorBaseClean}/api/v1/contracts/results/logs?address=${ADDR}&topic0=${encodeURIComponent(enteredTopic)}&timestamp=gte:${start24Secs}.000000000&timestamp=lt:${endSecs}.000000000&order=asc&limit=200`;
    const globalRes = await fetch(globalUrl).catch(() => null);
    const globalJson = globalRes ? await globalRes.json().catch(() => ({})) : {};
    const globalLogs = Array.isArray(globalJson.logs) ? globalJson.logs : [];
    const globalCount = globalLogs.length;
    const globalSample = globalLogs.slice(0, 2).map(l => ({ ts: l.consensus_timestamp || l.timestamp || '', topics: l.topics || [l.topic0, l.topic1, l.topic2, l.topic3] }));

    const perUrl = `${mirrorBaseClean}/api/v1/contracts/${encodeURIComponent(ADDR)}/results/logs?topic0=${encodeURIComponent(enteredTopic)}&timestamp=gte:${start24Secs}.000000000&timestamp=lt:${endSecs}.000000000&order=asc&limit=200`;
    const perRes = await fetch(perUrl).catch(() => null);
    const perText = perRes ? await perRes.text().catch(() => '') : '';
    let perJson = {};
    try { perJson = perText ? JSON.parse(perText) : {}; } catch {}
    const perLogs = Array.isArray(perJson.logs) ? perJson.logs : [];
    const perCount = perLogs.length;
    const perSize = perText.length;

    const winUrl = `${mirrorBaseClean}/api/v1/contracts/results/logs?address=${ADDR}&topic0=${encodeURIComponent(winnerTopic)}&timestamp=gte:${start7Secs}.000000000&timestamp=lt:${endSecs}.000000000&order=desc&limit=200`;
    const winRes = await fetch(winUrl).catch(() => null);
    const winJson = winRes ? await winRes.json().catch(() => ({})) : {};
    const winLogs = Array.isArray(winJson.logs) ? winJson.logs : [];
    const winCount = winLogs.length;
    const winSample = winLogs.slice(0, 2).map(l => ({ ts: l.consensus_timestamp || l.timestamp || '', topics: l.topics || [l.topic0, l.topic1, l.topic2, l.topic3] }));

    console.log(JSON.stringify({
      rpcChainId,
      ownerOnchain,
      participantCountOnchain,
      balanceHex,
      balanceDec,
      mirror: {
        entered: { globalCount, globalSample, perCount, perSize },
        winner: { winCount, winSample },
        topics: { enteredTopic, winnerTopic },
        urls: { globalUrl, perUrl, winUrl }
      },
      selectors: { ownerSel, participantSel, poolTargetSel, debugSel }
    }, null, 2));

    process.exit(0);
  } catch (err) {
    console.error('ERR', String(err));
    process.exit(1);
  }
})();