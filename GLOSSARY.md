# Sunny Pastures

A cosy farm and bakery idle game in which the server owns time and the rules, and a farm keeps
producing while its player is away.

## Language

### Time and rules

**Simulation**:
The game rules: the one source of truth for how a farm changes, shared by client and server.
_Avoid_: engine, game logic, reducer

**Farm**:
Everything one player owns and has produced: plots, buildings, goods and their timers.
_Avoid_: game state, save, account

**Action**:
Something a player chooses to do to their farm (plant, harvest, bake), stamped with the server
time at which it takes effect. An action the rules refuse is rejected and leaves no trace.
_Avoid_: command, event, move, input

**Sequence number**:
The position of an accepted action in its farm's history: the first is 1, the next is 2, with no
gaps. A farm "at sequence number 17" has had exactly 17 actions accepted. Written `seq` for short.
_Avoid_: version, revision, counter

**Replay**:
Rebuilding a farm by applying its accepted actions again, in sequence-number order.
_Avoid_: recompute, re-run, rebuild

**Server time**:
The only clock the game trusts. A device's clock never decides when anything happens.
_Avoid_: client time, device time, now

**Offline progress**:
What a farm produces between a player's last action and their return, computed when they come
back rather than while they are away.
_Avoid_: idle income, catch-up, background ticks

### Between players

**Gift**:
Goods one player sends to another. The goods leave the sender's farm when it is sent, and reach
the recipient's farm only when the recipient claims it.
_Avoid_: present, transfer, trade

**Claim**:
The recipient's own action that moves a gift's goods into their farm.
_Avoid_: accept, receive, open

### Client and server agreement

**Prediction**:
The client's own result of an action, shown immediately before the server has confirmed it.
_Avoid_: optimistic update, local state

**Reconciliation**:
Replacing a prediction with the server's result when the two disagree.
_Avoid_: sync, rollback, correction

**State hash**:
A fingerprint of a farm's state, used to tell whether two copies of it agree exactly.
_Avoid_: checksum, version
