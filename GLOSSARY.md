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

**Snapshot**:
A stored copy of a farm as it was after one sequence number, kept so a replay can start from it
instead of from the first action. The log is the source of truth; a snapshot is a cache of it.
_Avoid_: save, checkpoint, backup

**Rules version**:
A whole number naming one frozen set of content, and so one version of the rules. Every logged
action and every snapshot records the rules version it was written under. A change to content
after release adds a new rules version; it never edits a released one.
_Avoid_: content version, schema version, revision

**Upgrade**:
Bringing a farm from one rules version's shape to the next, such as adding a new good or plot,
without changing anything the two versions share.
_Avoid_: migrate, rebase, convert

**Base snapshot**:
The snapshot that holds a farm upgraded to a new rules version, written with the farm's first
action under that version. A replay never crosses a rules version: it upgrades the farm where its
log steps up a version.
_Avoid_: rebase, migration snapshot

**Audit**:
Rebuilding a farm as it was at a past server time from its accepted actions, and checking that
it obeys the rules and matches what was stored.
_Avoid_: verification, inspection, cheat scan

**Server time**:
The only clock the game trusts. A device's clock never decides when anything happens.
_Avoid_: client time, device time, now

**Offline progress**:
What a farm produces between a player's last action and their return, computed when they come
back rather than while they are away.
_Avoid_: idle income, catch-up, background ticks

**Automated step**:
A change the farm makes by itself at a server time, with no action behind it (a crop ripening, an
animal producing, a job finishing, a Collector moving goods, a Loop restarting, an order slot
refilling).
_Avoid_: event, tick, timer

### What a farm makes

**Goods**:
Anything a farm can hold in storage and count: crops, animal products, feed and finished
products. Coins are not goods.
_Avoid_: items, resources, inventory, products (for the whole set)

**Plot**:
One patch of a field where a single crop is planted, grows and is harvested.
_Avoid_: tile, slot, field (for one patch)

**Trough**:
An animal pen's store of feed. The animals eat from it on their own and keep producing until it
is empty.
_Avoid_: feeder, food bowl

**Facility**:
A building that turns goods into other goods by recipe: the feed mill, the bakery and the dairy.
_Avoid_: building (for these), machine, factory, workshop

**Recipe**:
What a facility can make: the goods it takes, the goods it gives and how long it takes.
_Avoid_: formula, blueprint, product

**Job**:
One run of a recipe in a facility's queue. Jobs run one after another; a job's goods wait in the
facility until they are collected.
_Avoid_: task, order (an order is something else), batch

**Tier**:
How far a facility has been upgraded, starting at 1. A higher tier works faster, can open more
queue slots and makes more recipes available.
_Avoid_: level (that is the player's), grade, rank

**Add-on**:
A purchase that changes how a facility or a pen works beyond its own upgrades, such as
automating a step or allowing more queue slots.
_Avoid_: module, extension, perk

**Loop**:
The add-on that starts the facility's last recipe again whenever its inputs are in storage.
_Avoid_: repeat, auto-craft

**Collector**:
The add-on that moves finished goods from a facility, or products from a pen, into storage.
_Avoid_: auto-collect, conveyor

**Silo**:
The farm's storage for crops, with a capacity.
_Avoid_: granary, storage (for one store)

**Barn**:
The farm's storage for every good that isn't a crop, with a capacity.
_Avoid_: warehouse, storage (for one store)

**Farmhand**:
A hired worker who does manual work on the farm without the player: harvesting and replanting,
carrying feed to troughs, collecting from pens, delivering orders.
_Avoid_: worker, helper, NPC, bot

### Progress

**Level**:
The player's progress, raised by XP. It never goes down, and reaching one unlocks content.
_Avoid_: rank, tier (that is a facility's), farm level

**Unlocked**:
Allowed by the player's level: an unlocked good may appear in orders, and an unlocked upgrade may
be bought. Unlocked is not the same as owned or producible.
_Avoid_: available, enabled

**Producible**:
A good the farm can make right now: it has the facility at the right tier, or the crop or animal,
that the good needs.
_Avoid_: available, craftable, unlocked

**Clover**:
The rare currency, earned by playing rather than bought, and spent to skip a wait. Not goods:
it can't be gifted.
_Avoid_: gems, premium currency, rare currency, time-skip currency

### Orders

**Order**:
A request from a non-player character for certain goods, paying coins and XP when delivered.
_Avoid_: quest, task, request, job

**Order board**:
The farm's open orders, one per slot. The number of slots grows with the player's level. A
delivered or discarded order is replaced after a delay.
_Avoid_: quest board, task list

### Between players

**Friend**:
A player you have agreed to be connected with, both ways, through an invite. Gifts and visits go
only to friends.
_Avoid_: contact, follower, neighbour, buddy

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
Replacing a prediction with the server's result when the two disagree, then applying the
client's still-unconfirmed actions on top of it again.
_Avoid_: sync, rollback, correction

**State hash**:
A fingerprint of a farm's state, used to tell whether two copies of it agree exactly.
_Avoid_: checksum, version

### Code

**Module**:
A unit of code that hides its insides behind one interface, and can contain modules of its own.
_Avoid_: component, service, package (for a module inside a package), add-on (that is the game's)

**Interface**:
Everything a caller must know to use a module correctly: its exports and their types, and its
invariants, error modes and units.
_Avoid_: API, public surface, signature (too narrow)
