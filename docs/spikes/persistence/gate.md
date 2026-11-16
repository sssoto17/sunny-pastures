# Equivalence gate: one script, one hash, every store

Part of the persistence spike (ADR-0001 "Decision rule", step 1; issue #9). It asks whether every
store keeps a farm exactly as the in-memory sim computes it, so the load runs (#11) only measure
stores that are correct. The gate is `prototypes/persistence/src/gate.ts` on
`prototype/persistence`.

## What runs

1. **Step 0** (`gate0.ts`, #6), with no database: the 500-action script (seed 42, an 8-hour gap, 44
   refused actions) runs twice and is replayed from in-memory snapshots at N = 1, 25 and 100. Every
   run must give one state hash. Step 0 decides how any later failure is labelled: if it fails, the
   **sim** is at fault; if it passes, the **store** that fails is.
2. **Per store** (A, B1, B25, B100), each in its own throwaway schemas: the same script is played
   through the store itself, with each step's own time and no HTTP. Each step is the handler's loop
   without its clock: `load` → `apply` at the step's time → `commit`.
   - **Round trip:** after every commit the next `load` must be strictly deep-equal
     (`isDeepStrictEqual`, so types count) to the in-memory farm, with the same `seq` and `at`.
   - **Script:** the farm the store loads at the end must have step 0's state hash and seq, and the
     store must accept and refuse exactly the steps the in-memory sim does.
   - **stateAt** (B only): at 10 random times and at the middle of the 8-hour gap, `stateAt` must
     return the same `{ state, seq }` as the in-memory sim (the accepted actions up to `t`, then
     advanced to `t`). The random times come from a seeded draw: a random step, then a moment from
     that step up to just before the next. Every B variant is asked at the same times.
   - **The gap audit time** (added for #15, before the load matrix): the draw by step lands in the
     gap only about once in 50, and seed 42's ten random times all miss it. Offline progress is the
     core of the research question, so the gate always adds one fixed time halfway between the last
     step before the gap and the first one after it. There the farm has had no action for 4 hours,
     so `stateAt` has to advance it through offline progress to match the sim.
3. The schemas are dropped when the run ends.

**Gifts.** The script claims gifts it makes up (`alice:7`), and the inbox refuses a claim of a gift
that doesn't exist (#8). Before each store's run, a fresh inbox schema is seeded with every gift the
script claims (`inbox.send`, sent at time 0 to the gate's farm, with the claimed goods). The script
and the step 0 hashes stay unchanged, and no run can see another run's gifts.

## Results

Run on 6 Nov 2026 in a cloud container: Node v24.22.2, PostgreSQL 16.15 on the same host, 4 CPUs.
Rerun the same day with the gap audit time (#15): unchanged except for the eleventh `stateAt` row.

<!-- prettier-ignore -->
| | A | B1 | B25 | B100 |
| --- | --- | --- | --- | --- |
| Gate | **pass** | **pass** | **pass** | **pass** |
| Final seq (step 0: 456) | 456 | 456 | 456 | 456 |
| Final state hash = step 0's | yes | yes | yes | yes |
| Round trips strictly equal | 456/456 | 456/456 | 456/456 | 456/456 |
| `stateAt` matches the sim | n/a (no history) | 11/11 | 11/11 | 11/11 |
| …of which the gap's middle (t = 16,366,000 ms, seq 225) | n/a | match | match | match |

Step 0 and every store end on the state hash
`e1925b02b5840ff7de506ccfa6db285b477aac1001d717e626dbdd3456968afc`. No failures, so nothing to
label. Seeds 7 and 2026 also pass in every store (seq 445 and 465), including their gap audit times
(t = 16,377,000 ms at seq 221, and t = 16,545,000 ms at seq 236).

For seed 42 the gap runs from 1,966,000 ms (the last step before it) to 30,766,000 ms (the first
after it), so its middle is 16,366,000 ms. The farm there is at seq 225 with state hash
`9c457260d1f25332394e2ccb58e0c19449511c6596953e5879fbdedddf88bb75` in B1, B25, B100 and the sim.

The full output for seed 42:

```text
Gate step 0 (ADR-0001): in-memory determinism, no database
script: seed 42, 500 actions (456 accepted, 44 refused), script hash 80975a094f8278824c1c9604100b6d3e9a0f37c4f7bbbfe20e6fa55eaab4eb37

run 1          e1925b02b5840ff7de506ccfa6db285b477aac1001d717e626dbdd3456968afc
run 2          e1925b02b5840ff7de506ccfa6db285b477aac1001d717e626dbdd3456968afc
replay N=1     e1925b02b5840ff7de506ccfa6db285b477aac1001d717e626dbdd3456968afc
replay N=25    e1925b02b5840ff7de506ccfa6db285b477aac1001d717e626dbdd3456968afc
replay N=100   e1925b02b5840ff7de506ccfa6db285b477aac1001d717e626dbdd3456968afc

PASS: every run gives the same state hash

Gate step 1 (ADR-0001): the same script through each store, called directly with explicit times

A     PASS  seq 456  hash e1925b02b5840ff7de506ccfa6db285b477aac1001d717e626dbdd3456968afc  round trips 456/456  stateAt n/a (no history)
B1    PASS  seq 456  hash e1925b02b5840ff7de506ccfa6db285b477aac1001d717e626dbdd3456968afc  round trips 456/456  stateAt 11/11
        stateAt t=   23082  seq   4  c1de21acdbf7d95c1716b3c730392d003f7202a3d90a3424d4f5c90b8d4f5dd0  match
        stateAt t=  619917  seq  70  80929999b710cc8f6bc8e5b58182d798012542ab20bbfd2ba1c1806d774770a5  match
        stateAt t=  681899  seq  73  ef87ec7c200c8aa3ca85d6a2e7de5dade3346e760ca545b45c1b7d98502336f2  match
        stateAt t=  989087  seq 108  30cd313fd041cd2d38b31393903607cd8a81cdb9e4386e21018b0e00ce3afb75  match
        stateAt t= 1588350  seq 180  8e8fdb07158f566286120fbf57579ad93b2496c5b8e09f2a4180bdd438e65777  match
        stateAt t=16366000  seq 225  9c457260d1f25332394e2ccb58e0c19449511c6596953e5879fbdedddf88bb75  match  (middle of the 8-hour gap)
        stateAt t=31098009  seq 264  a5b99a8ad874cf32555bfd266ff806f23371b327dff1d341b0e9ac39f726a8e5  match
        stateAt t=31466262  seq 311  ae1f507a61f51d8b8deec8bd6449298080242c7df9f303fc64e634ecc48a9686  match
        stateAt t=31921860  seq 362  f6e133e75d71c2ea86d955d93b970f1a8a6b2ab1bacdfde1e9d7dbab1a73dec6  match
        stateAt t=31946712  seq 364  a373a23085813f8188d5b43e9a71e0fec3c3a0c8083972b1a31b4d99a26d2342  match
        stateAt t=32711090  seq 452  a3e7a8f4fb2d7021efa152f768c7a7bd95b2706621730ee2f92086a4b4bd47d0  match
B25   PASS  seq 456  hash e1925b02b5840ff7de506ccfa6db285b477aac1001d717e626dbdd3456968afc  round trips 456/456  stateAt 11/11
        stateAt t=   23082  seq   4  c1de21acdbf7d95c1716b3c730392d003f7202a3d90a3424d4f5c90b8d4f5dd0  match
        stateAt t=  619917  seq  70  80929999b710cc8f6bc8e5b58182d798012542ab20bbfd2ba1c1806d774770a5  match
        stateAt t=  681899  seq  73  ef87ec7c200c8aa3ca85d6a2e7de5dade3346e760ca545b45c1b7d98502336f2  match
        stateAt t=  989087  seq 108  30cd313fd041cd2d38b31393903607cd8a81cdb9e4386e21018b0e00ce3afb75  match
        stateAt t= 1588350  seq 180  8e8fdb07158f566286120fbf57579ad93b2496c5b8e09f2a4180bdd438e65777  match
        stateAt t=16366000  seq 225  9c457260d1f25332394e2ccb58e0c19449511c6596953e5879fbdedddf88bb75  match  (middle of the 8-hour gap)
        stateAt t=31098009  seq 264  a5b99a8ad874cf32555bfd266ff806f23371b327dff1d341b0e9ac39f726a8e5  match
        stateAt t=31466262  seq 311  ae1f507a61f51d8b8deec8bd6449298080242c7df9f303fc64e634ecc48a9686  match
        stateAt t=31921860  seq 362  f6e133e75d71c2ea86d955d93b970f1a8a6b2ab1bacdfde1e9d7dbab1a73dec6  match
        stateAt t=31946712  seq 364  a373a23085813f8188d5b43e9a71e0fec3c3a0c8083972b1a31b4d99a26d2342  match
        stateAt t=32711090  seq 452  a3e7a8f4fb2d7021efa152f768c7a7bd95b2706621730ee2f92086a4b4bd47d0  match
B100  PASS  seq 456  hash e1925b02b5840ff7de506ccfa6db285b477aac1001d717e626dbdd3456968afc  round trips 456/456  stateAt 11/11
        stateAt t=   23082  seq   4  c1de21acdbf7d95c1716b3c730392d003f7202a3d90a3424d4f5c90b8d4f5dd0  match
        stateAt t=  619917  seq  70  80929999b710cc8f6bc8e5b58182d798012542ab20bbfd2ba1c1806d774770a5  match
        stateAt t=  681899  seq  73  ef87ec7c200c8aa3ca85d6a2e7de5dade3346e760ca545b45c1b7d98502336f2  match
        stateAt t=  989087  seq 108  30cd313fd041cd2d38b31393903607cd8a81cdb9e4386e21018b0e00ce3afb75  match
        stateAt t= 1588350  seq 180  8e8fdb07158f566286120fbf57579ad93b2496c5b8e09f2a4180bdd438e65777  match
        stateAt t=16366000  seq 225  9c457260d1f25332394e2ccb58e0c19449511c6596953e5879fbdedddf88bb75  match  (middle of the 8-hour gap)
        stateAt t=31098009  seq 264  a5b99a8ad874cf32555bfd266ff806f23371b327dff1d341b0e9ac39f726a8e5  match
        stateAt t=31466262  seq 311  ae1f507a61f51d8b8deec8bd6449298080242c7df9f303fc64e634ecc48a9686  match
        stateAt t=31921860  seq 362  f6e133e75d71c2ea86d955d93b970f1a8a6b2ab1bacdfde1e9d7dbab1a73dec6  match
        stateAt t=31946712  seq 364  a373a23085813f8188d5b43e9a71e0fec3c3a0c8083972b1a31b4d99a26d2342  match
        stateAt t=32711090  seq 452  a3e7a8f4fb2d7021efa152f768c7a7bd95b2706621730ee2f92086a4b4bd47d0  match

PASS: every store ends on step 0's hash, loads every commit back strictly equal, and every B's stateAt matches the sim
```

## Checks that the gate can fail

`gate.test.ts` runs the gate on deliberately broken stores, and each one fails as it should:

- Store A, except that the commit after action 100 stores one extra bread: the round trip fails at
  seq 101 (100 of 456 round trips pass), the final hash differs, and every failure is labelled
  store.
- B25 with `stateAt` answering seq + 1: the script still ends on the right hash, but all 10
  `stateAt` checks fail, labelled store.
- B100 whose `stateAt` answers, for any time inside the gap, with the farm as it was when the player
  left: only the gap check fails (the 10 random times still match), labelled store.
- B1 whose `load` throws: B1 fails with the error, labelled store; A in the same run still passes.
- Rules with hidden state (one accepted action in 97 adds a wheat): step 0 fails, and every store
  failure is labelled sim.
- Without the inbox seeding, every store stops at step 7: the inbox refuses `no gift alice:7`.
  (Checked once by hand, then restored.)

## Run it

```bash
pnpm --filter @sunny-pastures/persistence-spike gate
```

Optional argument: the script seed (default 42). It reads `DATABASE_URL` from the repo `.env` and
never prints it. It exits 1 if the gate fails.
