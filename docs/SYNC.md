# How devices stay in sync (and what happens when they disagree)

Every counter, laptop and phone keeps the whole shop in its own database and works offline.
With cloud sync on, each device pushes its changes to the Hisaab server and pulls everyone
else's. These are the rules that make that safe.

## Nothing is ever lost

| What | Rule |
| --- | --- |
| **Bills, payments, stock moves, ledger entries** | Append-only. Each device creates ids in its own block (device A: 1…, device B: 1 000 000 000 000…), so two devices can never create the same row. Every bill made anywhere ends up everywhere. |
| **Bill numbers** | Each device has its own series (`INV-41` on the first counter, `INV-B-7` on device B), so GST invoice numbers never clash. |
| **Stock** | Never copied between devices. Each device adds up the stock moves it has — so when two counters sell from the same batch, both sales deduct. |
| **Paid / due on a bill** | Recomputed from the payments after every pull, wherever the payment was taken. |
| **Masters (items, customers, prices, settings)** | The latest saved version wins, row by row. Your device's unsent edit is never overwritten by an older one from the server. |
| **Things that must be unique** (barcode, category name, recurring bill, a month's salary) | If two devices create the same one offline, the older row keeps it on every device; the other is renamed or cleared and listed under *Settings → Cloud & devices → Needs a look*. |

## Two phones sell the last packet

Device A and device B are both offline. The shelf shows one Maggi; each sells it.

Hisaab **allows it, then flags it**: refusing a sale at the counter because another phone
might have sold the same packet would stop billing every time the internet drops.

When the devices sync:

1. Both bills stand — the customers have their goods, and both are valid GST invoices.
2. Stock goes to −1 on every device.
3. Each device raises a red alert on the dashboard:
   *“Maggi 70 g went 1 Pcs short — sold on 2 devices while they were offline”*, listing the
   bills (number, device and who billed them).
4. The owner either **counts the shelf** (there may be stock nobody entered) or
   **records the purchase** that was missed. The alert closes by itself as soon as stock is
   back to zero or more. It can also be dismissed.

An item a single counter sold below zero is *not* a sync alert: the bill screen already
warned the cashier when it happened.

## Udhaar past the credit limit

The same rule for credit: if two devices each give a customer credit within the limit, but
together it goes over, both bills stand and the dashboard shows
*“Verma ji is ₹60.00 over the credit limit — udhaar was given on 2 devices”*, until the
dues are back under the limit.

## Phones on the shop Wi-Fi

Phones connected to the shop computer over Wi-Fi don't have their own copy: every bill goes
straight into the computer's database, so they can't oversell against each other at all.
