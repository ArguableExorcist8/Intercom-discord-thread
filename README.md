# Intercom To Discord Follow-up Bot

The bot receives Intercom conversation ID, fetches the ticket from Intercom, summarizes it with AI, and creates a routed Discord thread.

## Routing

- `VIP/Partner`: contact is a partner or level 50+. This can combine with another tag.
- `URGENT`: active, system-wide production/security/data/infrastructure emergency. This is the only tag that automatically pings oop and nikita.
- `Bug Bounty`: an intentional security disclosure or bounty submission, such as a reported vulnerability, exploit, proof of concept, or responsible disclosure. It does not auto-ping developers; a researcher report can still combine with `URGENT` when an active exploit is involved.
- `Standard`: account-specific support, including bugs that a player wants fixed for themselves (for example missing XP, RugPass progress, deposits, withdrawals, rewards, referrals, crashes, or wallet issues), plus all other non-urgent tickets.

## Security Operations

- `.env.example`

## Lifecycle Sync

After a thread is created, the bot stores its Discord thread ID on the Intercom conversation. Signed Intercom webhooks can then post only material customer updates, archive and lock threads when conversations close, and restore them when conversations reopen. This database-free sync is intended for one long-running app instance.

## API Contract

See [docs/API.md](docs/API.md)
